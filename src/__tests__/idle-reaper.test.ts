import { describe, it, expect, vi } from "vitest";
import {
  decideIdleAction,
  endIdleSession,
  type IdleSession,
  type IdleSessionManager,
} from "../idle-reaper.js";

describe("decideIdleAction", () => {
  it("skips a vanished session", () => {
    expect(decideIdleAction(undefined)).toBe("skip");
  });

  it("skips sessions already in a terminal state", () => {
    for (const status of ["finished", "cancelled", "error"]) {
      expect(decideIdleAction({ status })).toBe("skip");
    }
  });

  it("reschedules a session that is mid-turn", () => {
    expect(decideIdleAction({ status: "active", promptRunning: true })).toBe("reschedule");
    expect(decideIdleAction({ status: "active", queueDepth: 2 })).toBe("reschedule");
  });

  it("reaps a genuinely idle active session", () => {
    expect(decideIdleAction({ status: "active", promptRunning: false, queueDepth: 0 })).toBe("reap");
  });

  it("reaps an idle session with no status reported", () => {
    expect(decideIdleAction({})).toBe("reap");
  });

  it("treats initializing as reapable (will be evicted, not finished)", () => {
    expect(decideIdleAction({ status: "initializing" })).toBe("reap");
  });
});

function makeManager(session: IdleSession | undefined) {
  const calls: string[] = [];
  const sm: IdleSessionManager = {
    getSession: () => session,
    patchRecord: vi.fn(async (_id, patch) => {
      calls.push(`patch:${JSON.stringify(patch)}`);
      if (session && typeof (patch as { status?: string }).status === "string") {
        session.status = (patch as { status?: string }).status;
      }
    }),
    cancelSession: vi.fn(async () => {
      calls.push(`cancel:${session?.status}`);
    }),
  };
  return { sm, calls };
}

describe("endIdleSession", () => {
  it("ends an active session as finished, then evicts it (resumable)", async () => {
    const finish = vi.fn((reason?: string) => {
      session.status = "finished";
      expect(reason).toContain("idle");
    });
    const session: IdleSession = { status: "active", promptRunning: false, queueDepth: 0, finish };
    const { sm, calls } = makeManager(session);

    await endIdleSession(sm, "s1", "idle: no Slack activity for 10m");

    expect(finish).toHaveBeenCalledOnce();
    // Record persisted as `finished` BEFORE cancelSession runs, so cancelSession's
    // guard leaves it resumable rather than overwriting to `cancelled`.
    expect(calls).toEqual([
      'patch:{"status":"finished"}',
      "cancel:finished",
    ]);
  });

  it("evicts an initializing session without calling finish()", async () => {
    const finish = vi.fn();
    const session: IdleSession = { status: "initializing", finish };
    const { sm, calls } = makeManager(session);

    await endIdleSession(sm, "s2", "idle: no Slack activity for 10m");

    expect(finish).not.toHaveBeenCalled();
    expect(sm.patchRecord).not.toHaveBeenCalled();
    expect(calls).toEqual(["cancel:initializing"]);
  });

  it("is a no-op when the session is already gone", async () => {
    const { sm } = makeManager(undefined);
    await endIdleSession(sm, "s3", "idle");
    expect(sm.cancelSession).not.toHaveBeenCalled();
    expect(sm.patchRecord).not.toHaveBeenCalled();
  });
});
