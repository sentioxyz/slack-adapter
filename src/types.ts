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
