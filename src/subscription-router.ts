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
  const userId = msg.user ?? "";
  if (!userId || userId === ctx.botUserId) return { kind: "ignore" };

  const sub = ctx.subscribedChannels.find((c) => c.channelId === channelId);
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
