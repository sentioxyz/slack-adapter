import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackActivityTracker } from "../activity-tracker.js";
import type { SlackActivityTrackerConfig } from "../activity-tracker.js";
import type { ISlackSendQueue } from "../send-queue.js";
import type { OutputMode, ToolCallMeta } from "@openacp/plugin-sdk";

function mockQueue() {
  let tsCounter = 100;
  const enqueue = vi.fn().mockImplementation(async () => ({
    ok: true,
    ts: `${++tsCounter}.001`,
  }));
  return { enqueue } as unknown as ISlackSendQueue & { enqueue: ReturnType<typeof vi.fn> };
}

function makeConfig(overrides: Partial<SlackActivityTrackerConfig> = {}): SlackActivityTrackerConfig {
  return {
    channelId: "C123",
    sessionId: "sess-1",
    queue: mockQueue(),
    outputMode: "medium",
    ...overrides,
  };
}

function toolMeta(id: string, name = "Write"): ToolCallMeta {
  return { id, name, kind: "edit" };
}

describe("SlackActivityTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("onNewPrompt", () => {
    it("creates main message and returns TurnState", async () => {
      const config = makeConfig();
      const tracker = new SlackActivityTracker(config);

      const turn = await tracker.onNewPrompt();

      expect(turn).toBeDefined();
      expect(turn.mainMessageTs).toBe("101.001");
      expect(turn.threadTs).toBe("101.001");
      expect(turn.isFinalized).toBe(false);
      expect(turn.currentToolCardTs).toBeUndefined();

      // Should have posted a message
      const queue = config.queue as any;
      expect(queue.enqueue).toHaveBeenCalledWith("chat.postMessage", expect.objectContaining({
        channel: "C123",
      }));

      tracker.destroy();
    });
  });

  describe("onToolCall", () => {
    it("posts thread reply after debounce (first flush immediate)", async () => {
      const config = makeConfig();
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.onToolCall(toolMeta("t1", "Write"), "edit", { path: "/src/a.ts" });

      // First flush is immediate — should have posted thread reply + main update
      // Need to wait for microtasks
      await vi.advanceTimersByTimeAsync(0);

      // Should have posted a thread reply (chat.postMessage with thread_ts)
      const threadPost = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.postMessage" && c[1].thread_ts,
      );
      expect(threadPost).toBeDefined();

      // Should have updated main message
      const mainUpdate = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.update",
      );
      expect(mainUpdate).toBeDefined();

      tracker.destroy();
    });
  });

  describe("onToolUpdate", () => {
    it("updates existing tool card", async () => {
      const config = makeConfig();
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      await tracker.onToolCall(toolMeta("t1", "Write"), "edit", { path: "/src/a.ts" });
      await vi.advanceTimersByTimeAsync(0);

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.onToolUpdate("t1", "completed");
      // Trigger debounced flush
      await vi.advanceTimersByTimeAsync(1000);

      // Should have updated the thread reply (chat.update)
      const updateCalls = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.update",
      );
      // At least one update for tool card, one for main message
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      tracker.destroy();
    });
  });

  describe("finalize", () => {
    it("updates main message to done state", async () => {
      const config = makeConfig();
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      await tracker.onToolCall(toolMeta("t1", "Write"), "edit", {});
      await vi.advanceTimersByTimeAsync(0);

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.finalize();

      // Should update main message with isComplete=true
      const mainUpdate = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.update",
      );
      expect(mainUpdate).toBeDefined();

      const turn = tracker.getTurn();
      expect(turn?.isFinalized).toBe(true);

      tracker.destroy();
    });
  });

  describe("low mode", () => {
    it("does not post thread replies", async () => {
      const config = makeConfig({ outputMode: "low" });
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.onToolCall(toolMeta("t1", "Write"), "edit", {});
      await vi.advanceTimersByTimeAsync(1000);

      // Should NOT have posted any thread reply
      const threadPosts = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.postMessage" && c[1].thread_ts,
      );
      expect(threadPosts).toHaveLength(0);

      // But should still update main message
      const mainUpdates = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.update",
      );
      expect(mainUpdates.length).toBeGreaterThanOrEqual(1);

      tracker.destroy();
    });
  });

  describe("onThought", () => {
    it("posts thread reply in high mode only", async () => {
      const config = makeConfig({ outputMode: "high" });
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.onThought("Let me think about this...");

      const threadPost = queue.enqueue.mock.calls.find(
        (c: any[]) => c[0] === "chat.postMessage" && c[1].thread_ts,
      );
      expect(threadPost).toBeDefined();
      // Should contain thought text
      const params = threadPost![1] as Record<string, unknown>;
      const blocks = params.blocks as any[];
      const text = JSON.stringify(blocks);
      expect(text).toContain("Let me think about this...");

      tracker.destroy();
    });

    it("does NOT post in medium mode", async () => {
      const config = makeConfig({ outputMode: "medium" });
      const tracker = new SlackActivityTracker(config);
      await tracker.onNewPrompt();

      const queue = config.queue as any;
      queue.enqueue.mockClear();

      await tracker.onThought("Thinking...");

      const threadPosts = queue.enqueue.mock.calls.filter(
        (c: any[]) => c[0] === "chat.postMessage" && c[1].thread_ts,
      );
      expect(threadPosts).toHaveLength(0);

      tracker.destroy();
    });
  });

  describe("multiple turns", () => {
    it("finalizes old turn before starting new one", async () => {
      const config = makeConfig();
      const tracker = new SlackActivityTracker(config);

      const turn1 = await tracker.onNewPrompt();
      await tracker.onToolCall(toolMeta("t1", "Write"), "edit", {});
      await vi.advanceTimersByTimeAsync(0);

      expect(turn1.isFinalized).toBe(false);

      // Start a new turn — should finalize old one
      const turn2 = await tracker.onNewPrompt();

      expect(turn1.isFinalized).toBe(true);
      expect(turn2.isFinalized).toBe(false);
      expect(turn2.mainMessageTs).not.toBe(turn1.mainMessageTs);

      tracker.destroy();
    });
  });

  describe("channel subscription threading", () => {
    it("roots the main message in the outer thread when threadTs is set", async () => {
      const enqueue = vi.fn().mockResolvedValue({ ok: true, ts: "1.1" });
      const queue = { enqueue } as any;
      const tracker = new SlackActivityTracker({
        channelId: "C_SUB",
        sessionId: "sess-1",
        queue,
        outputMode: "medium",
        threadTs: "169.1",
      });
      await tracker.onNewPrompt();
      expect(enqueue).toHaveBeenCalledWith(
        "chat.postMessage",
        expect.objectContaining({ channel: "C_SUB", thread_ts: "169.1" }),
      );
    });
  });
});
