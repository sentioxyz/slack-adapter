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
  /**
   * When true (default), treat a direct-message channel (`D…`) as a
   * `trigger: "all"` subscription: every top-level DM starts its own threaded
   * session and the bot replies in that thread, matching channel behavior. When
   * false, DMs are ignored.
   */
  respondToDms?: boolean;
  /**
   * Slack `bot_id`s allowed to trigger this bot. A message authored by another
   * app/bot (it carries a `bot_id`) is normally ignored to prevent loops; a
   * `bot_id` listed here is honored, but ONLY when the message also @mentions
   * this bot. Empty (default) → all bot messages ignored, the legacy behavior.
   */
  allowedBotIds?: string[];
}

export type Classification =
  | { kind: "ignore" }
  | {
      kind: "sub-start";
      channelId: string;
      threadTs: string;
      userId: string;
      text: string;
      /**
       * True only when the session is started from an @mention INSIDE an
       * existing (non-bot-owned) thread. Top-level starts leave this
       * undefined. The adapter uses it to fetch and prepend the thread's
       * full history as context. `triggerTs` is the ts of the mentioning
       * message so the adapter can exclude it from that context block.
       */
      midThread?: boolean;
      triggerTs?: string;
    }
  | { kind: "sub-continue"; channelId: string; threadTs: string; userId: string; text: string };

/** True when `text` mentions the given bot user (`<@U..>` or `<@U..|name>`). */
export function mentionsBot(text: string, botUserId: string): boolean {
  return new RegExp(`<@${botUserId}(\\|[^>]+)?>`).test(text);
}

/**
 * True when `text` mentions someone OTHER than the given bot: another user/bot
 * (`<@U…>`, `<@W…>`, with or without `|label`), a broadcast (`<!here>`,
 * `<!channel>`, `<!everyone>`), or a user group (`<!subteam^…>`). Used to gate
 * owned-thread replies: such a reply is probably addressed to that someone,
 * not to this bot.
 */
export function mentionsOthers(text: string, botUserId: string): boolean {
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    if (m[1] !== botUserId) return true;
  }
  return /<!(?:here|channel|everyone)(?:\|[^>]+)?>|<!subteam\^[^>]+>/.test(text);
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
 * Sessions normally start from a top-level trigger. A reply in a thread the
 * bot does not already own is ignored UNLESS it explicitly @mentions the bot:
 * an explicit mention is always an opt-in signal, so it starts a session bound
 * to that thread (a "mid-thread" start). Without a mention, such replies are
 * ignored in both trigger modes, so the bot never hijacks unrelated human
 * threads.
 */
export function classifySubscription(msg: SubscriptionMessage, ctx: SubscriptionContext): Classification {
  const fromBot = Boolean(msg.bot_id);
  if (fromBot) {
    // Bot-authored messages are ignored unless the bot is explicitly whitelisted
    // AND the message @mentions us — a loop-safe opt-in. Bot posts use the
    // `bot_message` subtype, which we must allow here (the generic subtype gate
    // below would otherwise drop them).
    if (!(ctx.allowedBotIds ?? []).includes(msg.bot_id!)) return { kind: "ignore" };
    if (msg.subtype && msg.subtype !== "file_share" && msg.subtype !== "bot_message") {
      return { kind: "ignore" };
    }
    if (!mentionsBot(msg.text ?? "", ctx.botUserId)) return { kind: "ignore" };
  } else if (msg.subtype && msg.subtype !== "file_share") {
    return { kind: "ignore" };
  }

  const channelId = msg.channel;
  // A bot has no `user`; identify it by its `bot_id` so the session has a stable
  // author. The self-mute (userId === botUserId) only applies to human messages.
  const userId = msg.user ?? msg.bot_id ?? "";
  if (!userId || (!fromBot && userId === ctx.botUserId)) return { kind: "ignore" };

  // Resolve the effective subscription. Explicit `subscribedChannels` entries
  // win (they may set `trigger: "all"`). Otherwise:
  //  - a direct message (`D…`) behaves as `trigger: "all"` so every top-level DM
  //    starts a threaded session and the bot replies in that thread — matching
  //    channel behavior. Gated by respondToDms (default on).
  //  - mentionAnyChannel synthesizes a mention-only sub so an @mention in any
  //    invited channel starts a thread.
  let sub = ctx.subscribedChannels.find((c) => c.channelId === channelId);
  if (!sub && channelId.startsWith("D")) {
    if (ctx.respondToDms === false) return { kind: "ignore" };
    sub = { channelId, trigger: "all" };
  } else if (!sub && ctx.mentionAnyChannel) {
    sub = { channelId, trigger: "mention" };
  }
  if (!sub) return { kind: "ignore" };

  // allowedUserIds gates humans only; a whitelisted bot already passed its own
  // (allowedBotIds + mention) gate above.
  if (!fromBot && ctx.allowedUserIds.length > 0 && !ctx.allowedUserIds.includes(userId)) {
    return { kind: "ignore" };
  }

  const text = stripBotMention(msg.text ?? "", ctx.botUserId);

  // Thread reply.
  if (msg.thread_ts) {
    // A thread the bot already owns → continue the existing session, UNLESS the
    // reply @mentions someone else without mentioning this bot — then it is
    // almost certainly addressed to that someone, not the bot. Skipped content
    // is recovered later by gap backfill. Bot-authored messages already passed
    // the stricter whitelist+mention gate at the top and are not re-gated.
    if (ctx.hasThreadSession(channelId, msg.thread_ts)) {
      if (!fromBot && !mentionsBot(msg.text ?? "", ctx.botUserId) && mentionsOthers(msg.text ?? "", ctx.botUserId)) {
        return { kind: "ignore" };
      }
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text };
    }
    // An unowned (human) thread: only join it on an explicit @mention. This is
    // independent of sub.trigger — even in "all" mode we must not hijack a
    // human thread the bot wasn't asked to join. Bind the session to the thread
    // ROOT (msg.thread_ts) so subsequent replies match hasThreadSession and
    // continue this session. triggerTs is the mentioning message's ts, which the
    // adapter uses to exclude it from the prepended thread-history context.
    if (mentionsBot(msg.text ?? "", ctx.botUserId)) {
      return { kind: "sub-start", channelId, threadTs: msg.thread_ts, userId, text, midThread: true, triggerTs: msg.ts };
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
