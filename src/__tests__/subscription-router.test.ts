import { describe, expect, it, vi } from "vitest";
import { classifySubscription } from "../subscription-router.js";
import type { SubscriptionContext } from "../subscription-router.js";

function ctx(overrides: Partial<SubscriptionContext> = {}): SubscriptionContext {
  return {
    subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }],
    botUserId: "BOT1",
    allowedUserIds: [],
    hasThreadSession: () => false,
    ...overrides,
  };
}

describe("classifySubscription", () => {
  it("ignores channels that are not subscribed", () => {
    const r = classifySubscription({ channel: "C_OTHER", user: "U1", text: "<@BOT1> hi", ts: "1.1" }, ctx());
    expect(r.kind).toBe("ignore");
  });

  it("ignores bot's own and bot_id messages", () => {
    expect(classifySubscription({ channel: "C_SUB", user: "BOT1", text: "<@BOT1> hi", ts: "1.1" }, ctx()).kind).toBe("ignore");
    expect(classifySubscription({ channel: "C_SUB", user: "U1", text: "hi", ts: "1.1", bot_id: "B1" }, ctx()).kind).toBe("ignore");
  });

  it("ignores edited/deleted subtypes but allows file_share", () => {
    expect(classifySubscription({ channel: "C_SUB", user: "U1", text: "x", ts: "1.1", subtype: "message_changed" }, ctx()).kind).toBe("ignore");
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "<@BOT1> x", ts: "1.1", subtype: "file_share" }, ctx());
    expect(r.kind).toBe("sub-start");
  });

  it("enforces allowedUserIds when non-empty", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U_NO", text: "<@BOT1> hi", ts: "1.1" },
      ctx({ allowedUserIds: ["U_YES"] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("starts a session on a top-level mention and strips the mention", () => {
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "<@BOT1> triage TICKET-1", ts: "169.1" }, ctx());
    expect(r).toEqual({ kind: "sub-start", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "triage TICKET-1" });
  });

  it("ignores a top-level non-mention in mention mode", () => {
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "just chatting", ts: "169.1" }, ctx());
    expect(r.kind).toBe("ignore");
  });

  it("starts on any top-level message in 'all' mode", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "no mention here", ts: "169.1" },
      ctx({ subscribedChannels: [{ channelId: "C_SUB", trigger: "all" }] }),
    );
    expect(r).toEqual({ kind: "sub-start", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "no mention here" });
  });

  it("continues a reply only when the thread is a known bot session", () => {
    const known = vi.fn().mockReturnValue(true);
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "and the PR too", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: known }),
    );
    expect(known).toHaveBeenCalledWith("C_SUB", "169.1");
    expect(r).toEqual({ kind: "sub-continue", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "and the PR too" });
  });

  it("ignores a reply in an unknown thread (no hijacking human threads)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "human chat", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false }),
    );
    expect(r.kind).toBe("ignore");
  });
});
