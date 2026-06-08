import { describe, expect, it } from "vitest";
import { SlackChannelConfigSchema } from "../types.js";

describe("SlackChannelConfigSchema", () => {
  it("defaults respondToDms to true", () => {
    const cfg = SlackChannelConfigSchema.parse({});
    expect(cfg.respondToDms).toBe(true);
  });

  it("allows respondToDms to be disabled", () => {
    const cfg = SlackChannelConfigSchema.parse({ respondToDms: false });
    expect(cfg.respondToDms).toBe(false);
  });

  it("defaults broadcastReplies to false", () => {
    const cfg = SlackChannelConfigSchema.parse({});
    expect(cfg.broadcastReplies).toBe(false);
  });

  it("allows broadcastReplies to be enabled", () => {
    const cfg = SlackChannelConfigSchema.parse({ broadcastReplies: true });
    expect(cfg.broadcastReplies).toBe(true);
  });
});
