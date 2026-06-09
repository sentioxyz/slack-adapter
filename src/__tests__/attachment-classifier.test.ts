import { describe, expect, it } from "vitest";
import { classifyAttachment } from "../attachment-classifier.js";

function f(mimetype: string, size: number, name = "x") {
  return { id: "F1", name, mimetype, size, url_private: "https://files.slack.com/x" };
}
const opts = { inlineMaxBytes: 100 };

describe("classifyAttachment", () => {
  it("classifies audio first", () => {
    expect(classifyAttachment(f("audio/mpeg", 9999), opts)).toBe("audio");
    expect(classifyAttachment(f("video/mp4", 9999, "audio_message_x.mp4"), opts)).toBe("audio");
  });

  it("inlines small text", () => {
    expect(classifyAttachment(f("text/plain", 50), opts)).toBe("text-inline");
    expect(classifyAttachment(f("application/json", 100), opts)).toBe("text-inline");
  });

  it("saves large text as file", () => {
    expect(classifyAttachment(f("text/plain", 101), opts)).toBe("text-file");
  });

  it("treats everything else as binary", () => {
    expect(classifyAttachment(f("image/png", 10), opts)).toBe("binary");
    expect(classifyAttachment(f("application/pdf", 10), opts)).toBe("binary");
  });
});
