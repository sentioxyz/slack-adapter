// src/idle-reaper.ts
//
// Idle-session reaping. A Slack session that has seen no inbound or outbound
// activity within a timeout window is automatically ended so it stops occupying
// a concurrency slot (the `@openacp/security` plugin caps concurrent sessions,
// and sessions that finish their work but are never told to end leak slots
// until the cap is hit and the bot goes silent).
//
// The key contract: an idle session is ended as `finished`, NOT `cancelled`.
// Core's lazy-resume path (getOrResume → lazyResume) revives a `finished`
// record with its full agent history on the next human reply, but explicitly
// refuses to resume `cancelled`/`error` records. So ending as `finished` makes
// the timeout transparent — a human who returns to the thread continues the
// same conversation; only the dormant slot was reclaimed.

/** The slice of a live session this module needs. */
export type IdleSession = {
  status?: string;
  promptRunning?: boolean;
  queueDepth?: number;
  finish?(reason?: string): void;
};

/** The slice of core's SessionManager this module needs. */
export type IdleSessionManager = {
  getSession(id: string): IdleSession | undefined;
  patchRecord(id: string, patch: Record<string, unknown>): Promise<void>;
  cancelSession(id: string): Promise<void>;
};

export type IdleAction = "reap" | "reschedule" | "skip";

/**
 * Decide what to do when a session's idle timer fires.
 *  - `skip`       — session is gone or already in a terminal state; drop the timer.
 *  - `reschedule` — session is mid-turn (agent still working or prompts queued).
 *                   Never kill mid-turn: re-arm the timer and re-check later.
 *  - `reap`       — session is genuinely idle; end it.
 */
export function decideIdleAction(session: IdleSession | undefined): IdleAction {
  if (!session) return "skip";
  const status = session.status;
  // Only live conversations are reapable. finished/cancelled/error are terminal.
  if (status && status !== "active" && status !== "initializing") return "skip";
  if (session.promptRunning || (session.queueDepth ?? 0) > 0) return "reschedule";
  return "reap";
}

/**
 * End an idle session, leaving it resumable.
 *
 * An `active` session is first transitioned to `finished` (the only state
 * lazy-resume will revive). cancelSession() then aborts/destroys the agent
 * subprocess and evicts the session from core's live map — without which
 * getSessionByThread would keep returning the dead session and silently drop
 * the next reply. cancelSession only overwrites the status to `cancelled` when
 * it is not already `finished`/`cancelled`, so persisting `finished` first
 * keeps the record resumable.
 *
 * An `initializing` session has no agent conversation yet and cannot transition
 * to `finished`, so it is simply evicted (ending up `cancelled`); a later reply
 * starts fresh, which is correct since there was nothing to resume.
 */
export async function endIdleSession(
  sm: IdleSessionManager,
  sessionId: string,
  reason: string,
): Promise<void> {
  const session = sm.getSession(sessionId);
  if (!session) return;
  if (session.status === "active" && typeof session.finish === "function") {
    session.finish(reason);
    // Persist `finished` BEFORE cancelSession reads the record, so its
    // cancelled-overwrite guard sees `finished` and leaves it resumable.
    await sm.patchRecord(sessionId, { status: "finished" });
  }
  await sm.cancelSession(sessionId);
}
