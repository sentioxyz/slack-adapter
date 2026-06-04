// src/event-router.ts
import type { App } from "@slack/bolt";
import type { SlackSessionMeta, SlackFileInfo, Logger } from "./types.js";
import type { SlackChannelConfig } from "./types.js";
import { classifySubscription } from "./subscription-router.js";

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
}

// Callback to look up which session (if any) owns a Slack channelId
export type SessionLookup = (channelId: string) => SlackSessionMeta | undefined;

// Callback to dispatch an incoming message to core
export type IncomingMessageCallback = (sessionId: string, text: string, userId: string, files?: SlackFileInfo[]) => void | Promise<void>;

// Callback to create a new session when user messages the notification channel
export type NewSessionCallback = (text: string, userId: string) => void;

// Callback to dispatch a subscribed-channel message (start or continue a thread session)
export type SubscriptionMessageCallback = (
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  files?: SlackFileInfo[],
) => void | Promise<void>;

// Callback to start/continue a session bound to a DM channel
export type DmSessionCallback = (
  dmChannelId: string,
  text: string,
  userId: string,
  files?: SlackFileInfo[],
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
    private onDmSession?: DmSessionCallback,
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
        },
      );
      if (cls.kind !== "ignore") {
        await this.onSubscriptionMessage?.(cls.channelId, cls.threadTs, cls.userId, cls.text, files);
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
        this.onIncoming(session.channelSlug, text, userId, files);
        return;
      }

      this.log.debug({ channelId, notificationChannelId: this.notificationChannelId }, "No session found for channel");

      if (this.notificationChannelId && channelId === this.notificationChannelId) {
        this.onNewSession(text, userId);
        return;
      }

      if (channelId.startsWith("D")) {
        if (this.config.respondToDms === false) {
          this.log.debug({ channelId, userId }, "DM ignored (respondToDms disabled)");
          return;
        }
        this.log.debug({ channelId, userId }, "DM received, routing to DM session");
        await this.onDmSession?.(channelId, text, userId, files);
        return;
      }
    });
  }
}
