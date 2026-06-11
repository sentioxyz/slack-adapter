# Slack Thread Reply Gating, Gap Backfill & Processing Reaction Design

**Date:** 2026-06-11
**Branch:** `feat/thread-reply-gating`
**Status:** Implemented
**Depends on:** `2026-06-03-channel-subscription-design.md` (thread-session model)

## Overview

Today, every human reply in a bot-owned thread is dispatched to the agent — even
replies that are clearly addressed to *someone else* (`@alice can you check this?`).
Each such reply enters the agent context and triggers a full agent turn.

This feature makes the bot a polite thread participant via three related changes:

1. **Reply gating** — in a bot-owned thread, skip human replies that @mention other
   people/bots without mentioning this bot. Such replies are almost certainly not
   addressed to the bot.
2. **Gap backfill** — because skipped replies never reach the agent, the agent's
   view of the thread develops gaps. Track how far the agent has seen
   (`lastDeliveredTs`); when the next processed message arrives, fetch the missed
   messages and prepend them as a context block.
3. **Processing reaction** — add a Slack reaction (default 👀 `eyes`) to the
   triggering message when it is dispatched to the agent, and remove it when the
   agent's turn completes, so humans can see "the bot saw this and is working on it"
   vs. "the bot is idle".

All three changes are adapter-local. No OpenACP core changes.

## Non-Goals

- No change to *top-level* message triggering in `trigger: "all"` channels or DMs —
  gating applies only to replies inside bot-owned threads (`sub-continue` path).
- No change to the mid-thread `@mention` session-start rule (already mention-gated).
- No loosening of the bot-to-bot gate: another bot still needs `allowedBotIds`
  membership **and** an explicit @mention (current behavior, unchanged).
- No "done" reaction (e.g. swapping 👀 → ✅) — the reaction is removed, not replaced.
- No persistence of the reaction bookkeeping across restarts (see Known Limitations).

## Change 1 — Reply gating in owned threads

### Behavior matrix (sub-continue path only)

| Author | Message | Action |
|---|---|---|
| Human | @mentions this bot (possibly others too) | **Process** (unchanged) |
| Human | no mentions at all | **Process** (unchanged — default audience in an owned thread is the bot) |
| Human | mentions other user(s)/bot(s), or broadcast (`@here`/`@channel`/`@everyone`/user-group), and does **not** mention this bot | **Skip** (new) |
| Other bot | in `allowedBotIds` **and** @mentions this bot | **Process** (unchanged) |
| Other bot | anything else | **Skip** (unchanged — gated at the top of `classifySubscription`) |

### Implementation

`src/subscription-router.ts`:

- New pure helper `mentionsOthers(text, botUserId): boolean` — true when the text
  contains any of:
  - a user mention `<@U…>` or `<@W…>` whose ID is not `botUserId`
    (with or without the `|label` suffix),
  - a broadcast mention `<!here>`, `<!channel>`, `<!everyone>`
    (with or without `|label`),
  - a user-group mention `<!subteam^…>`.
- In `classifySubscription`, in the owned-thread branch
  (`hasThreadSession(...)` true): for **human** messages, return
  `{ kind: "ignore" }` when `!mentionsBot(text) && mentionsOthers(text)`.
  Bot-authored messages already passed the whitelist+mention gate at the top of
  the function and are not re-gated here.

The skip happens *before* dispatch, so a skipped reply triggers no agent turn, no
attachment collection, and no reaction. Its content is recovered later by gap
backfill (Change 2), and its files are recovered by the existing thread-history
attachment sweep (the per-thread `surfacedFiles` seen-set already dedupes).

## Change 2 — Gap backfill (`lastDeliveredTs`)

### State

`SlackSessionMeta` (`src/types.ts`) gains an optional field:

```ts
/** ts of the last thread message delivered to the agent (subscription threads). */
lastDeliveredTs?: string;
```

It is kept in the in-memory `sessions` map and persisted into the session record's
`platform` field via `patchRecord` (same field that already stores
`channelId`/`topicId`/`threadTs`), so backfill keeps working after a restart and
covers messages that arrived while the process was down.

### Flow (fetch-and-diff)

On each subscription dispatch (`onSubscriptionMessage` in `src/adapter.ts`):

1. **Fetch** — `dispatchToSession` already fetches the full thread via
   `fetchThreadMessages` for attachment collection (default config,
   `readThreadHistory !== false`). Hoist that single fetch so it serves both
   attachment collection and gap computation. No additional Slack API calls in the
   default configuration.
2. **Diff** — from the fetched messages, select the gap set:
   - `tsNum(m.ts) > tsNum(lastDeliveredTs)` (numeric compare via `parseFloat`,
     never string compare),
   - `m.ts !== trigger.ts` (the trigger is dispatched as the user text itself),
   - not authored by this bot (`m.user === botUserId` excluded — the agent already
     has its own replies in context).
3. **Render** — reuse the `renderThreadContext` line-rendering rules (author +
   text + bot-attachment fallback) with a distinct header so the agent can tell a
   gap block from the mid-thread full-history block:

   ```
   [Thread context — messages in this thread since your last turn that were not
   individually delivered]
   …
   [End thread context]
   ```

   The header/footer wrapper is parameterized rather than duplicated.
4. **Prepend** — `<gap block>\n\n<trigger text>`, same pattern as the existing
   mid-thread history block.
5. **Advance** — after a successful dispatch, set
   `meta.lastDeliveredTs = trigger.ts` (in memory) and persist via `patchRecord`.
   This applies to `sub-continue` and to both `sub-start` variants (top-level
   start: the trigger is the thread root; mid-thread start: the full history was
   just prepended, so the agent is caught up through `triggerTs`).

### Plumbing

- `Classification`'s `sub-continue` variant gains `ts: string` (the replying
  message's ts); `sub-start` already carries it (`threadTs` for top-level,
  `triggerTs` for mid-thread). The event router passes it to
  `onSubscriptionMessage` via `opts.triggerTs` for all variants.
- Messages without `ts` (shouldn't occur for real events) skip gap logic.

### Degradation & migration

- `readThreadHistory: false` disables gap backfill too — that flag's documented
  meaning is "don't walk the thread"; document the interaction on the flag.
- Thread fetch failure → warn and dispatch the bare trigger text (same degradation
  as the existing mid-thread history fetch).
- Records persisted before this feature have no `lastDeliveredTs` → no backfill on
  the next message (today's behavior); the field is set from that dispatch onward.
- Empty gap set → no block prepended (common case: nothing was skipped).

## Change 3 — Processing reaction

### Behavior

- When a message is about to be dispatched to the agent, the adapter adds the
  configured reaction (default `eyes`) to **that message** via `reactions.add`.
- When the agent turn completes (`session_end`) or errors (`error`), the adapter
  removes the oldest outstanding reaction via `reactions.remove`.
- If message B arrives while A's turn is running, B is dispatched immediately
  (core queues it) and also gets the reaction — both messages show "seen".
  A `session_end` event is **terminal** for the live session (SessionBridge calls
  `session.finish()`; the `finished` state has no outgoing transitions; subsequent
  thread replies resume the record into a fresh live session via lazy resume). As a
  result, at most one `session_end` arrives per live session, and `handleSessionEnd`
  drains **all** outstanding reactions via `removeAll`. The recoverable `error` path
  (error→active is a valid transition) pops exactly one reaction.

### Implementation

- **Bookkeeping** — a per-session FIFO, `sessionId → Array<{channel, ts}>`,
  in-memory only. Implemented as `src/reaction-tracker.ts` (`ReactionTracker`),
  which owns the Slack `reactions.add` / `reactions.remove` calls via an injected
  enqueue function. The tracker owns the calls (rather than the adapter) because
  `remove()` must await its own paired `add()`'s API-call settlement — `reactions.add`
  and `reactions.remove` run on separate rate-limit queues, so a naïve design could
  issue a remove before its corresponding add had landed. A `clear(sessionKey)` method
  exists as a teardown hook to release all pending refs when a session is torn down.
- **Add** — in `dispatchToSession`, after `/command` interception (commands never
  reach the agent → no reaction) and before `core.handleMessage`. Requires the
  trigger message's `channel` + `ts`, available on both dispatch paths: the
  subscription path passes `opts.triggerTs` (added in Change 2), the legacy path
  passes `msg.ts` from the event router.
- **Remove** — `handleSessionEnd` calls `removeAll(sessionId)` (drains every
  outstanding reaction, since `session_end` is terminal); `handleError` calls
  `pop(sessionId)` → `reactions.remove` for the single-pop recoverable path.
- **Send queue** — `reactions.add` and `reactions.remove` are added to
  `SlackMethod` and `METHOD_RPM` in `src/send-queue.ts` (Slack Web API Tier 3 →
  50 rpm, matching the other Tier 3 entries).
- **Config** — `SlackChannelConfigSchema` gains
  `processingReaction: z.string().default("eyes")`; emoji name without colons
  (e.g. `"hourglass"`). Empty string `""` disables the feature entirely.
- **Error tolerance** — `reactions.add`/`remove` failures warn and never block the
  dispatch or the outgoing message. `already_reacted` (add) and `no_reaction` /
  `message_not_found` (remove) are treated as success.
- **OAuth scope** — requires `reactions:write`. The setup wizard's app manifest
  (`src/setup.ts`) and the README scope list must both be updated. If the token
  lacks the scope, the API error is caught by the warn-and-continue path —
  existing installs degrade gracefully until reinstalled with the new scope.

## Config summary

| Key | Type | Default | Meaning |
|---|---|---|---|
| `processingReaction` | string | `"eyes"` | Reaction emoji name added while a message is being processed; `""` disables. |
| `readThreadHistory` | boolean | `true` | Existing flag; now also gates gap backfill (documented). |

## Testing

`src/__tests__/subscription-router.test.ts` (extend):
- `mentionsOthers`: other-user mention, `<@W…>` IDs, `|label` suffixed mentions,
  `<!here>`/`<!channel>`/`<!everyone>` (bare and labeled), `<!subteam^…>`,
  self-mention only → false, plain text → false.
- Gating: owned-thread human reply @other → ignore; @bot+@other → continue;
  no mention → continue; broadcast-only → ignore; whitelisted-bot rules unchanged;
  unowned-thread and top-level behavior unchanged.
- `sub-continue` carries `ts`.

Gap rendering (pure-function tests, adapter test file):
- ts-range filter (numeric compare), trigger exclusion, own-bot exclusion,
  empty gap → empty string, distinct header text.

Adapter integration (existing harness in `adapter-thread-context.test.ts` style):
- `lastDeliveredTs` advances after dispatch and is persisted via `patchRecord`.
- Gap block prepended when messages were skipped; absent when nothing skipped.
- Missing `lastDeliveredTs` (legacy record) → no backfill, field set afterward.
- Fetch failure → bare dispatch, warn logged.

`src/__tests__/reaction-tracker.test.ts` (new):
- FIFO push/pop pairing, multi-session isolation, pop on empty → undefined.

Adapter reaction tests:
- add on dispatch / remove on `session_end` and on `error`;
- `/command` → no reaction; `processingReaction: ""` → no calls;
- API failure → dispatch proceeds, warn logged.

## Known Limitations

- **Stale reactions on crash/restart** — the reaction FIFO is in-memory; if the
  process dies mid-turn, the reaction stays on the message until someone removes
  it manually. Accepted; persisting reaction state is not worth the complexity.
- **Gap cap** — `fetchThreadMessages` pages up to its existing cap (10 × 200);
  an extremely long gap loses its oldest messages with the existing warn log.
- **Misdirected-reply heuristic** — a human reply like "@alice please review"
  that *also* expects the bot to act is skipped; the author must @mention the bot
  to pull it in. This is the intended trade-off.
- **Watermark float precision** — gap selection compares Slack ts values via
  `parseFloat`; two ts that differ only in the last microsecond digits can
  collide in IEEE-754 and drop a single boundary message from backfill.
  Real thread replies are seconds apart, so this is accepted.
