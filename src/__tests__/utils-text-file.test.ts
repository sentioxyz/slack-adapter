import { describe, expect, it } from "vitest";
import { isTextFile } from "../utils.js";

function f(mimetype: string, name = "x") {
  return { id: "F1", name, mimetype, size: 0, url_private: "https://files.slack.com/x" };
}

describe("isTextFile", () => {
  it("treats text/* as text", () => {
    expect(isTextFile(f("text/plain"))).toBe(true);
    expect(isTextFile(f("text/csv"))).toBe(true);
    expect(isTextFile(f("text/markdown"))).toBe(true);
  });

  it("treats known textual application types as text", () => {
    expect(isTextFile(f("application/json"))).toBe(true);
    expect(isTextFile(f("application/xml"))).toBe(true);
    expect(isTextFile(f("application/javascript"))).toBe(true);
    expect(isTextFile(f("application/x-yaml"))).toBe(true);
  });

  it("rejects binary types", () => {
    expect(isTextFile(f("image/png"))).toBe(false);
    expect(isTextFile(f("application/pdf"))).toBe(false);
    expect(isTextFile(f("audio/mpeg"))).toBe(false);
    expect(isTextFile(f("application/octet-stream"))).toBe(false);
  });
});
