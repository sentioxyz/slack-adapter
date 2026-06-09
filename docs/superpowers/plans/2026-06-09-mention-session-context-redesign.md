# @mention Session-Context Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the bot is @mentioned anywhere in a thread, create-or-resume one session bound to that thread and feed the agent exactly the thread content it hasn't seen yet (channel name+topic, body text, attachments, forwarded messages), tracked by a persisted high-water-mark.

**Architecture:** Replace today's fragmented decision (classify sub-start/continue → midThread-gated text fetch → sessionId-gated attachment re-fetch) with one path in `onSubscriptionMessage`: resolve the session, read the persisted `lastReadTs`, fetch the thread **once**, compute the unread delta, render text + collect attachments from that delta, dispatch, then persist the new `lastReadTs`. Absent `lastReadTs` ⇒ NEW session ⇒ full history; present ⇒ RESUME ⇒ delta only. The bulk of the logic is extracted into pure functions tested in isolation, matching the codebase's existing `renderThreadContext`/`fetchThreadMessages` test style.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Slack Web API (`conversations.replies`, `conversations.info`). No lint step; typecheck via `tsc`.

**Spec:** `docs/superpowers/specs/2026-06-09-mention-session-context-redesign-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/adapter.ts` | Hosts the pure context helpers + the adapter wiring | Modify: add `selectThreadDelta`, enhance `renderThreadContext`, change `fetchThreadMessages` return, add hwm/topic helpers, rewrite `onSubscriptionMessage` + `dispatchToSession`, add `resolveChannelInfo` |
| `src/event-router.ts` | Routes Slack messages → classification → subscription callback | Modify: forward `msg.ts` as `triggerTs` for every handled message (~152-155) |
| `src/__tests__/event-router.test.ts` | Tests for the router | Modify: 5 `triggerTs` expectation updates |
| `src/__tests__/thread-delta.test.ts` | Unit tests for `selectThreadDelta` | Create |
| `src/__tests__/adapter-thread-context.test.ts` | Tests for `renderThreadContext` / `fetchThreadContext` | Modify: add title + truncation + sinceTs cases |
| `src/__tests__/fetch-thread-messages.test.ts` | Tests for `fetchThreadMessages` | Modify: object return + truncated flag |
| `src/__tests__/high-water-mark.test.ts` | Unit tests for `readLastReadTs` / `buildLastReadTsPatch` / `extractChannelTopic` | Create |
| `docs/superpowers/specs/...-design.md` | Spec | Modify: mark Implemented at the end |

**Note on testing strategy:** This codebase never instantiates `SlackAdapter` in tests — it extracts pure functions and tests those (see `adapter-thread-context.test.ts`). This plan follows that: all new logic lands in pure exported functions (Tasks 1–4) with full unit coverage; the event-router change (Task 5) has its own tests; the adapter wiring (Task 6) is verified by the typecheck + full suite (Task 7), not a new adapter-instantiation test.

---

## Task 1: `selectThreadDelta` — pure unread-delta selector

Splits a fetched thread into "messages the agent hasn't seen" plus the high-water-mark ts. This is the linchpin for NEW (no `sinceTs` ⇒ everything) vs RESUME (`sinceTs` present ⇒ only newer). `newestTs` always reflects the newest message **including** the trigger, so the caller can persist it.

**Files:**
- Modify: `src/adapter.ts` (add export near `renderThreadContext`, ~line 142)
- Test: `src/__tests__/thread-delta.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/thread-delta.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectThreadDelta, type ThreadContextMessage } from "../adapter.js";

const msgs: ThreadContextMessage[] = [
  { ts: "100.1", user: "U1", text: "first" },
  { ts: "100.2", user: "U2", text: "second" },
  { ts: "100.3", user: "U3", text: "third (the @mention)" },
];

describe("selectThreadDelta", () => {
  it("returns ALL messages when no sinceTs (NEW session) and reports newestTs", () => {
    const d = selectThreadDelta(msgs);
    expect(d.messages.map((m) => m.ts)).toEqual(["100.1", "100.2", "100.3"]);
    expect(d.newestTs).toBe("100.3");
  });

  it("returns only messages strictly newer than sinceTs (RESUME)", () => {
    const d = selectThreadDelta(msgs, "100.1");
    expect(d.messages.map((m) => m.ts)).toEqual(["100.2", "100.3"]);
    expect(d.newestTs).toBe("100.3");
  });

  it("excludes the trigger message from the delta but still counts it toward newestTs", () => {
    const d = selectThreadDelta(msgs, undefined, "100.3");
    expect(d.messages.map((m) => m.ts)).toEqual(["100.1", "100.2"]);
    expect(d.newestTs).toBe("100.3");
  });

  it("compares ts numerically, not lexically (10-digit vs 9-digit seconds)", () => {
    const wide: ThreadContextMessage[] = [
      { ts: "999999999.5", user: "U1", text: "older 9-digit" },
      { ts: "1000000000.5", user: "U2", text: "newer 10-digit" },
    ];
    const d = selectThreadDelta(wide, "999999999.5");
    expect(d.messages.map((m) => m.ts)).toEqual(["1000000000.5"]);
  });

  it("yields an empty delta when everything is at or below sinceTs", () => {
    const d = selectThreadDelta(msgs, "100.3");
    expect(d.messages).toEqual([]);
    expect(d.newestTs).toBe("100.3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/thread-delta.test.ts`
Expected: FAIL — `selectThreadDelta` is not exported.

- [ ] **Step 3: Implement `selectThreadDelta`**

In `src/adapter.ts`, immediately after the `renderThreadContext` function (after its closing brace at ~line 142), add:

```typescript
/** Result of {@link selectThreadDelta}: the messages to feed plus the high-water-mark. */
export interface ThreadDelta {
  /** Messages the agent has not seen: ts > sinceTs (when given), trigger excluded. */
  messages: ThreadContextMessage[];
  /** Newest ts across ALL input messages (incl. the trigger) — persist as lastReadTs. */
  newestTs?: string;
}

/**
 * Split a fetched thread into the unread delta plus the high-water-mark ts.
 *
 * - `sinceTs` undefined  → NEW session: return every message (full history).
 * - `sinceTs` given      → RESUME: return only messages strictly newer than it.
 * - `triggerTs`          → the @mention message itself, dispatched separately as
 *                          the user prompt, so excluded from the delta — but it
 *                          still advances `newestTs` so the next turn won't re-read it.
 *
 * ts values are Slack "seconds.micros" strings compared NUMERICALLY (lexical
 * compare breaks across the 9→10 digit second boundary).
 */
export function selectThreadDelta(
  messages: ThreadContextMessage[],
  sinceTs?: string,
  triggerTs?: string,
): ThreadDelta {
  const newer = (a?: string, b?: string) => Number(a ?? 0) > Number(b ?? 0);
  const out: ThreadContextMessage[] = [];
  let newestTs: string | undefined;
  for (const m of messages) {
    if (m.ts && newer(m.ts, newestTs)) newestTs = m.ts;
    if (triggerTs && m.ts === triggerTs) continue;
    if (sinceTs && (!m.ts || !newer(m.ts, sinceTs))) continue;
    out.push(m);
  }
  return { messages: out, newestTs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/thread-delta.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/thread-delta.test.ts
git commit -m "feat: add selectThreadDelta for unread thread-history delta"
```

---

## Task 2: Enhance `renderThreadContext` with channel title + truncation note

Adds the "title" (channel name + topic) to the context block heading and an explicit truncation note, without breaking the existing 2-arg callers/tests.

**Files:**
- Modify: `src/adapter.ts:125-142` (`renderThreadContext`)
- Test: `src/__tests__/adapter-thread-context.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/adapter-thread-context.test.ts`, inside the existing `describe("renderThreadContext", ...)` block, add:

```typescript
  it("uses channel label + topic in the heading when provided", () => {
    const msgs: ThreadContextMessage[] = [{ ts: "1", user: "U1", text: "hi" }];
    const out = renderThreadContext(msgs, undefined, {
      channelLabel: "#general",
      channelTopic: "Team chat",
    });
    expect(out).toContain("[Thread context — history of the Slack thread in #general (topic: Team chat)]");
    expect(out).toContain("<@U1>: hi");
  });

  it("omits the topic clause when no topic is given but still names the channel", () => {
    const msgs: ThreadContextMessage[] = [{ ts: "1", user: "U1", text: "hi" }];
    const out = renderThreadContext(msgs, undefined, { channelLabel: "#general" });
    expect(out).toContain("[Thread context — history of the Slack thread in #general]");
    expect(out).not.toContain("topic:");
  });

  it("injects a truncation note when truncated is true", () => {
    const msgs: ThreadContextMessage[] = [{ ts: "1", user: "U1", text: "hi" }];
    const out = renderThreadContext(msgs, undefined, { truncated: true });
    expect(out).toMatch(/older messages.*omitted/i);
  });

  it("keeps the original heading and no note when opts is omitted (back-compat)", () => {
    const msgs: ThreadContextMessage[] = [{ ts: "1", user: "U1", text: "hi" }];
    const out = renderThreadContext(msgs);
    expect(out).toContain("[Thread context — full history of the Slack thread this conversation was started from]");
    expect(out).not.toMatch(/omitted/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/adapter-thread-context.test.ts`
Expected: FAIL — `renderThreadContext` ignores a 3rd argument; heading/note assertions fail.

- [ ] **Step 3: Implement the enhancement**

In `src/adapter.ts`, replace the entire `renderThreadContext` function (currently lines 125–142) with:

```typescript
/** Optional presentation controls for {@link renderThreadContext}. */
export interface ThreadContextOpts {
  /** Channel label like "#general" — used as the block's "title". */
  channelLabel?: string;
  /** Channel topic/purpose text, appended to the title when present. */
  channelTopic?: string;
  /** When true, append a note that older messages were dropped by the page cap. */
  truncated?: boolean;
}

export function renderThreadContext(
  messages: ThreadContextMessage[],
  triggerTs?: string,
  opts?: ThreadContextOpts,
): string {
  const lines: string[] = [];
  for (const m of messages) {
    // Skip the triggering message — it's already dispatched as the user text.
    if (triggerTs && m.ts === triggerTs) continue;
    const text = (m.text ?? "").trim();
    if (!text) continue;
    const author = m.user ? `<@${m.user}>` : m.bot_id ? `<@${m.bot_id}>` : "<unknown>";
    lines.push(`${author}: ${text}`);
  }
  if (lines.length === 0) return "";

  const heading = opts?.channelLabel
    ? `[Thread context — history of the Slack thread in ${opts.channelLabel}${
        opts.channelTopic ? ` (topic: ${opts.channelTopic})` : ""
      }]`
    : "[Thread context — full history of the Slack thread this conversation was started from]";

  const out = [heading];
  if (opts?.truncated) {
    out.push("[Note: older messages were omitted — the thread exceeds the history fetch limit.]");
  }
  out.push(...lines, "[End thread context]");
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/adapter-thread-context.test.ts`
Expected: PASS (original 6 + 4 new = 10 in the `renderThreadContext` block; the `fetchThreadContext` block still passes).

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/adapter-thread-context.test.ts
git commit -m "feat: render channel title + truncation note in thread context"
```

---

## Task 3: `fetchThreadMessages` surfaces a `truncated` flag

Today truncation is only logged. To inject the note (Task 2) the caller needs the flag, so `fetchThreadMessages` returns `{ messages, truncated }`. Two internal callers and two tests are updated.

**Files:**
- Modify: `src/adapter.ts:254-309` (`fetchThreadMessages`, `fetchThreadContext`)
- Modify: `src/adapter.ts:1368-1371` (the `dispatchToSession` caller)
- Test: `src/__tests__/fetch-thread-messages.test.ts`, `src/__tests__/adapter-thread-context.test.ts`

- [ ] **Step 1: Update the failing test (fetch-thread-messages)**

Replace the body of `src/__tests__/fetch-thread-messages.test.ts` with:

```typescript
import { describe, expect, it, vi } from "vitest";
import { fetchThreadMessages } from "../adapter.js";

const log = { info() {}, warn: vi.fn(), error() {}, debug() {} };

describe("fetchThreadMessages", () => {
  it("returns messages with their files across pages and truncated=false", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "1", user: "U1", files: [{ id: "F1", name: "a", mimetype: "image/png", size: 1, url_private: "u" }] }],
        has_more: true,
        response_metadata: { next_cursor: "c1" },
      })
      .mockResolvedValueOnce({ messages: [{ ts: "2", user: "U2" }], has_more: false });

    const { messages, truncated } = await fetchThreadMessages(enqueue as any, log as any, "C1", "1");
    expect(messages).toHaveLength(2);
    expect(messages[0].files?.[0].id).toBe("F1");
    expect(truncated).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("reports truncated=true when the page cap is hit", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      messages: [{ ts: "x", user: "U1", text: "msg" }],
      has_more: true,
      response_metadata: { next_cursor: "MORE" },
    });
    const { truncated } = await fetchThreadMessages(enqueue as any, log as any, "C1", "1", /* maxPages */ 2);
    expect(truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/fetch-thread-messages.test.ts`
Expected: FAIL — destructuring `{ messages, truncated }` from an array yields `undefined`.

- [ ] **Step 3: Change `fetchThreadMessages` return type**

In `src/adapter.ts`, add this interface just above `fetchThreadMessages` (~line 253), and change the signature + return:

```typescript
/** Result of paging a thread: the messages plus whether the page cap dropped any. */
export interface FetchThreadResult {
  messages: ThreadContextMessage[];
  /** True when the thread exceeded `maxPages` and the oldest head was dropped. */
  truncated: boolean;
}
```

Change the signature line from:

```typescript
): Promise<ThreadContextMessage[]> {
```

to:

```typescript
): Promise<FetchThreadResult> {
```

and change the final `return collected;` (currently line 296) to:

```typescript
  return { messages: collected, truncated };
```

(Leave the `truncated` local, the do/while, and the warn log exactly as they are.)

- [ ] **Step 4: Update `fetchThreadContext` to thread the flag through**

In `src/adapter.ts`, replace the `fetchThreadContext` body (lines 306–308) so it destructures and passes `truncated`:

```typescript
  const { messages, truncated } = await fetchThreadMessages(enqueue, log, channelId, threadTs, maxPages);
  return renderThreadContext(messages, triggerTs, { truncated });
```

- [ ] **Step 5: Update the `dispatchToSession` caller**

In `src/adapter.ts` (~lines 1365–1375), the block that assigns `threadMessages`. Change:

```typescript
        let threadMessages: ThreadContextMessage[] | undefined;
        if (this.slackConfig.readThreadHistory !== false && extras?.channelId && extras?.threadTs) {
          try {
            threadMessages = await fetchThreadMessages(
              (method: any, params: any) => this.queue.enqueue(method, params),
              this.log, extras.channelId, extras.threadTs,
            );
          } catch (err) {
            this.log.warn({ err }, "Failed to fetch thread history for attachments; using triggering message only");
          }
        }
```

to:

```typescript
        let threadMessages: ThreadContextMessage[] | undefined = extras?.threadMessages;
        if (!threadMessages && this.slackConfig.readThreadHistory !== false && extras?.channelId && extras?.threadTs) {
          try {
            const fetched = await fetchThreadMessages(
              (method: any, params: any) => this.queue.enqueue(method, params),
              this.log, extras.channelId, extras.threadTs,
            );
            threadMessages = fetched.messages;
          } catch (err) {
            this.log.warn({ err }, "Failed to fetch thread history for attachments; using triggering message only");
          }
        }
```

(The new `extras?.threadMessages` lets Task 6 pass the already-fetched delta so the thread is fetched only once. The `extras` type gains `threadMessages` in Task 6 Step 2 — until then TypeScript will flag it; that is expected and resolved in Task 6. To keep this task green on its own, the typecheck is deferred to Task 6; run only the unit tests below now.)

- [ ] **Step 6: Run the affected unit tests**

Run: `npx vitest run src/__tests__/fetch-thread-messages.test.ts src/__tests__/adapter-thread-context.test.ts`
Expected: PASS. (`tsc` is intentionally NOT run yet — see the note in Step 5; it goes green in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts src/__tests__/fetch-thread-messages.test.ts
git commit -m "feat: fetchThreadMessages returns truncated flag; allow pre-fetched messages"
```

---

## Task 4: Pure helpers for high-water-mark + channel topic

Small, fully-pure helpers so the adapter wiring (Task 6) stays thin and the merge/parse behavior is unit-tested. `buildLastReadTsPatch` mirrors the existing `skillMsgTs` persistence pattern (`adapter.ts:1920-1923`): merge into `platform`, never clobber sibling keys.

**Files:**
- Modify: `src/adapter.ts` (add exports near the other pure helpers, ~line 228)
- Test: `src/__tests__/high-water-mark.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/high-water-mark.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readLastReadTs, buildLastReadTsPatch, extractChannelTopic } from "../adapter.js";

describe("readLastReadTs", () => {
  it("returns the persisted lastReadTs string", () => {
    expect(readLastReadTs({ platform: { lastReadTs: "100.2", channelId: "C1" } })).toBe("100.2");
  });
  it("returns undefined when absent or record missing", () => {
    expect(readLastReadTs({ platform: { channelId: "C1" } })).toBeUndefined();
    expect(readLastReadTs(undefined)).toBeUndefined();
    expect(readLastReadTs({})).toBeUndefined();
  });
});

describe("buildLastReadTsPatch", () => {
  it("merges lastReadTs into existing platform without dropping siblings", () => {
    const patch = buildLastReadTsPatch({ channelId: "C1", threadId: "C1:100.1" }, "100.3");
    expect(patch).toEqual({ platform: { channelId: "C1", threadId: "C1:100.1", lastReadTs: "100.3" } });
  });
  it("handles undefined existing platform", () => {
    expect(buildLastReadTsPatch(undefined, "100.3")).toEqual({ platform: { lastReadTs: "100.3" } });
  });
});

describe("extractChannelTopic", () => {
  it("prefers topic.value, falls back to purpose.value, trims, ignores empty", () => {
    expect(extractChannelTopic({ channel: { topic: { value: " Deploys " }, purpose: { value: "x" } } })).toBe("Deploys");
    expect(extractChannelTopic({ channel: { topic: { value: "" }, purpose: { value: "Purpose" } } })).toBe("Purpose");
    expect(extractChannelTopic({ channel: { topic: { value: "  " }, purpose: { value: "" } } })).toBeUndefined();
    expect(extractChannelTopic({})).toBeUndefined();
    expect(extractChannelTopic(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/high-water-mark.test.ts`
Expected: FAIL — none of the three helpers are exported.

- [ ] **Step 3: Implement the helpers**

In `src/adapter.ts`, after `renderChannelContext` (~line 228), add:

```typescript
/** Read the persisted high-water-mark ts from a session record's platform blob. */
export function readLastReadTs(
  record: { platform?: Record<string, unknown> } | undefined,
): string | undefined {
  const v = record?.platform?.lastReadTs;
  return typeof v === "string" ? v : undefined;
}

/**
 * Build a patchRecord payload that sets `platform.lastReadTs` while preserving
 * every other platform key (channelId, threadId, skillMsgTs, …). Mirrors the
 * skillMsgTs persistence pattern so the two never clobber each other.
 */
export function buildLastReadTsPatch(
  existingPlatform: Record<string, unknown> | undefined,
  newestTs: string,
): { platform: Record<string, unknown> } {
  return { platform: { ...(existingPlatform ?? {}), lastReadTs: newestTs } };
}

/**
 * Pick a human-readable topic for a channel from a conversations.info response:
 * channel.topic.value, falling back to channel.purpose.value. Trims and treats
 * blank as absent.
 */
export function extractChannelTopic(
  info: { channel?: { topic?: { value?: string }; purpose?: { value?: string } } } | undefined,
): string | undefined {
  const topic = (info?.channel?.topic?.value ?? "").trim();
  if (topic) return topic;
  const purpose = (info?.channel?.purpose?.value ?? "").trim();
  return purpose || undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/high-water-mark.test.ts`
Expected: PASS (8 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/high-water-mark.test.ts
git commit -m "feat: add high-water-mark and channel-topic pure helpers"
```

---

## Task 5: Always forward the trigger ts from the event router

The unread delta must exclude the message that triggered this turn (it is dispatched separately as the user prompt). Today `triggerTs` is plumbed only for mid-thread `sub-start`; a `sub-continue` carries none, which would double-feed the current reply. Forward `msg.ts` as `triggerTs` for **every** handled subscription message.

**Files:**
- Modify: `src/event-router.ts:152-155`
- Test: `src/__tests__/event-router.test.ts` (4 expectation updates)

- [ ] **Step 1: Update the failing test expectations**

In `src/__tests__/event-router.test.ts`, update these four assertions to expect `triggerTs = msg.ts`:

Line ~234 (subscribed-channel top-level mention, `ts: "169.1"`):
```typescript
    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: "169.1", forwards: [] });
```

Line ~252 (subscribed-channel thread reply continue, `ts: "169.2"`):
```typescript
    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "more", undefined, { triggerTs: "169.2", forwards: [] });
```

Line ~288 (top-level DM, `ts: "1.1"`):
```typescript
    expect(onSubscription).toHaveBeenCalledWith("D123", "1.1", "U1", "hello", undefined, { midThread: undefined, triggerTs: "1.1", forwards: [] });
```

Line ~304 (known DM thread reply continue, `ts: "1.2"`):
```typescript
    expect(onSubscription).toHaveBeenCalledWith("D123", "1.1", "U1", "more", undefined, { triggerTs: "1.2", forwards: [] });
```

Line ~350 (top-level mention, `ts: "169.1"`):
```typescript
    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined, { midThread: undefined, triggerTs: "169.1", forwards: [] });
```

(The mid-thread case at line ~334 already expects `triggerTs: "169.5"` and is unchanged.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: FAIL — current code passes `triggerTs: undefined` (mention) and omits it entirely on continue.

- [ ] **Step 3: Forward `msg.ts` as `triggerTs` for both kinds**

In `src/event-router.ts`, replace the `opts` construction (lines 152-155):

```typescript
        const opts =
          cls.kind === "sub-start"
            ? { midThread: cls.midThread, triggerTs: cls.triggerTs, forwards }
            : { forwards };
```

with:

```typescript
        // Always forward the triggering message's ts so the adapter can exclude it
        // from the prepended history delta (it is dispatched as the user prompt).
        const opts =
          cls.kind === "sub-start"
            ? { midThread: cls.midThread, triggerTs: msg.ts, forwards }
            : { triggerTs: msg.ts, forwards };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/event-router.ts src/__tests__/event-router.test.ts
git commit -m "feat: forward trigger ts for every subscription message"
```

---

## Task 6: Wire the unified mention handler in the adapter

Compose the pure pieces: one fetch, delta selection, titled context block, single-fetch attachment collection, and high-water-mark persistence. Remove the `midThread`-only gate and the first-turn sessionId drop.

**Files:**
- Modify: `src/adapter.ts` — `EventRouterDeps`/`dispatchToSession` `extras` type, `onSubscriptionMessage` callback (~695-734), `dispatchToSession` (~1347-1429), add `resolveChannelInfo` (near `resolveChannelLabel` ~1303)

- [ ] **Step 1: Add `resolveChannelInfo` (name + topic, cached)**

In `src/adapter.ts`, find the `_channelNameCache` field declaration (used at line 1305) and add a topic cache beside it. Search for `_channelNameCache` and add directly below its declaration:

```typescript
  private _channelTopicCache = new Map<string, string | undefined>();
```

Then, immediately **above** `resolveChannelLabel` (~line 1303), add:

```typescript
  /**
   * Resolve a channel's label ("#general") AND topic in one cached lookup, used
   * to title the thread-context block. DMs have no name/topic. On failure we
   * return the raw id and no topic rather than throwing — context titling must
   * never block dispatch.
   */
  private async resolveChannelInfo(channelId: string): Promise<{ label: string; topic?: string }> {
    if (channelId.startsWith("D")) return { label: "a direct message" };
    if (this._channelNameCache.has(channelId)) {
      return { label: this._channelNameCache.get(channelId)!, topic: this._channelTopicCache.get(channelId) };
    }
    try {
      const info = await this.queue.enqueue<{
        channel?: { name?: string; topic?: { value?: string }; purpose?: { value?: string } };
      }>("conversations.info", { channel: channelId });
      const name = info?.channel?.name;
      const label = name ? `#${name}` : channelId;
      const topic = extractChannelTopic(info);
      this._channelNameCache.set(channelId, label);
      this._channelTopicCache.set(channelId, topic);
      return { label, topic };
    } catch (err) {
      this.log.warn({ err, channelId }, "Failed to resolve channel info for thread-context title");
      return { label: channelId };
    }
  }
```

Note: `_channelNameCache` is a `Map<string,string>`; the existing `resolveChannelLabel` uses `.get()`/`.set()`. Keeping both methods is fine — `resolveChannelLabel` stays for the one-time location header; `resolveChannelInfo` is the titled variant. (If `_channelNameCache` is declared with a different name in your tree, search for the `conversations.info` call inside `resolveChannelLabel` to find it.)

- [ ] **Step 2: Extend the dispatch `extras` type**

In `src/adapter.ts`, change the `dispatchToSession` `extras` parameter type (line 1352) from:

```typescript
    extras?: { channelId?: string; threadTs?: string; triggerTs?: string; forwards?: ForwardedMessage[] },
```

to:

```typescript
    extras?: {
      channelId?: string;
      threadTs?: string;
      triggerTs?: string;
      forwards?: ForwardedMessage[];
      /** Pre-fetched (and already delta-filtered) thread messages, so the thread is fetched once upstream. */
      threadMessages?: ThreadContextMessage[];
      /** Already-resolved session id, so the first (session-creating) turn doesn't drop attachments. */
      sessionId?: string;
    },
```

- [ ] **Step 3: Use the passed sessionId + decouple from fileProxy in `dispatchToSession`**

In `src/adapter.ts`, in `dispatchToSession`, change the attachment-gate line (currently 1363-1364):

```typescript
      const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
      if (sessionId && this.fileProxy) {
```

to:

```typescript
      const sessionId =
        extras?.sessionId ?? this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
      // Inline text + forwarded text render even without the proxy; only binary
      // download LINKS need it. registerProxy below no-ops to "" when absent.
      if (sessionId) {
```

Then make `registerProxy` tolerate a missing proxy. Change (currently line 1394):

```typescript
          registerProxy: (f) => this.fileProxy!.register({ url_private: f.url_private, mimetype: f.mimetype, name: f.name }),
```

to:

```typescript
          registerProxy: (f) =>
            this.fileProxy
              ? this.fileProxy.register({ url_private: f.url_private, mimetype: f.mimetype, name: f.name })
              : "",
```

(The `extras?.threadMessages` short-circuit added in Task 3 Step 5 means when Task 6 passes the delta, no second `conversations.replies` is issued.)

- [ ] **Step 4: Rewrite the `onSubscriptionMessage` callback**

In `src/adapter.ts`, replace the whole `onSubscriptionMessage` async callback body (the function passed at ~695-734, beginning `async (channelId, threadTs, userId, text, files, opts) => {`) with:

```typescript
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

          // RESUME vs NEW: the persisted high-water-mark decides what is "missing".
          // Absent → NEW → read all history; present → RESUME → only newer messages.
          const record = this.core.sessionManager.getSessionRecord(sessionId);
          const sinceTs = readLastReadTs(record);

          // Fetch the thread ONCE (text + attachments share it). Skip the call for
          // a brand-new top-level mention (thread root IS this message, nothing prior).
          const triggerTs = opts?.triggerTs;
          let delta: ThreadDelta = { messages: [], newestTs: triggerTs ?? threadTs };
          let truncated = false;
          const isFreshTopLevel = !sinceTs && threadTs === triggerTs;
          if (this.slackConfig.readThreadHistory !== false && !isFreshTopLevel) {
            try {
              const fetched = await fetchThreadMessages(
                (method, params) => this.queue.enqueue(method, params),
                this.log,
                channelId,
                threadTs,
              );
              truncated = fetched.truncated;
              delta = selectThreadDelta(fetched.messages, sinceTs, triggerTs);
            } catch (ctxErr) {
              this.log.warn(
                { err: ctxErr, channelId, threadTs },
                "Failed to fetch thread history; dispatching without prepended context",
              );
            }
          }

          // Prepend the unread history as a titled context block (channel + topic).
          let dispatchText = text;
          if (delta.messages.length) {
            const { label, topic } = await this.resolveChannelInfo(channelId);
            const ctxBlock = renderThreadContext(delta.messages, undefined, {
              channelLabel: label,
              channelTopic: topic,
              truncated,
            });
            if (ctxBlock) dispatchText = `${ctxBlock}\n\n${text}`;
          }

          await this.dispatchToSession(meta.channelSlug, dispatchText, userId, files, {
            channelId,
            threadTs,
            triggerTs: opts?.triggerTs,
            forwards: opts?.forwards,
            threadMessages: delta.messages,
            sessionId,
          });

          // Record progress: advance the high-water-mark so the next mention only
          // reads what arrives after this turn. Best-effort; never blocks dispatch.
          if (delta.newestTs) {
            const patch = buildLastReadTsPatch(record?.platform, delta.newestTs);
            this.core.sessionManager
              .patchRecord(sessionId, patch)
              .catch((err) => this.log.warn({ err, sessionId }, "Failed to persist lastReadTs"));
          }
        } catch (err) {
          this.log.error({ err, channelId, threadTs }, "Failed to handle subscription message");
        }
      },
```

Note: `resolveThreadSession` already returns `{ sessionId, meta }` (see `subscription-router.ts:163`), so destructure `sessionId` directly instead of re-querying. This deletes the old `opts?.midThread` branch and the `buildThreadContext` call.

- [ ] **Step 5: Typecheck the whole package**

Run: `npx tsc --noEmit`
Expected: PASS (0 errors). This is the first full typecheck since Task 3; it confirms `extras.threadMessages`, the `ThreadDelta` import usage, and the destructured `sessionId` all line up. If `buildThreadContext` is now unused and your `tsconfig` flags unused privates, delete the `buildThreadContext` method (lines ~1283-1295) and re-run.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green (new + existing, including `subscription-router`, `event-router`, `adapter-thread-context`).

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: unified delta-aware mention handler with high-water-mark"
```

---

## Task 7: Final verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-06-09-mention-session-context-redesign-design.md`

- [ ] **Step 1: Full typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: both exit 0.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all suites pass, no skipped/failed.

- [ ] **Step 3: Confirm the four requirements are covered**

Re-read the spec's "Desired behavior" 1–4 against the diff and confirm:
1. No session (no `lastReadTs`) → full history fed (`selectThreadDelta` with `sinceTs` undefined). ✓
2. Session exists → only `ts > lastReadTs` fed; `lastReadTs` persisted after each turn. ✓
3. Channel name + topic titling + body + attachments (history attachments via the shared `delta.messages` into `collectAttachments`). ✓
4. Forwarded message + attachments (`extractForwards` runs over `delta.messages` in `collectAttachments`). ✓

- [ ] **Step 4: Mark the spec Implemented**

At the very end of `docs/superpowers/specs/2026-06-09-mention-session-context-redesign-design.md`, append:

```markdown

---

## Status: Implemented (2026-06-09)

Delivered across Tasks 1–5: `selectThreadDelta`, titled/truncation-aware
`renderThreadContext`, `{messages,truncated}` fetch, high-water-mark helpers,
and the unified `onSubscriptionMessage` handler. Out of scope as designed:
forwarded-thread recursion (G11) and attachment-only triggering (G10).
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-09-mention-session-context-redesign-design.md
git commit -m "docs: mark mention session-context redesign implemented"
```

---

## Self-Review notes (for the implementer)

- **Single fetch:** Task 6 fetches once in `onSubscriptionMessage` and passes `delta.messages` to `dispatchToSession` via `extras.threadMessages`; the Task 3 Step 5 short-circuit (`if (!threadMessages && …)`) prevents the second `conversations.replies`. The legacy dedicated-channel path (no `extras.threadMessages`) still self-fetches — unchanged behavior.
- **High-water-mark covers G9:** because attachments are now collected only from `delta.messages`, a message at/under `lastReadTs` is never re-collected after restart — no separate persisted seen-set is needed.
- **ts comparison is numeric** everywhere (`selectThreadDelta`) — do not switch to lexical compare.
- **Back-compat:** `renderThreadContext(msgs)` and `renderThreadContext(msgs, triggerTs)` are unchanged; only the new 3rd `opts` arg adds behavior. `fetchThreadContext` keeps its string return.
- **Degradation:** every Slack call in Task 6 is wrapped — a failed `conversations.replies` or `conversations.info` logs and dispatches the bare/untitled message rather than dropping it.
