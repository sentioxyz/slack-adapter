import { describe, it, expect, vi } from "vitest";
import { fetchThreadContext, renderThreadContext, type ThreadContextMessage } from "../adapter.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// renderThreadContext is the pure core of SlackAdapter.buildThreadContext: given
// the messages fetched from conversations.replies it produces the prependable
// "[Thread context …]" block. Exercising it directly covers the exclusion,
// rendering, and emptiness rules without a live Slack client. The fetch/pagination
// and graceful-degradation wiring live in buildThreadContext (the do/while around
// this function) and the onSubscriptionMessage callback.

describe("renderThreadContext", () => {
  it("renders each non-empty message as <@author>: text and wraps in the context block", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "hello" },
      { ts: "2", user: "U2", text: "world" },
    ];
    expect(renderThreadContext(msgs)).toBe(
      [
        "[Thread context — full history of the Slack thread this conversation was started from]",
        "<@U1>: hello",
        "<@U2>: world",
        "[End thread context]",
      ].join("\n"),
    );
  });

  it("excludes the triggering message by triggerTs but keeps non-matching ts", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "earlier" },
      { ts: "2", user: "U2", text: "the @mention that triggered" },
    ];
    const out = renderThreadContext(msgs, "2");
    expect(out).toContain("<@U1>: earlier");
    expect(out).not.toContain("the @mention that triggered");
  });

  it("includes all messages when triggerTs is undefined", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "a" },
      { ts: "2", user: "U2", text: "b" },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@U1>: a");
    expect(out).toContain("<@U2>: b");
  });

  it("falls back to <@bot_id> for bot messages, then <unknown> when neither user nor bot_id", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", bot_id: "B99", text: "from a bot" },
      { ts: "2", text: "no author" },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@B99>: from a bot");
    expect(out).toContain("<unknown>: no author");
  });

  it("skips blank and whitespace-only messages", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "kept" },
      { ts: "2", user: "U2", text: "   " },
      { ts: "3", user: "U3", text: "" },
      { ts: "4", user: "U4" },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@U1>: kept");
    expect(out).not.toContain("<@U2>");
    expect(out).not.toContain("<@U3>");
    expect(out).not.toContain("<@U4>");
  });

  it("returns an empty string when nothing is worth prepending", () => {
    expect(renderThreadContext([])).toBe("");
    expect(renderThreadContext([{ ts: "1", user: "U1", text: "only message" }], "1")).toBe("");
    expect(renderThreadContext([{ ts: "1", user: "U1", text: "  " }])).toBe("");
  });

  it("renders Slack message attachments (e.g. a GitHub notification) even when text is empty", () => {
    // GitHub/integration posts arrive as bot_message with empty top-level text;
    // all content lives in the legacy `attachments[]` array. Without rendering it,
    // an @mention in that thread sees nothing of what was posted.
    const msgs: ThreadContextMessage[] = [
      {
        ts: "1",
        bot_id: "B0B0W56N468",
        text: "",
        attachments: [
          {
            title: "OffchainLabs/nitro on GitHub",
            text: "*nitro [Updated]* `v3.10.2`\nrelease notes here",
          },
        ],
      },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@B0B0W56N468>:");
    expect(out).toContain("OffchainLabs/nitro on GitHub");
    expect(out).toContain("release notes here");
  });

  it("combines a bot message's text and attachment content", () => {
    const msgs: ThreadContextMessage[] = [
      {
        ts: "1",
        bot_id: "B1",
        text: "see this",
        attachments: [{ title: "A title", text: "attachment body" }],
      },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@B1>: see this");
    expect(out).toContain("A title");
    expect(out).toContain("attachment body");
  });

  it("falls back to an attachment's fallback when it has no structured fields", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", bot_id: "B1", text: "", attachments: [{ fallback: "plain summary" }] },
    ];
    expect(renderThreadContext(msgs)).toContain("plain summary");
  });

  it("does NOT render attachments on non-bot (human) messages — those are forwards handled elsewhere", () => {
    // Human shares/forwards also populate attachments[], but extractForwards/
    // forwardedTexts surfaces them; rendering here too would duplicate them.
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "hi", attachments: [{ author_id: "U9", text: "forwarded content" }] },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@U1>: hi");
    expect(out).not.toContain("forwarded content");
  });

  it("still drops a message that has neither text nor renderable attachment content", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "1", user: "U1", text: "kept" },
      { ts: "2", bot_id: "B1", text: "", attachments: [{}] },
    ];
    const out = renderThreadContext(msgs);
    expect(out).toContain("<@U1>: kept");
    expect(out).not.toContain("<@B1>");
  });
});

describe("fetchThreadContext", () => {
  it("enqueues conversations.replies with {channel, ts: threadTs, limit: 200} and no cursor on the first page", async () => {
    const enqueue = vi.fn().mockResolvedValue({ messages: [{ ts: "1", user: "U1", text: "hi" }] });
    await fetchThreadContext(enqueue, silentLog, "C1", "100.5");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("conversations.replies", {
      channel: "C1",
      ts: "100.5",
      limit: 200,
    });
  });

  it("excludes the triggering message and renders the rest", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      messages: [
        { ts: "1", user: "U1", text: "earlier" },
        { ts: "2", user: "U2", text: "the trigger" },
      ],
    });
    const out = await fetchThreadContext(enqueue, silentLog, "C1", "1", "2");
    expect(out).toContain("<@U1>: earlier");
    expect(out).not.toContain("the trigger");
  });

  it("follows next_cursor forward when has_more is true, accumulating the NEWEST messages", async () => {
    // conversations.replies returns oldest-first; page 2 holds the messages just
    // before the @mention — the most relevant context that a single fetch drops.
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "1", user: "U1", text: "old" }],
        has_more: true,
        response_metadata: { next_cursor: "CURSOR2" },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "2", user: "U2", text: "recent" }],
        has_more: false,
      });

    const out = await fetchThreadContext(enqueue, silentLog, "C1", "1");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(2, "conversations.replies", {
      channel: "C1",
      ts: "1",
      limit: 200,
      cursor: "CURSOR2",
    });
    expect(out).toContain("<@U1>: old");
    expect(out).toContain("<@U2>: recent");
  });

  it("stops at the page cap and logs a warning when the thread is pathologically long", async () => {
    const warn = vi.fn();
    const log = { ...silentLog, warn };
    // Always reports more pages available — would loop forever without the cap.
    const enqueue = vi.fn().mockResolvedValue({
      messages: [{ ts: "x", user: "U1", text: "msg" }],
      has_more: true,
      response_metadata: { next_cursor: "MORE" },
    });

    await fetchThreadContext(enqueue, log, "C1", "1", undefined, /* maxPages */ 3);

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/omitted/i);
  });

  it("does not log a warning when the thread fits within the page cap", async () => {
    const warn = vi.fn();
    const log = { ...silentLog, warn };
    const enqueue = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", user: "U1", text: "done" }],
      has_more: false,
    });
    await fetchThreadContext(enqueue, log, "C1", "1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("propagates enqueue errors so the caller can degrade gracefully", async () => {
    // The function intentionally does NOT swallow errors — the onSubscriptionMessage
    // callback wraps it in try/catch and dispatches the bare message on failure.
    const enqueue = vi.fn().mockRejectedValue(new Error("slack down"));
    await expect(fetchThreadContext(enqueue, silentLog, "C1", "1")).rejects.toThrow("slack down");
  });
});
