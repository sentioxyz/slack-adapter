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

  it("extracts forwards from thread-history messages, not just the triggering message", () => {
    // Real-world shape: the thread PARENT is a forward (empty body, content in
    // `attachments`) and a SEPARATE reply @-mentions the bot. The triggering
    // message itself carries no forwards.
    const res = collectAttachments({
      triggerFiles: [],
      forwards: [],
      threadMessages: [
        {
          attachments: [
            {
              author_name: "bob",
              channel_name: "ops",
              ts: "5",
              text: "incident details",
              files: [{ id: "FF", name: "trace.log", mimetype: "text/plain", size: 3, url_private: "https://files.slack.com/FF" }],
            },
          ],
        },
        { user: "U1", text: "@bot look" },
      ],
    });
    expect(res.forwardedTexts.some((t) => t.includes("incident details"))).toBe(true);
    const ff = res.attachments.find((a) => a.file.id === "FF");
    expect(ff).toBeDefined();
    expect(ff!.source).toBe("forward");
  });

  it("skips forwards inside bot messages in history", () => {
    const res = collectAttachments({
      threadMessages: [
        { bot_id: "B1", attachments: [{ text: "bot forward", files: [file("FB")] }] },
      ],
    });
    expect(res.forwardedTexts).toHaveLength(0);
    expect(res.attachments).toHaveLength(0);
  });

  it("dedupes forwarded text shared by the triggering message and thread history", () => {
    const res = collectAttachments({
      forwards: [{ author: "alice", channelName: "incidents", ts: "1", text: "dup", files: [] }],
      threadMessages: [
        { attachments: [{ author_name: "alice", channel_name: "incidents", ts: "1", text: "dup" }] },
      ],
    });
    expect(res.forwardedTexts.filter((t) => t.includes("dup"))).toHaveLength(1);
  });
});
