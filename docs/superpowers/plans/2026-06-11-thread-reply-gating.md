# Thread Reply Gating, Gap Backfill & Processing Reaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In bot-owned threads, skip human replies addressed to someone else, backfill the resulting context gaps on the next processed message, and show a 👀 reaction while the agent is working on a message.

**Architecture:** All adapter-local. Gating is a new rule in the pure `classifySubscription` (subscription-router). Gap backfill persists a `lastDeliveredTs` watermark in `SlackSessionMeta` and diffs it against the thread fetch that `dispatchToSession` already performs for attachments. The reaction indicator is a new small `ReactionTracker` module (per-session FIFO + Slack `reactions.add/remove` calls) wired into dispatch and turn-end handlers.

**Tech Stack:** TypeScript, Zod config schema, Slack Bolt/Web API via `SlackSendQueue`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-thread-reply-gating-design.md`

## File map

| File | Change |
|---|---|
| `src/subscription-router.ts` | `mentionsOthers()`, owned-thread gating, `ts` on `sub-continue`, `lastDeliveredTs` restore in `resolveThreadSession` |
| `src/event-router.ts` | pass `triggerTs` for all subscription variants; pass `msg.ts` on the legacy path |
| `src/adapter.ts` | `renderGapContext()`, hoisted thread fetch + gap prepend + reaction add in `dispatchToSession`, watermark advance/persist in `onSubscriptionMessage`, reaction remove in `handleSessionEnd`/`handleError` |
| `src/reaction-tracker.ts` (new) | FIFO reaction bookkeeping + Slack calls |
| `src/send-queue.ts` | add `reactions.add` / `reactions.remove` methods |
| `src/types.ts` | `SlackSessionMeta.lastDeliveredTs`, `processingReaction` config |
| `src/setup.ts`, `README.md` | `reactions:write` scope + docs |
| Tests | extend `subscription-router.test.ts`, `event-router.test.ts`, `adapter-thread-context.test.ts`; new `reaction-tracker.test.ts` |

---

### Task 1: `mentionsOthers` helper

**Files:**
- Modify: `src/subscription-router.ts` (after `stripBotMention`, ~line 80)
- Test: `src/__tests__/subscription-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/subscription-router.test.ts` (top-level `describe`, alongside the existing ones). Add `mentionsOthers` to the existing import from `../subscription-router.js`:

```ts
import { classifySubscription, mentionsOthers } from "../subscription-router.js";
```

```ts
describe("mentionsOthers", () => {
  it("detects a mention of another user", () => {
    expect(mentionsOthers("<@U2> can you check?", "BOT1")).toBe(true);
  });

  it("detects labeled and enterprise-style mentions", () => {
    expect(mentionsOthers("<@U2|alice> please", "BOT1")).toBe(true);
    expect(mentionsOthers("<@W2ENT> please", "BOT1")).toBe(true);
  });

  it("does not count the bot's own mention (bare or labeled)", () => {
    expect(mentionsOthers("<@BOT1> do it", "BOT1")).toBe(false);
    expect(mentionsOthers("<@BOT1|openacp> do it", "BOT1")).toBe(false);
  });

  it("returns true when the bot AND someone else are mentioned", () => {
    expect(mentionsOthers("<@BOT1> and <@U2> look", "BOT1")).toBe(true);
  });

  it("detects broadcast mentions (bare and labeled)", () => {
    expect(mentionsOthers("<!here> anyone?", "BOT1")).toBe(true);
    expect(mentionsOthers("<!here|here> anyone?", "BOT1")).toBe(true);
    expect(mentionsOthers("<!channel> heads up", "BOT1")).toBe(true);
    expect(mentionsOthers("<!everyone> hi", "BOT1")).toBe(true);
  });

  it("detects user-group mentions", () => {
    expect(mentionsOthers("<!subteam^S123ABC|@oncall> ping", "BOT1")).toBe(true);
  });

  it("returns false for plain text and non-mention markup", () => {
    expect(mentionsOthers("just words", "BOT1")).toBe(false);
    expect(mentionsOthers("a link <https://x.y|label>", "BOT1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: FAIL — `mentionsOthers` is not exported.

- [ ] **Step 3: Implement `mentionsOthers`**

In `src/subscription-router.ts`, after `stripBotMention`:

```ts
/**
 * True when `text` mentions someone OTHER than the given bot: another user/bot
 * (`<@U…>`, `<@W…>`, with or without `|label`), a broadcast (`<!here>`,
 * `<!channel>`, `<!everyone>`), or a user group (`<!subteam^…>`). Used to gate
 * owned-thread replies: such a reply is probably addressed to that someone,
 * not to this bot.
 */
export function mentionsOthers(text: string, botUserId: string): boolean {
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    if (m[1] !== botUserId) return true;
  }
  return /<!(?:here|channel|everyone)(?:\|[^>]+)?>|<!subteam\^[^>]+>/.test(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subscription-router.ts src/__tests__/subscription-router.test.ts
git commit -m "feat: mentionsOthers helper for reply gating"
```

---

### Task 2: Owned-thread reply gating

**Files:**
- Modify: `src/subscription-router.ts` (owned-thread branch of `classifySubscription`, ~line 139-143)
- Test: `src/__tests__/subscription-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("classifySubscription", …)` block:

```ts
  it("skips an owned-thread human reply that mentions someone else without mentioning the bot", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@U2> can you check this?", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("processes an owned-thread reply that mentions the bot AND someone else", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@BOT1> and <@U2> look at this", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("sub-continue");
  });

  it("skips an owned-thread reply that only carries a broadcast mention", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<!here> anyone around?", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("does not re-gate a whitelisted bot in an owned thread (its own gate already passed)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", text: "<@BOT1> build finished", ts: "169.2", thread_ts: "169.1", bot_id: "B_OK", subtype: "bot_message" },
      ctx({ allowedBotIds: ["B_OK"], hasThreadSession: () => true }),
    );
    expect(r.kind).toBe("sub-continue");
  });

  it("does not gate a TOP-LEVEL message that mentions someone else in 'all' mode", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "<@U2> fyi", ts: "169.9" },
      ctx({ subscribedChannels: [{ channelId: "C_SUB", trigger: "all" }] }),
    );
    expect(r.kind).toBe("sub-start");
  });
```

- [ ] **Step 2: Run tests to verify the new gating tests fail**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: the two "skips …" tests FAIL (currently `sub-continue`); the other three already pass (they pin current behavior).

- [ ] **Step 3: Implement the gate**

In `src/subscription-router.ts`, replace the owned-thread branch:

```ts
    // A thread the bot already owns → continue the existing session.
    if (ctx.hasThreadSession(channelId, msg.thread_ts)) {
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text };
    }
```

with:

```ts
    // A thread the bot already owns → continue the existing session, UNLESS the
    // reply @mentions someone else without mentioning this bot — then it is
    // almost certainly addressed to that someone, not the bot. Skipped content
    // is recovered later by gap backfill. Bot-authored messages already passed
    // the stricter whitelist+mention gate at the top and are not re-gated.
    if (ctx.hasThreadSession(channelId, msg.thread_ts)) {
      if (!fromBot && !mentionsBot(msg.text ?? "", ctx.botUserId) && mentionsOthers(msg.text ?? "", ctx.botUserId)) {
        return { kind: "ignore" };
      }
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subscription-router.ts src/__tests__/subscription-router.test.ts
git commit -m "feat: skip owned-thread replies addressed to someone else"
```

---

### Task 3: `ts` on sub-continue + `triggerTs` plumbing in the event router

**Files:**
- Modify: `src/subscription-router.ts` (Classification type + sub-continue returns)
- Modify: `src/event-router.ts` (subscription opts, `IncomingMessageCallback`, legacy call site)
- Test: `src/__tests__/subscription-router.test.ts`, `src/__tests__/event-router.test.ts`

- [ ] **Step 1: Update router tests to expect `ts` / `triggerTs`**

In `src/__tests__/subscription-router.test.ts`, the three `sub-continue` `toEqual` assertions gain `ts` (the replying message's ts):

```ts
// "continues a reply only when the thread is a known bot session"
expect(r).toEqual({ kind: "sub-continue", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "and the PR too", ts: "169.2" });
// "continues a known DM thread reply"
expect(r).toEqual({ kind: "sub-continue", channelId: "D123", threadTs: "1.1", userId: "U1", text: "more", ts: "1.2" });
// "continues (not starts) a mention in a thread that already has a bot session"
expect(r).toEqual({ kind: "sub-continue", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "more", ts: "169.5" });
```

In `src/__tests__/event-router.test.ts`, update the `onSubscription` / `onIncoming` assertions — `triggerTs` is now always populated from the triggering message:

```ts
// "routes a subscribed-channel mention to onSubscriptionMessage" (top-level, ts 169.1)
expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: "169.1", forwards: [] });
// "routes a subscribed-channel thread reply … when the thread is known" (reply ts 169.2)
expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "more", undefined, { triggerTs: "169.2", forwards: [] });
// "routes a top-level DM to onSubscriptionMessage" (ts 1.1)
expect(onSubscription).toHaveBeenCalledWith("D123", "1.1", "U1", "hello", undefined, { midThread: undefined, triggerTs: "1.1", forwards: [] });
// "plumbs midThread/triggerTs opts through for a mid-thread mention" — unchanged (already "169.5")
// "does not pass mid-thread opts for a top-level mention" (ts 169.1)
expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: "169.1", forwards: [] });
// "leaves legacy routing unchanged for non-subscribed channels" — onIncoming gains trailing ts
// (the fixture message has no ts → undefined)
expect(onIncoming).toHaveBeenCalledWith("openacp-session-abc1", "hello", "U1", undefined, [], undefined);
```

Also update the "continues a known DM thread reply via onSubscriptionMessage" assertion the same way as the C_SUB reply (its `triggerTs` is the reply's ts — check the fixture in that test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/subscription-router.test.ts src/__tests__/event-router.test.ts`
Expected: FAIL on the updated assertions.

- [ ] **Step 3: Add `ts` to the sub-continue classification**

In `src/subscription-router.ts`:

```ts
  | { kind: "sub-continue"; channelId: string; threadTs: string; userId: string; text: string; ts?: string };
```

and the single `sub-continue` return site (the owned-thread branch from Task 2):

```ts
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text, ts: msg.ts };
```

- [ ] **Step 4: Plumb `triggerTs` through the event router**

In `src/event-router.ts`:

1. Extend `IncomingMessageCallback` with a trailing `ts`:

```ts
export type IncomingMessageCallback = (
  sessionId: string, text: string, userId: string,
  files?: SlackFileInfo[], forwards?: ForwardedMessage[], ts?: string,
) => void | Promise<void>;
```

2. Replace the subscription `opts` construction (currently `cls.kind === "sub-start" ? { midThread: …, triggerTs: cls.triggerTs, forwards } : { forwards }`):

```ts
        // triggerTs is the triggering message's own ts for EVERY variant: the
        // adapter reacts to it ("processing" indicator) and advances the
        // gap-backfill watermark to it. Top-level starts trigger on the thread
        // root itself, so threadTs doubles as the trigger ts there.
        const opts =
          cls.kind === "sub-start"
            ? { midThread: cls.midThread, triggerTs: cls.triggerTs ?? cls.threadTs, forwards }
            : { triggerTs: cls.ts, forwards };
```

3. Pass `msg.ts` on the legacy call site:

```ts
        this.onIncoming(session.channelSlug, text, userId, files, forwards, msg.ts);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts src/__tests__/event-router.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/subscription-router.ts src/event-router.ts src/__tests__/subscription-router.test.ts src/__tests__/event-router.test.ts
git commit -m "feat: carry triggering-message ts through subscription and legacy routing"
```

---

### Task 4: `renderGapContext`

**Files:**
- Modify: `src/adapter.ts` (refactor `renderThreadContext` ~line 177-202, add `renderGapContext`)
- Test: `src/__tests__/adapter-thread-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/adapter-thread-context.test.ts` (import `renderGapContext` from `../adapter.js`):

```ts
describe("renderGapContext", () => {
  const BOT = "BOTU";

  it("includes only messages strictly after lastDeliveredTs, excluding the trigger and the bot's own", () => {
    const msgs: ThreadContextMessage[] = [
      { ts: "100.1", user: "U1", text: "already delivered" },
      { ts: "100.2", user: "U2", text: "skipped reply" },
      { ts: "100.3", user: BOT, text: "bot's own answer" },
      { ts: "100.4", user: "U3", text: "the trigger" },
    ];
    const out = renderGapContext(msgs, "100.1", BOT, "100.4");
    expect(out).toContain("<@U2>: skipped reply");
    expect(out).not.toContain("already delivered");
    expect(out).not.toContain("bot's own answer");
    expect(out).not.toContain("the trigger");
  });

  it("uses numeric ts comparison, not string comparison", () => {
    // String compare would order "9.0" AFTER "10.5"; numeric compare must not.
    const msgs: ThreadContextMessage[] = [
      { ts: "9.0", user: "U1", text: "old message" },
      { ts: "11.0", user: "U2", text: "new message" },
    ];
    const out = renderGapContext(msgs, "10.5", "BOTU");
    expect(out).not.toContain("old message");
    expect(out).toContain("new message");
  });

  it("wraps the gap in its own distinct header", () => {
    const out = renderGapContext([{ ts: "2", user: "U1", text: "hi" }], "1", "BOTU");
    expect(out).toBe(
      [
        "[Thread context — messages in this thread since your last turn that were not individually delivered]",
        "<@U1>: hi",
        "[End thread context]",
      ].join("\n"),
    );
  });

  it("returns empty string when nothing falls in the gap", () => {
    expect(renderGapContext([], "1", "BOTU")).toBe("");
    expect(renderGapContext([{ ts: "1", user: "U1", text: "delivered" }], "1", "BOTU")).toBe("");
    expect(renderGapContext([{ ts: "2", user: "U1", text: "trigger" }], "1", "BOTU", "2")).toBe("");
  });

  it("keeps other bots' messages (only this bot's own are excluded)", () => {
    const out = renderGapContext([{ ts: "2", bot_id: "B_CI", text: "build failed" }], "1", "BOTU");
    expect(out).toContain("<@B_CI>: build failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/adapter-thread-context.test.ts`
Expected: FAIL — `renderGapContext` is not exported.

- [ ] **Step 3: Implement (refactor + new function)**

In `src/adapter.ts`, refactor `renderThreadContext` so the per-message line rendering is shared, and add `renderGapContext`. Replace the body of `renderThreadContext` (lines 177-202) with:

```ts
/** Shared line renderer for thread-context blocks: "<@author>: body" per message. */
function renderContextLines(
  messages: ThreadContextMessage[],
  skip: (m: ThreadContextMessage) => boolean,
): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (skip(m)) continue;
    const text = (m.text ?? "").trim();
    // Bot/integration posts (GitHub, CI, alerting bots) carry an empty top-level
    // text and put everything in `attachments[]`; include that so an @mention in
    // such a thread actually sees what was posted. Restricted to bot messages:
    // human shares/forwards also live in `attachments[]` but are surfaced
    // separately via extractForwards/forwardedTexts, so rendering them here too
    // would duplicate them.
    const attachmentText = m.bot_id ? renderMessageAttachments(m.attachments) : "";
    const body = [text, attachmentText].filter(Boolean).join("\n");
    if (!body) continue;
    const author = m.user ? `<@${m.user}>` : m.bot_id ? `<@${m.bot_id}>` : "<unknown>";
    lines.push(`${author}: ${body}`);
  }
  return lines;
}

export function renderThreadContext(messages: ThreadContextMessage[], triggerTs?: string): string {
  // Skip the triggering message — it's already dispatched as the user text.
  const lines = renderContextLines(messages, (m) => Boolean(triggerTs && m.ts === triggerTs));
  if (lines.length === 0) return "";
  return [
    "[Thread context — full history of the Slack thread this conversation was started from]",
    ...lines,
    "[End thread context]",
  ].join("\n");
}

/**
 * Render the messages a thread accumulated since the agent's last delivered
 * message (`lastDeliveredTs`) as a prependable context block — the "gap" left by
 * replies that were skipped (e.g. addressed to someone else) or arrived while
 * the process was down. Excludes the triggering message (dispatched separately
 * as the user text) and the bot's own replies (the agent already has them in
 * context). ts comparison is numeric: Slack ts strings must never be compared
 * lexicographically. Returns "" when the gap is empty.
 */
export function renderGapContext(
  messages: ThreadContextMessage[],
  lastDeliveredTs: string,
  botUserId: string,
  triggerTs?: string,
): string {
  const watermark = Number.parseFloat(lastDeliveredTs);
  const lines = renderContextLines(
    messages,
    (m) =>
      !m.ts ||
      !(Number.parseFloat(m.ts) > watermark) ||
      m.ts === triggerTs ||
      m.user === botUserId,
  );
  if (lines.length === 0) return "";
  return [
    "[Thread context — messages in this thread since your last turn that were not individually delivered]",
    ...lines,
    "[End thread context]",
  ].join("\n");
}
```

(Keep the existing doc comment on `renderThreadContext`; the duplicated bot-attachment comment moves into `renderContextLines`.)

- [ ] **Step 4: Run tests to verify they pass (including existing renderThreadContext tests)**

Run: `npx vitest run src/__tests__/adapter-thread-context.test.ts`
Expected: PASS — both old and new describes.

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/adapter-thread-context.test.ts
git commit -m "feat: renderGapContext for backfilling skipped thread messages"
```

---

### Task 5: Types & send-queue methods

**Files:**
- Modify: `src/types.ts` (`SlackSessionMeta`, `SlackChannelConfigSchema`)
- Modify: `src/send-queue.ts` (`SlackMethod`, `METHOD_RPM`)

- [ ] **Step 1: Add `lastDeliveredTs` to `SlackSessionMeta`**

In `src/types.ts`:

```ts
// Per-session metadata stored in SessionRecord.platform
export interface SlackSessionMeta {
  channelId: string;     // Slack channel ID for this session (C… for channels, D… for DMs)
  channelSlug: string;   // e.g. "openacp-fix-auth-bug-a3k9", or "C123:169..." for subscription threads
  /** Slack thread root (parent message ts) when this session is bound to a subscribed channel thread. */
  threadTs?: string;
  /**
   * ts of the last thread message delivered to the agent (subscription threads).
   * Watermark for gap backfill: messages after it that were never individually
   * dispatched (skipped replies, downtime) are prepended as context on the next
   * dispatch. Persisted with the rest of the platform fields.
   */
  lastDeliveredTs?: string;
}
```

- [ ] **Step 2: Add `processingReaction` to the config schema**

In `src/types.ts`, after `readThreadHistory` inside `SlackChannelConfigSchema`:

```ts
  /**
   * Emoji name (no colons) added as a reaction to a message while the agent is
   * processing it, and removed when the turn completes — e.g. "eyes" or
   * "hourglass". Set to "" to disable the indicator. Requires the
   * `reactions:write` OAuth scope.
   */
  processingReaction: z.string().default("eyes"),
```

- [ ] **Step 3: Register the reactions methods in the send queue**

In `src/send-queue.ts`:

```ts
export type SlackMethod =
  | "chat.postMessage"
  | "chat.update"
  | "chat.delete"
  | "conversations.create"
  | "conversations.rename"
  | "conversations.archive"
  | "conversations.invite"
  | "conversations.join"
  | "conversations.unarchive"
  | "conversations.info"
  | "conversations.open"
  | "conversations.replies"
  | "reactions.add"
  | "reactions.remove";
```

and in `METHOD_RPM`:

```ts
  "conversations.replies":   50, // Tier 3
  "reactions.add":           50, // Tier 3
  "reactions.remove":        50, // Tier 3
```

(`METHOD_RPM` is `Record<SlackMethod, number>` — the compiler enforces completeness.)

- [ ] **Step 4: Verify it compiles and existing tests pass**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean compile; all tests PASS (defaults only, no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/send-queue.ts
git commit -m "feat: lastDeliveredTs meta, processingReaction config, reactions send-queue methods"
```

---

### Task 6: `ReactionTracker` module

**Files:**
- Create: `src/reaction-tracker.ts`
- Test: `src/__tests__/reaction-tracker.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/reaction-tracker.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/reaction-tracker.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/reaction-tracker.ts`**

```ts
// src/reaction-tracker.ts
// "Processing" indicator: a reaction (default 👀) on the message the agent is
// currently working on. add() marks a triggering message as seen; remove() is
// called at turn end and clears the OLDEST outstanding reaction (FIFO — matches
// core's FIFO prompt queue, so each turn-end clears its own trigger).
// In-memory only: a crash mid-turn leaves the reaction behind (accepted).
import type { Logger } from "./types.js";

export type ReactionEnqueue = (
  method: "reactions.add" | "reactions.remove",
  params: Record<string, unknown>,
) => Promise<unknown>;

interface PendingReaction {
  channel: string;
  ts: string;
  /** Settles when the reactions.add call has completed (never rejects). remove()
   * awaits it so a rate-limit-delayed add cannot land AFTER its own remove. */
  added: Promise<void>;
}

/** Slack platform errors arrive as `{ data: { error: "code" } }` on the thrown value. */
function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } } | null | undefined)?.data?.error;
}

export class ReactionTracker {
  private pending = new Map<string, PendingReaction[]>();

  constructor(
    private enqueue: ReactionEnqueue,
    private emoji: string,
    private log: Logger,
  ) {}

  /**
   * Add the processing reaction to a triggering message and remember it (FIFO).
   * Fire-and-forget: the API call never blocks or fails the dispatch.
   */
  add(sessionKey: string, channel: string, ts: string): void {
    if (!this.emoji) return;
    const added = this.enqueue("reactions.add", { channel, timestamp: ts, name: this.emoji })
      .then(() => undefined)
      .catch((err) => {
        if (slackErrorCode(err) === "already_reacted") return;
        this.log.warn({ err, channel, ts }, "Failed to add processing reaction");
      });
    const list = this.pending.get(sessionKey) ?? [];
    list.push({ channel, ts, added });
    this.pending.set(sessionKey, list);
  }

  /** Turn ended: remove the oldest outstanding reaction for this session. */
  async remove(sessionKey: string): Promise<void> {
    if (!this.emoji) return;
    const list = this.pending.get(sessionKey);
    const ref = list?.shift();
    if (!ref) return;
    if (list && list.length === 0) this.pending.delete(sessionKey);
    await ref.added;
    try {
      await this.enqueue("reactions.remove", { channel: ref.channel, timestamp: ref.ts, name: this.emoji });
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "no_reaction" || code === "message_not_found") return;
      this.log.warn({ err, channel: ref.channel, ts: ref.ts }, "Failed to remove processing reaction");
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/reaction-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/reaction-tracker.ts src/__tests__/reaction-tracker.test.ts
git commit -m "feat: ReactionTracker — FIFO processing-reaction bookkeeping"
```

---

### Task 7: `resolveThreadSession` restores `lastDeliveredTs` from the record

**Files:**
- Modify: `src/subscription-router.ts` (`ThreadSessionDeps`, record path of `resolveThreadSession`)
- Test: `src/__tests__/subscription-router.test.ts`

- [ ] **Step 1: Write the failing test**

The existing `resolveThreadSession` tests build a `ThreadSessionDeps` mock (see the `d.patchRecord` fixture around line 241). Add:

```ts
  it("restores lastDeliveredTs from a persisted record so gap backfill survives restarts", async () => {
    const d = makeDeps(); // however the surrounding tests build deps
    d.getSessionByThread = vi.fn().mockReturnValue(undefined);
    d.getRecordByThread = vi.fn().mockReturnValue({
      sessionId: "sess-old",
      platform: { channelId: "C_SUB", topicId: "C_SUB:169.1", threadTs: "169.1", lastDeliveredTs: "169.7" },
    });
    const { sessionId, meta } = await resolveThreadSession(d, "C_SUB", "169.1");
    expect(sessionId).toBe("sess-old");
    expect(meta.lastDeliveredTs).toBe("169.7");
  });
```

(Adapt `makeDeps()` to whatever helper the existing `resolveThreadSession` describe uses; if deps are built inline, build them inline here the same way.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: FAIL — `meta.lastDeliveredTs` is `undefined`.

- [ ] **Step 3: Implement**

In `src/subscription-router.ts`:

1. Widen `ThreadSessionDeps.getRecordByThread`:

```ts
  getRecordByThread: (
    platform: string,
    threadId: string,
  ) => { sessionId: string; platform?: Record<string, unknown> } | undefined;
```

2. In the record path of `resolveThreadSession`, restore the watermark:

```ts
  // Persisted (post-restart): bind meta to the stored session and let
  // core.handleMessage(threadId=key) lazily resume it. Do NOT create a new
  // session — that would orphan the stored one and lose its agent context.
  const record = deps.getRecordByThread("slack", key);
  if (record) {
    const lastDeliveredTs = (record.platform as { lastDeliveredTs?: string } | undefined)?.lastDeliveredTs;
    const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs, lastDeliveredTs };
    deps.sessions.set(record.sessionId, meta);
    return { sessionId: record.sessionId, meta };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/subscription-router.ts src/__tests__/subscription-router.test.ts
git commit -m "feat: restore lastDeliveredTs watermark when resuming a persisted thread session"
```

---

### Task 8: Adapter wiring — gap prepend, watermark advance, reactions

This task is wiring only; every piece of logic it connects was unit-tested in Tasks 1–7. Verification is compile + full suite + a careful read-through.

**Files:**
- Modify: `src/adapter.ts`:
  - imports (~line 28 region)
  - field declarations (~line 470/511 region)
  - `start()` queue construction (~line 557)
  - legacy `onIncoming` closure (~line 689-696)
  - `onSubscriptionMessage` closure (~line 752-792)
  - `dispatchToSession` (~line 1405-1485)
  - `handleSessionEnd` (~line 1526), `handleError` (~line 1557)

- [ ] **Step 1: Construct the tracker**

Add the import:

```ts
import { ReactionTracker } from "./reaction-tracker.js";
```

Add the field next to `private queue!: SlackSendQueue;`:

```ts
  private reactions!: ReactionTracker;
```

In `start()`, right after `this.queue = new SlackSendQueue(this.webClient);`:

```ts
    this.reactions = new ReactionTracker(
      (method, params) => this.queue.enqueue(method, params),
      this.slackConfig.processingReaction ?? "eyes",
      this.log,
    );
```

- [ ] **Step 2: Legacy path passes the trigger ts**

Replace the `onIncoming` closure (adapter.ts:689-696):

```ts
      (sessionChannelSlug, text, userId, files, forwards, ts) => {
        const meta = [...this.sessions.values()].find((m) => m.channelSlug === sessionChannelSlug);
        return this.dispatchToSession(sessionChannelSlug, text, userId, files, {
          channelId: meta?.channelId,
          threadTs: meta?.threadTs,
          triggerTs: ts,
          forwards,
        });
      },
```

- [ ] **Step 3: `onSubscriptionMessage` — pass the watermark, advance it after dispatch**

Replace the `onSubscriptionMessage` closure body (adapter.ts:753-791) with:

```ts
      async (channelId, threadTs, userId, text, files, opts) => {
        try {
          const { sessionId, meta } = await resolveThreadSession(
            {
              sessions: this.sessions,
              getSessionByThread: (p, t) => this.core.sessionManager.getSessionByThread(p, t),
              getRecordByThread: (p, t) => this.core.sessionManager.getRecordByThread(p, t),
              handleNewSession: (p, a, w, o) => this.core.handleNewSession(p, a, w, o),
              patchRecord: (sid, patch) => this.core.sessionManager.patchRecord(sid, patch),
            },
            channelId,
            threadTs,
          );

          // When the session is started by an @mention INSIDE an existing human
          // thread, the agent has no idea what was already discussed there.
          // Fetch the full thread and prepend it as a context block so the agent
          // sees the conversation it was pulled into. The triggering message
          // (already delivered as `text`) is excluded by ts. Degrade gracefully:
          // if the fetch fails, dispatch the bare message rather than dropping it.
          let dispatchText = text;
          if (opts?.midThread) {
            try {
              const ctxBlock = await this.buildThreadContext(channelId, threadTs, opts.triggerTs);
              if (ctxBlock) dispatchText = `${ctxBlock}\n\n${text}`;
            } catch (ctxErr) {
              this.log.warn({ err: ctxErr, channelId, threadTs }, "Failed to fetch thread history for mid-thread mention; dispatching without context");
            }
          }

          await this.dispatchToSession(meta.channelSlug, dispatchText, userId, files, {
            channelId,
            threadTs,
            triggerTs: opts?.triggerTs,
            forwards: opts?.forwards,
            lastDeliveredTs: meta.lastDeliveredTs,
          });

          // Advance the gap-backfill watermark: everything up to and including
          // this trigger has now been delivered (skipped messages in between
          // were just backfilled by dispatchToSession). Persisted so backfill
          // keeps working across restarts.
          if (opts?.triggerTs) {
            meta.lastDeliveredTs = opts.triggerTs;
            try {
              await this.core.sessionManager.patchRecord(sessionId, {
                platform: { channelId, topicId: meta.channelSlug, threadTs, lastDeliveredTs: opts.triggerTs },
              });
            } catch (patchErr) {
              this.log.warn({ err: patchErr, sessionId }, "Failed to persist lastDeliveredTs");
            }
          }
        } catch (err) {
          this.log.error({ err, channelId, threadTs }, "Failed to handle subscription message");
        }
      },
```

- [ ] **Step 4: `dispatchToSession` — reaction add, hoisted fetch, gap prepend**

Replace `dispatchToSession` (adapter.ts:1405-1485). The signature gains `lastDeliveredTs` in `extras`; the body adds the reaction call, hoists the thread fetch out of the attachment block, and prepends the gap:

```ts
  private async dispatchToSession(
    sessionChannelSlug: string,
    text: string,
    userId: string,
    files?: SlackFileInfo[],
    extras?: { channelId?: string; threadTs?: string; triggerTs?: string; forwards?: ForwardedMessage[]; lastDeliveredTs?: string },
  ): Promise<void> {
    if (text.startsWith("/")) {
      const handled = await this.tryCommandDispatch(sessionChannelSlug, text, userId);
      if (handled) return;
    }

    // Processing indicator: mark the triggering message as seen. Fire-and-forget —
    // a reaction failure must never block or fail the dispatch.
    if (extras?.channelId && extras?.triggerTs) {
      this.reactions.add(sessionChannelSlug, extras.channelId, extras.triggerTs);
    }

    let dispatchText = text;
    let attachments: Attachment[] | undefined;

    try {
      // One thread fetch serves BOTH gap backfill and attachment collection.
      // readThreadHistory: false means "don't walk the thread" and disables both.
      let threadMessages: ThreadContextMessage[] | undefined;
      if (this.slackConfig.readThreadHistory !== false && extras?.channelId && extras?.threadTs) {
        try {
          threadMessages = await fetchThreadMessages(
            (method: any, params: any) => this.queue.enqueue(method, params),
            this.log, extras.channelId, extras.threadTs,
          );
        } catch (err) {
          this.log.warn({ err }, "Failed to fetch thread history; dispatching without gap backfill or thread attachments");
        }
      }

      // Gap backfill: prepend thread messages the agent never saw (skipped
      // replies, downtime) since the lastDeliveredTs watermark.
      if (threadMessages && extras?.lastDeliveredTs) {
        const gap = renderGapContext(threadMessages, extras.lastDeliveredTs, this.botUserId, extras.triggerTs);
        if (gap) dispatchText = `${gap}\n\n${dispatchText}`;
      }

      const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
      if (sessionId && this.fileProxy) {
        const seen = this.surfacedFiles.get(sessionChannelSlug) ?? new Set<string>();
        const { attachments: collected, forwardedTexts } = collectAttachments({
          triggerFiles: files,
          threadMessages,
          forwards: extras?.forwards,
          seen,
        });

        const payload = await buildAttachmentPayload({
          sessionId,
          inlineMaxBytes: this.slackConfig.attachmentInlineMaxBytes ?? 16384,
          collected,
          forwardedTexts,
          download: (url) => this.downloadSlackFile(url),
          saveFile: (sid, name, buf, mime) => this.fileService.saveFile(sid, name, buf, mime),
          registerProxy: (f) => this.fileProxy!.register({ url_private: f.url_private, mimetype: f.mimetype, name: f.name }),
          log: this.log,
        });

        for (const id of payload.surfacedIds) seen.add(id);
        this.surfacedFiles.set(sessionChannelSlug, seen);

        if (payload.promptAdditions) dispatchText = `${dispatchText}\n\n${payload.promptAdditions}`;
        if (payload.attachments.length) attachments = payload.attachments;
      }
    } catch (err) {
      this.log.error({ err }, "Failed to process attachments; dispatching message text only");
    }
```

(The rest of the method — channel-context header and `core.handleMessage` — is unchanged.)

Note two deliberate details:
- The attachment append now uses `${dispatchText}\n\n${payload.promptAdditions}` (was `${text}\n\n…`) so the gap block survives. Final order: gap → message text → attachments → wrapped by the channel header.
- The fetch is no longer gated on `sessionId && this.fileProxy` — gap backfill must work even without the file proxy. Attachment collection keeps its own gate.

- [ ] **Step 5: Remove the reaction at turn end**

In `handleSessionEnd` (adapter.ts:1526), after `const meta = this.getSessionMeta(sessionId); if (!meta) return;`:

```ts
    // Turn complete → agent idle: clear the processing reaction (fire-and-forget).
    void this.reactions.remove(meta.channelSlug);
```

Add the same two lines at the same position in `handleError` (after its `if (!meta) return;`).

- [ ] **Step 6: Compile and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean compile, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: wire gap backfill and processing reaction into dispatch and turn end"
```

---

### Task 9: OAuth scope & docs

**Files:**
- Modify: `src/setup.ts` (manifest scopes, ~line 41-49)
- Modify: `README.md` (~line 90 scope paragraph)

- [ ] **Step 1: Add `reactions:write` to the app manifest**

In `src/setup.ts`, extend the bot scopes array:

```ts
          bot: [
            'channels:manage', 'channels:history', 'channels:join', 'channels:read',
            'chat:write', 'chat:write.public',
            'commands',
            'groups:write', 'groups:history', 'groups:read',
            'files:read', 'files:write',
            'im:history',
            'im:write',
            'reactions:write',
          ],
```

- [ ] **Step 2: Document the indicator and the scope in README.md**

After the paragraph ending "…for reading thread replies." (~line 92), add:

```markdown
### Processing indicator

While the agent works on a message, the bot adds a reaction (default 👀 `eyes`)
to it and removes the reaction when the turn completes. Configure with
`processingReaction` (emoji name without colons, e.g. `"hourglass"`); set it to
`""` to disable. Requires the `reactions:write` scope — existing installs
without it keep working, the indicator just logs a warning until the app is
reinstalled with the updated manifest.

In bot-owned threads the bot also skips replies that @mention someone else
without mentioning the bot (including `@here`/`@channel`/user-group-only
mentions). Skipped replies are not lost: the next processed message prepends
them as context ("gap backfill"). Gap backfill is disabled when
`readThreadHistory: false`, since it relies on walking the thread.
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

```bash
git add src/setup.ts README.md
git commit -m "docs: reactions:write scope, processing indicator and gating docs"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full build + suite**

Run: `npm run build && npx vitest run`
Expected: build succeeds, all tests PASS.

- [ ] **Step 2: Re-read the spec against the diff**

Run: `git diff main --stat` and skim each spec section (gating matrix, watermark flow, reaction FIFO, config, scopes) against the implementation. Fix anything missing.

- [ ] **Step 3: Mark the spec implemented**

In `docs/superpowers/specs/2026-06-11-thread-reply-gating-design.md`, change `**Status:** Planned` to `**Status:** Implemented`.

```bash
git add docs/superpowers/specs/2026-06-11-thread-reply-gating-design.md
git commit -m "docs: mark thread reply gating spec implemented"
```
