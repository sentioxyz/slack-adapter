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
import type { SlackSessionMeta, SlackFileInfo } from "./types.js";
import { SlackSendQueue } from "./send-queue.js";
import { SlackFormatter } from "./formatter.js";
import { SlackChannelManager } from "./channel-manager.js";
import { SlackPermissionHandler } from "./permission-handler.js";
import { SlackModalHandler } from "./modal-handler.js";
import { SlackEventRouter } from "./event-router.js";
import { SlackTextBuffer } from "./text-buffer.js";
import { SlackActivityTracker } from "./activity-tracker.js";
import { toSlug } from "./slug.js";
import { isAudioClip } from "./utils.js";

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
    getSessionRecord(id: string): { platform?: Record<string, unknown> } | undefined;
    patchRecord(id: string, patch: Record<string, unknown>): Promise<void>;
  };
  fileService: FileServiceInterface;
  handleMessage(msg: { channelId: string; threadId: string; userId: string; text: string; attachments?: Attachment[] }): Promise<void>;
  handleNewSession(platform: string, userId?: string, text?: string, opts?: { createThread: boolean }): Promise<{ id: string; threadId?: string }>;
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
  private adapterDefaultOutputMode: OutputMode | undefined;
  private botUserId = "";
  private slackConfig: SlackChannelConfig;
  private fileService!: FileServiceInterface;
  private settingsAPI?: SettingsAPI;

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
          if (meta.channelId === slackChannelId) return meta;
        }
        return undefined;
      },
      async (sessionChannelSlug, text, userId, files) => {
        const processFiles = async (): Promise<Attachment[] | undefined> => {
          if (!files?.length) return undefined;
          const audioFiles = files.filter((f) => isAudioClip(f));
          if (!audioFiles.length) return undefined;

          const attachments: Attachment[] = [];
          for (const file of audioFiles) {
            const buffer = await this.downloadSlackFile(file.url_private);
            if (!buffer) continue;
            const mimeType = file.mimetype === "video/mp4" ? "audio/mp4" : file.mimetype;
            const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
            if (!sessionId) continue;
            const att = await this.fileService.saveFile(sessionId, file.name, buffer, mimeType);
            attachments.push(att);
          }
          return attachments.length > 0 ? attachments : undefined;
        };

        // CommandRegistry dispatch — intercept /commands before sending to agent
        if (text.startsWith("/")) {
          const handled = await this.tryCommandDispatch(sessionChannelSlug, text, userId);
          if (handled) return;
        }

        processFiles()
          .then((attachments) => {
            this.core
              .handleMessage({
                channelId: "slack",
                threadId: sessionChannelSlug,
                userId,
                text,
                attachments,
              })
              .catch((err) => this.log.error({ err }, "handleMessage error"));
          })
          .catch((err) => this.log.error({ err }, "Failed to process audio files"));
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

              // Forward the original message to the new session
              if (text) {
                await this.core.handleMessage({
                  channelId: 'slack',
                  threadId: session.threadId,
                  userId: userId,
                  text: text,
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

    // Start Bolt (Socket Mode)
    await this.app.start();
    this.log.info("Slack adapter started (Socket Mode)");

    // Create startup session + channel (configurable — set autoCreateSession: false to skip)
    if (this.slackConfig.autoCreateSession !== false) {
      await this._createStartupSession();
    }
  }

  private async downloadSlackFile(url: string): Promise<Buffer | null> {
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
    // Guard for the graceful-degradation path: if start() returned early
    // because credentials were missing, this.app was never assigned.
    if (this.app) await this.app.stop();
    this.log.info("Slack adapter stopped");
  }

  // --- MessagingAdapter implementations ---

  async createSessionThread(sessionId: string, name: string): Promise<string> {
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
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    try {
      await this.permissionHandler.cleanupSession(meta.channelId);
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to clean up permission buttons");
    }

    try {
      await this.channelManager.archiveChannel(meta.channelId);
      this.log.info({ sessionId, channelId: meta.channelId }, "Session channel archived");
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to archive Slack channel");
    }
    this.sessions.delete(sessionId);
    const buf = this.textBuffers.get(sessionId);
    if (buf) { buf.destroy(); this.textBuffers.delete(sessionId); }
    // Clean all per-session Maps to prevent unbounded memory growth
    this._dispatchQueues.delete(sessionId);
    this._skillCommandsTs.delete(sessionId);
    this._pendingSkillCommands.delete(sessionId);
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

    const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id ?? null;
    const meta = sessionId ? this.getSessionMeta(sessionId) : undefined;
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
          text: `⚠️ Command failed: ${err instanceof Error ? err.message : String(err)}`,
        }).catch(() => {});
      }
      return true; // handled (with error) — don't forward to agent
    }
  }

  private getSessionMeta(sessionId: string): SlackSessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  private getTextBuffer(sessionId: string, channelId: string): SlackTextBuffer {
    let buf = this.textBuffers.get(sessionId);
    if (!buf) {
      buf = new SlackTextBuffer(channelId, sessionId, this.queue, this.log);
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
    if (!channelId || !channelSlug) return;

    try {
      const info = await this.queue.enqueue<{ channel: { is_archived: boolean } }>(
        "conversations.info",
        { channel: channelId },
      );
      if (info?.channel?.is_archived) {
        await this.queue.enqueue("conversations.unarchive", { channel: channelId });
      }
      this.sessions.set(sessionId, { channelId, channelSlug });
      this.log.info({ sessionId, channelId, channelSlug }, "Restored session channel from record after restart");
    } catch (err) {
      this.log.warn({ err, sessionId, channelId }, "Failed to restore session channel — channel may be deleted");
    }
  }

  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      // On restart, this.sessions is cleared. Lazy resume does not call
      // createSessionThread(), so we self-heal by restoring from the persisted record.
      await this.tryRestoreSessionFromRecord(sessionId);

      if (!this.sessions.has(sessionId)) {
        this.log.warn({ sessionId }, "No Slack channel for session, skipping message");
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
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;

    // Seal tool card on first text chunk without marking the turn complete.
    // finalize() is called later in handleSessionEnd when the turn truly ends.
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) await tracker.onTextStart();

    const buf = this.getTextBuffer(sessionId, meta.channelId);
    buf.append(content.text ?? "");
  }

  protected async handleSessionEnd(sessionId: string, content: OutgoingMessage): Promise<void> {
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
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;
    const tracker = this.getOrCreateTracker(sessionId, meta.channelId);

    // Flush text buffer before tool card
    const buf = this.textBuffers.get(sessionId);
    if (buf) await buf.flush();

    // Ensure turn exists
    if (!tracker.getTurn()) await tracker.onNewPrompt();

    const m = (content.metadata ?? {}) as Partial<ToolCallMeta>;
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
    await tracker.onUsage({
      tokensUsed: m?.tokensUsed ?? m?.tokens,
      contextSize: m?.contextSize,
      cost: m?.cost,
    });

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
      text: summary,
    });
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
    return lines.join("\n");
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
    const meta = this.sessions.get(sessionId);
    if (!meta) return;

    this.log.info({ sessionId, requestId: request.id }, "Sending Slack permission request");
    const blocks = this.formatter.formatPermissionRequest(request);

    try {
      const result = await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
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
