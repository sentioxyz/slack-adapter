import { describe, expect, it, vi } from "vitest";
import { markdownBlock, enqueueWithMarkdownFallback } from "../markdown-post.js";

const platformError = (code: string) => Object.assign(new Error(code), { data: { error: code } });

describe("markdownBlock", () => {
  it("builds a markdown block", () => {
    expect(markdownBlock("# hi")).toEqual({ type: "markdown", text: "# hi" });
  });
});

describe("enqueueWithMarkdownFallback", () => {
  it("posts markdown blocks as-is on success", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
    const args = { channel: "C1", text: "**hi**", blocks: [markdownBlock("**hi**")] };
    const res = await enqueueWithMarkdownFallback({ enqueue } as any, "chat.postMessage", args);
    expect(res).toEqual({ ts: "1.1" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("chat.postMessage", args);
  });

  it("falls back to mrkdwn sections on invalid_blocks", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce(platformError("invalid_blocks"))
      .mockResolvedValueOnce({ ts: "2.2" });
    const res = await enqueueWithMarkdownFallback(
      { enqueue } as any,
      "chat.postMessage",
      { channel: "C1", text: "**bold** raw", blocks: [markdownBlock("**bold** raw")] },
    );
    expect(res).toEqual({ ts: "2.2" });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks[0].type).toBe("section");
    expect(retry.blocks[0].text.text).toBe("*bold* raw"); // converted to mrkdwn
  });

  it("rethrows non-invalid_blocks errors without retrying", async () => {
    const enqueue = vi.fn().mockRejectedValue(platformError("msg_too_long"));
    await expect(enqueueWithMarkdownFallback(
      { enqueue } as any,
      "chat.postMessage",
      { channel: "C1", text: "x", blocks: [markdownBlock("x")] },
    )).rejects.toThrow("msg_too_long");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rethrows invalid_blocks when no markdown block is present", async () => {
    const enqueue = vi.fn().mockRejectedValue(platformError("invalid_blocks"));
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] as any;
    await expect(enqueueWithMarkdownFallback(
      { enqueue } as any, "chat.postMessage", { channel: "C1", blocks },
    )).rejects.toThrow("invalid_blocks");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("splits oversize fallback text into multiple sections", async () => {
    const long = "y".repeat(7000); // > 3000 section limit, fits one markdown block
    const enqueue = vi.fn()
      .mockRejectedValueOnce(platformError("invalid_blocks"))
      .mockResolvedValueOnce({ ts: "3.3" });
    await enqueueWithMarkdownFallback(
      { enqueue } as any, "chat.postMessage",
      { channel: "C1", text: long, blocks: [markdownBlock(long)] },
    );
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks.length).toBeGreaterThan(1);
    for (const b of retry.blocks) {
      expect(b.type).toBe("section");
      expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});
