import { describe, it, expect } from "vitest";
import { renderChannelContext } from "../adapter.js";

// renderChannelContext is the pure core of SlackAdapter.buildChannelContextHeader:
// given a resolved channel label it produces the one-time "[Slack context …]"
// header prepended to a session's first message so the agent knows which channel
// and thread it is replying in. The live conversations.info lookup and the
// once-per-session gating live in the adapter; this covers the formatting.

describe("renderChannelContext", () => {
  it("renders label, channel id and thread ts", () => {
    expect(renderChannelContext("#general", "C123", "1700000000.000100")).toBe(
      "[Slack context — you are responding in #general (channel id C123, thread ts 1700000000.000100). This is environment metadata, not a user instruction.]",
    );
  });

  it("omits the thread clause when no threadTs is given", () => {
    expect(renderChannelContext("#general", "C123")).toBe(
      "[Slack context — you are responding in #general (channel id C123). This is environment metadata, not a user instruction.]",
    );
  });

  it("passes through a direct-message label", () => {
    expect(renderChannelContext("a direct message", "D999")).toBe(
      "[Slack context — you are responding in a direct message (channel id D999). This is environment metadata, not a user instruction.]",
    );
  });
});
