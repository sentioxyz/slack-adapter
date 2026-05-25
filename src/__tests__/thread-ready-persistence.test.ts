import { describe, expect, it, vi } from "vitest";
import { makeThreadReadyHandler } from "../adapter.js";
import type { SlackSessionMeta } from "../types.js";

/**
 * Regression test for issue #258 bug 4: "No Slack channel for session".
 *
 * Core invokes `createSessionThread("", name)` BEFORE the real sessionId is
 * assigned. Before this fix, the adapter did `this.sessions.set("", meta)` and
 * `patchRecord("", { platform: { channelId } })` — both no-ops against the
 * real session record. After restart, `tryRestoreSessionFromRecord` returned
 * early because `platform.channelId` was missing.
 *
 * Fix: pre-created channels are stashed by slug in `_pendingChannelsBySlug`
 * and re-keyed onto the real sessionId when `SESSION_THREAD_READY` fires.
 *
 * These tests import the actual production handler factory so they catch
 * regressions where the handler logic diverges.
 */
describe("issue #258 bug 4: makeThreadReadyHandler", () => {
  function setup() {
    const sessions = new Map<string, SlackSessionMeta>();
    const pendingChannelsBySlug = new Map<string, SlackSessionMeta>();
    const patchRecord = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const handler = makeThreadReadyHandler({
      sessions,
      pendingChannelsBySlug,
      patchRecord,
      onError,
    });
    return { sessions, pendingChannelsBySlug, patchRecord, onError, handler };
  }

  it("re-keys pending channel onto real sessionId and persists channelId+threadId", () => {
    const { sessions, pendingChannelsBySlug, patchRecord, handler } = setup();
    const slug = "openacp-fix-bug-abcd";
    const channelId = "C0123";
    pendingChannelsBySlug.set(slug, { channelId, channelSlug: slug });

    handler({ sessionId: "sess-real-1", channelId: "slack", threadId: slug });

    expect(sessions.get("sess-real-1")).toEqual({ channelId, channelSlug: slug });
    expect(pendingChannelsBySlug.has(slug)).toBe(false);
    expect(patchRecord).toHaveBeenCalledWith("sess-real-1", {
      platform: { channelId, threadId: slug },
    });
  });

  it("ignores events from other adapters (channelId !== 'slack')", () => {
    const { sessions, pendingChannelsBySlug, patchRecord, handler } = setup();
    pendingChannelsBySlug.set("openacp-x", { channelId: "C1", channelSlug: "openacp-x" });

    handler({ sessionId: "sess-1", channelId: "telegram", threadId: "openacp-x" });

    expect(sessions.size).toBe(0);
    expect(pendingChannelsBySlug.size).toBe(1);
    expect(patchRecord).not.toHaveBeenCalled();
  });

  it("no-ops when slug is not pending (e.g. startup reuse path emits its own event)", () => {
    const { sessions, patchRecord, handler } = setup();

    handler({ sessionId: "sess-1", channelId: "slack", threadId: "startup-12345678" });

    expect(sessions.size).toBe(0);
    expect(patchRecord).not.toHaveBeenCalled();
  });

  it("invokes onError if patchRecord rejects", async () => {
    const sessions = new Map<string, SlackSessionMeta>();
    const pendingChannelsBySlug = new Map<string, SlackSessionMeta>();
    const patchErr = new Error("disk full");
    const patchRecord = vi.fn().mockRejectedValue(patchErr);
    const onError = vi.fn();
    const handler = makeThreadReadyHandler({ sessions, pendingChannelsBySlug, patchRecord, onError });
    pendingChannelsBySlug.set("openacp-x", { channelId: "C1", channelSlug: "openacp-x" });

    handler({ sessionId: "sess-1", channelId: "slack", threadId: "openacp-x" });
    // Let the rejection propagate through the .catch chain
    await new Promise((r) => setImmediate(r));

    expect(onError).toHaveBeenCalledWith(patchErr, "sess-1");
    // Even on persist failure, sessions Map is still updated so in-memory routing works
    expect(sessions.get("sess-1")).toBeDefined();
  });
});
