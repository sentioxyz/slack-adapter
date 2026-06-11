import { describe, expect, it, vi } from "vitest";
import { SlackTextBuffer } from "../text-buffer.js";

describe("SlackTextBuffer", () => {
  it("flushes buffered text as a single message", async () => {
    const mockQueue = {
      enqueue: vi.fn().mockResolvedValue({}),
    } as any;
    const buf = new SlackTextBuffer("C123", undefined, "sess1", mockQueue);

    buf.append("Hello ");
    buf.append("world");
    await buf.flush();

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    const call = mockQueue.enqueue.mock.calls[0];
    expect(call[1].text).toContain("Hello");
    expect(call[1].text).toContain("world");
  });

  it("does not post empty content", async () => {
    const mockQueue = { enqueue: vi.fn().mockResolvedValue({}) } as any;
    const buf = new SlackTextBuffer("C123", undefined, "sess1", mockQueue);
    await buf.flush();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("does not lose content appended during flush", async () => {
    const resolvers: Array<() => void> = [];
    const mockQueue = {
      enqueue: vi.fn().mockImplementation(
        () => new Promise<void>(r => { resolvers.push(r); }),
      ),
    } as any;
    const buf = new SlackTextBuffer("C123", undefined, "sess1", mockQueue);

    buf.append("first");
    const flushPromise = buf.flush(); // starts flush, blocks on first enqueue

    // Wait for first enqueue to be called
    await new Promise(r => setTimeout(r, 10));

    // Append more content while flush is in progress
    buf.append(" second");

    // Unblock first enqueue — this triggers re-flush in finally block
    resolvers[0]();

    // Wait for re-flush to call enqueue again, then unblock it
    await new Promise(r => setTimeout(r, 20));
    if (resolvers[1]) resolvers[1]();

    await flushPromise;
    await new Promise(r => setTimeout(r, 20));

    const allText = mockQueue.enqueue.mock.calls
      .map((c: any) => c[1].text as string)
      .join(" ");
    expect(allText).toContain("second");
  });

  it("concurrent flush() awaits ongoing flush instead of returning immediately", async () => {
    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<void>(r => { resolveFirst = r; });
    const postResults: string[] = [];

    const mockQueue: { enqueue: ReturnType<typeof vi.fn> } = {
      enqueue: vi.fn().mockImplementation(async (_method: string, _params: unknown) => {
        if (postResults.length === 0) {
          postResults.push("first-start");
          await firstCallPromise;
          postResults.push("first-end");
        } else {
          postResults.push("second");
        }
        return { ts: "123" };
      }),
    };

    const buf = new SlackTextBuffer("C123", undefined, "sess-1", mockQueue as any);
    buf.append("hello ");

    // Start flush1 — this blocks on firstCallPromise
    const flush1 = buf.flush();

    // Append more while flush1 is in flight
    buf.append("world");

    // Call flush2 while flush1 is still in progress
    const flush2 = buf.flush();

    // flush2 should not have resolved yet (first flush is still blocked)
    let flush2Resolved = false;
    flush2.then(() => { flush2Resolved = true; });

    // Yield to microtask queue — if flush2 returned immediately (old bug),
    // flush2Resolved would already be true here
    await Promise.resolve();
    await Promise.resolve();

    // Under the buggy implementation: flush2 returns immediately when flushing=true
    // so flush2Resolved would be true even though "world" hasn't been sent yet.
    // Under the fixed implementation: flush2 awaits the ongoing flush promise,
    // so flush2Resolved is still false while firstCallPromise is unresolved.
    expect(flush2Resolved).toBe(false);

    // Now unblock the first flush
    resolveFirst();
    await flush1;
    await flush2;

    // After awaiting both, all content must have been sent
    expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(postResults).toContain("second");

    buf.destroy();
  });

  it("destroy clears buffer and timer", async () => {
    const mockQueue = { enqueue: vi.fn().mockResolvedValue({}) } as any;
    const buf = new SlackTextBuffer("C123", undefined, "sess1", mockQueue);
    buf.append("text");
    buf.destroy();
    // After destroy, flush should not post anything
    await buf.flush();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it("includes thread_ts on posts when constructed with a thread", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
    const queue = { enqueue } as any;
    const buf = new SlackTextBuffer("C_SUB", "169.1", "sess-1", queue);
    buf.append("hello world");
    await buf.flush();
    expect(enqueue).toHaveBeenCalledWith(
      "chat.postMessage",
      expect.objectContaining({ channel: "C_SUB", thread_ts: "169.1" }),
    );
  });

  it("posts raw markdown as a markdown block with full text fallback", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("# Title\n\n**bold** and `**kwargs` stay raw");
    await buf.flush();

    const [method, params] = enqueue.mock.calls[0];
    expect(method).toBe("chat.postMessage");
    expect(params.blocks).toEqual([
      { type: "markdown", text: "# Title\n\n**bold** and `**kwargs` stay raw" },
    ]);
    // Stored `text` is what other agents read back as thread context —
    // it must be the FULL raw chunk, never a summary or converted dialect.
    expect(params.text).toBe("# Title\n\n**bold** and `**kwargs` stay raw");
  });

  it("falls back to mrkdwn sections when markdown block is rejected", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }))
      .mockResolvedValueOnce({ ts: "2.2" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("**bold**");
    await buf.flush();

    expect(enqueue).toHaveBeenCalledTimes(2);
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks[0].type).toBe("section");
    expect(retry.blocks[0].text.text).toBe("*bold*");
  });

  it("stripTtsBlock preserves markdown newline structure", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "9.9" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("# Title\n\n- item 1\n- item 2\n\n[TTS]spoken summary[/TTS]");
    await buf.flush();
    await buf.stripTtsBlock();

    const updateCall = enqueue.mock.calls.find((c: any) => c[0] === "chat.update");
    expect(updateCall).toBeDefined();
    // newlines must survive — markdown blocks need them for structure
    expect(updateCall![1].text).toBe("# Title\n\n- item 1\n- item 2");
    expect(updateCall![1].blocks).toEqual([{ type: "markdown", text: "# Title\n\n- item 1\n- item 2" }]);
  });

  it("stripTtsBlock edits the posted message with a markdown block", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "9.9" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("Answer text [TTS]spoken[/TTS]");
    await buf.flush();
    await buf.stripTtsBlock();

    const updateCall = enqueue.mock.calls.find((c: any) => c[0] === "chat.update");
    expect(updateCall).toBeDefined();
    expect(updateCall![1].blocks).toEqual([{ type: "markdown", text: "Answer text" }]);
    expect(updateCall![1].text).toBe("Answer text");
  });
});
