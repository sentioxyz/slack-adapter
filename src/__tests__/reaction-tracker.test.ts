import { describe, it, expect, vi } from "vitest";
import { ReactionTracker } from "../reaction-tracker.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function makeTracker(emoji = "eyes", enqueue = vi.fn().mockResolvedValue({})) {
  const log = { ...silentLog, warn: vi.fn() };
  return { tracker: new ReactionTracker(enqueue, emoji, log), enqueue, log };
}

describe("ReactionTracker", () => {
  it("add() enqueues reactions.add with channel/timestamp/name", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledWith("reactions.add", { channel: "C1", timestamp: "100.1", name: "eyes" }));
  });

  it("remove() pops FIFO — oldest reaction first", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    tracker.add("sess-1", "C1", "100.2");
    await tracker.remove("sess-1");
    await tracker.remove("sess-1");
    const removes = enqueue.mock.calls.filter(([m]) => m === "reactions.remove");
    expect(removes[0][1]).toEqual({ channel: "C1", timestamp: "100.1", name: "eyes" });
    expect(removes[1][1]).toEqual({ channel: "C1", timestamp: "100.2", name: "eyes" });
  });

  it("remove() on an empty queue is a no-op", async () => {
    const { tracker, enqueue } = makeTracker();
    await tracker.remove("sess-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("sessions are isolated", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    await tracker.remove("sess-2");
    expect(enqueue.mock.calls.filter(([m]) => m === "reactions.remove")).toHaveLength(0);
  });

  it("empty emoji disables both add and remove", async () => {
    const { tracker, enqueue } = makeTracker("");
    tracker.add("sess-1", "C1", "100.1");
    await tracker.remove("sess-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("swallows already_reacted on add without warning", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce({ data: { error: "already_reacted" } }) // add benign
      .mockResolvedValue({});                                        // remove ok
    const { tracker, log } = makeTracker("eyes", enqueue);
    tracker.add("sess-1", "C1", "100.1");
    await tracker.remove("sess-1"); // waits for the add to settle internally
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns on other add failures but keeps the FIFO entry", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce({ data: { error: "missing_scope" } }) // add fails
      .mockResolvedValue({});                                       // remove succeeds
    const { tracker, log } = makeTracker("eyes", enqueue);
    tracker.add("sess-1", "C1", "100.1");
    await tracker.remove("sess-1");
    expect(log.warn).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith("reactions.remove", expect.anything());
  });

  it("swallows no_reaction / message_not_found on remove", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({})                                        // add ok
      .mockRejectedValueOnce({ data: { error: "no_reaction" } });       // remove benign
    const { tracker, log } = makeTracker("eyes", enqueue);
    tracker.add("sess-1", "C1", "100.1");
    await tracker.remove("sess-1");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("clear() drops pending entries without calling Slack", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    tracker.clear("sess-1");
    await tracker.remove("sess-1");
    expect(enqueue.mock.calls.filter(([m]) => m === "reactions.remove")).toHaveLength(0);
  });

  it("concurrent remove() calls pop distinct entries", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    tracker.add("sess-1", "C1", "100.2");
    await Promise.all([tracker.remove("sess-1"), tracker.remove("sess-1")]);
    const removes = enqueue.mock.calls.filter(([m]) => m === "reactions.remove").map(([, p]) => p);
    expect(removes).toHaveLength(2);
    expect(new Set(removes.map((p: any) => p.timestamp))).toEqual(new Set(["100.1", "100.2"]));
  });

  it("removeAll() drains every outstanding reaction for the session", async () => {
    const { tracker, enqueue } = makeTracker();
    tracker.add("sess-1", "C1", "100.1");
    tracker.add("sess-1", "C1", "100.2");
    tracker.add("sess-2", "C2", "200.1");
    await tracker.removeAll("sess-1");
    const removes = enqueue.mock.calls.filter(([m]) => m === "reactions.remove").map(([, p]: any[]) => p.timestamp);
    expect(removes).toEqual(["100.1", "100.2"]);
  });

  it("removeAll() on an empty session is a no-op", async () => {
    const { tracker, enqueue } = makeTracker();
    await tracker.removeAll("sess-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("removes only after its add has settled (no add-after-remove race)", async () => {
    const order: string[] = [];
    let releaseAdd!: () => void;
    const enqueue = vi.fn().mockImplementation((method: string) => {
      order.push(method);
      if (method === "reactions.add") return new Promise<void>((res) => { releaseAdd = () => res(); });
      return Promise.resolve({});
    });
    const { tracker } = makeTracker("eyes", enqueue);
    tracker.add("sess-1", "C1", "100.1");
    const removing = tracker.remove("sess-1");
    expect(order).toEqual(["reactions.add"]); // remove must not have fired yet
    releaseAdd();
    await removing;
    expect(order).toEqual(["reactions.add", "reactions.remove"]);
  });
});
