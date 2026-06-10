// src/event-router.ts
import type { App } from "@slack/bolt";
import type { SlackSessionMeta, SlackFileInfo, ForwardedMessage, RawSlackAttachment, Logger } from "./types.js";
import type { SlackChannelConfig } from "./types.js";
import { classifySubscription } from "./subscription-router.js";
import { extractForwards } from "./attachment-collector.js";

// Forward extraction lives with the collector (it is reused for every
// thread-history message too); re-exported here for callers and existing tests.
export { extractForwards };

/** Subset of Bolt's message event fields used by the router */
interface SlackMessageEvent {
  bot_id?: string;
  subtype?: string;
  channel: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    url_private: string;
  }>;
  attachments?: RawSlackAttachment[];
}

// Callback to look up which session (if any) owns a Slack channelId
export type SessionLookup = (channelId: string) => SlackSessionMeta | undefined;

// Callback to dispatch an incoming message to core
export type IncomingMessageCallback = (
  sessionId: string, text: string, userId: string,
  files?: SlackFileInfo[], forwards?: ForwardedMessage[],
) => void | Promise<void>;

// Callback to create a new session when user messages the notification channel
export type NewSessionCallback = (text: string, userId: string) => void;

// Callback to dispatch a subscribed-channel message (start or continue a thread session).
// `opts.midThread` is set when the session was started by an @mention inside an
// existing (non-bot-owned) thread; `opts.triggerTs` is that mention's ts so the
// adapter can fetch the thread history and exclude the triggering message.
export type SubscriptionMessageCallback = (
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  files?: SlackFileInfo[],
  opts?: { midThread?: boolean; triggerTs?: string; forwards?: ForwardedMessage[] },
) => void | Promise<void>;

export interface ISlackEventRouter {
  register(app: App): void;
}

export class SlackEventRouter implements ISlackEventRouter {
  private log: Logger;

  constructor(
    private sessionLookup: SessionLookup,
    private onIncoming: IncomingMessageCallback,
    private botUserId: string,
    private notificationChannelId: string | undefined,
    private onNewSession: NewSessionCallback,
    private config: SlackChannelConfig,
    private hasThreadSession?: (channelId: string, threadTs: string) => boolean,
    private onSubscriptionMessage?: SubscriptionMessageCallback,
    logger?: Logger,
  ) {
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }

  // Empty allowedUserIds means "allow all" — matches Telegram convention and what
  // the setup wizard advertises ("press Enter to allow all").
  private isAllowedUser(userId: string): boolean {
    const allowed = this.config.allowedUserIds ?? [];
    if (allowed.length === 0) return true;
    return allowed.includes(userId);
  }

  register(app: App): void {
    app.message(async ({ message }) => {
      this.log.debug({ message }, "Slack raw message event");

      const msg = message as unknown as SlackMessageEvent;

      const files: SlackFileInfo[] | undefined = msg.files?.map((f) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        url_private: f.url_private,
      }));

      const forwards = extractForwards(msg.attachments);

      // Subscription path: self-contained decision. Returns "ignore" for any
      // channel not in subscribedChannels, so legacy behavior is untouched.
      const cls = classifySubscription(
        {
          bot_id: msg.bot_id,
          subtype: msg.subtype,
          channel: msg.channel,
          text: msg.text,
          user: msg.user,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
        },
        {
          subscribedChannels: this.config.subscribedChannels ?? [],
          botUserId: this.botUserId,
          allowedUserIds: this.config.allowedUserIds ?? [],
          hasThreadSession: this.hasThreadSession ?? (() => false),
          mentionAnyChannel: this.config.mentionAnyChannel ?? false,
          respondToDms: this.config.respondToDms,
          allowedBotIds: this.config.allowedBotIds ?? [],
        },
      );
      if (cls.kind !== "ignore") {
        // Forward the mid-thread markers (only present on a sub-start that began
        // from an @mention inside an unowned thread) so the adapter can prepend
        // the thread's full history before dispatching.
        const opts =
          cls.kind === "sub-start"
            ? { midThread: cls.midThread, triggerTs: cls.triggerTs, forwards }
            : { forwards };
        await this.onSubscriptionMessage?.(cls.channelId, cls.threadTs, cls.userId, cls.text, files, opts);
        return;
      }

      // ----- Legacy routing (unchanged) -----
      if (msg.bot_id) return;
      const subtype = msg.subtype;
      if (subtype && subtype !== "file_share") return; // edited, deleted, etc.

      // Ignore thread replies — only channel-level messages route to legacy sessions
      if (msg.thread_ts) return;

      const channelId = msg.channel;
      const text: string = msg.text ?? "";
      const userId: string = msg.user ?? "";

      this.log.debug({ channelId, userId, text }, "Slack message received");

      if (userId === this.botUserId) return;

      if (!this.isAllowedUser(userId)) {
        this.log.warn({ userId }, "slack: message from non-allowed user rejected");
        return;
      }

      const session = this.sessionLookup(channelId);
      if (session) {
        this.log.debug({ channelId, sessionSlug: session.channelSlug }, "Routing to session");
        this.onIncoming(session.channelSlug, text, userId, files, forwards);
        return;
      }

      this.log.debug({ channelId, notificationChannelId: this.notificationChannelId }, "No session found for channel");

      if (this.notificationChannelId && channelId === this.notificationChannelId) {
        this.onNewSession(text, userId);
        return;
      }

      // Direct messages are handled by classifySubscription above (treated as a
      // trigger:"all" subscription so the bot replies in a thread). Reaching
      // here for a D… channel means respondToDms is disabled → ignore.
    });
  }
}
