import { describe, expect, it, vi } from "vitest";
import { classifySubscription } from "../subscription-router.js";
import type { SubscriptionContext } from "../subscription-router.js";
import { resolveThreadSession } from "../subscription-router.js";
import type { ThreadSessionDeps } from "../subscription-router.js";
import type { SlackSessionMeta } from "../types.js";

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

  it("ignores direct-message channels even with mentionAnyChannel and a mention", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "<@BOT1> hi", ts: "1.1" },
      ctx({ subscribedChannels: [], mentionAnyChannel: true }),
    );
    expect(r.kind).toBe("ignore");
  });
});

function deps(overrides: Partial<ThreadSessionDeps> = {}): ThreadSessionDeps {
  return {
    sessions: new Map<string, SlackSessionMeta>(),
    getSessionByThread: () => undefined,
    getRecordByThread: () => undefined,
    handleNewSession: vi.fn(async () => ({ id: "sess-new" })),
    patchRecord: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("resolveThreadSession", () => {
  it("reuses an in-memory session for the same thread", async () => {
    const sessions = new Map<string, SlackSessionMeta>([
      ["sess-1", { channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" }],
    ]);
    const d = deps({ sessions });
    const r = await resolveThreadSession(d, "C_SUB", "169.1");
    expect(r.sessionId).toBe("sess-1");
    expect(d.handleNewSession).not.toHaveBeenCalled();
  });

  it("binds to a live session found by thread without creating a new one", async () => {
    const d = deps({ getSessionByThread: () => ({ id: "sess-live" }) });
    const r = await resolveThreadSession(d, "C_SUB", "169.1");
    expect(r.sessionId).toBe("sess-live");
    expect(d.sessions.get("sess-live")).toEqual({ channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" });
    expect(d.handleNewSession).not.toHaveBeenCalled();
  });

  it("restores a PERSISTED session after restart (via getRecordByThread) without creating a new one", async () => {
    const d = deps({ getRecordByThread: () => ({ sessionId: "sess-persisted" }) });
    const r = await resolveThreadSession(d, "C_SUB", "169.1");
    expect(r.sessionId).toBe("sess-persisted");
    expect(d.sessions.get("sess-persisted")).toEqual({ channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" });
    expect(d.handleNewSession).not.toHaveBeenCalled();
  });

  it("creates a new session bound to the existing channel with NO agentName and persists platform fields", async () => {
    const d = deps();
    const r = await resolveThreadSession(d, "C_SUB", "169.1");
    expect(d.handleNewSession).toHaveBeenCalledWith("slack", undefined, undefined, { createThread: false });
    expect(r.meta).toEqual({ channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" });
    expect(d.sessions.get("sess-new")).toEqual(r.meta);
    expect(d.patchRecord).toHaveBeenCalledWith("sess-new", {
      platform: { channelId: "C_SUB", topicId: "C_SUB:169.1", threadTs: "169.1" },
    });
  });
});
