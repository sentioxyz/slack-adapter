// src/activity-tracker.ts
import {
  ToolStateMap,
  ThoughtBuffer,
  DisplaySpecBuilder,
  ToolCardState,
} from "@openacp/plugin-sdk";
import type {
  ToolDisplaySpec,
  ToolCardSnapshot,
  OutputMode,
  ToolCallMeta,
  ViewerLinks,
  TunnelServiceInterface,
  PlanEntry,
} from "@openacp/plugin-sdk";
import type { types } from "@slack/bolt";
import type { ISlackSendQueue } from "./send-queue.js";
import type { TurnState } from "./types.js";
import { SlackToolCardRenderer } from "./tool-card-renderer.js";

type KnownBlock = types.KnownBlock;

export interface SlackActivityTrackerConfig {
  channelId: string;
  sessionId: string;
  queue: ISlackSendQueue;
  outputMode: OutputMode;
  tunnelService?: TunnelServiceInterface;
  sessionContext?: { id: string; workingDirectory: string };
  /** Outer thread root for subscribed channels — roots the main message in that thread. */
  threadTs?: string;
}

export class SlackActivityTracker {
  private channelId: string;
  private sessionId: string;
  private queue: ISlackSendQueue;
  private outputMode: OutputMode;
  private tunnelService?: TunnelServiceInterface;
  private sessionContext?: { id: string; workingDirectory: string };
  private rootThreadTs?: string;

  private toolStateMap = new ToolStateMap();
  private specBuilder: DisplaySpecBuilder;
  private toolCardState: ToolCardState | null = null;
  private thoughtBuffer = new ThoughtBuffer();
  private renderer = new SlackToolCardRenderer();
  private turn: TurnState | null = null;
  private textStarted = false;
  private lastSnapshot: ToolCardSnapshot = {
    specs: [],
    totalVisible: 0,
    completedVisible: 0,
    allComplete: false,
  };
  private thoughtMessageTs?: string;

  constructor(config: SlackActivityTrackerConfig) {
    this.channelId = config.channelId;
    this.sessionId = config.sessionId;
    this.queue = config.queue;
    this.outputMode = config.outputMode;
    this.tunnelService = config.tunnelService;
    this.sessionContext = config.sessionContext;
    this.rootThreadTs = config.threadTs;
    this.specBuilder = new DisplaySpecBuilder(config.tunnelService);
  }

  setOutputMode(mode: OutputMode): void {
    this.outputMode = mode;
  }

  async onNewPrompt(): Promise<TurnState> {
    // Finalize previous turn if exists
    if (this.turn && !this.turn.isFinalized) {
      await this.finalize();
    }

    // Reset state
    this.toolStateMap.clear();
    this.thoughtBuffer.reset();
    this.textStarted = false;
    if (this.toolCardState) {
      this.toolCardState.destroy();
      this.toolCardState = null;
    }
    this.thoughtMessageTs = undefined;
    this.lastSnapshot = {
      specs: [],
      totalVisible: 0,
      completedVisible: 0,
      allComplete: false,
    };

    // Post initial main message
    let blocks: KnownBlock[];
    if (this.outputMode === "low") {
      blocks = this.renderer.renderMainMessageLow(false);
    } else {
      blocks = this.renderer.renderMainMessage(this.lastSnapshot, false);
    }

    const result = await this.queue.enqueue<{ ok: boolean; ts: string }>(
      "chat.postMessage",
      {
        channel: this.channelId,
        ...(this.rootThreadTs ? { thread_ts: this.rootThreadTs } : {}),
        blocks,
        text: "Processing...",
      },
    );

    const turn: TurnState = {
      mainMessageTs: result.ts,
      threadTs: this.rootThreadTs ?? result.ts,
      isFinalized: false,
    };
    this.turn = turn;

    return turn;
  }

  async onThought(text: string): Promise<void> {
    this.thoughtBuffer.append(text);

    if (this.outputMode !== "high") return;
    if (!this.turn) return;

    const truncated = this.thoughtBuffer.getText().slice(0, 2900);
    const blocks: KnownBlock[] = [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `\u{1F4AD} _${truncated}_` }],
      } as KnownBlock,
    ];

    if (this.thoughtMessageTs) {
      await this.queue.enqueue("chat.update", {
        channel: this.channelId,
        ts: this.thoughtMessageTs,
        blocks,
        text: truncated,
      });
    } else {
      const result = await this.queue.enqueue<{ ok: boolean; ts: string }>(
        "chat.postMessage",
        {
          channel: this.channelId,
          thread_ts: this.turn.threadTs,
          blocks,
          text: truncated,
        },
      );
      this.thoughtMessageTs = result.ts;
    }
  }

  async onToolCall(
    meta: ToolCallMeta,
    kind: string,
    rawInput: unknown,
  ): Promise<void> {
    // Seal thought buffer if not sealed
    if (!this.thoughtBuffer.isSealed()) {
      this.thoughtBuffer.seal();
    }

    const entry = this.toolStateMap.upsert(meta, kind, rawInput);
    const spec = this.specBuilder.buildToolSpec(
      entry,
      this.outputMode,
      this.sessionContext,
    );

    if (spec.isHidden) return;

    this.ensureToolCardState();
    this.toolCardState!.updateFromSpec(spec);

    await this.updateMainMessage(false);
  }

  async onToolUpdate(
    id: string,
    status: string,
    viewerLinks?: ViewerLinks,
    viewerFilePath?: string,
    content?: string | null,
    rawInput?: unknown,
    diffStats?: { added: number; removed: number },
  ): Promise<void> {
    const entry = this.toolStateMap.merge(
      id,
      status,
      rawInput,
      content,
      viewerLinks,
      diffStats,
    );

    if (!entry) return;

    const spec = this.specBuilder.buildToolSpec(
      entry,
      this.outputMode,
      this.sessionContext,
    );

    if (spec.isHidden) return;

    this.ensureToolCardState();
    this.toolCardState!.updateFromSpec(spec);

    await this.updateMainMessage(false);
  }

  /**
   * Called on the first text chunk of a turn.
   *
   * Seals the thought buffer and freezes the tool card — no more updates accepted.
   * Does NOT mark the turn as complete (that's finalize()'s job). Idempotent: safe
   * to call multiple times per turn.
   */
  async onTextStart(): Promise<void> {
    if (!this.turn || this.textStarted) return;
    this.textStarted = true;
    this.thoughtBuffer.seal();
    if (this.toolCardState) {
      // Freeze the tool card — don't destroy it, keep it visible
      this.toolCardState.finalize();
      // Null out so any tool calls arriving after text start get a fresh card
      this.toolCardState = null;
    }
    await this.updateMainMessage(false);
  }

  async onPlan(entries: PlanEntry[]): Promise<void> {
    if (this.toolCardState) {
      this.toolCardState.updatePlan(entries);
    }
  }

  async onUsage(usage: {
    tokensUsed?: number;
    contextSize?: number;
    cost?: number;
  }): Promise<void> {
    if (this.toolCardState) {
      this.toolCardState.appendUsage(usage);
    }
  }

  async finalize(): Promise<void> {
    if (!this.turn || this.turn.isFinalized) return;

    if (this.toolCardState) {
      this.toolCardState.finalize();
    }

    await this.updateMainMessage(true);
    this.turn.isFinalized = true;
  }

  destroy(): void {
    if (this.toolCardState) {
      this.toolCardState.destroy();
      this.toolCardState = null;
    }
  }

  getTurn(): TurnState | null {
    return this.turn;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private ensureToolCardState(): void {
    if (this.toolCardState) return;

    this.toolCardState = new ToolCardState({
      onFlush: (snapshot: ToolCardSnapshot) => {
        this.lastSnapshot = snapshot;
        void this.flushToolCard(snapshot);
      },
    });
  }

  private async flushToolCard(snapshot: ToolCardSnapshot): Promise<void> {
    if (this.outputMode === "low") return;
    if (!this.turn) return;

    const blocks = this.renderer.renderToolCard(snapshot);

    if (this.turn.currentToolCardTs) {
      try {
        await this.queue.enqueue("chat.update", {
          channel: this.channelId,
          ts: this.turn.currentToolCardTs,
          blocks,
          text: "Tool details",
        });
      } catch {
        // Non-critical: tool card update failed, skip
      }
    } else {
      const result = await this.queue.enqueue<{ ok: boolean; ts: string }>(
        "chat.postMessage",
        {
          channel: this.channelId,
          thread_ts: this.turn.threadTs,
          blocks,
          text: "Tool details",
        },
      );
      this.turn.currentToolCardTs = result.ts;
    }
  }

  private async updateMainMessage(isComplete: boolean): Promise<void> {
    if (!this.turn) return;

    const snapshot = { ...this.lastSnapshot, allComplete: isComplete };
    const blocks: KnownBlock[] =
      this.outputMode === "low"
        ? this.renderer.renderMainMessageLow(isComplete)
        : this.renderer.renderMainMessage(snapshot, isComplete);

    try {
      await this.queue.enqueue("chat.update", {
        channel: this.channelId,
        ts: this.turn.mainMessageTs,
        blocks,
        text: isComplete ? "Done" : "Processing...",
      });
    } catch {
      // Fallback: post new message if edit fails (e.g., message deleted)
      try {
        const result = await this.queue.enqueue<{ ts?: string }>(
          "chat.postMessage",
          {
            channel: this.channelId,
            ...(this.rootThreadTs ? { thread_ts: this.rootThreadTs } : {}),
            blocks,
            text: isComplete ? "Done" : "Processing...",
          },
        );
        if (result?.ts) {
          this.turn.mainMessageTs = result.ts;
          this.turn.threadTs = this.rootThreadTs ?? result.ts;
        }
      } catch {
        // Give up silently
      }
    }
  }
}
