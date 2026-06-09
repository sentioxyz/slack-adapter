import { describe, expect, it, vi } from "vitest";
import { buildAttachmentPayload } from "../adapter.js";
import type { SlackFileInfo } from "../types.js";

function file(id: string, name: string, mimetype: string, size: number): SlackFileInfo {
  return { id, name, mimetype, size, url_private: `https://files.slack.com/${id}` };
}

describe("buildAttachmentPayload", () => {
  it("inlines small text, saves large text, links binaries, and inlines forwards", async () => {
    const download = vi.fn(async (url: string) => Buffer.from(`bytes:${url}`));
    const saveFile = vi.fn(async (_sid: string, name: string, _buf: Buffer, mime: string) => ({
      type: "file", filePath: `/tmp/${name}`, fileName: name, mimeType: mime, size: 1,
    }));
    const registerProxy = vi.fn((f: SlackFileInfo) => `http://127.0.0.1:1/slack-file/${f.id}`);

    const res = await buildAttachmentPayload({
      sessionId: "s1",
      inlineMaxBytes: 100,
      collected: [
        { file: file("F1", "small.txt", "text/plain", 10), source: "message" },
        { file: file("F2", "big.log", "text/plain", 9999), source: "thread" },
        { file: file("F3", "diagram.png", "image/png", 5000), source: "message" },
      ],
      forwardedTexts: ["[Forwarded from @alice]\n> hello"],
      download,
      saveFile,
      registerProxy,
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });

    expect(res.promptAdditions).toContain("[Forwarded from @alice]");
    expect(res.promptAdditions).toContain("small.txt");
    expect(res.promptAdditions).toContain("bytes:https://files.slack.com/F1");
    expect(res.promptAdditions).toContain("http://127.0.0.1:1/slack-file/F3");
    expect(res.promptAdditions).toContain("diagram.png");
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].fileName).toBe("big.log");
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(registerProxy).toHaveBeenCalledTimes(1);
    expect(res.surfacedIds.sort()).toEqual(["F1", "F2", "F3"]);
  });

  it("skips a file whose download fails but still surfaces the rest", async () => {
    const download = vi.fn(async (url: string) => (url.endsWith("F1") ? null : Buffer.from("ok")));
    const saveFile = vi.fn(async (_s: string, name: string, _b: Buffer, mime: string) => ({
      type: "file", filePath: `/tmp/${name}`, fileName: name, mimeType: mime, size: 1,
    }));
    const res = await buildAttachmentPayload({
      sessionId: "s1",
      inlineMaxBytes: 5,
      collected: [{ file: file("F1", "a.txt", "text/plain", 1), source: "message" }],
      forwardedTexts: [],
      download,
      saveFile,
      registerProxy: vi.fn(),
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });
    expect(res.promptAdditions).toBe("");
    expect(res.attachments).toHaveLength(0);
    expect(res.surfacedIds).toEqual([]);
  });

  it("returns empty additions when nothing is collected", async () => {
    const res = await buildAttachmentPayload({
      sessionId: "s1", inlineMaxBytes: 100, collected: [], forwardedTexts: [],
      download: vi.fn(), saveFile: vi.fn(), registerProxy: vi.fn(),
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });
    expect(res.promptAdditions).toBe("");
    expect(res.attachments).toEqual([]);
  });
});
