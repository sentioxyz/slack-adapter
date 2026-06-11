import { describe, expect, it, vi } from "vitest";
import { classifySubscription, mentionsOthers } from "../subscription-router.js";
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

  it("starts a session for a whitelisted bot that @mentions us (bot_message subtype)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "<@BOT1> beacon-kit v1.4.0 released", ts: "169.1", bot_id: "B_OK", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"] }),
    );
    expect(r).toEqual({ kind: "sub-start", channelId: "C_SUB", threadTs: "169.1", userId: "B_OK", text: "beacon-kit v1.4.0 released" });
  });

  it("ignores a whitelisted bot when it does NOT @mention us", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "beacon-kit v1.4.0 released", ts: "169.1", bot_id: "B_OK", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("ignores a non-whitelisted bot even when it @mentions us", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "<@BOT1> hi", ts: "169.1", bot_id: "B_OTHER", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("does not apply allowedUserIds to a whitelisted bot", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "<@BOT1> go", ts: "169.1", bot_id: "B_OK", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"], allowedUserIds: ["U_ONLY_HUMAN"] }),
    );
    expect(r.kind).toBe("sub-start");
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

  it("treats a DM as trigger:all — a top-level message starts a thread session", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "hello there", ts: "1.1" },
      ctx({ subscribedChannels: [], respondToDms: true }),
    );
    expect(r).toEqual({ kind: "sub-start", channelId: "D123", threadTs: "1.1", userId: "U1", text: "hello there" });
  });

  it("treats a DM as trigger:all by default (respondToDms undefined)", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "hi", ts: "1.1" },
      ctx({ subscribedChannels: [] }),
    );
    expect(r.kind).toBe("sub-start");
  });

  it("ignores DMs when respondToDms is false", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "hi", ts: "1.1" },
      ctx({ subscribedChannels: [], respondToDms: false, mentionAnyChannel: true }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("continues a known DM thread reply", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "more", ts: "1.2", thread_ts: "1.1" },
      ctx({ subscribedChannels: [], respondToDms: true, hasThreadSession: () => true }),
    );
    expect(r).toEqual({ kind: "sub-continue", channelId: "D123", threadTs: "1.1", userId: "U1", text: "more" });
  });

  it("starts a mid-thread session when mentioned in an unknown thread (root threadTs, midThread flag)", () => {
    // A human thread the bot doesn't own: an explicit @mention is an opt-in
    // signal, so we start a session bound to the thread ROOT (thread_ts), not
    // the reply ts, so later replies match hasThreadSession and continue.
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@BOT1> can you look at this?", ts: "169.5", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false }),
    );
    expect(r).toEqual({
      kind: "sub-start",
      channelId: "C_SUB",
      threadTs: "169.1",
      userId: "U1",
      text: "can you look at this?",
      midThread: true,
      triggerTs: "169.5",
    });
  });

  it("ignores a thread reply that does NOT mention the bot in mention mode (no hijacking)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "humans talking", ts: "169.5", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false, subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("ignores a thread reply that does NOT mention the bot even in 'all' mode (no hijacking)", () => {
    // trigger:"all" applies to TOP-LEVEL messages; a thread the bot doesn't own
    // must not be hijacked without an explicit mention.
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "humans talking", ts: "169.5", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false, subscribedChannels: [{ channelId: "C_SUB", trigger: "all" }] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("continues (not starts) a mention in a thread that already has a bot session", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@BOT1> more", ts: "169.5", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r).toEqual({ kind: "sub-continue", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "more" });
  });

  it("respects allowedUserIds for a mid-thread mention", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U_NO", text: "<@BOT1> hi", ts: "169.5", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false, allowedUserIds: ["U_YES"] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("starts a mid-thread session via mentionAnyChannel for a non-subscribed channel", () => {
    const r = classifySubscription(
      { channel: "C_OTHER", user: "U1", text: "<@BOT1> help", ts: "169.5", thread_ts: "169.1" },
      ctx({ subscribedChannels: [], mentionAnyChannel: true, hasThreadSession: () => false }),
    );
    expect(r).toEqual({
      kind: "sub-start",
      channelId: "C_OTHER",
      threadTs: "169.1",
      userId: "U1",
      text: "help",
      midThread: true,
      triggerTs: "169.5",
    });
  });

  it("starts a mid-thread session inside a DM thread the bot does not yet own", () => {
    const r = classifySubscription(
      { channel: "D123", user: "U1", text: "<@BOT1> here", ts: "1.5", thread_ts: "1.1" },
      ctx({ subscribedChannels: [], respondToDms: true, hasThreadSession: () => false }),
    );
    expect(r).toEqual({
      kind: "sub-start",
      channelId: "D123",
      threadTs: "1.1",
      userId: "U1",
      text: "here",
      midThread: true,
      triggerTs: "1.5",
    });
  });

  it("leaves midThread undefined on a top-level sub-start", () => {
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "<@BOT1> go", ts: "169.1" }, ctx());
    expect(r.kind).toBe("sub-start");
    expect((r as { midThread?: boolean }).midThread).toBeUndefined();
  });

  it("skips an owned-thread human reply that mentions someone else without mentioning the bot", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@U2> can you check this?", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("processes an owned-thread reply that mentions the bot AND someone else", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@BOT1> and <@U2> look at this", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("sub-continue");
  });

  it("skips an owned-thread reply that only carries a broadcast mention", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<!here> anyone around?", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("does not re-gate a whitelisted bot in an owned thread (its own gate already passed)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "<@BOT1> build finished", ts: "169.2", thread_ts: "169.1", bot_id: "B_OK", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"], hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("sub-continue");
  });

  it("does not gate a TOP-LEVEL message that mentions someone else in 'all' mode", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@U2> fyi", ts: "169.9" },
      ctx({ subscribedChannels: [{ channelId: "C_SUB", trigger: "all" }] }),
    );
    expect(r.kind).toBe("sub-start");
  });
});

describe("mentionsOthers", () => {
  it("detects a mention of another user", () => {
    expect(mentionsOthers("<@U2> can you check?", "BOT1")).toBe(true);
  });

  it("detects labeled and enterprise-style mentions", () => {
    expect(mentionsOthers("<@U2|alice> please", "BOT1")).toBe(true);
    expect(mentionsOthers("<@W2ENT> please", "BOT1")).toBe(true);
  });

  it("does not count the bot's own mention (bare or labeled)", () => {
    expect(mentionsOthers("<@BOT1> do it", "BOT1")).toBe(false);
    expect(mentionsOthers("<@BOT1|openacp> do it", "BOT1")).toBe(false);
  });

  it("returns true when the bot AND someone else are mentioned", () => {
    expect(mentionsOthers("<@BOT1> and <@U2> look", "BOT1")).toBe(true);
  });

  it("detects broadcast mentions (bare and labeled)", () => {
    expect(mentionsOthers("<!here> anyone?", "BOT1")).toBe(true);
    expect(mentionsOthers("<!here|here> anyone?", "BOT1")).toBe(true);
    expect(mentionsOthers("<!channel> heads up", "BOT1")).toBe(true);
    expect(mentionsOthers("<!everyone> hi", "BOT1")).toBe(true);
  });

  it("detects user-group mentions", () => {
    expect(mentionsOthers("<!subteam^S123ABC|@oncall> ping", "BOT1")).toBe(true);
  });

  it("returns false for plain text and non-mention markup", () => {
    expect(mentionsOthers("just words", "BOT1")).toBe(false);
    expect(mentionsOthers("a link <https://x.y|label>", "BOT1")).toBe(false);
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
