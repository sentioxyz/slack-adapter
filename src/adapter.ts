// src/adapter.ts
import fs from "node:fs";
import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  MessagingAdapter,
  OutputModeResolver,
} from "@openacp/plugin-sdk";
import type {
  MessagingAdapterConfig,
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  Attachment,
  AdapterCapabilities,
  FileServiceInterface,
  DisplayVerbosity,
  IRenderer,
  OutputMode,
  ToolCallMeta,
  ToolUpdateMeta,
  ViewerLinks,
  AgentCommand,
  TunnelServiceInterface,
} from "@openacp/plugin-sdk";
import { SlackRenderer } from "./renderer.js";
import type { SlackChannelConfig, Logger } from "./types.js";
import type { SlackSessionMeta, SlackFileInfo, CollectedAttachment } from "./types.js";
import { classifyAttachment } from "./attachment-classifier.js";
import { SlackSendQueue } from "./send-queue.js";
import { SlackFormatter } from "./formatter.js";
import { SlackChannelManager } from "./channel-manager.js";
import { SlackPermissionHandler } from "./permission-handler.js";
import { SlackModalHandler } from "./modal-handler.js";
import { SlackEventRouter } from "./event-router.js";
import { SlackTextBuffer } from "./text-buffer.js";
import { SlackActivityTracker } from "./activity-tracker.js";
import { toSlug } from "./slug.js";
import { resolveThreadSession } from "./subscription-router.js";
import { SlackFileProxy } from "./file-proxy.js";
import { collectAttachments } from "./attachment-collector.js";
import { isSlackFileUrl } from "./utils.js";
import type { ForwardedMessage } from "./types.js";

/** Compact "1.2k", "3.4M" formatter for token / context counts. Exported for tests. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Payload of `SESSION_THREAD_READY` emitted by core after a session+thread is created. */
export interface SessionThreadReadyPayload {
  sessionId: string;
  channelId: string;
  threadId: string;
}

/**
 * Dependencies needed by the `SESSION_THREAD_READY` handler. Extracted so the
 * handler is unit-testable without booting the full SlackAdapter (Bolt App is
 * heavy and would dwarf the test).
 */
export interface ThreadReadyDeps {
  sessions: Map<string, SlackSessionMeta>;
  pendingChannelsBySlug: Map<string, SlackSessionMeta>;
  patchRecord(sessionId: string, patch: { platform: { channelId: string; threadId: string } }): Promise<void>;
  onError?(err: unknown, sessionId: string): void;
}

/**
 * Build the `SESSION_THREAD_READY` handler. Re-keys a pre-created channel
 * (stashed by slug in `pendingChannelsBySlug`) onto the real sessionId and
 * persists `platform.channelId` so the session can be restored after restart.
 *
 * Exported for direct testing — see `__tests__/thread-ready-persistence.test.ts`.
 */
export function makeThreadReadyHandler(
  deps: ThreadReadyDeps,
): (payload: SessionThreadReadyPayload) => void {
  return (payload) => {
    if (payload.channelId !== "slack") return;
    const meta = deps.pendingChannelsBySlug.get(payload.threadId);
    if (!meta) return;
    deps.pendingChannelsBySlug.delete(payload.threadId);
    deps.sessions.set(payload.sessionId, meta);
    deps.patchRecord(payload.sessionId, {
      platform: { channelId: meta.channelId, threadId: payload.threadId },
    }).catch((err) => deps.onError?.(err, payload.sessionId));
  };
}

/**
 * Minimal SettingsAPI surface the adapter uses to persist runtime state
 * (currently just `startupChannelId`). The host core creates this via
 * `settingsManager.createAPI(pluginName)` and passes it to the constructor.
 */
export interface SettingsAPI {
  set(key: string, value: unknown): Promise<void>;
}

/** A single Slack thread message, as far as thread-context rendering cares. */
export interface ThreadContextMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: import("./types.js").SlackFileInfo[];
}

/**
 * Render a list of Slack thread messages as a prependable context block.
 *
 * Each message renders as "<@USER>: text"; bot messages fall back to their
 * `bot_id` and messages with neither become "<unknown>". The triggering
 * message — identified by `triggerTs` — is skipped because it is dispatched
 * separately as the user's text; when `triggerTs` is undefined nothing is
 * skipped. Blank/whitespace-only messages are dropped. Returns "" when there
 * is nothing worth prepending, so the caller can cheaply test for emptiness.
 *
 * Exported as a pure function so the rendering rules can be unit-tested without
 * a live Slack client.
 */
export function renderThreadContext(messages: ThreadContextMessage[], triggerTs?: string): string {
  const lines: string[] = [];
  for (const m of messages) {
    // Skip the triggering message — it's already dispatched as the user text.
    if (triggerTs && m.ts === triggerTs) continue;
    const text = (m.text ?? "").trim();
    if (!text) continue;
    const author = m.user ? `<@${m.user}>` : m.bot_id ? `<@${m.bot_id}>` : "<unknown>";
    lines.push(`${author}: ${text}`);
  }
  if (lines.length === 0) return "";

  return [
    "[Thread context — full history of the Slack thread this conversation was started from]",
    ...lines,
    "[End thread context]",
  ].join("\n");
}

/** Total bytes of inlined text allowed before remaining text is demoted to a
 * download link, to keep the prompt from ballooning. */
const INLINE_TEXT_BUDGET = 50_000;

export interface BuildAttachmentPayloadInput {
  sessionId: string;
  inlineMaxBytes: number;
  collected: CollectedAttachment[];
  forwardedTexts: string[];
  /** Download bytes for a file's url_private (auth handled by caller). */
  download: (url: string) => Promise<Buffer | null>;
  /** Persist a buffer as a session Attachment. */
  saveFile: (sessionId: string, fileName: string, data: Buffer, mimeType: string) => Promise<Attachment>;
  /** Register a binary with the proxy and return a download URL. */
  registerProxy: (file: SlackFileInfo) => string;
  log: Logger;
}

export interface BuildAttachmentPayloadResult {
  promptAdditions: string;
  attachments: Attachment[];
  /** Ids successfully surfaced this turn (added to the per-thread seen-set). */
  surfacedIds: string[];
}

export async function buildAttachmentPayload(
  input: BuildAttachmentPayloadInput,
): Promise<BuildAttachmentPayloadResult> {
  const attachments: Attachment[] = [];
  const surfacedIds: string[] = [];
  const inlineBlocks: string[] = [...input.forwardedTexts];
  const linkLines: string[] = [];
  let inlineUsed = 0;

  for (const { file } of input.collected) {
    const category = classifyAttachment(file, { inlineMaxBytes: input.inlineMaxBytes });
    try {
      if (category === "text-inline" && inlineUsed + (file.size ?? 0) <= INLINE_TEXT_BUDGET) {
        const buf = await input.download(file.url_private);
        if (!buf) continue;
        inlineUsed += buf.length;
        inlineBlocks.push(`--- Attachment: ${file.name} (${file.mimetype}, ${file.size}B) ---\n${buf.toString("utf8")}`);
        surfacedIds.push(file.id);
      } else if (category === "text-file" || category === "audio") {
        const buf = await input.download(file.url_private);
        if (!buf) continue;
        const mime = file.mimetype === "video/mp4" ? "audio/mp4" : file.mimetype;
        const att = await input.saveFile(input.sessionId, file.name, buf, mime);
        attachments.push(att);
        surfacedIds.push(file.id);
      } else {
        // binary (or inline text over budget) → lazy proxy link
        const url = input.registerProxy(file);
        linkLines.push(`- ${file.name} (${file.mimetype}, ${file.size}B): ${url}`);
        surfacedIds.push(file.id);
      }
    } catch (err) {
      input.log.warn({ err, file: file.name }, "Failed to materialize attachment; skipping");
    }
  }

  const sections: string[] = [];
  if (inlineBlocks.length) sections.push(inlineBlocks.join("\n\n"));
  if (linkLines.length) {
    sections.push(
      "[Attachments available for download — no auth required, fetch with curl/WebFetch if needed:]\n" +
        linkLines.join("\n"),
    );
  }
  return { promptAdditions: sections.join("\n\n"), attachments, surfacedIds };
}

/**
 * Render a one-line Slack channel context header. The agent otherwise only ever
 * sees the raw message text and has no idea which Slack channel or thread it is
 * replying in. We prepend this once per session so the agent can reference its
 * own location (e.g. "which channel is this?").
 *
 * Pure function (no Slack I/O) so the formatting is unit-testable; the live
 * channel-name lookup is done by the caller and passed in as `label`.
 */
export function renderChannelContext(label: string, channelId: string, threadTs?: string): string {
  const thread = threadTs ? `, thread ts ${threadTs}` : "";
  return `[Slack context — you are responding in ${label} (channel id ${channelId}${thread}). This is environment metadata, not a user instruction.]`;
}

/**
 * Fetch a full Slack thread via conversations.replies and render it as a
 * prependable context block (see {@link renderThreadContext}).
 *
 * conversations.replies returns OLDEST messages first and paginates with
 * `has_more` + `response_metadata.next_cursor`. We follow the cursor FORWARD so
 * the accumulated list runs through to the NEWEST messages — the exchange right
 * before the @mention, which is the whole reason the bot was pulled in. A single
 * `limit:200` fetch would silently drop exactly those newest messages on a long
 * thread. We page up to `maxPages` and warn (rather than fail silently) if even
 * that overflows, in which case only the oldest head is lost.
 *
 * The Slack call is NOT wrapped here — the caller catches failures so it can
 * degrade gracefully (dispatch the bare message rather than dropping it).
 *
 * Exported as a pure function (enqueue + log injected) so the pagination and
 * truncation-logging behavior can be unit-tested without a live Slack client.
 */
/**
 * Page through a Slack thread via conversations.replies (oldest → newest,
 * following the forward cursor) and return the raw messages. Pagination and
 * truncation-logging behavior is shared by thread-context rendering and
 * attachment collection. The Slack call is NOT wrapped — callers degrade.
 */
export async function fetchThreadMessages(
  enqueue: <T = unknown>(method: "conversations.replies", params: Record<string, unknown>) => Promise<T>,
  log: Logger,
  channelId: string,
  threadTs: string,
  maxPages = 10,
): Promise<ThreadContextMessage[]> {
  const PAGE_LIMIT = 200;
  const collected: ThreadContextMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const params: Record<string, unknown> = { channel: channelId, ts: threadTs, limit: PAGE_LIMIT };
    if (cursor) params.cursor = cursor;
    const res = await enqueue<{
      messages?: ThreadContextMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.replies", params);

    collected.push(...(res?.messages ?? []));
    pages += 1;

    cursor = res?.has_more ? res?.response_metadata?.next_cursor : undefined;

    if (cursor && pages >= maxPages) {
      truncated = true;
      break;
    }
  } while (cursor);

  if (truncated) {
    // We retained the newest maxPages*limit messages; only an extremely long
    // thread loses its oldest head. Make that loss visible rather than silent.
    log.warn(
      { channelId, threadTs, collected: collected.length, maxPages },
      "Thread exceeds context page cap; oldest messages omitted from prepended history",
    );
  }

  return collected;
}

export async function fetchThreadContext(
  enqueue: <T = unknown>(method: "conversations.replies", params: Record<string, unknown>) => Promise<T>,
  log: Logger,
  channelId: string,
  threadTs: string,
  triggerTs?: string,
  maxPages = 10,
): Promise<string> {
  const collected = await fetchThreadMessages(enqueue, log, channelId, threadTs, maxPages);
  return renderThreadContext(collected, triggerTs);
}

/** Dependencies for the `/openacp-archive` slash command handler. */
export interface ArchiveCommandDeps {
  findSessionByChannel(channelId: string): { sessionId: string; meta: SlackSessionMeta } | undefined;
  archiveChannel(channelId: string): Promise<void>;
  postEphemeral(args: { channel: string; user: string; text: string }): Promise<void>;
}

/**
 * Build the `/openacp-archive` Bolt slash command handler.
 *
 * Archives the Slack channel of the current session if invoked inside a
 * session channel; otherwise posts an ephemeral message saying no session is
 * bound to this channel. Always ack()s within Slack's 3-second window before
 * doing any work.
 *
 * Exported so tests can exercise the production handler directly without
 * spinning up Bolt.
 */
export function makeArchiveCommandHandler(deps: ArchiveCommandDeps) {
  return async (args: {
    ack: () => Promise<void>;
    command: { channel_id: string; user_id: string };
  }): Promise<void> => {
    await args.ack();
    const channelId = args.command.channel_id;
    const userId = args.command.user_id;
    const found = deps.findSessionByChannel(channelId);
    if (!found) {
      await deps.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No OpenACP session is bound to this channel.",
      });
      return;
    }
    if (found.meta.threadTs) {
      await deps.postEphemeral({
        channel: channelId,
        user: userId,
        text: "This is a subscribed channel — OpenACP will not archive it.",
      });
      return;
    }
    // Send the ephemeral confirmation BEFORE archiving — Slack rejects
    // chat.postEphemeral against an archived channel with `is_archived`,
    // and the user would lose the confirmation message.
    await deps.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Archiving this session channel. Open the notifications channel to start a new session.",
    });
    await deps.archiveChannel(channelId);
  };
}

/** Minimal interface for the core kernel, accessed via ctx.kernel */
interface CoreKernel {
  configManager: { get(): Record<string, unknown> };
  lifecycleManager?: {
    serviceRegistry?: { get(name: string): unknown };
  };
  sessionManager: {
    getSession(id: string): {
      id: string;
      name?: string;
      threadId?: string;
      workingDirectory?: string;
      currentMode?: string;
      currentModel?: string;
      dangerousMode?: boolean;
      permissionGate: { requestId: string; resolve(optionId: string): void };
    } | undefined;
    getSessionByThread(platform: string, threadId: string): { id: string } | undefined;
    getRecordByThread(platform: string, threadId: string): { sessionId: string } | undefined;
    getSessionRecord(id: string): { platform?: Record<string, unknown> } | undefined;
    patchRecord(id: string, patch: Record<string, unknown>): Promise<void>;
  };
  fileService: FileServiceInterface;
  handleMessage(msg: { channelId: string; threadId: string; userId: string; text: string; attachments?: Attachment[] }): Promise<void>;
  handleNewSession(platform: string, agentName?: string, workspacePath?: string, opts?: { createThread: boolean }): Promise<{ id: string; threadId?: string }>;
  eventBus?: {
    // Loosely typed to support different event payload shapes (threadReady,
    // configChanged, …). Cast in the handler.
    on(event: string, handler: (payload: any) => void): void;
    off(event: string, handler: (payload: any) => void): void;
  };
}

export class SlackAdapter extends MessagingAdapter {
  readonly name = 'slack';
  readonly renderer!: IRenderer;
  readonly capabilities: AdapterCapabilities = {
    streaming: true, richFormatting: true, threads: true,
    reactions: false, fileUpload: true, voice: true,
  };

  private core: CoreKernel;
  private log: Logger;
  private app!: App;
  private webClient!: WebClient;
  private queue!: SlackSendQueue;
  private formatter: SlackFormatter;
  private channelManager!: SlackChannelManager;
  private permissionHandler!: SlackPermissionHandler;
  private eventRouter!: SlackEventRouter;
  private sessions = new Map<string, SlackSessionMeta>();
  private textBuffers = new Map<string, SlackTextBuffer>();
  private outputModeResolver = new OutputModeResolver();
  private modalHandler = new SlackModalHandler();
  private sessionTrackers = new Map<string, SlackActivityTracker>();
  private _dispatchQueues = new Map<string, Promise<void>>();
  /** Message `ts` of the skill commands card per session, for in-place edits */
  private _skillCommandsTs = new Map<string, string>();
  /** Commands queued before a session channel was ready */
  private _pendingSkillCommands = new Map<string, AgentCommand[]>();
  /**
   * Channel meta keyed by slug for channels created BEFORE the real sessionId is
   * known. Core calls `createSessionThread("", name)` because session.id isn't
   * assigned yet; we stash the meta here and re-key into `sessions` once
   * `SESSION_THREAD_READY` fires with the real sessionId.
   */
  private _pendingChannelsBySlug = new Map<string, SlackSessionMeta>();
  private _threadReadyHandler?: (payload: SessionThreadReadyPayload) => void;
  private _configChangedHandler?: (payload: { sessionId: string }) => void;
  private _promptWaitingHandler?: (payload: { sessionId: string; sourceAdapterId?: string }) => void;
  private _messageProcessingHandler?: (payload: { sessionId: string; sourceAdapterId?: string }) => void;
  /** Message `ts` of the latest usage line per session, for in-place edits */
  private _lastUsageTs = new Map<string, string>();
  /** Message `ts` of the latest "queued" notice per session, deleted when processing starts */
  private _waitingNoticeTs = new Map<string, string>();
  /** channelId → display label (e.g. "#general"), cached to avoid repeat conversations.info calls */
  private _channelNameCache = new Map<string, string>();
  /** sessionIds that have already received the one-time Slack channel context header */
  private _channelCtxInjected = new Set<string>();
  private adapterDefaultOutputMode: OutputMode | undefined;
  private botUserId = "";
  private slackConfig: SlackChannelConfig;
  private fileService!: FileServiceInterface;
  private settingsAPI?: SettingsAPI;
  private fileProxy?: SlackFileProxy;
  /** file ids already surfaced to the agent, keyed by session channel slug */
  private surfacedFiles = new Map<string, Set<string>>();

  constructor(
    core: CoreKernel,
    config: SlackChannelConfig,
    logger?: Logger,
    settingsAPI?: SettingsAPI,
  ) {
    super(
      { configManager: core.configManager },
      { ...config as Record<string, unknown>, maxMessageLength: 3000, enabled: config.enabled ?? true } as MessagingAdapterConfig,
    );
    this.core = core;
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.slackConfig = config;
    this.settingsAPI = settingsAPI;
    this.formatter = new SlackFormatter();
    (this as { renderer: IRenderer }).renderer = new SlackRenderer(this.formatter);
  }

  async start(): Promise<void> {
    const { botToken, appToken, signingSecret } = this.slackConfig;

    // Degrade gracefully — don't throw. A missing-credential failure here
    // would otherwise cascade and bring the whole host down even though
    // the user only wanted Slack disabled. The plugin's setup() also
    // checks botToken/appToken, but signingSecret would otherwise reach
    // this point and throw.
    if (!botToken || !appToken || !signingSecret) {
      const missing = [
        !botToken && "botToken",
        !appToken && "appToken",
        !signingSecret && "signingSecret",
      ].filter(Boolean).join(", ");
      this.log.warn({ missing }, "Slack adapter disabled — missing required credentials");
      return;
    }

    this.app = new App({
      token: botToken,
      appToken,
      signingSecret,
      socketMode: true,
    });

    this.webClient = new WebClient(botToken);
    this.queue = new SlackSendQueue(this.webClient);
    this.fileService = this.core.fileService;

    // Start the lazy file proxy (best-effort — must not block startup). It
    // serves binary attachments to the agent on demand; if it fails to bind a
    // port, binary attachments degrade to being skipped rather than crashing.
    try {
      this.fileProxy = new SlackFileProxy({ botToken: botToken!, log: this.log });
      await this.fileProxy.start();
    } catch (err) {
      this.log.warn({ err }, "Failed to start Slack file proxy; binary attachments will be skipped");
      this.fileProxy = undefined;
    }

    // Resolve bot user ID — required to filter bot's own messages (prevent infinite loop)
    const authResult = await this.webClient.auth.test();
    if (!authResult.user_id) {
      throw new Error("Slack auth.test() did not return user_id — verify botToken is valid");
    }
    this.botUserId = authResult.user_id as string;
    this.log.info({ botUserId: this.botUserId }, "Slack bot authenticated");

    this.channelManager = new SlackChannelManager(this.queue, this.slackConfig);

    // Permission handler — resolve permission gate when user clicks a button
    this.permissionHandler = new SlackPermissionHandler(
      this.queue,
      (requestId, optionId) => {
        for (const [sessionId, _meta] of this.sessions) {
          const session = this.core.sessionManager.getSession(sessionId);
          if (session && session.permissionGate.requestId === requestId) {
            session.permissionGate.resolve(optionId);
            this.log.info({ sessionId, requestId, optionId }, "Permission resolved");
            return;
          }
        }
        this.log.warn({ requestId, optionId }, "No matching session found for permission response");
      },
    );
    this.permissionHandler.register(this.app);

    // Register /openacp-archive — manifest (setup.ts:33) advertises this command,
    // so without a handler Slack shows users a "timeout" error.
    this.app.command("/openacp-archive", makeArchiveCommandHandler({
      findSessionByChannel: (cid) => this.findSessionByChannel(cid),
      archiveChannel: async (cid) => {
        const found = this.findSessionByChannel(cid);
        if (found) await this.deleteSessionThread(found.sessionId);
      },
      postEphemeral: async ({ channel, user, text }) => {
        await this.app.client.chat.postEphemeral({ channel, user, text });
      },
    }));

    // Register /outputmode slash command
    this.app.command("/outputmode", async ({ command, ack, client }) => {
      await ack();

      const args = command.text.trim().toLowerCase();
      const channelId = command.channel_id;

      // Inline shortcut: /outputmode low|medium|high
      if (args === "low" || args === "medium" || args === "high") {
        const found = this.findSessionByChannel(channelId);
        if (found) {
          await this.core.sessionManager.patchRecord(found.sessionId, { outputMode: args });
          const tracker = this.sessionTrackers.get(found.sessionId);
          if (tracker) tracker.setOutputMode(args as OutputMode);
        }
        await client.chat.postEphemeral({
          channel: channelId,
          user: command.user_id,
          text: `Output mode set to *${args}*`,
        });
        return;
      }

      // Open modal
      const found = this.findSessionByChannel(channelId);
      const currentMode = this.resolveOutputMode(found?.sessionId);

      const view = this.modalHandler.buildOutputModeModal(currentMode, found?.sessionId, channelId);
      await client.views.open({
        trigger_id: command.trigger_id,
        view: view as any,
      });
    });

    // Handle /outputmode modal submission
    this.app.view("output_mode_modal", async ({ ack, view, body }) => {
      await ack();
      const metadata = JSON.parse(view.private_metadata || "{}");
      const result = this.modalHandler.parseSubmission(view.state, metadata.sessionId);

      if (result.scope === "session" && result.sessionId) {
        // Session scope: update this session's record and tracker
        await this.core.sessionManager.patchRecord(result.sessionId, { outputMode: result.mode });
        const tracker = this.sessionTrackers.get(result.sessionId);
        if (tracker) tracker.setOutputMode(result.mode);
      } else {
        // Adapter scope: set in-memory default + update all existing trackers
        this.adapterDefaultOutputMode = result.mode;
        for (const tracker of this.sessionTrackers.values()) {
          tracker.setOutputMode(result.mode);
        }
        this.log.info({ mode: result.mode }, "Adapter output mode changed");
      }

      // Post ephemeral confirmation
      if (metadata.channelId) {
        const modeLabel: Record<string, string> = { low: "🔇 Low", medium: "📊 Medium", high: "🔍 High" };
        const scopeLabel = result.scope === "session" ? "this session" : "all sessions";
        try {
          await this.app.client.chat.postEphemeral({
            channel: metadata.channelId,
            user: body.user.id,
            text: `Output mode set to *${modeLabel[result.mode] ?? result.mode}* for ${scopeLabel}`,
          });
        } catch {
          // Non-critical
        }
      }
    });

    // Event router — dispatch incoming messages from session channels to core
    this.eventRouter = new SlackEventRouter(
      (slackChannelId) => {
        for (const meta of this.sessions.values()) {
          if (meta.channelId === slackChannelId && !meta.threadTs) return meta;
        }
        return undefined;
      },
      (sessionChannelSlug, text, userId, files, forwards) => {
        const meta = [...this.sessions.values()].find((m) => m.channelSlug === sessionChannelSlug);
        return this.dispatchToSession(sessionChannelSlug, text, userId, files, {
          channelId: meta?.channelId,
          threadTs: meta?.threadTs,
          forwards,
        });
      },
      this.botUserId,
      this.slackConfig.notificationChannelId,
      // onNewSession: create a new session with a private channel
      async (text, userId) => {
        try {
          const session = await this.core.handleNewSession("slack", undefined, undefined, { createThread: true });
          if (session.threadId) {
            this.log.debug({ sessionId: session.id, threadId: session.threadId }, "New session created from DM/notification");

            // Invite the user who triggered the session into the new channel
            const meta = this.sessions.get(session.id);
            if (meta && userId) {
              try {
                await this.queue.enqueue("conversations.invite", {
                  channel: meta.channelId,
                  users: userId,
                });
                // Notify user in DM with link to the new channel
                const dmRes = await this.queue.enqueue<{ channel: { id: string } }>("conversations.open", { users: userId });
                const dmChannelId = dmRes?.channel?.id;
                if (dmChannelId) {
                  await this.queue.enqueue("chat.postMessage", {
                    channel: dmChannelId,
                    text: `✅ New session started! Continue the conversation in <#${meta.channelId}>`,
                  });
                }
              } catch (inviteErr) {
                this.log.warn({ err: inviteErr, userId, channelId: meta.channelId }, "Failed to invite user to session channel");
              }

              // Forward the original message to the new session, prefixed with
              // the one-time Slack channel context header (this path bypasses
              // dispatchToSession, so the header is added here directly).
              if (text) {
                let firstText = text;
                const header = await this.buildChannelContextHeader(session.id, meta.channelId, meta.threadTs);
                if (header) firstText = `${header}\n\n${text}`;
                await this.core.handleMessage({
                  channelId: 'slack',
                  threadId: session.threadId,
                  userId: userId,
                  text: firstText,
                });
              }
            } else {
              this.log.warn({ sessionId: session.id, userId }, 'Session channel not ready yet, skipping user invite');
            }
          }
        } catch (err) {
          this.log.error({ err, userId }, "Failed to create new session");
        }
      },
      this.slackConfig,
      (channelId, threadTs) => this.hasThreadSession(channelId, threadTs),
      // onSubscriptionMessage: bind the thread to a session and dispatch
      async (channelId, threadTs, userId, text, files, opts) => {
        try {
          const { meta } = await resolveThreadSession(
            {
              sessions: this.sessions,
              getSessionByThread: (p, t) => this.core.sessionManager.getSessionByThread(p, t),
              getRecordByThread: (p, t) => this.core.sessionManager.getRecordByThread(p, t),
              handleNewSession: (p, a, w, o) => this.core.handleNewSession(p, a, w, o),
              patchRecord: (sid, patch) => this.core.sessionManager.patchRecord(sid, patch),
            },
            channelId,
            threadTs,
          );

          // When the session is started by an @mention INSIDE an existing human
          // thread, the agent has no idea what was already discussed there.
          // Fetch the full thread and prepend it as a context block so the agent
          // sees the conversation it was pulled into. The triggering message
          // (already delivered as `text`) is excluded by ts. Degrade gracefully:
          // if the fetch fails, dispatch the bare message rather than dropping it.
          let dispatchText = text;
          if (opts?.midThread) {
            try {
              const ctxBlock = await this.buildThreadContext(channelId, threadTs, opts.triggerTs);
              if (ctxBlock) dispatchText = `${ctxBlock}\n\n${text}`;
            } catch (ctxErr) {
              this.log.warn({ err: ctxErr, channelId, threadTs }, "Failed to fetch thread history for mid-thread mention; dispatching without context");
            }
          }

          await this.dispatchToSession(meta.channelSlug, dispatchText, userId, files, {
            channelId,
            threadTs,
            triggerTs: opts?.triggerTs,
            forwards: opts?.forwards,
          });
        } catch (err) {
          this.log.error({ err, channelId, threadTs }, "Failed to handle subscription message");
        }
      },
      this.log,
    );
    this.eventRouter.register(this.app);

    // Re-key pre-created channels onto the real sessionId once core emits
    // SESSION_THREAD_READY. Without this, channels created via
    // `createSessionThread("", name)` would be orphaned in the sessions Map
    // and never persist channelId — causing "No Slack channel for session"
    // after restart.
    this._threadReadyHandler = makeThreadReadyHandler({
      sessions: this.sessions,
      pendingChannelsBySlug: this._pendingChannelsBySlug,
      patchRecord: (sessionId, patch) => this.core.sessionManager.patchRecord(sessionId, patch),
      onError: (err, sessionId) => this.log.warn({ err, sessionId }, "Failed to persist Slack channelId"),
    });
    if (this.core.eventBus) {
      this.core.eventBus.on("session:threadReady", this._threadReadyHandler);
    } else {
      // Without eventBus, channels created via `createSessionThread("", ...)` never
      // get re-keyed onto the real sessionId — bug 4 silently reoccurs. Surface this
      // loudly so it's caught in dev, not in a user's session weeks later.
      this.log.warn("core.eventBus is not available — Slack sessions created via createThread:true will not persist channelId across restarts");
    }

    // Post a brief notice when /model, /mode, /bypass etc. change session
    // config. Telegram updates a pinned control card here; without that UI
    // in Slack, an inline message at least surfaces the change to the user
    // who isn't watching log output.
    this._configChangedHandler = ({ sessionId }) => {
      this.postConfigChangedNotice(sessionId).catch((err) =>
        this.log.warn({ err, sessionId }, "Failed to post config-changed notice"),
      );
    };
    this.core.eventBus?.on("session:configChanged", this._configChangedHandler);

    // Surface queue depth so users know their message is waiting behind an
    // active prompt instead of being silently buffered. Telegram does this
    // with interactive buttons (process now / clear / cancel / flush);
    // without that UX in Slack, we post a passive notice and delete it
    // when MESSAGE_PROCESSING fires.
    this._promptWaitingHandler = (data) => {
      if (data.sourceAdapterId && data.sourceAdapterId !== "slack") return;
      const queueDepth = (data as { queueDepth?: number }).queueDepth ?? 1;
      this.postWaitingNotice(data.sessionId, queueDepth).catch((err) =>
        this.log.warn({ err, sessionId: data.sessionId }, "Failed to post waiting notice"),
      );
    };
    this.core.eventBus?.on("prompt:waiting", this._promptWaitingHandler);

    this._messageProcessingHandler = (data) => {
      this.dismissWaitingNotice(data.sessionId).catch((err) =>
        this.log.warn({ err, sessionId: data.sessionId }, "Failed to dismiss waiting notice"),
      );
    };
    this.core.eventBus?.on("message:processing", this._messageProcessingHandler);

    // Start Bolt (Socket Mode)
    await this.app.start();
    this.log.info("Slack adapter started (Socket Mode)");

    // Create startup session + channel (configurable — set autoCreateSession: false to skip)
    if (this.slackConfig.autoCreateSession !== false) {
      await this._createStartupSession();
    }
  }

  private async downloadSlackFile(url: string): Promise<Buffer | null> {
    if (!isSlackFileUrl(url)) {
      this.log.warn({ url }, "Refusing to download non-Slack URL with bot token");
      return null;
    }
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.slackConfig.botToken}` },
      });
      if (!resp.ok) {
        this.log.warn({ status: resp.status }, "Failed to download Slack file");
        return null;
      }
      // Slack returns 200 with HTML login page if bot lacks files:read scope
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        this.log.warn("Slack file download returned HTML instead of binary — bot likely missing files:read scope. Reinstall the Slack app with files:read scope.");
        return null;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      this.log.error({ err }, "Error downloading Slack file");
      return null;
    }
  }

  private async uploadAudioFile(channelId: string, att: Attachment): Promise<void> {
    const fileBuffer = await fs.promises.readFile(att.filePath);
    await this.webClient.files.uploadV2({
      channel_id: channelId,
      file: fileBuffer,
      filename: att.fileName,
    });
  }

  private async _createStartupSession(): Promise<void> {
    try {
      let reuseChannelId = this.slackConfig.startupChannelId;

      // Try to reuse existing startup channel (Telegram ensureTopics pattern)
      if (reuseChannelId) {
        try {
          const info = await this.queue.enqueue<Record<string, unknown>>(
            "conversations.info", { channel: reuseChannelId },
          );
          const channel = (info as Record<string, unknown>)?.channel as Record<string, unknown> | undefined;
          if (!channel || typeof channel.is_archived !== "boolean") {
            this.log.warn({ reuseChannelId }, "Unexpected conversations.info response shape, creating new channel");
            reuseChannelId = undefined;
          } else if (channel.is_archived) {
            await this.queue.enqueue("conversations.unarchive", { channel: reuseChannelId });
            this.log.info({ channelId: reuseChannelId }, "Unarchived startup channel for reuse");
          }
        } catch {
          // Channel deleted or inaccessible — will create new
          reuseChannelId = undefined;
        }
      }

      if (reuseChannelId) {
        // Reuse existing channel — create session pointing to it
        let hasSession = false;
        for (const m of this.sessions.values()) {
          if (m.channelId === reuseChannelId) { hasSession = true; break; }
        }
        if (!hasSession) {
          const session = await this.core.handleNewSession("slack", undefined, undefined, { createThread: false });
          const slug = `startup-${session.id.slice(0, 8)}`;
          this.sessions.set(session.id, { channelId: reuseChannelId, channelSlug: slug });
          session.threadId = slug;
          // Persist both channelId and slug so the channel can be restored after restart.
          // topicId is used here (vs threadId) for backward compat with existing records.
          await this.core.sessionManager.patchRecord(session.id, {
            platform: { topicId: slug, channelId: reuseChannelId },
          });
          this.log.info({ sessionId: session.id, channelId: reuseChannelId }, "Reused startup channel");
        }
      } else {
        // Create new channel + session
        const session = await this.core.handleNewSession("slack", undefined, undefined, { createThread: true });
        if (!session.threadId) {
          this.log.error({ sessionId: session.id }, "Startup session created without threadId");
          return;
        }

        // Persist channel ID via plugin settings so the next restart reuses
        // this channel instead of creating a fresh one (which would orphan
        // the previous channel and lose history).
        const meta = this.sessions.get(session.id);
        if (meta) {
          this.slackConfig.startupChannelId = meta.channelId;
          if (this.settingsAPI) {
            await this.settingsAPI.set('startupChannelId', meta.channelId).catch((err) => {
              this.log.warn({ err, sessionId: session.id }, 'Failed to persist startupChannelId — next restart will create another channel');
            });
            this.log.info({ sessionId: session.id, channelId: meta.channelId }, "Startup channel created and persisted");
          } else {
            this.log.info({ sessionId: session.id, channelId: meta.channelId }, "Startup channel created (not persisted — settingsAPI missing)");
          }
        }
      }

      // Notify
      if (this.slackConfig.notificationChannelId) {
        const startupMeta = [...this.sessions.values()].find(m =>
          m.channelId === (reuseChannelId ?? this.slackConfig.startupChannelId)
        );
        if (startupMeta) {
          await this.queue.enqueue("chat.postMessage", {
            channel: this.slackConfig.notificationChannelId,
            text: `\u2705 OpenACP ready \u2014 chat with the agent in <#${startupMeta.channelId}>`,
          });
        }
      }
    } catch (err) {
      this.log.error({ err }, "Failed to create/reuse Slack startup session");
    }
  }

  async stop(): Promise<void> {
    if (this._threadReadyHandler) {
      this.core.eventBus?.off("session:threadReady", this._threadReadyHandler);
      this._threadReadyHandler = undefined;
    }
    if (this._configChangedHandler) {
      this.core.eventBus?.off("session:configChanged", this._configChangedHandler);
      this._configChangedHandler = undefined;
    }
    if (this._promptWaitingHandler) {
      this.core.eventBus?.off("prompt:waiting", this._promptWaitingHandler);
      this._promptWaitingHandler = undefined;
    }
    if (this._messageProcessingHandler) {
      this.core.eventBus?.off("message:processing", this._messageProcessingHandler);
      this._messageProcessingHandler = undefined;
    }
    // Cleanup all activity trackers
    for (const [sessionId, tracker] of this.sessionTrackers) {
      try {
        await tracker.finalize();
        tracker.destroy();
      } catch (err) {
        this.log.warn({ err, sessionId }, "Tracker cleanup failed during stop");
      }
    }
    this.sessionTrackers.clear();

    // Flush all active text buffers before stopping to prevent data loss
    for (const [sessionId, buf] of this.textBuffers) {
      try {
        await buf.flush();
      } catch (err) {
        this.log.warn({ err, sessionId }, "Flush failed during stop");
      }
      buf.destroy();
    }
    this.textBuffers.clear();
    await this.fileProxy?.stop().catch((err) => this.log.warn({ err }, "Error stopping Slack file proxy"));
    this.fileProxy = undefined;
    // Guard for the graceful-degradation path: if start() returned early
    // because credentials were missing, this.app was never assigned.
    if (this.app) await this.app.stop();
    this.log.info("Slack adapter stopped");
  }

  // --- MessagingAdapter implementations ---

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    if (sessionId) this.getTracer(sessionId)?.log("slack", { action: "thread:create", sessionId, name });
    const meta = await this.channelManager.createChannel(sessionId, name);

    if (sessionId) {
      // Direct caller knew the sessionId — register and persist immediately.
      // The startup reuse path bypasses this method (createThread:false), so this
      // branch is reserved for any future caller that already has session.id.
      this.sessions.set(sessionId, meta);
      await this.core.sessionManager.patchRecord(sessionId, {
        platform: { channelId: meta.channelId, threadId: meta.channelSlug },
      });
    } else {
      // Core invokes us with sessionId="" before session.id is assigned. Stash
      // the meta by slug; SESSION_THREAD_READY will re-key it once the real
      // sessionId is known, and patchRecord then persists channelId.
      this._pendingChannelsBySlug.set(meta.channelSlug, meta);
    }

    this.log.info({ sessionId, channelId: meta.channelId, slug: meta.channelSlug }, "Session channel created");
    // Return the slug as the threadId so that lookups via getSessionByThread work
    return meta.channelSlug;
  }

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    // Thread-bound sessions (subscribed channels and DMs) live inside a shared
    // conversation we don't own — renaming it is wrong (and Slack rejects
    // `conversations.rename` on a DM with `not_authorized`). The thread itself
    // carries the session identity, so there is nothing to rename.
    if (meta.threadTs) return;

    const newSlug = toSlug(newName, this.slackConfig.channelPrefix ?? "openacp");

    try {
      await this.queue.enqueue("conversations.rename", {
        channel: meta.channelId,
        name: newSlug,
      });
      meta.channelSlug = newSlug;
      // Update session.threadId so getSessionByThread() keeps working after rename
      const session = this.core.sessionManager.getSession(sessionId);
      if (session) session.threadId = newSlug;
      const existingRecord = this.core.sessionManager.getSessionRecord(sessionId);
      await this.core.sessionManager.patchRecord(sessionId, {
        name: newName,
        platform: { ...(existingRecord?.platform ?? {}), topicId: newSlug },
      });
      this.log.info({ sessionId, newSlug }, "Session channel renamed");
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to rename Slack channel");
    }
  }

  async deleteSessionThread(sessionId: string): Promise<void> {
    this.getTracer(sessionId)?.log("slack", { action: "thread:delete", sessionId });
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    try {
      if (meta.threadTs) {
        const sess = this.core.sessionManager.getSession(sessionId);
        const requestId = sess?.permissionGate?.requestId;
        if (requestId) await this.permissionHandler.cleanupRequest(requestId);
      } else {
        await this.permissionHandler.cleanupSession(meta.channelId);
      }
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to clean up permission buttons");
    }

    if (meta.threadTs) {
      // Thread-bound session (subscribed channel or DM): the channel is a real,
      // shared conversation — never archive it. Only in-memory state is torn
      // down below.
      this.log.info({ sessionId, channelId: meta.channelId }, "Thread session ended (channel preserved)");
    } else {
      try {
        await this.channelManager.archiveChannel(meta.channelId);
        this.log.info({ sessionId, channelId: meta.channelId }, "Session channel archived");
      } catch (err) {
        this.log.warn({ err, sessionId }, "Failed to archive Slack channel");
      }
    }
    this.sessions.delete(sessionId);
    const buf = this.textBuffers.get(sessionId);
    if (buf) { buf.destroy(); this.textBuffers.delete(sessionId); }
    // Clean all per-session Maps to prevent unbounded memory growth
    this._dispatchQueues.delete(sessionId);
    this._skillCommandsTs.delete(sessionId);
    this._pendingSkillCommands.delete(sessionId);
    this._lastUsageTs.delete(sessionId);
    this._waitingNoticeTs.delete(sessionId);
    this._channelCtxInjected.delete(sessionId);
    this.surfacedFiles.delete(meta.channelSlug);
  }

  /**
   * Try to dispatch a /command via CommandRegistry. Returns true if handled.
   */
  private async tryCommandDispatch(sessionChannelSlug: string, text: string, userId: string): Promise<boolean> {
    const registry = (this.core as any).lifecycleManager?.serviceRegistry?.get("command-registry");
    if (!registry) return false;

    const spaceIdx = text.indexOf(" ");
    const rawCommand = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    const commandName = rawCommand.toLowerCase();
    const rawArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);

    const def = registry.get(commandName);
    if (!def) return false; // not a registered command, let agent handle it

    let sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id ?? null;
    let meta = sessionId ? this.getSessionMeta(sessionId) : undefined;
    // Subscription sessions register their meta in this.sessions (keyed by the
    // resolved session id) before the agent is live. Fall back to that map by
    // slug so a /command as the first post-restart reply still resolves its
    // session and threads its response correctly.
    if (!meta) {
      for (const [sid, m] of this.sessions) {
        if (m.channelSlug === sessionChannelSlug) {
          sessionId = sid;
          meta = m;
          break;
        }
      }
    }
    const channelId = meta?.channelId;

    try {
      const response = await registry.execute(text.slice(1), {
        raw: rawArgs,
        sessionId,
        channelId: "slack",
        userId,
      });

      // silent/delegated — handled, no message needed
      if (!response || response.type === "silent" || response.type === "delegated") return true;

      // Render response as Slack message
      if (channelId) {
        let replyText = "";
        let replyBlocks: unknown[] | undefined;
        if (response.type === "text") {
          replyText = response.text;
        } else if (response.type === "adaptive") {
          const variant = response.variants?.['slack'] as
            | { text?: string; blocks?: unknown[] }
            | undefined;
          replyText = variant?.text ?? response.fallback;
          replyBlocks = variant?.blocks;
        } else if (response.type === "error") {
          replyText = `⚠️ ${response.message}`;
        } else if (response.type === "menu") {
          const lines = [response.title];
          for (const opt of response.options) {
            lines.push(`• ${opt.label}${opt.hint ? ` — ${opt.hint}` : ""}`);
            lines.push(`  → Type \`${opt.command}\``);
          }
          replyText = lines.join("\n");
        } else if (response.type === "list") {
          const items = response.items.map((i: { label: string; detail?: string }) =>
            `• ${i.label}${i.detail ? ` — ${i.detail}` : ""}`
          );
          replyText = `${response.title}\n${items.join("\n")}`;
        } else if (response.type === "confirm") {
          replyText = `${response.question}\nType \`${response.onYes}\` to confirm or \`${response.onNo}\` to cancel.`;
        }

        if (replyText || replyBlocks) {
          await this.queue.enqueue("chat.postMessage", {
            channel: channelId,
            ...(meta ? this.threadParams(meta) : {}),
            text: replyText,
            ...(replyBlocks && { blocks: replyBlocks }),
          });
        }
      }
      return true;
    } catch (err) {
      this.log.error({ err, command: commandName }, "Command dispatch failed");
      if (channelId) {
        await this.queue.enqueue("chat.postMessage", {
          channel: channelId,
          ...(meta ? this.threadParams(meta) : {}),
          text: `⚠️ Command failed: ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => {});
      }
      return true; // handled (with error) — don't forward to agent
    }
  }

  /**
   * Return the agent's debugTracer for this session, if one exists.
   * Bug reports include per-event traces when the user enables debug mode;
   * without this hook, Slack-side dispatch is invisible to that audit trail.
   */
  private getTracer(sessionId: string): { log(adapter: string, payload: Record<string, unknown>): void } | null {
    const session = this.core.sessionManager.getSession(sessionId) as unknown as { agentInstance?: { debugTracer?: { log(a: string, p: Record<string, unknown>): void } } } | undefined;
    return session?.agentInstance?.debugTracer ?? null;
  }

  private getSessionMeta(sessionId: string): SlackSessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  /** Spread into chat.postMessage params to thread output for subscription sessions. */
  private threadParams(meta: SlackSessionMeta): { thread_ts?: string } {
    return meta.threadTs ? { thread_ts: meta.threadTs } : {};
  }

  private getTextBuffer(sessionId: string, channelId: string, threadTs?: string): SlackTextBuffer {
    let buf = this.textBuffers.get(sessionId);
    if (!buf) {
      buf = new SlackTextBuffer(channelId, threadTs, sessionId, this.queue, this.log);
      this.textBuffers.set(sessionId, buf);
    }
    return buf;
  }

  private resolveOutputMode(sessionId?: string): OutputMode {
    // 1. Session record (most specific — set via patchRecord)
    if (sessionId) {
      const record = this.core.sessionManager.getSessionRecord(sessionId) as any;
      const sessionMode = record?.outputMode as OutputMode | undefined;
      if (sessionMode) return sessionMode;
    }
    // 2. Adapter default (in-memory, set by /outputmode with scope=adapter)
    if (this.adapterDefaultOutputMode) return this.adapterDefaultOutputMode;
    // 3. Global config (no session context)
    return this.outputModeResolver.resolve(this.core.configManager as any, "slack");
  }

  private getOrCreateTracker(sessionId: string, channelId: string): SlackActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    const mode = this.resolveOutputMode(sessionId);
    if (!tracker) {
      const tunnelService = this.core.lifecycleManager?.serviceRegistry?.get("tunnel") as TunnelServiceInterface | undefined;
      const session = this.core.sessionManager.getSession(sessionId);
      const sessionContext = session?.workingDirectory
        ? { id: sessionId, workingDirectory: session.workingDirectory }
        : undefined;
      tracker = new SlackActivityTracker({
        channelId,
        sessionId,
        queue: this.queue,
        outputMode: mode,
        tunnelService,
        sessionContext,
        threadTs: this.getSessionMeta(sessionId)?.threadTs,
      });
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(mode);
    }
    return tracker;
  }

  private findSessionByChannel(channelId: string): { sessionId: string; meta: SlackSessionMeta } | undefined {
    for (const [sessionId, meta] of this.sessions) {
      if (meta.channelId === channelId) {
        return { sessionId, meta };
      }
    }
    return undefined;
  }

  /** True if a session already owns (channelId, threadTs) — in memory, live, or persisted. */
  private hasThreadSession(channelId: string, threadTs: string): boolean {
    for (const meta of this.sessions.values()) {
      if (meta.channelId === channelId && meta.threadTs === threadTs) return true;
    }
    const key = `${channelId}:${threadTs}`;
    if (this.core.sessionManager.getSessionByThread("slack", key)) return true;
    return !!this.core.sessionManager.getRecordByThread("slack", key);
  }

  /**
   * Attempt to restore a session's Slack channel metadata from the persisted session record.
   *
   * Called when a session is not in the in-memory `this.sessions` Map, which happens
   * after a process restart when lazy resume re-creates the session without calling
   * createSessionThread(). Without this, all agent responses are silently dropped.
   */
  private async tryRestoreSessionFromRecord(sessionId: string): Promise<void> {
    const record = this.core.sessionManager.getSessionRecord(sessionId) as any;
    const channelId = record?.platform?.channelId as string | undefined;
    // Startup reuse sessions use topicId; normal sessions use threadId
    const channelSlug = (record?.platform?.threadId ?? record?.platform?.topicId) as string | undefined;
    const threadTs = record?.platform?.threadTs as string | undefined;
    if (!channelId || !channelSlug) return;

    try {
      const info = await this.queue.enqueue<{ channel: { is_archived: boolean } }>(
        "conversations.info",
        { channel: channelId },
      );
      if (info?.channel?.is_archived) {
        await this.queue.enqueue("conversations.unarchive", { channel: channelId });
      }
      this.sessions.set(sessionId, { channelId, channelSlug, threadTs });
      this.log.info({ sessionId, channelId, channelSlug }, "Restored session channel from record after restart");
    } catch (err) {
      this.log.warn({ err, sessionId, channelId }, "Failed to restore session channel — channel may be deleted");
    }
  }

  /**
   * Thin instance wrapper over {@link fetchThreadContext}, binding it to this
   * adapter's send queue and logger. See that function for the pagination and
   * graceful-degradation contract.
   */
  private buildThreadContext(
    channelId: string,
    threadTs: string,
    triggerTs?: string,
  ): Promise<string> {
    return fetchThreadContext(
      (method, params) => this.queue.enqueue(method, params),
      this.log,
      channelId,
      threadTs,
      triggerTs,
    );
  }

  /**
   * Resolve a human-friendly label for a Slack channel ("#general"), cached.
   * DMs (`D…`) have no name, so they render as "a direct message". On lookup
   * failure we fall back to the raw id rather than throwing — a missing name
   * must never block message dispatch.
   */
  private async resolveChannelLabel(channelId: string): Promise<string> {
    if (channelId.startsWith("D")) return "a direct message";
    const cached = this._channelNameCache.get(channelId);
    if (cached) return cached;
    try {
      const info = await this.queue.enqueue<{ channel?: { name?: string } }>(
        "conversations.info",
        { channel: channelId },
      );
      const name = info?.channel?.name;
      const label = name ? `#${name}` : channelId;
      this._channelNameCache.set(channelId, label);
      return label;
    } catch (err) {
      this.log.warn({ err, channelId }, "Failed to resolve channel name for context header");
      return channelId;
    }
  }

  /**
   * Build the one-time-per-session Slack context header (see
   * {@link renderChannelContext}). Returns "" if this session has already been
   * given the header — the agent retains it in its conversation history, so it
   * only needs telling once. The in-memory injected-set resets on restart, so a
   * resumed session is harmlessly reminded of its channel on its next message.
   */
  private async buildChannelContextHeader(
    sessionId: string,
    channelId: string,
    threadTs?: string,
  ): Promise<string> {
    if (this._channelCtxInjected.has(sessionId)) return "";
    const label = await this.resolveChannelLabel(channelId);
    this._channelCtxInjected.add(sessionId);
    return renderChannelContext(label, channelId, threadTs);
  }

  /**
   * Forward a user message to core for an existing session, identified by its
   * threadId slug. Handles /command interception, the one-time Slack channel
   * context header, and attachment collection (trigger files, thread-history
   * files, and forwarded messages) via the file proxy / inline payload builder.
   * Shared by the legacy event-router path and the channel-subscription path.
   */
  private async dispatchToSession(
    sessionChannelSlug: string,
    text: string,
    userId: string,
    files?: SlackFileInfo[],
    extras?: { channelId?: string; threadTs?: string; triggerTs?: string; forwards?: ForwardedMessage[] },
  ): Promise<void> {
    if (text.startsWith("/")) {
      const handled = await this.tryCommandDispatch(sessionChannelSlug, text, userId);
      if (handled) return;
    }

    let dispatchText = text;
    let attachments: Attachment[] | undefined;

    try {
      const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
      if (sessionId && this.fileProxy) {
        let threadMessages: ThreadContextMessage[] | undefined;
        if (this.slackConfig.readThreadHistory !== false && extras?.channelId && extras?.threadTs) {
          try {
            threadMessages = await fetchThreadMessages(
              (method: any, params: any) => this.queue.enqueue(method, params),
              this.log, extras.channelId, extras.threadTs,
            );
          } catch (err) {
            this.log.warn({ err }, "Failed to fetch thread history for attachments; using triggering message only");
          }
        }

        const seen = this.surfacedFiles.get(sessionChannelSlug) ?? new Set<string>();
        const { attachments: collected, forwardedTexts } = collectAttachments({
          triggerFiles: files,
          threadMessages,
          forwards: extras?.forwards,
          seen,
        });

        const payload = await buildAttachmentPayload({
          sessionId,
          inlineMaxBytes: this.slackConfig.attachmentInlineMaxBytes ?? 16384,
          collected,
          forwardedTexts,
          download: (url) => this.downloadSlackFile(url),
          saveFile: (sid, name, buf, mime) => this.fileService.saveFile(sid, name, buf, mime),
          registerProxy: (f) => this.fileProxy!.register({ url_private: f.url_private, mimetype: f.mimetype, name: f.name }),
          log: this.log,
        });

        for (const id of payload.surfacedIds) seen.add(id);
        this.surfacedFiles.set(sessionChannelSlug, seen);

        if (payload.promptAdditions) dispatchText = `${text}\n\n${payload.promptAdditions}`;
        if (payload.attachments.length) attachments = payload.attachments;
      }
    } catch (err) {
      this.log.error({ err }, "Failed to process attachments; dispatching message text only");
    }

    // Prepend the one-time Slack channel context header so the agent knows which
    // channel/thread it is in. Resolve the session via the thread index, falling
    // back to a scan of in-memory metas (newly created `createThread: false`
    // sessions are registered there before they appear in the thread index).
    let headerSessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
    if (!headerSessionId) {
      for (const [sid, m] of this.sessions) {
        if (m.channelSlug === sessionChannelSlug) { headerSessionId = sid; break; }
      }
    }
    if (headerSessionId) {
      const meta = this.sessions.get(headerSessionId);
      if (meta?.channelId) {
        const header = await this.buildChannelContextHeader(headerSessionId, meta.channelId, meta.threadTs);
        if (header) dispatchText = `${header}\n\n${dispatchText}`;
      }
    }

    await this.core
      .handleMessage({ channelId: "slack", threadId: sessionChannelSlug, userId, text: dispatchText, attachments })
      .catch((err) => this.log.error({ err }, "handleMessage error"));
  }

  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    this.getTracer(sessionId)?.log("slack", { action: "dispatch:enter", sessionId, type: content.type });
    if (!this.sessions.has(sessionId)) {
      // On restart, this.sessions is cleared. Lazy resume does not call
      // createSessionThread(), so we self-heal by restoring from the persisted record.
      await this.tryRestoreSessionFromRecord(sessionId);

      if (!this.sessions.has(sessionId)) {
        this.log.warn({ sessionId }, "No Slack channel for session, skipping message");
        this.getTracer(sessionId)?.log("slack", { action: "dispatch:dropped", sessionId, reason: "no-channel" });
        return;
      }
    }
    // Serialize per session — SessionBridge fires sendMessage() fire-and-forget so
    // concurrent events (tool_call, tool_update, text) can race without this queue.
    const prev = this._dispatchQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => super.sendMessage(sessionId, content))
      .catch((err) => { this.log.warn({ err, sessionId }, "Dispatch queue error"); });
    this._dispatchQueues.set(sessionId, next);
    await next;
  }

  // --- Handler overrides (dispatched by base class) ---

  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    this.getTracer(sessionId)?.log("slack", { action: "handle:text", sessionId, len: content.text?.length ?? 0 });
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;

    // Seal tool card on first text chunk without marking the turn complete.
    // finalize() is called later in handleSessionEnd when the turn truly ends.
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) await tracker.onTextStart();

    const buf = this.getTextBuffer(sessionId, meta.channelId, meta.threadTs);
    buf.append(content.text ?? "");
  }

  protected async handleSessionEnd(sessionId: string, content: OutgoingMessage): Promise<void> {
    this.getTracer(sessionId)?.log("slack", { action: "handle:sessionEnd", sessionId });
    // Cleanup tracker
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      await tracker.finalize();
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }
    // No more events expected after session end — drop the queue entry
    this._dispatchQueues.delete(sessionId);

    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    await this.flushTextBuffer(sessionId);

    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }

  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    // Finalize then destroy tracker — ensures the Slack message gets a final update
    // before we tear down, matching the same finalize→destroy pattern in handleSessionEnd.
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      await tracker.finalize();
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }
    // Drop the dispatch queue entry — no more events expected after an error
    this._dispatchQueues.delete(sessionId);

    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    await this.flushTextBuffer(sessionId);

    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }

  protected async handleAttachment(sessionId: string, content: OutgoingMessage): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta || !content.attachment) return;

    // Slack files.uploadV2 caps at 1GB but workspace bots typically run at
    // 50MB or lower. Reject early with a friendly message; uploading anything
    // larger usually fails opaquely with `request_entity_too_large`.
    const MAX_BYTES = 50 * 1024 * 1024;
    if (content.attachment.size > MAX_BYTES) {
      const mb = (content.attachment.size / 1024 / 1024).toFixed(1);
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: `⚠️ File too large for Slack (${mb}MB > 50MB limit): \`${content.attachment.fileName}\``,
      }).catch((err) => this.log.warn({ err, sessionId }, "Failed to post size-limit notice"));
      return;
    }

    if (content.attachment.type === "audio") {
      try {
        await this.uploadAudioFile(meta.channelId, content.attachment);
        const buf = this.textBuffers.get(sessionId);
        if (buf) await buf.stripTtsBlock();
      } catch (err) {
        this.log.error({ err, sessionId }, "Failed to upload audio to Slack");
      }
    }
  }

  protected async handleThought(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    if (!tracker.getTurn()) await tracker.onNewPrompt();
    await tracker.onThought(content.text ?? "");
  }

  protected async handleToolCall(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const m = (content.metadata ?? {}) as Partial<ToolCallMeta>;
    this.getTracer(sessionId)?.log("slack", { action: "handle:toolCall", sessionId, toolId: m.id, toolName: m.name, kind: m.kind, status: m.status });
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);

    // Flush text buffer before tool card
    const buf = this.textBuffers.get(sessionId);
    if (buf) await buf.flush();

    // Ensure turn exists
    if (!tracker.getTurn()) await tracker.onNewPrompt();

    await tracker.onToolCall(
      { id: m.id ?? "", name: m.name ?? "unknown", kind: m.kind, status: m.status, rawInput: m.rawInput, viewerLinks: m.viewerLinks },
      String(m.kind ?? ""),
      m.rawInput,
    );
  }

  protected async handleToolUpdate(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    const m = (content.metadata ?? {}) as Partial<ToolUpdateMeta>;

    await tracker.onToolUpdate(
      m.id ?? "",
      m.status ?? "completed",
      m.viewerLinks as ViewerLinks | undefined,
      (m as any).viewerFilePath as string | undefined,
      typeof m.content === "string" ? m.content : null,
      m.rawInput ?? undefined,
      (m as any).diffStats as { added: number; removed: number } | undefined,
    );
  }

  protected async handlePlan(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    if (!tracker.getTurn()) await tracker.onNewPrompt();
    const entries = (content.metadata as any)?.planEntries ?? [];
    await tracker.onPlan(entries);
  }

  protected async handleUsage(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);
    const m = content.metadata as any;
    const tokens = m?.tokensUsed ?? m?.tokens;
    const contextSize = m?.contextSize;
    const cost = m?.cost;
    await tracker.onUsage({ tokensUsed: tokens, contextSize, cost });

    // In-thread usage line: post once per turn, edit subsequent updates in
    // place. Telegram does the same via formatUsage / message replace pattern.
    const parts: string[] = [];
    if (typeof tokens === "number") parts.push(`*${formatTokens(tokens)}* tokens`);
    if (typeof contextSize === "number") parts.push(`ctx \`${formatTokens(contextSize)}\``);
    if (typeof cost === "number") parts.push(`$${cost.toFixed(4)}`);
    if (parts.length > 0) {
      const text = `📊 ${parts.join(" · ")}`;
      const existingTs = this._lastUsageTs.get(sessionId);
      try {
        if (existingTs) {
          await this.queue.enqueue("chat.update", {
            channel: meta.channelId,
            ts: existingTs,
            text,
          });
        } else {
          const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
            channel: meta.channelId,
            ...this.threadParams(meta),
            text,
          });
          if (result?.ts) this._lastUsageTs.set(sessionId, result.ts);
        }
      } catch (err) {
        // If edit fails (message gone), clear the cached ts so the next event
        // posts a fresh one instead of looping on the same failure.
        this._lastUsageTs.delete(sessionId);
        this.log.warn({ err, sessionId }, "Failed to post/update usage line");
      }
    }

    // Post inline completion notification with direct channel link
    if (this.slackConfig.notificationChannelId) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name ?? "Session";
      await this.queue.enqueue("chat.postMessage", {
        channel: this.slackConfig.notificationChannelId,
        text: `✅ *${name}* — Task completed. <#${meta.channelId}>`,
      }).catch((err) => this.log.warn({ err, sessionId }, "Failed to post completion notification"));
    }
  }

  protected async handleSystem(sessionId: string, content: OutgoingMessage): Promise<void> {
    await this.postFormattedMessage(sessionId, content);
  }

  // --- Private helpers ---

  private async flushTextBuffer(sessionId: string): Promise<void> {
    const buf = this.textBuffers.get(sessionId);
    if (buf) {
      try {
        await buf.flush();
      } catch (err) {
        this.log.warn({ err, sessionId }, "Flush failed on session_end");
      }
      buf.destroy();
      this.textBuffers.delete(sessionId);
    }
  }

  private async postFormattedMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const blocks = this.formatter.formatOutgoing(content);
    if (blocks.length === 0) return;

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: content.text ?? content.type,
        blocks,
      });
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
  }

  /**
   * Post an inline notice when session config (model/mode/bypass) changes.
   * Best-effort: caller swallows errors. Skipped if the session is unknown
   * or its channel isn't in our map.
   */
  private async postConfigChangedNotice(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    const session = this.core.sessionManager.getSession(sessionId);
    if (!session) return;

    const bits: string[] = [];
    if (session.currentModel) bits.push(`model: \`${session.currentModel}\``);
    if (session.currentMode) bits.push(`mode: \`${session.currentMode}\``);
    if (session.dangerousMode) bits.push("bypass: *on*");

    const summary = bits.length > 0
      ? `⚙️ Session settings updated — ${bits.join(", ")}`
      : "⚙️ Session settings updated";

    await this.queue.enqueue("chat.postMessage", {
      channel: meta.channelId,
      ...this.threadParams(meta),
      text: summary,
    });
  }

  /**
   * Post a "message queued" notice when a prompt is enqueued behind an
   * active one. Stash the ts so we can delete it when MESSAGE_PROCESSING
   * fires for the same session. Best-effort.
   */
  private async postWaitingNotice(sessionId: string, position: number): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    // If we already posted a notice for an earlier queued message, leave it
    // — the new one would just duplicate the same UX.
    if (this._waitingNoticeTs.has(sessionId)) return;

    const text = `📋 Message queued (#${position} in line). Agent is processing the previous prompt.`;
    const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
      channel: meta.channelId,
      ...this.threadParams(meta),
      text,
    });
    if (result?.ts) this._waitingNoticeTs.set(sessionId, result.ts);
  }

  /**
   * Delete the "queued" notice once the queued message starts processing.
   * Telegram does the same via deleteMessage on MESSAGE_PROCESSING.
   */
  private async dismissWaitingNotice(sessionId: string): Promise<void> {
    const ts = this._waitingNoticeTs.get(sessionId);
    if (!ts) return;
    const meta = this.sessions.get(sessionId);
    if (!meta) {
      this._waitingNoticeTs.delete(sessionId);
      return;
    }
    this._waitingNoticeTs.delete(sessionId);
    await this.queue.enqueue("chat.delete", {
      channel: meta.channelId,
      ts,
    }).catch((err) => this.log.warn({ err, sessionId, ts }, "Failed to delete waiting notice"));
  }

  private formatSkillCommands(commands: AgentCommand[]): string {
    if (commands.length === 0) return "_No commands available_";
    const lines = ["*Available commands:*"];
    for (const cmd of commands) {
      const hint = (cmd as { description?: string }).description
        ? ` — ${(cmd as { description?: string }).description}`
        : "";
      lines.push(`• \`/${cmd.name}\`${hint}`);
    }
    let text = lines.join("\n");
    // Slack section blocks cap at 3000 chars — a longer text rejects the whole
    // message with invalid_blocks. Truncate at a line boundary.
    if (text.length > 3000) {
      const cut = text.slice(0, 2980);
      text = `${cut.slice(0, cut.lastIndexOf("\n"))}\n_… list truncated_`;
    }
    return text;
  }

  // NOTE: Async flow — different from Telegram adapter.
  // Telegram: sendPermissionRequest awaits user response inline.
  // Slack: posts interactive buttons and returns immediately.
  // Resolution happens asynchronously via the Bolt action handler in
  // SlackPermissionHandler, which calls the PermissionResponseCallback
  // passed during construction. The callback iterates sessions to find
  // the matching permissionGate and resolves it.
  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    this.getTracer(sessionId)?.log("slack", { action: "permission:send", sessionId, requestId: request.id });
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    this.log.info({ sessionId, requestId: request.id }, "Sending Slack permission request");
    const blocks = this.formatter.formatPermissionRequest(request);

    try {
      const result = await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: `Permission request: ${request.description}`,
        blocks,
      });
      const ts = (result as { ts?: string })?.ts;
      if (ts) {
        this.permissionHandler.trackPendingMessage(request.id, meta.channelId, ts, request.options);
      }
    } catch (err) {
      this.log.error({ err, sessionId }, "Failed to post Slack permission request");
    }

    // Also ping the notification channel so users see permission prompts even
    // when they're not actively watching this session's channel. Best-effort:
    // a failure here must not break the underlying permission flow.
    if (this.slackConfig.notificationChannelId) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name ?? "Session";
      this.queue.enqueue("chat.postMessage", {
        channel: this.slackConfig.notificationChannelId,
        text: `🔐 *${name}* — Permission needed. <#${meta.channelId}>`,
      }).catch((err) => this.log.warn({ err, sessionId }, "Failed to post permission notification"));
    }
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    if (!this.slackConfig.notificationChannelId) return;

    const emoji: Record<string, string> = {
      completed: "\u2705",
      error: "\u274C",
      permission: "\u{1F510}",
      input_required: "\u{1F4AC}",
    };
    const icon = emoji[notification.type] ?? "\u2139\uFE0F";
    const text = `${icon} *${notification.sessionName ?? "Session"}*\n${notification.summary}`;
    const blocks = this.formatter.formatNotification(text);

    try {
      await this.queue.enqueue("chat.postMessage", {
        channel: this.slackConfig.notificationChannelId,
        text,
        blocks,
      });
    } catch (err) {
      this.log.warn({ err, sessionId: notification.sessionId }, "Failed to send Slack notification");
    }
  }

  /**
   * Remove [TTS]...[/TTS] blocks from the text buffer for a session.
   * Called by SessionBridge on tts_strip events — fires independently of the
   * attachment upload, so this handles the case where tts_strip arrives before
   * or separately from handleAttachment.
   */
  async stripTTSBlock(sessionId: string): Promise<void> {
    const buf = this.textBuffers.get(sessionId);
    if (buf) await buf.stripTtsBlock();
  }

  /**
   * Post or update the skill commands card in the session channel.
   * If the session channel is not yet ready, queues for later flush.
   */
  async sendSkillCommands(sessionId: string, commands: AgentCommand[]): Promise<void> {
    // Only surface the "Available commands" card at high verbosity. In low /
    // medium output modes it's noise, so skip posting to Slack entirely.
    if (this.resolveOutputMode(sessionId) !== "high") {
      this._pendingSkillCommands.delete(sessionId);
      return;
    }

    const meta = this.sessions.get(sessionId);
    if (!meta) {
      // Channel not ready yet — queue and flush in flushPendingSkillCommands()
      this._pendingSkillCommands.set(sessionId, commands);
      return;
    }

    const text = this.formatSkillCommands(commands);
    // Hydrate from the persisted record on first call after restart so we
    // update the existing card instead of posting a duplicate.
    if (!this._skillCommandsTs.has(sessionId)) {
      const persisted = (this.core.sessionManager.getSessionRecord(sessionId) as any)
        ?.platform?.skillMsgTs as string | undefined;
      if (persisted) this._skillCommandsTs.set(sessionId, persisted);
    }
    const existingTs = this._skillCommandsTs.get(sessionId);

    try {
      if (existingTs) {
        await this.queue.enqueue("chat.update", {
          channel: meta.channelId,
          ts: existingTs,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
      } else {
        const result = await this.queue.enqueue<{ ts?: string }>("chat.postMessage", {
          channel: meta.channelId,
          ...this.threadParams(meta),
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
        });
        if (result?.ts) {
          this._skillCommandsTs.set(sessionId, result.ts);
          // Persist so the next restart finds it and updates the same card.
          const existingRecord = this.core.sessionManager.getSessionRecord(sessionId);
          this.core.sessionManager.patchRecord(sessionId, {
            platform: { ...(existingRecord?.platform ?? {}), skillMsgTs: result.ts },
          }).catch((err) => this.log.warn({ err, sessionId }, "Failed to persist skillMsgTs"));
        }
      }
    } catch (err) {
      // If the card was deleted by the user (or otherwise lost), chat.update
      // fails with `message_not_found`. Clear the stale ts so the next call
      // posts a fresh card instead of looping on the same failure.
      this._skillCommandsTs.delete(sessionId);
      this.log.warn({ err, sessionId }, "Failed to post/update skill commands — cleared stale ts");
    }
  }

  /**
   * Update the skill commands card to "Session ended" and clear all tracking.
   * Called by SessionBridge on session_end and error events.
   */
  async cleanupSkillCommands(sessionId: string): Promise<void> {
    this._pendingSkillCommands.delete(sessionId);

    const ts = this._skillCommandsTs.get(sessionId);
    const meta = this.sessions.get(sessionId);
    if (ts && meta) {
      try {
        await this.queue.enqueue("chat.update", {
          channel: meta.channelId,
          ts,
          text: "_Session ended_",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Session ended_" } }],
        });
      } catch (err) {
        this.log.warn({ err, sessionId }, "Failed to cleanup skill commands card");
      }
    }

    this._skillCommandsTs.delete(sessionId);
  }

  /**
   * Flush any skill commands that were queued before the session channel was ready.
   * Called after createSessionThread() makes the channel available.
   */
  async flushPendingSkillCommands(sessionId: string): Promise<void> {
    const commands = this._pendingSkillCommands.get(sessionId);
    if (!commands) return;
    this._pendingSkillCommands.delete(sessionId);
    await this.sendSkillCommands(sessionId, commands);
  }

  /**
   * Clean up all adapter-side state for a session.
   *
   * Called when switching agents so the new agent starts from a clean slate.
   * Destroys the activity tracker, flushes and destroys the text buffer, and
   * clears pending skill commands.
   */
  async cleanupSessionState(sessionId: string): Promise<void> {
    this._pendingSkillCommands.delete(sessionId);
    this._dispatchQueues.delete(sessionId);

    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }

    await this.flushTextBuffer(sessionId);
  }
}

export type { SlackChannelConfig } from "./types.js";
