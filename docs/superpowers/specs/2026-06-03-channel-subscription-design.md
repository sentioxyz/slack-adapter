# Slack Channel Subscription Design

**Date:** 2026-06-03
**Branch:** `feat/channel-subscription`
**Status:** Planned
**Depends on:** `2026-03-31-slack-output-mode-design.md` (thread rendering model)

## Overview

Today the Slack adapter only routes messages from channels **it owns** — channels it
created via `conversations.create` (one private channel per session), plus DMs and the
notification channel. A message posted in a pre-existing business channel (e.g. `#support`)
is received by the bot but **dropped** by the event router.

This feature lets the adapter **subscribe to specific, pre-existing Slack channels** and run
an AI agent against their messages, with a human-in-the-loop escalation path — all without
any change to OpenACP core.

**Model: one session per thread.**
- An `@mention` (or, per channel config, *any* top-level message) starts a **new session bound
  to that message's thread**. The agent's entire turn renders as replies in that thread.
- Replies inside an existing bot thread **continue** that thread's session (Claude `--resume`,
  full context).
- Tool-permission requests post **as buttons in the thread** (existing PermissionGate); a click
  resolves and the agent continues.
- A human's free-text reply in the thread is enqueued as the next prompt — the agent continues.
- After `session_end`, the thread mapping is **kept**: a later reply resumes the same session
  indefinitely.

**Why no core change is needed:** the adapter's `CoreKernel` interface already exposes
`handleNewSession(..., { createThread: false })`, `handleMessage`, and
`sessionManager.{getSessionByThread,patchRecord}`. The existing **startup-channel-reuse** path
(`adapter.ts` `_createStartupSession`) already binds a brand-new session to a *pre-existing*
channel without creating one. This feature generalizes that primitive from "the startup channel"
to "any subscribed thread."

## Non-Goals

- No `ask_human` MCP tool / explicit blocking free-text escalation (built-in PermissionGate +
  turn-boundary resume only).
- No change to OpenACP core, the Slack app manifest, or OAuth scopes (reuses `message.channels`
  / `message.groups`; the bot just needs to be invited to the subscribed channel).
- No change to the existing channel-per-session / DM / notification behavior.

## Configuration

Added to `SlackChannelConfigSchema` (`src/types.ts`). Backward-compatible: defaults to `[]`, so
existing configs are unaffected.

```ts
subscribedChannels: z
  .array(
    z.object({
      channelId: z.string(),                         // "C0123..."
      trigger: z.enum(["mention", "all"]).default("mention"),
    }),
  )
  .default([]),
```

- `trigger: "mention"` (default) — only top-level messages that `@mention` the bot start a session.
- `trigger: "all"` — every top-level message in the channel starts/feeds a session.
- `@mention` detection reuses the already-resolved `this.botUserId`: the text contains
  `<@${botUserId}>`. The mention token is stripped before the text is sent to the agent.

## Architecture (Approach C: isolated input, reused output)

### Input — `src/subscription-router.ts` (new, pure, unit-tested)

A side-effect-free classifier:

```ts
type Classification =
  | { kind: "ignore" }
  | { kind: "sub-start";    channelId: string; threadTs: string; userId: string; text: string }
  | { kind: "sub-continue"; channelId: string; threadTs: string; userId: string; text: string };

function classifySubscription(msg, ctx): Classification
```

`ctx` carries the subscription config, `botUserId`, `allowedUserIds`, and a
`hasThreadSession(channelId, threadTs): boolean` lookup (in-memory `this.sessions` + persisted
records) so the pure classifier can tell a known bot thread from an unrelated human thread without
performing I/O.

Rules (in order):
1. `msg.bot_id` set, or `userId === botUserId` → `ignore` (loop prevention — the bot now writes
   into channels it also listens to).
2. `subtype` present and not `file_share` (edits/deletes/joins) → `ignore`.
3. `userId` not in `allowedUserIds` (when the list is non-empty) → `ignore`.
4. `channelId` not in `subscribedChannels` → `ignore` (safety net; legacy routing is handled
   before the classifier is ever called).
5. `msg.thread_ts` present (a thread reply):
   - if `hasThreadSession(channelId, msg.thread_ts)` → `sub-continue` (`threadTs = msg.thread_ts`)
   - else → `ignore`. Sessions are only ever started from a top-level trigger, never from a
     mid-thread reply — so a reply in a thread the bot never owned is left alone in **both**
     trigger modes.
6. Top-level message: if `trigger === "all"`, **or** `trigger === "mention"` and the text mentions
   the bot → `sub-start` (`threadTs = msg.ts`, text with mention stripped). Otherwise `ignore`.

`event-router.ts` stays the single Bolt `app.message` binding, restructured so subscription and
legacy routing never interfere:
- After the common filters, if `channelId` is in `subscribedChannels`, run `classifySubscription`
  and dispatch `sub-start` / `sub-continue` via the adapter callbacks below.
- Otherwise fall through to the **unchanged** legacy path (its early `thread_ts` ignore,
  owned-session lookup, notification channel, DM). Legacy behavior is therefore byte-for-byte
  preserved; only subscribed channels see the new thread handling.

### Session binding — `adapter.ts`

New method:

```ts
private async getOrCreateThreadSession(
  channelId: string, threadTs: string, userId: string,
): Promise<{ sessionId: string; meta: SlackSessionMeta }>
```

- `key = `${channelId}:${threadTs}`` is used as the OpenACP `threadId`.
- Lookup first: `core.sessionManager.getSessionByThread("slack", key)`. If found but absent from
  the in-memory `this.sessions` map (post-restart), restore its meta (`{ channelId, channelSlug:
  key, threadTs }`) and return it.
- Otherwise create: `handleNewSession("slack", userId, undefined, { createThread: false })`, then
  - `this.sessions.set(session.id, { channelId, channelSlug: key, threadTs })`
  - `session.threadId = key`
  - `patchRecord(session.id, { platform: { channelId, topicId: key, threadTs } })`

`sub-start` / `sub-continue` both resolve to a session id, then route via
`core.handleMessage({ channelId: "slack", threadId: key, userId, text })` — identical to the legacy
path, so the prompt queue, middleware, agent, and SessionBridge are all reused unchanged.

### Output — thread the existing renderers

`SlackSessionMeta` gains an optional field:

```ts
export interface SlackSessionMeta {
  channelId: string;
  channelSlug: string;
  threadTs?: string;   // present only for subscription-bound thread sessions
}
```

Every `chat.postMessage` issued for a session includes `thread_ts: meta.threadTs` **when set**;
when unset, posting stays channel-level (existing behavior — fully backward compatible). This
threads through:

- `SlackTextBuffer` (constructor gains optional `threadTs`)
- `SlackActivityTracker` (main progress message + tool cards) — its per-turn "inner thread" and
  the outer @mention thread collapse into one, since Slack flattens replies-to-replies into the
  parent thread. All turn output therefore lands flat in the @mention thread.
- usage line, `handleSessionEnd` / `handleError` / `postFormattedMessage`, `sendPermissionRequest`,
  `sendSkillCommands`.

This supersedes, for subscription sessions only, the legacy spec's "final text + permissions posted
in channel (not thread)" rule: in a shared business channel everything must stay inside the thread.

## Safety Guards (critical)

1. **Never archive a subscribed channel.** `deleteSessionThread` and the `/openacp-archive`
   command call `conversations.archive`. The subscribed channel is a real business channel —
   archiving it would be destructive. When `meta.threadTs` is set, these paths **skip channel
   archival** and only tear down in-memory state (optionally posting a brief "session ended" note
   in-thread). `/openacp-archive` invoked inside a subscribed channel reports that it does not own
   the channel.
2. **Per-thread permission cleanup.** `permission-handler.cleanupSession(channelId)` currently
   wipes pending permission messages by `channelId`. With multiple thread sessions sharing one
   channelId, this would cross-wipe sibling threads. Cleanup is narrowed to the specific
   `requestId`s / `thread_ts` belonging to the ending session.
3. **Loop prevention.** The bot's own thread replies are filtered by `bot_id` / `userId ===
   botUserId` (rule 1 of the classifier), so the bot never reacts to itself.

## Restart Recovery

- **Inbound:** `sub-continue` relies on `getSessionByThread("slack", key)` reading the persisted
  record (`platform.topicId == key`) to restore the session and its meta. `sub-start` for a fresh
  thread simply creates a new session.
- **Outbound:** extend the existing `tryRestoreSessionFromRecord` to also restore
  `platform.threadTs` into the in-memory meta, so post-restart output re-threads correctly.
- **After `session_end`:** the mapping persists (via `patchRecord`), so a later thread reply
  re-resumes the same session (`getOrResume` → Claude `--resume`). Threads remain resumable
  indefinitely.

## Data Flow

```
#support  [User] "@OpenACP can you triage TICKET-123?"      ← ts = T0
            └─ thread (rooted at T0):
                 [Bot] 🔧 Processing…  (main message, edited as it works)
                 [Bot] 📖 Read … / 🔧 Bash …  (tool cards)
                 [Bot] 🔐 Permission: run `gh issue view`  [Allow] [Deny]   ← human clicks Allow
                 [Bot] "Here's the triage: …"   (final text)
                 [Bot] 📊 8.2k tokens · $0.02
            [User] "also check the linked PR"   (thread reply → sub-continue → resume)
                 [Bot] …continues with full context…
```

## Testing (vitest, mocked send queue — mirrors existing `event-router.test.ts`)

- **`classifySubscription` — all branches:** mention vs no mention; thread reply mapped vs
  unmapped; `allowedUserIds` enforcement; bot/`bot_id` filtering; subtype filtering;
  `trigger: "all"` vs `"mention"`; non-subscribed channel ignored.
- **`getOrCreateThreadSession`:** new-session creation persists the right `platform` fields;
  cache miss after restart restores via `getSessionByThread`; second message in the same thread
  reuses the same session id.
- **Safety:** `deleteSessionThread` / `/openacp-archive` do **not** call `conversations.archive`
  when `meta.threadTs` is set; permission cleanup only removes the ending session's pending
  messages, not a sibling thread's.
- **Output threading:** posts carry `thread_ts` when `meta.threadTs` is set and omit it otherwise
  (legacy unchanged).

## Files

**New**
- `src/subscription-router.ts` (+ `src/__tests__/subscription-router.test.ts`)

**Modified**
- `src/types.ts` — `subscribedChannels` config; `SlackSessionMeta.threadTs`
- `src/event-router.ts` — branch subscribed channels to the classifier before the legacy path;
  legacy path (incl. its `thread_ts` ignore) left unchanged
- `src/adapter.ts` — wire `subscribedChannels`; `getOrCreateThreadSession`; thread `thread_ts`
  into posts; archive guards; restore `threadTs`
- `src/text-buffer.ts`, `src/activity-tracker.ts` — optional `threadTs` param
- `src/permission-handler.ts` — per-thread cleanup
- `README.md` + `docs/superpowers/` — document subscription config & setup
