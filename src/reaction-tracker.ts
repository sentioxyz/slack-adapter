// src/reaction-tracker.ts
// "Processing" indicator: a reaction (default 👀) on the message the agent is
// currently working on. add() marks a triggering message as seen; remove() is
// called at turn end and clears the OLDEST outstanding reaction (FIFO — matches
// core's FIFO prompt queue, so each turn-end clears its own trigger).
// removeAll() is called on terminal session_end and drains every outstanding
// reaction for the session. clear() is the teardown escape hatch for sessions
// ending abnormally without Slack cleanup.
// In-memory only: a crash mid-turn leaves the reaction behind (accepted).
//
// session_end vs error model (verified against @openacp/cli core):
// session_end is TERMINAL — SessionBridge calls session.finish(), which drives
// the state machine to the "finished" state (no outgoing transitions).
// processPrompt early-returns on finished sessions, so a live session delivers
// AT MOST ONE session_end. Thread sessions continue across turns via lazy
// resume: each later reply resumes the persisted record into a NEW live
// session. Therefore turn end must drain ALL outstanding reactions via
// removeAll(), not just one — a single pop would leak any reaction beyond the
// first if multiple messages were dispatched in the same live session.
// error, by contrast, is recoverable (error → active is a valid transition),
// so popping one reaction per error is correct.
import type { Logger } from "./types.js";

export type ReactionEnqueue = (
  method: "reactions.add" | "reactions.remove",
  params: Record<string, unknown>,
) => Promise<unknown>;

interface PendingReaction {
  channel: string;
  ts: string;
  /** Settles when the reactions.add call has completed (never rejects). remove()
   * awaits it so a rate-limit-delayed add cannot land AFTER its own remove. */
  added: Promise<void>;
}

/** Slack platform errors arrive as `{ data: { error: "code" } }` on the thrown value. */
function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | null | undefined)?.data?.error;
}

export class ReactionTracker {
  private pending = new Map<string, PendingReaction[]>();

  constructor(
    private enqueue: ReactionEnqueue,
    private emoji: string,
    private log: Logger,
  ) {}

  /**
   * Add the processing reaction to a triggering message and remember it (FIFO).
   * Fire-and-forget: the API call never blocks or fails the dispatch.
   */
  add(sessionKey: string, channel: string, ts: string): void {
    if (!this.emoji) return;
    const added = this.enqueue("reactions.add", { channel, timestamp: ts, name: this.emoji })
      .then(() => undefined)
      .catch((err) => {
        if (slackErrorCode(err) === "already_reacted") return;
        this.log.warn({ err, channel, ts }, "Failed to add processing reaction");
      });
    const list = this.pending.get(sessionKey) ?? [];
    list.push({ channel, ts, added });
    this.pending.set(sessionKey, list);
  }

  /** Session torn down: forget its outstanding reactions without touching Slack. */
  clear(sessionKey: string): void {
    this.pending.delete(sessionKey);
  }

  /** Turn ended: remove the oldest outstanding reaction for this session. */
  async remove(sessionKey: string): Promise<void> {
    if (!this.emoji) return;
    const list = this.pending.get(sessionKey);
    const ref = list?.shift();
    if (!ref) return;
    if (list && list.length === 0) this.pending.delete(sessionKey);
    await ref.added;
    try {
      await this.enqueue("reactions.remove", { channel: ref.channel, timestamp: ref.ts, name: this.emoji });
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "no_reaction" || code === "message_not_found") return;
      this.log.warn({ err, channel: ref.channel, ts: ref.ts }, "Failed to remove processing reaction");
    }
  }

  /**
   * Session finished (terminal `session_end`): remove every outstanding
   * reaction for this session. A live session delivers at most one
   * session_end, so per-entry pops would leak any reaction beyond the first.
   */
  async removeAll(sessionKey: string): Promise<void> {
    while (this.pending.get(sessionKey)?.length) {
      await this.remove(sessionKey);
    }
  }
}
