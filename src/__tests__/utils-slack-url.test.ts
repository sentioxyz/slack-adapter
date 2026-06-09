import { describe, expect, it } from "vitest";
import { isSlackFileUrl } from "../utils.js";

describe("isSlackFileUrl", () => {
  it("accepts https files.slack.com URLs", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T1-F1/x.pdf")).toBe(true);
    expect(isSlackFileUrl("https://my-workspace.slack.com/x")).toBe(true);
  });
  it("rejects non-slack hosts and non-https", () => {
    expect(isSlackFileUrl("http://files.slack.com/x")).toBe(false);
    expect(isSlackFileUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSlackFileUrl("https://evil.com/slack.com")).toBe(false);
    expect(isSlackFileUrl("https://notslack.com/x")).toBe(false);
    expect(isSlackFileUrl("not a url")).toBe(false);
  });
});
