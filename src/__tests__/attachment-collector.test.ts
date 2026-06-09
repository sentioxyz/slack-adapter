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

  it("reads files from third-party bot messages in the thread", () => {
    // A bot_id alone no longer means "skip" — only OUR bot (selfUserId/selfBotId)
    // is skipped. Third-party integration bots are legitimate thread content.
    const res = collectAttachments({
      threadMessages: [{ bot_id: "B1", files: [file("F9")] }],
    });
    expect(res.attachments.map((a) => a.file.id)).toEqual(["F9"]);
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

  it("reads third-party bot messages but skips our own bot's output", () => {
    const res = collectAttachments({
      selfUserId: "UME",
      selfBotId: "BME",
      threadMessages: [
        // third-party integration bot (e.g. GitHub) — MUST be read
        { bot_id: "B_GITHUB", attachments: [{ text: "release notes", files: [file("FG")] }] },
        // our own bot's output (matched by bot_id) — MUST be skipped
        { bot_id: "BME", user: "UME", attachments: [{ text: "replayed prompt", files: [file("FSELF")] }] },
        // our own bot's output (matched by user only) — MUST be skipped
        { user: "UME", files: [file("FSELF2")] },
      ],
    });
    expect(res.forwardedTexts.some((t) => t.includes("release notes"))).toBe(true);
    expect(res.forwardedTexts.some((t) => t.includes("replayed prompt"))).toBe(false);
    const ids = res.attachments.map((a) => a.file.id);
    expect(ids).toContain("FG");
    expect(ids).not.toContain("FSELF");
    expect(ids).not.toContain("FSELF2");
  });

  it("reads integration/bot cards: title + link + text, and skips button-only attachments", () => {
    // Exact shape observed live: a GitHub release card (empty message text;
    // content in attachments) — attachment[0] is a title/text card, attachment[1]
    // is action buttons (blocks only, placeholder fallback).
    const res = collectAttachments({
      threadMessages: [
        {
          bot_id: "B_GITHUB",
          attachments: [
            {
              title: "OffchainLabs/nitro on GitHub",
              title_link: "https://github.com/OffchainLabs/nitro/releases/tag/v3.10.2",
              text: "*nitro [Updated]* `v3.10.2`",
              fallback: "OffchainLabs/nitro on GitHub",
            },
            { fallback: "[no preview available]" }, // action-buttons-only → no readable body
          ],
        },
      ],
    });
    expect(res.forwardedTexts).toHaveLength(1);
    const block = res.forwardedTexts[0];
    expect(block).toContain("OffchainLabs/nitro on GitHub");
    expect(block).toContain("https://github.com/OffchainLabs/nitro/releases/tag/v3.10.2");
    expect(block).toContain("v3.10.2");
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
