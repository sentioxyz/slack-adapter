import { describe, expect, it, vi } from "vitest";
import { SlackPermissionHandler } from "../permission-handler.js";
import type { ISlackSendQueue } from "../send-queue.js";

function createMockApp() {
  let actionHandler: Function | undefined;
  return {
    action: vi.fn((_pattern: any, handler: Function) => { actionHandler = handler; }),
    _triggerAction: async (payload: any) => {
      if (actionHandler) await actionHandler(payload);
    },
  };
}

function makeMockQueue() {
  return {
    enqueue: vi.fn().mockResolvedValue({}),
  };
}

describe("SlackPermissionHandler", () => {
  it("calls onResponse with parsed requestId and optionId when button is clicked", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    await app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "req-123:allow" },
      body: {
        channel: { id: "C123" },
        message: { ts: "1234567890.123456" },
      },
    });

    expect(onResponse).toHaveBeenCalledWith("req-123", "allow");
  });

  it("ignores action values without colon separator (malformed value)", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    await app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "malformed-no-colon" },
      body: {
        channel: { id: "C123" },
        message: { ts: "1234567890.123456" },
      },
    });

    expect(onResponse).not.toHaveBeenCalled();
  });

  it("updates the original message after response (calls queue.enqueue with chat.update)", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    await app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "req-abc:deny" },
      body: {
        channel: { id: "C456" },
        message: { ts: "9876543210.654321" },
        user: { id: "U123", name: "bob" },
      },
    });

    expect(queue.enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({
      channel: "C456",
      ts: "9876543210.654321",
    }));
  });

  it("updates message with resolved state after button click", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    await app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "req-999:allow" },
      body: {
        channel: { id: "C999" },
        message: { ts: "1111111111.000001" },
        user: { id: "U42", name: "alice" },
      },
    });

    expect(queue.enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({
      channel: "C999",
      ts: "1111111111.000001",
      text: "Permission Allowed",
      blocks: [
        expect.objectContaining({
          type: "context",
          elements: [
            expect.objectContaining({
              type: "mrkdwn",
              text: expect.stringContaining("Allowed"),
            }),
          ],
        }),
      ],
    }));
  });

  it("cleanupSession edits pending permission messages to remove buttons", async () => {
    const mockQueue: ISlackSendQueue = {
      enqueue: vi.fn().mockResolvedValue({ ts: "msg-ts-1" }),
    };
    const handler = new SlackPermissionHandler(mockQueue, vi.fn());

    handler.trackPendingMessage("req-1", "C123", "msg-ts-1");

    await handler.cleanupSession("C123");

    expect(mockQueue.enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({
      channel: "C123",
      ts: "msg-ts-1",
      blocks: [],
    }));
  });

  it("uses isAllow from tracked options (not heuristic) when options are stored", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    // Track with options where "custom-id" is isAllow=false (heuristic would say true if name contained "allow")
    handler.trackPendingMessage("req-opt", "C100", "ts-100", [
      { id: "custom-id", label: "Allow-ish", isAllow: false },
    ]);

    await app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "req-opt:custom-id" },
      body: {
        channel: { id: "C100" },
        message: { ts: "ts-100" },
        user: { id: "U1", name: "alice" },
      },
    });

    // Despite "allow" appearing in label, isAllow=false from stored options takes precedence
    expect(queue.enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({
      text: "Permission Denied",
    }));
  });

  it("cleanupRequest removes only the given request, not sibling threads sharing a channel", async () => {
    const enqueue = vi.fn().mockResolvedValue({});
    const queue = { enqueue } as any;
    const handler = new SlackPermissionHandler(queue, vi.fn());
    handler.trackPendingMessage("req-A", "C_SUB", "1.1", []);
    handler.trackPendingMessage("req-B", "C_SUB", "2.2", []);

    await handler.cleanupRequest("req-A");

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({ channel: "C_SUB", ts: "1.1" }));
  });

  it("handles missing message in body gracefully (no crash when body.message is undefined)", async () => {
    const onResponse = vi.fn();
    const queue = makeMockQueue();
    const handler = new SlackPermissionHandler(queue as any, onResponse);
    const app = createMockApp();
    handler.register(app as any);

    await expect(app._triggerAction({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "req-xyz:allow" },
      body: {
        channel: { id: "C789" },
        message: undefined,
        user: { id: "U1", name: "anon" },
      },
    })).resolves.not.toThrow();

    expect(onResponse).toHaveBeenCalledWith("req-xyz", "allow");
    // chat.update is still attempted (ts will be undefined); errors are caught silently
    expect(queue.enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({
      channel: "C789",
    }));
  });
});
