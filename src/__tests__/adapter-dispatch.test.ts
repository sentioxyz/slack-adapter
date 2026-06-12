import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../adapter.js";

// These tests exercise the private `dispatchToSession` method — the untested
// glue between the (well-tested) pure layers (renderGapContext,
// fetchThreadMessages, tryCommandDispatch) and core.handleMessage. Constructing
// a full SlackAdapter boots Bolt and a file proxy, which dwarfs the unit under
// test, so we build a bare prototype instance and assign ONLY the private
// fields `dispatchToSession` touches. The boolean return value is the contract
// the subscription watermark-advance is gated on (see Finding 1): true =
// dispatched toward the agent, false = intercepted as a /command. The advance
// logic itself lives in the onSubscriptionMessage closure registered during
// start(); it is not exercisable without booting Bolt, so its correctness rests
// on (a) this boolean return and (b) the existing buildWatermarkPlatformPatch
// tests — see the note in the PR/commit.

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

interface Stubs {
  tryCommandDispatch: ReturnType<typeof vi.fn>;
  reactionsAdd: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  handleMessage: ReturnType<typeof vi.fn>;
  getSessionByThread: ReturnType<typeof vi.fn>;
}

const SLUG = "openacp-thread";
const SESSION_ID = "sess-1";
const CHANNEL_ID = "C123";
const THREAD_TS = "100.0";

/**
 * Build a minimally-stubbed SlackAdapter on which `dispatchToSession` runs. Only
 * the fields the method reads are populated. `fileProxy` is left undefined so the
 * attachment-payload branch is skipped (no file IO); the channel-header path is
 * short-circuited by pre-seeding `_channelCtxInjected` with the session id.
 */
function makeAdapter(overrides?: {
  readThreadHistory?: boolean;
  processingReaction?: string;
  threadMessages?: unknown[];
  enqueueImpl?: (method: string, params: unknown) => Promise<unknown>;
}): { adapter: any; stubs: Stubs } {
  const adapter: any = Object.create(SlackAdapter.prototype);

  const tryCommandDispatch = vi.fn();
  const reactionsAdd = vi.fn();
  const handleMessage = vi.fn().mockResolvedValue(undefined);
  const getSessionByThread = vi.fn().mockReturnValue({ id: SESSION_ID });

  const enqueue =
    overrides?.enqueueImpl
      ? vi.fn(overrides.enqueueImpl as any)
      : vi.fn(async (method: string) => {
          if (method === "conversations.replies") {
            return { messages: overrides?.threadMessages ?? [], has_more: false };
          }
          return {};
        });

  adapter.log = silentLog;
  adapter.botUserId = "BOTU";
  adapter.slackConfig = {
    readThreadHistory: overrides?.readThreadHistory ?? true,
    attachmentInlineMaxBytes: 16384,
  };
  adapter.queue = { enqueue };
  adapter.reactions = {
    add: reactionsAdd,
    remove: vi.fn(),
    removeAll: vi.fn(),
    clear: vi.fn(),
  };
  adapter.fileProxy = undefined; // skip attachment-payload branch
  adapter.surfacedFiles = new Map();
  adapter.sessions = new Map([[SESSION_ID, { channelId: CHANNEL_ID, channelSlug: SLUG, threadTs: THREAD_TS }]]);
  // Pre-seed so buildChannelContextHeader short-circuits and returns "" — keeps
  // the dispatched text free of the channel header so gap-block assertions are clean.
  adapter._channelCtxInjected = new Set([SESSION_ID]);
  adapter.core = {
    sessionManager: { getSessionByThread },
    handleMessage,
  };

  // Stub the command-dispatch seam directly on the instance.
  adapter.tryCommandDispatch = tryCommandDispatch;

  return {
    adapter,
    stubs: { tryCommandDispatch, reactionsAdd, enqueue, handleMessage, getSessionByThread },
  };
}

function dispatch(
  adapter: any,
  text: string,
  extras?: { channelId?: string; threadTs?: string; triggerTs?: string; lastDeliveredTs?: string },
): Promise<boolean> {
  return adapter.dispatchToSession(SLUG, text, "U1", undefined, extras);
}

describe("dispatchToSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns false for an intercepted /command, adds no reaction, and never calls handleMessage", async () => {
    const { adapter, stubs } = makeAdapter();
    stubs.tryCommandDispatch.mockResolvedValue(true);

    const result = await dispatch(adapter, "/clear stuff", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      triggerTs: "200.1",
    });

    expect(result).toBe(false);
    expect(stubs.tryCommandDispatch).toHaveBeenCalledWith(SLUG, "/clear stuff", "U1");
    expect(stubs.reactionsAdd).not.toHaveBeenCalled();
    expect(stubs.handleMessage).not.toHaveBeenCalled();
  });

  it("returns true for normal text, adds the processing reaction, and dispatches the text to the agent", async () => {
    const { adapter, stubs } = makeAdapter();

    const result = await dispatch(adapter, "hello agent", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      triggerTs: "200.1",
    });

    expect(result).toBe(true);
    expect(stubs.tryCommandDispatch).not.toHaveBeenCalled();
    expect(stubs.reactionsAdd).toHaveBeenCalledWith(SLUG, CHANNEL_ID, "200.1");
    expect(stubs.handleMessage).toHaveBeenCalledTimes(1);
    const arg = stubs.handleMessage.mock.calls[0][0];
    expect(arg.threadId).toBe(SLUG);
    expect(arg.userId).toBe("U1");
    expect(arg.text).toBe("hello agent");
  });

  it("prepends a gap-context block when lastDeliveredTs is set and the thread has a skipped message", async () => {
    const { adapter, stubs } = makeAdapter({
      threadMessages: [
        { ts: "100.0", user: "U1", text: "delivered earlier" },
        { ts: "150.0", user: "U2", text: "a skipped reply" },
        { ts: "200.1", user: "BOTU", text: "the bot's own answer" },
        { ts: "201.0", user: "U1", text: "the trigger message" },
      ],
    });

    const result = await dispatch(adapter, "the trigger message", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      triggerTs: "201.0",
      lastDeliveredTs: "100.0",
    });

    expect(result).toBe(true);
    const text: string = stubs.handleMessage.mock.calls[0][0].text;
    expect(text.startsWith("[Thread context — messages in this thread since your last turn")).toBe(true);
    expect(text).toContain("<@U2>: a skipped reply");
    expect(text).not.toContain("the bot's own answer"); // bot's own excluded
    expect(text).not.toContain("<@U1>: the trigger message"); // trigger excluded from gap block
    expect(text.endsWith("the trigger message")).toBe(true); // raw trigger appended after the block
  });

  it("does not prepend a gap block when lastDeliveredTs is absent", async () => {
    const { adapter, stubs } = makeAdapter({
      threadMessages: [{ ts: "150.0", user: "U2", text: "a reply" }],
    });

    await dispatch(adapter, "hi", { channelId: CHANNEL_ID, threadTs: THREAD_TS, triggerTs: "201.0" });

    const text: string = stubs.handleMessage.mock.calls[0][0].text;
    expect(text).toBe("hi");
    expect(text).not.toContain("[Thread context");
  });

  it("does not walk the thread or produce a gap block when readThreadHistory is false", async () => {
    const { adapter, stubs } = makeAdapter({
      readThreadHistory: false,
      threadMessages: [{ ts: "150.0", user: "U2", text: "a skipped reply" }],
    });

    await dispatch(adapter, "hi", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      triggerTs: "201.0",
      lastDeliveredTs: "100.0",
    });

    expect(stubs.enqueue).not.toHaveBeenCalledWith("conversations.replies", expect.anything());
    const text: string = stubs.handleMessage.mock.calls[0][0].text;
    expect(text).toBe("hi");
  });

  it("degrades gracefully when the thread fetch fails — still dispatches the bare text", async () => {
    const { adapter, stubs } = makeAdapter({
      enqueueImpl: async (method: string) => {
        if (method === "conversations.replies") throw new Error("slack down");
        return {};
      },
    });

    const result = await dispatch(adapter, "hi", {
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      triggerTs: "201.0",
      lastDeliveredTs: "100.0",
    });

    expect(result).toBe(true);
    expect(stubs.handleMessage).toHaveBeenCalledTimes(1);
    expect(stubs.handleMessage.mock.calls[0][0].text).toBe("hi");
  });

  it("does not add a reaction when triggerTs or channelId is missing, but still dispatches", async () => {
    const { adapter, stubs } = makeAdapter();

    // No channelId/triggerTs (e.g. legacy event-router path without ts).
    const result = await dispatch(adapter, "hi");

    expect(result).toBe(true);
    expect(stubs.reactionsAdd).not.toHaveBeenCalled();
    expect(stubs.handleMessage).toHaveBeenCalledTimes(1);
  });
});
