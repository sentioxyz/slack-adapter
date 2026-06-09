import { describe, expect, it, vi } from "vitest";
import { fetchThreadMessages } from "../adapter.js";

const log = { info() {}, warn: vi.fn(), error() {}, debug() {} };

describe("fetchThreadMessages", () => {
  it("returns messages with their files across pages", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "1", user: "U1", files: [{ id: "F1", name: "a", mimetype: "image/png", size: 1, url_private: "u" }] }],
        has_more: true,
        response_metadata: { next_cursor: "c1" },
      })
      .mockResolvedValueOnce({ messages: [{ ts: "2", user: "U2" }], has_more: false });

    const msgs = await fetchThreadMessages(enqueue as any, log as any, "C1", "1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].files?.[0].id).toBe("F1");
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
