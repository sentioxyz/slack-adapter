import { describe, expect, it, vi } from "vitest";
import { SlackEventRouter, extractForwards } from "../event-router.js";
import type { SlackChannelConfig } from "../types.js";

function createMockApp() {
  const handlers: Record<string, Function> = {};
  return {
    message: vi.fn((handler: Function) => { handlers["message"] = handler; }),
    _trigger: async (event: string, payload: any) => {
      const handler = handlers[event];
      if (handler) await handler(payload);
    },
  };
}

function makeConfig(overrides: Partial<SlackChannelConfig> = {}): SlackChannelConfig {
  return {
    enabled: true,
    botToken: "xoxb-test",
    appToken: "xapp-test",
    signingSecret: "secret",
    allowedUserIds: [],
    channelPrefix: "openacp",
    autoCreateSession: true,
    ...overrides,
  } as SlackChannelConfig;
}

describe("SlackEventRouter", () => {
  it("ignores bot messages (message has bot_id field)", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "hello", bot_id: "B1" } });

    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("ignores own messages (userId matches botUserId)", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "BOT1", text: "hello" } });

    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("ignores messages with subtype (edited, deleted)", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "edited", subtype: "message_changed" } });

    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("rejects messages from non-allowed users when allowedUserIds is configured", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup,
      onIncoming,
      "BOT1",
      "NOTIF",
      onNewSession,
      makeConfig({ allowedUserIds: ["U_ALLOWED"] }),
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U_NOT_ALLOWED", text: "hello" } });

    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("allows messages when allowedUserIds is empty (open access mode)", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup,
      onIncoming,
      "BOT1",
      "NOTIF",
      onNewSession,
      makeConfig({ allowedUserIds: [] }),
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "NOTIF", user: "U_ANYONE", text: "hello" } });

    expect(onNewSession).toHaveBeenCalledWith("hello", "U_ANYONE");
  });

  it("routes to onIncoming when sessionLookup returns a match", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "hello" } });

    expect(onIncoming).toHaveBeenCalledWith("openacp-session-abc1", "hello", "U1", undefined, []);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("routes file_share messages with audio clips", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", {
      message: {
        channel: "C123",
        user: "U1",
        text: "",
        subtype: "file_share",
        files: [
          { id: "F1", name: "audio_message_abc.mp4", mimetype: "video/mp4", size: 1024, url_private: "https://files.slack.com/F1" },
        ],
      },
    });

    expect(onIncoming).toHaveBeenCalledWith(
      "openacp-session-abc1",
      "",
      "U1",
      [{ id: "F1", name: "audio_message_abc.mp4", mimetype: "video/mp4", size: 1024, url_private: "https://files.slack.com/F1" }],
      [],
    );
  });

  it("still blocks edited/deleted subtypes", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "edited", subtype: "message_changed" } });
    expect(onIncoming).not.toHaveBeenCalled();

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "deleted", subtype: "message_deleted" } });
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it("routes to onNewSession when message is in notification channel and no session match", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF_CHAN", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "NOTIF_CHAN", user: "U1", text: "new task" } });

    expect(onNewSession).toHaveBeenCalledWith("new task", "U1");
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it("ignores thread replies", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession, makeConfig());
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "reply in thread", thread_ts: "1234567890.123456" } });

    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("allows all users when both Slack and global lists are empty", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup,
      onIncoming,
      "BOT1",
      "NOTIF",
      onNewSession,
      makeConfig({ allowedUserIds: [] }),
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "NOTIF", user: "U_ANYONE", text: "hello" } });
    expect(onNewSession).toHaveBeenCalledWith("hello", "U_ANYONE");
  });

  it("routes a subscribed-channel mention to onSubscriptionMessage", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const onSubscription = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession,
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "<@BOT1> hi", ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: undefined, forwards: [] });
    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("routes a subscribed-channel thread reply to onSubscriptionMessage when the thread is known", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => true,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "more", ts: "169.2", thread_ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "more", undefined, { forwards: [] });
  });

  it("leaves legacy routing unchanged for non-subscribed channels", async () => {
    const onIncoming = vi.fn();
    const onSubscription = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(
      sessionLookup, onIncoming, "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "hello" } });

    expect(onIncoming).toHaveBeenCalledWith("openacp-session-abc1", "hello", "U1", undefined, []);
    expect(onSubscription).not.toHaveBeenCalled();
  });

  it("routes a top-level DM to onSubscriptionMessage as a threaded session", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const onSubscription = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession,
      makeConfig(), () => false, onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "D123", user: "U1", text: "hello", ts: "1.1" } });

    expect(onSubscription).toHaveBeenCalledWith("D123", "1.1", "U1", "hello", undefined, { midThread: undefined, triggerTs: undefined, forwards: [] });
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it("continues a known DM thread reply via onSubscriptionMessage", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig(), () => true, onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "D123", user: "U1", text: "more", ts: "1.2", thread_ts: "1.1" } });

    expect(onSubscription).toHaveBeenCalledWith("D123", "1.1", "U1", "more", undefined, { forwards: [] });
  });

  it("does not route DMs when respondToDms is false", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ respondToDms: false }), () => false, onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "D123", user: "U1", text: "hello", ts: "1.1" } });

    expect(onSubscription).not.toHaveBeenCalled();
  });

  it("plumbs midThread/triggerTs opts through for a mid-thread mention in an unknown thread", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "<@BOT1> help", ts: "169.5", thread_ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "help", undefined, { midThread: true, triggerTs: "169.5", forwards: [] });
  });

  it("does not pass mid-thread opts for a top-level mention", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "<@BOT1> hi", ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: undefined, forwards: [] });
  });

  it("does not route a DM from a non-allowed user", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ allowedUserIds: ["U_ALLOWED"] }), () => false, onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "D123", user: "U_NOT_ALLOWED", text: "hello", ts: "1.1" } });

    expect(onSubscription).not.toHaveBeenCalled();
  });
});

describe("extractForwards", () => {
  it("returns [] when no attachments", () => {
    expect(extractForwards(undefined)).toEqual([]);
    expect(extractForwards([])).toEqual([]);
  });

  it("maps shared-message attachments to ForwardedMessage", () => {
    const fwds = extractForwards([
      {
        author_name: "alice",
        channel_name: "incidents",
        ts: "111.2",
        text: "look here",
        files: [{ id: "F1", name: "log.txt", mimetype: "text/plain", size: 10, url_private: "u" }],
      },
    ]);
    expect(fwds).toHaveLength(1);
    expect(fwds[0]).toMatchObject({ author: "alice", channelName: "incidents", ts: "111.2", text: "look here" });
    expect(fwds[0].files[0].id).toBe("F1");
  });

  it("skips attachments with no readable body and no files", () => {
    // Empty, and a placeholder-fallback-only attachment (e.g. action buttons).
    expect(extractForwards([{}])).toEqual([]);
    expect(extractForwards([{ fallback: "[no preview available]" }])).toEqual([]);
  });

  it("extracts integration-card attachments via title (+ link)", () => {
    const fwds = extractForwards([
      { title: "OffchainLabs/nitro on GitHub", title_link: "https://github.com/x/releases/tag/v3.10.2" },
    ]);
    expect(fwds).toHaveLength(1);
    expect(fwds[0].text).toContain("OffchainLabs/nitro on GitHub");
    expect(fwds[0].text).toContain("https://github.com/x/releases/tag/v3.10.2");
  });

  it("falls back to author_id when author_name is absent", () => {
    const fwds = extractForwards([{ author_id: "U9", text: "hi" }]);
    expect(fwds[0].author).toBe("U9");
  });
});
