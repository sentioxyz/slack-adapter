import { describe, expect, it } from "vitest";
import { collectAttachments } from "../attachment-collector.js";
import type { SlackFileInfo, ForwardedMessage } from "../types.js";

function file(id: string, name = id, mimetype = "image/png"): SlackFileInfo {
  return { id, name, mimetype, size: 1, url_private: `https://files.slack.com/${id}` };
}

describe("collectAttachments", () => {
  it("collects from trigger, thread, and forwards", () => {
    const forwards: ForwardedMessage[] = [
      { author: "alice", channelName: "incidents", ts: "1", text: "see this", files: [file("F3")] },
    ];
    const res = collectAttachments({
      triggerFiles: [file("F1")],
      threadMessages: [{ files: [file("F2")] }],
      forwards,
    });
    const ids = res.attachments.map((a) => a.file.id).sort();
    expect(ids).toEqual(["F1", "F2", "F3"]);
    expect(res.attachments.find((a) => a.file.id === "F1")!.source).toBe("message");
    expect(res.attachments.find((a) => a.file.id === "F2")!.source).toBe("thread");
    expect(res.attachments.find((a) => a.file.id === "F3")!.source).toBe("forward");
    expect(res.forwardedTexts[0]).toContain("alice");
    expect(res.forwardedTexts[0]).toContain("see this");
  });

  it("dedupes by file id (first occurrence wins)", () => {
    const res = collectAttachments({
      triggerFiles: [file("F1")],
      threadMessages: [{ files: [file("F1")] }],
    });
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].source).toBe("message");
  });

  it("skips files already in the seen set", () => {
    const res = collectAttachments({
      triggerFiles: [file("F1"), file("F2")],
      seen: new Set(["F1"]),
    });
    expect(res.attachments.map((a) => a.file.id)).toEqual(["F2"]);
  });

  it("skips files from bot messages in the thread", () => {
    const res = collectAttachments({
      threadMessages: [{ bot_id: "B1", files: [file("F9")] }],
    });
    expect(res.attachments).toHaveLength(0);
  });

  it("omits forwarded text entries that have no text", () => {
    const res = collectAttachments({
      forwards: [{ text: "", files: [file("F4")] }],
    });
    expect(res.forwardedTexts).toHaveLength(0);
    expect(res.attachments.map((a) => a.file.id)).toEqual(["F4"]);
  });
});
