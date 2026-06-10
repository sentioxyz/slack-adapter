// src/types.ts
import { z } from "zod";

/** Shared logger interface — used by adapter, event-router, and text-buffer */
export interface Logger {
  info(msg: string): void;
  info(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  error(msg: string): void;
  error(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  debug(obj: unknown, msg?: string): void;
}

/**
 * Slack channel configuration schema.
 * Defined locally (was previously part of OpenACP core config).
 */
export const SlackChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  adapter: z.literal("slack").optional(),
  botToken: z.string().optional(),       // xoxb-...
  appToken: z.string().optional(),       // xapp-... (Socket Mode)
  signingSecret: z.string().optional(),
  notificationChannelId: z.string().optional(),
  allowedUserIds: z.array(z.string()).default([]),
  channelPrefix: z.string().default("openacp"),
  autoCreateSession: z.boolean().default(true),
  startupChannelId: z.string().optional(),
  subscribedChannels: z
    .array(
      z.object({
        channelId: z.string(),
        trigger: z.enum(["mention", "all"]).default("mention"),
      }),
    )
    .default([]),
  /**
   * When true, the bot responds to @mentions in ANY channel it has been invited
   * to, without that channel being listed in `subscribedChannels`. Explicit
   * entries still take precedence (e.g. to use `trigger: "all"` for a channel).
   */
  mentionAnyChannel: z.boolean().default(false),
  /**
   * When true (default), the bot treats a direct message as its own persistent
   * session and replies inline in the DM. The allowedUserIds allowlist still
   * gates who may start a DM session. Set false to ignore DMs entirely.
   */
  respondToDms: z.boolean().default(true),
  /**
   * Slack `bot_id`s whose messages are allowed to trigger this bot. By default
   * the adapter ignores every message authored by another app/bot (they carry a
   * `bot_id`) to prevent bot-to-bot loops. List a `bot_id` here to make a
   * loop-safe exception: a message from that bot is honored ONLY when it also
   * @mentions this bot, so a notifier (e.g. a changelog/release bot) can hand
   * work to us while two ordinary bots can never trigger each other by accident.
   */
  allowedBotIds: z.array(z.string()).default([]),
  /**
   * Text files at or below this size (bytes) are inlined into the prompt;
   * larger text files are saved as file attachments. Default 16 KiB.
   */
  attachmentInlineMaxBytes: z.number().int().positive().default(16384),
  /**
   * When true (default), the adapter walks the full Slack thread
   * (conversations.replies) to collect attachments from every message, not just
   * the triggering one. Set false to limit API calls to the triggering message.
   */
  readThreadHistory: z.boolean().default(true),
});

export type SlackChannelConfig = z.infer<typeof SlackChannelConfigSchema>;

// Per-session metadata stored in SessionRecord.platform
export interface SlackSessionMeta {
  channelId: string;     // Slack channel ID for this session (C… for channels, D… for DMs)
  channelSlug: string;   // e.g. "openacp-fix-auth-bug-a3k9", or "C123:169..." for subscription threads
  /** Slack thread root (parent message ts) when this session is bound to a subscribed channel thread. */
  threadTs?: string;
}

/** Minimal file metadata extracted from Slack message events (subtype: file_share) */
export interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

/**
 * A forwarded / shared message extracted from a Slack message's `attachments`
 * array. Slack represents a shared message as an attachment carrying the
 * original author, channel, text, and any files.
 */
export interface ForwardedMessage {
  author?: string;       // author_name, falling back to author_id
  channelName?: string;  // channel_name of the source
  ts?: string;           // ts of the shared message
  text: string;          // shared message body (may be empty)
  files: SlackFileInfo[]; // files attached to the shared message
}

/**
 * A raw Slack message `attachments[]` entry. Slack uses this both for a
 * shared/forwarded message (author, source channel, text, and nested files —
 * see {@link RawSlackAttachment.author_id}) and for rich integration posts
 * (GitHub, CI, alerting bots) whose content lives in title/pretext/text/fields.
 * Present both on incoming events and on messages returned by
 * conversations.replies, so it can be read from any thread message.
 */
export interface RawSlackAttachment {
  author_name?: string;
  author_id?: string;
  channel_name?: string;
  ts?: string;
  text?: string;
  files?: SlackFileInfo[];
  // Rich integration-post fields (GitHub release notes, CI summaries, etc.).
  pretext?: string;
  title?: string;
  title_link?: string;
  fields?: { title?: string; value?: string }[];
  /** Plain-text summary integrations supply for clients that can't render the rich form. */
  fallback?: string;
}

/** A file candidate collected from the triggering message, thread, or a forward. */
export interface CollectedAttachment {
  file: SlackFileInfo;
  source: "message" | "thread" | "forward";
}

/** How an attachment is delivered to the agent. */
export type AttachmentCategory = "audio" | "text-inline" | "text-file" | "binary";

/** State for a single prompt turn within a session */
export interface TurnState {
  /** Timestamp of the main progress message (used for editing and as thread parent) */
  mainMessageTs: string;
  /** Same as mainMessageTs — thread replies use this as thread_ts */
  threadTs: string;
  /** Timestamp of current aggregated tool card message in thread */
  currentToolCardTs?: string;
  /** Whether this turn has been finalized */
  isFinalized: boolean;
}
