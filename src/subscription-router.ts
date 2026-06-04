// src/subscription-router.ts
// Pure subscription logic for the Slack adapter — no Slack/Bolt I/O.
import type { SlackSessionMeta } from "./types.js";

/** Subscribed-channel config entry (mirrors the Zod schema in types.ts). */
export interface SubscribedChannel {
  channelId: string;
  trigger: "mention" | "all";
}

/** Subset of a Slack message event used by the classifier. */
export interface SubscriptionMessage {
  bot_id?: string;
  subtype?: string;
  channel: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SubscriptionContext {
  subscribedChannels: SubscribedChannel[];
  botUserId: string;
  allowedUserIds: string[];
  /** True if a session already owns (channelId, threadTs) — in memory or persisted. */
  hasThreadSession: (channelId: string, threadTs: string) => boolean;
  /**
   * When true, treat any channel not in `subscribedChannels` as mention-triggered,
   * so the bot responds to @mentions in every channel it has been invited to.
   */
  mentionAnyChannel?: boolean;
}

export type Classification =
  | { kind: "ignore" }
  | { kind: "sub-start"; channelId: string; threadTs: string; userId: string; text: string }
  | { kind: "sub-continue"; channelId: string; threadTs: string; userId: string; text: string };

/** True when `text` mentions the given bot user (`<@U..>` or `<@U..|name>`). */
export function mentionsBot(text: string, botUserId: string): boolean {
  return new RegExp(`<@${botUserId}(\\|[^>]+)?>`).test(text);
}

/** Remove the bot's own mention token(s) and collapse the resulting whitespace. */
export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(\\|[^>]+)?>`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Decide what to do with a message in a (potentially) subscribed channel.
 *
 * Sessions are only ever started from a top-level trigger; a reply in a thread
 * the bot does not already own is ignored in both trigger modes, so the bot
 * never hijacks unrelated human threads.
 */
export function classifySubscription(msg: SubscriptionMessage, ctx: SubscriptionContext): Classification {
  if (msg.bot_id) return { kind: "ignore" };
  if (msg.subtype && msg.subtype !== "file_share") return { kind: "ignore" };

  const channelId = msg.channel;
  // Direct messages (D…) are handled by the dedicated DM-session path, never
  // the subscription path — otherwise mentionAnyChannel would synthesize a
  // mention-only sub and a DM containing "<@bot>" would start a thread session.
  if (channelId.startsWith("D")) return { kind: "ignore" };
  const userId = msg.user ?? "";
  if (!userId || userId === ctx.botUserId) return { kind: "ignore" };

  // Explicit subscription wins (it may set `trigger: "all"`); otherwise, when
  // mentionAnyChannel is on, synthesize a mention-only sub so an @mention in any
  // invited channel starts a thread. The mention-only mode means non-mention
  // top-level messages and unrelated human threads are still ignored.
  let sub = ctx.subscribedChannels.find((c) => c.channelId === channelId);
  if (!sub && ctx.mentionAnyChannel) sub = { channelId, trigger: "mention" };
  if (!sub) return { kind: "ignore" };

  if (ctx.allowedUserIds.length > 0 && !ctx.allowedUserIds.includes(userId)) {
    return { kind: "ignore" };
  }

  const text = stripBotMention(msg.text ?? "", ctx.botUserId);

  // Thread reply → continue only a known bot thread.
  if (msg.thread_ts) {
    if (ctx.hasThreadSession(channelId, msg.thread_ts)) {
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text };
    }
    return { kind: "ignore" };
  }

  // Top-level message → start a thread session when the trigger fires.
  const triggered = sub.trigger === "all" || mentionsBot(msg.text ?? "", ctx.botUserId);
  if (!triggered || !msg.ts) return { kind: "ignore" };
  return { kind: "sub-start", channelId, threadTs: msg.ts, userId, text };
}

export interface ThreadSessionDeps {
  sessions: Map<string, SlackSessionMeta>;
  getSessionByThread: (platform: string, threadId: string) => { id: string } | undefined;
  getRecordByThread: (platform: string, threadId: string) => { sessionId: string } | undefined;
  handleNewSession: (
    platform: string,
    agentName?: string,
    workspacePath?: string,
    opts?: { createThread: boolean },
  ) => Promise<{ id: string; threadId?: string }>;
  patchRecord: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
}

/**
 * Resolve the session that owns a (channelId, threadTs) thread. Prefers, in order:
 * an in-memory meta, a live session by thread, then a PERSISTED record (post-restart)
 * — in which case core.handleMessage(threadId) lazily resumes the agent. Only when no
 * session exists at all does it create one bound to the *existing* channel
 * (`createThread: false`, so no new Slack channel is created).
 */
export async function resolveThreadSession(
  deps: ThreadSessionDeps,
  channelId: string,
  threadTs: string,
): Promise<{ sessionId: string; meta: SlackSessionMeta }> {
  const key = `${channelId}:${threadTs}`;

  for (const [sid, meta] of deps.sessions) {
    if (meta.channelId === channelId && meta.threadTs === threadTs) {
      return { sessionId: sid, meta };
    }
  }

  const live = deps.getSessionByThread("slack", key);
  if (live) {
    const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs };
    deps.sessions.set(live.id, meta);
    return { sessionId: live.id, meta };
  }

  // Persisted (post-restart): bind meta to the stored session and let
  // core.handleMessage(threadId=key) lazily resume it. Do NOT create a new
  // session — that would orphan the stored one and lose its agent context.
  const record = deps.getRecordByThread("slack", key);
  if (record) {
    const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs };
    deps.sessions.set(record.sessionId, meta);
    return { sessionId: record.sessionId, meta };
  }

  const session = await deps.handleNewSession("slack", undefined, undefined, { createThread: false });
  const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs };
  deps.sessions.set(session.id, meta);
  (session as { threadId?: string }).threadId = key;
  await deps.patchRecord(session.id, {
    platform: { channelId, topicId: key, threadTs },
  });
  return { sessionId: session.id, meta };
}

/**
 * Resolve the session that owns a DM channel. Prefers, in order: an in-memory
 * meta, a live session by slug, then a PERSISTED record (post-restart). Only
 * when no session exists does it create one bound to the DM channel
 * (`createThread: false`, so no new Slack channel is created). The slug is
 * deterministic (`dm-<channelId>`) so a post-restart inbound DM can look the
 * session up by channel.
 */
export async function resolveDmSession(
  deps: ThreadSessionDeps,
  dmChannelId: string,
): Promise<{ sessionId: string; meta: SlackSessionMeta }> {
  const slug = `dm-${dmChannelId}`;

  for (const [sid, meta] of deps.sessions) {
    if (meta.channelId === dmChannelId && !meta.threadTs) {
      return { sessionId: sid, meta };
    }
  }

  const live = deps.getSessionByThread("slack", slug);
  if (live) {
    const meta: SlackSessionMeta = { channelId: dmChannelId, channelSlug: slug };
    deps.sessions.set(live.id, meta);
    return { sessionId: live.id, meta };
  }

  const record = deps.getRecordByThread("slack", slug);
  if (record) {
    const meta: SlackSessionMeta = { channelId: dmChannelId, channelSlug: slug };
    deps.sessions.set(record.sessionId, meta);
    return { sessionId: record.sessionId, meta };
  }

  const session = await deps.handleNewSession("slack", undefined, undefined, { createThread: false });
  const meta: SlackSessionMeta = { channelId: dmChannelId, channelSlug: slug };
  deps.sessions.set(session.id, meta);
  (session as { threadId?: string }).threadId = slug;
  await deps.patchRecord(session.id, {
    platform: { channelId: dmChannelId, topicId: slug },
  });
  return { sessionId: session.id, meta };
}
