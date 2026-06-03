# Slack Channel Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Slack adapter subscribe to pre-existing channels and run an AI agent against their messages with a one-session-per-thread model, entirely within the adapter (no OpenACP core changes).

**Architecture:** A pure `classifySubscription` function decides, per inbound message, whether to ignore it, start a new thread session (top-level trigger), or continue an existing one (reply in a known bot thread). `SlackEventRouter` calls it before its unchanged legacy routing. The adapter binds each thread to a session via `resolveThreadSession` (reusing the existing `handleNewSession({createThread:false})` primitive) and threads all output by adding `thread_ts` to posts when the session's `SlackSessionMeta.threadTs` is set. Human-in-the-loop reuses the built-in PermissionGate and turn-boundary resume — no new HITL code.

**Tech Stack:** TypeScript (ESM, `.js` imports), `@slack/bolt` (Socket Mode), `@openacp/plugin-sdk`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-03-channel-subscription-design.md`

**Conventions:**
- Run a single test file: `npx vitest run src/__tests__/<file>.test.ts`
- Run all tests: `npm test`
- Type-check/build: `npm run build`
- Commit trailer: end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

**New**
- `src/subscription-router.ts` — pure subscription logic: `classifySubscription`, `resolveThreadSession`, mention helpers. No I/O, no Slack/Bolt imports.
- `src/__tests__/subscription-router.test.ts` — unit tests for the above.

**Modified**
- `src/types.ts` — `subscribedChannels` config field; optional `SlackSessionMeta.threadTs`.
- `src/event-router.ts` — call `classifySubscription` before the (unchanged) legacy path; new optional constructor params.
- `src/adapter.ts` — `hasThreadSession`, `onSubscriptionMessage` wiring, extracted `dispatchToSession`, `thread_ts` on all session posts, archive guard, restore `threadTs`.
- `src/text-buffer.ts` — optional `threadTs` ctor param, applied to `chat.postMessage`.
- `src/activity-tracker.ts` — optional `threadTs` config, applied to the turn's main message.
- `src/permission-handler.ts` — per-request cleanup helper so sibling threads in a shared channel are not cross-wiped.
- `README.md` — document `subscribedChannels`.

---

## Task 1: Config schema + session meta field

**Files:**
- Modify: `src/types.ts`
- Test: `src/__tests__/subscription-router.test.ts` (config-shape assertion lives with the new module's tests)

- [ ] **Step 1: Add `subscribedChannels` to the Zod schema and `threadTs` to the meta**

In `src/types.ts`, inside `SlackChannelConfigSchema` (after `startupChannelId`), add:

```ts
  subscribedChannels: z
    .array(
      z.object({
        channelId: z.string(),
        trigger: z.enum(["mention", "all"]).default("mention"),
      }),
    )
    .default([]),
```

And extend `SlackSessionMeta`:

```ts
export interface SlackSessionMeta {
  channelId: string;     // Slack channel ID for this session (C...)
  channelSlug: string;   // e.g. "openacp-fix-auth-bug-a3k9", or "C123:169...". for subscription threads
  /** Slack thread root (parent message ts) when this session is bound to a subscribed channel thread. */
  threadTs?: string;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS (no type errors). Existing configs remain valid because the new field defaults to `[]`.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add subscribedChannels config and SlackSessionMeta.threadTs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure subscription module (`classifySubscription` + helpers)

**Files:**
- Create: `src/subscription-router.ts`
- Test: `src/__tests__/subscription-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/subscription-router.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { classifySubscription } from "../subscription-router.js";
import type { SubscriptionContext } from "../subscription-router.js";

function ctx(overrides: Partial<SubscriptionContext> = {}): SubscriptionContext {
  return {
    subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }],
    botUserId: "BOT1",
    allowedUserIds: [],
    hasThreadSession: () => false,
    ...overrides,
  };
}

describe("classifySubscription", () => {
  it("ignores channels that are not subscribed", () => {
    const r = classifySubscription({ channel: "C_OTHER", user: "U1", text: "<@BOT1> hi", ts: "1.1" }, ctx());
    expect(r.kind).toBe("ignore");
  });

  it("ignores bot's own and bot_id messages", () => {
    expect(classifySubscription({ channel: "C_SUB", user: "BOT1", text: "<@BOT1> hi", ts: "1.1" }, ctx()).kind).toBe("ignore");
    expect(classifySubscription({ channel: "C_SUB", user: "U1", text: "hi", ts: "1.1", bot_id: "B1" }, ctx()).kind).toBe("ignore");
  });

  it("ignores edited/deleted subtypes but allows file_share", () => {
    expect(classifySubscription({ channel: "C_SUB", user: "U1", text: "x", ts: "1.1", subtype: "message_changed" }, ctx()).kind).toBe("ignore");
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "<@BOT1> x", ts: "1.1", subtype: "file_share" }, ctx());
    expect(r.kind).toBe("sub-start");
  });

  it("enforces allowedUserIds when non-empty", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U_NO", text: "<@BOT1> hi", ts: "1.1" },
      ctx({ allowedUserIds: ["U_YES"] }),
    );
    expect(r.kind).toBe("ignore");
  });

  it("starts a session on a top-level mention and strips the mention", () => {
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "<@BOT1> triage TICKET-1", ts: "169.1" }, ctx());
    expect(r).toEqual({ kind: "sub-start", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "triage TICKET-1" });
  });

  it("ignores a top-level non-mention in mention mode", () => {
    const r = classifySubscription({ channel: "C_SUB", user: "U1", text: "just chatting", ts: "169.1" }, ctx());
    expect(r.kind).toBe("ignore");
  });

  it("starts on any top-level message in 'all' mode", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "no mention here", ts: "169.1" },
      ctx({ subscribedChannels: [{ channelId: "C_SUB", trigger: "all" }] }),
    );
    expect(r).toEqual({ kind: "sub-start", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "no mention here" });
  });

  it("continues a reply only when the thread is a known bot session", () => {
    const known = vi.fn().mockReturnValue(true);
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "and the PR too", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: known }),
    );
    expect(known).toHaveBeenCalledWith("C_SUB", "169.1");
    expect(r).toEqual({ kind: "sub-continue", channelId: "C_SUB", threadTs: "169.1", userId: "U1", text: "and the PR too" });
  });

  it("ignores a reply in an unknown thread (no hijacking human threads)", () => {
    const r = classifySubscription(
      { channel: "C_SUB", user: "U1", text: "human chat", ts: "169.2", thread_ts: "169.1" },
      ctx({ hasThreadSession: () => false }),
    );
    expect(r.kind).toBe("ignore");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: FAIL — `Cannot find module '../subscription-router.js'`.

- [ ] **Step 3: Implement the module**

Create `src/subscription-router.ts`:

```ts
// src/subscription-router.ts
// Pure subscription logic for the Slack adapter — no Slack/Bolt I/O.
import type { SlackSessionMeta } from "./types.js";

/** Subscribed-channel config entry (mirrors the Zod schema in types.ts). */
export interface SubscribedChannel {
  channelId: string;
  trigger: "mention" | "all";
}

/** Subset of a Slack message event used by the classifier. */
export interface SubscriptionMessage {
  bot_id?: string;
  subtype?: string;
  channel: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SubscriptionContext {
  subscribedChannels: SubscribedChannel[];
  botUserId: string;
  allowedUserIds: string[];
  /** True if a session already owns (channelId, threadTs) — in memory or persisted. */
  hasThreadSession: (channelId: string, threadTs: string) => boolean;
}

export type Classification =
  | { kind: "ignore" }
  | { kind: "sub-start"; channelId: string; threadTs: string; userId: string; text: string }
  | { kind: "sub-continue"; channelId: string; threadTs: string; userId: string; text: string };

/** True when `text` mentions the given bot user (`<@U..>` or `<@U..|name>`). */
export function mentionsBot(text: string, botUserId: string): boolean {
  return new RegExp(`<@${botUserId}(\\|[^>]+)?>`).test(text);
}

/** Remove the bot's own mention token(s) and collapse the resulting whitespace. */
export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(\\|[^>]+)?>`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Decide what to do with a message in a (potentially) subscribed channel.
 *
 * Sessions are only ever started from a top-level trigger; a reply in a thread
 * the bot does not already own is ignored in both trigger modes, so the bot
 * never hijacks unrelated human threads.
 */
export function classifySubscription(msg: SubscriptionMessage, ctx: SubscriptionContext): Classification {
  if (msg.bot_id) return { kind: "ignore" };
  if (msg.subtype && msg.subtype !== "file_share") return { kind: "ignore" };

  const channelId = msg.channel;
  const userId = msg.user ?? "";
  if (!userId || userId === ctx.botUserId) return { kind: "ignore" };

  const sub = ctx.subscribedChannels.find((c) => c.channelId === channelId);
  if (!sub) return { kind: "ignore" };

  if (ctx.allowedUserIds.length > 0 && !ctx.allowedUserIds.includes(userId)) {
    return { kind: "ignore" };
  }

  const text = stripBotMention(msg.text ?? "", ctx.botUserId);

  // Thread reply → continue only a known bot thread.
  if (msg.thread_ts) {
    if (ctx.hasThreadSession(channelId, msg.thread_ts)) {
      return { kind: "sub-continue", channelId, threadTs: msg.thread_ts, userId, text };
    }
    return { kind: "ignore" };
  }

  // Top-level message → start a thread session when the trigger fires.
  const triggered = sub.trigger === "all" || mentionsBot(msg.text ?? "", ctx.botUserId);
  if (!triggered || !msg.ts) return { kind: "ignore" };
  return { kind: "sub-start", channelId, threadTs: msg.ts, userId, text };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/subscription-router.ts src/__tests__/subscription-router.test.ts
git commit -m "feat: add pure classifySubscription routing logic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `resolveThreadSession` (bind a thread to a session)

**Files:**
- Modify: `src/subscription-router.ts`
- Test: `src/__tests__/subscription-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/subscription-router.test.ts`:

```ts
import { resolveThreadSession } from "../subscription-router.js";
import type { ThreadSessionDeps } from "../subscription-router.js";
import type { SlackSessionMeta } from "../types.js";

function deps(overrides: Partial<ThreadSessionDeps> = {}): ThreadSessionDeps {
  return {
    sessions: new Map<string, SlackSessionMeta>(),
    getSessionByThread: () => undefined,
    handleNewSession: vi.fn(async () => ({ id: "sess-new" })),
    patchRecord: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("resolveThreadSession", () => {
  it("reuses an in-memory session for the same thread", async () => {
    const sessions = new Map<string, SlackSessionMeta>([
      ["sess-1", { channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" }],
    ]);
    const d = deps({ sessions });
    const r = await resolveThreadSession(d, "C_SUB", "169.1", "U1");
    expect(r.sessionId).toBe("sess-1");
    expect(d.handleNewSession).not.toHaveBeenCalled();
  });

  it("restores a persisted session after restart and caches its meta", async () => {
    const d = deps({ getSessionByThread: () => ({ id: "sess-persisted" }) });
    const r = await resolveThreadSession(d, "C_SUB", "169.1", "U1");
    expect(r.sessionId).toBe("sess-persisted");
    expect(d.sessions.get("sess-persisted")).toEqual({ channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" });
    expect(d.handleNewSession).not.toHaveBeenCalled();
  });

  it("creates a new session bound to the existing channel and persists platform fields", async () => {
    const d = deps();
    const r = await resolveThreadSession(d, "C_SUB", "169.1", "U1");
    expect(d.handleNewSession).toHaveBeenCalledWith("slack", "U1", undefined, { createThread: false });
    expect(r.meta).toEqual({ channelId: "C_SUB", channelSlug: "C_SUB:169.1", threadTs: "169.1" });
    expect(d.sessions.get("sess-new")).toEqual(r.meta);
    expect(d.patchRecord).toHaveBeenCalledWith("sess-new", {
      platform: { channelId: "C_SUB", topicId: "C_SUB:169.1", threadTs: "169.1" },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: FAIL — `resolveThreadSession` / `ThreadSessionDeps` not exported.

- [ ] **Step 3: Implement**

Append to `src/subscription-router.ts`:

```ts
export interface ThreadSessionDeps {
  sessions: Map<string, SlackSessionMeta>;
  getSessionByThread: (platform: string, threadId: string) => { id: string } | undefined;
  handleNewSession: (
    platform: string,
    userId?: string,
    text?: string,
    opts?: { createThread: boolean },
  ) => Promise<{ id: string; threadId?: string }>;
  patchRecord: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
}

/**
 * Resolve the session that owns a (channelId, threadTs) thread, creating one
 * bound to the *existing* channel if none exists. Uses `createThread: false`
 * so no new Slack channel is created — the thread root is the binding.
 */
export async function resolveThreadSession(
  deps: ThreadSessionDeps,
  channelId: string,
  threadTs: string,
  userId: string,
): Promise<{ sessionId: string; meta: SlackSessionMeta }> {
  const key = `${channelId}:${threadTs}`;

  for (const [sid, meta] of deps.sessions) {
    if (meta.channelId === channelId && meta.threadTs === threadTs) {
      return { sessionId: sid, meta };
    }
  }

  const existing = deps.getSessionByThread("slack", key);
  if (existing) {
    const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs };
    deps.sessions.set(existing.id, meta);
    return { sessionId: existing.id, meta };
  }

  const session = await deps.handleNewSession("slack", userId, undefined, { createThread: false });
  const meta: SlackSessionMeta = { channelId, channelSlug: key, threadTs };
  deps.sessions.set(session.id, meta);
  (session as { threadId?: string }).threadId = key;
  await deps.patchRecord(session.id, {
    platform: { channelId, topicId: key, threadTs },
  });
  return { sessionId: session.id, meta };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/subscription-router.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/subscription-router.ts src/__tests__/subscription-router.test.ts
git commit -m "feat: add resolveThreadSession to bind threads to sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the classifier into `SlackEventRouter`

**Files:**
- Modify: `src/event-router.ts`
- Test: `src/__tests__/event-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("SlackEventRouter", ...)` block in `src/__tests__/event-router.test.ts`:

```ts
  it("routes a subscribed-channel mention to onSubscriptionMessage", async () => {
    const onIncoming = vi.fn();
    const onNewSession = vi.fn();
    const onSubscription = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue(undefined);
    const router = new SlackEventRouter(
      sessionLookup, onIncoming, "BOT1", "NOTIF", onNewSession,
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "<@BOT1> hi", ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "hi", undefined);
    expect(onIncoming).not.toHaveBeenCalled();
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("routes a subscribed-channel thread reply to onSubscriptionMessage when the thread is known", async () => {
    const onSubscription = vi.fn();
    const router = new SlackEventRouter(
      vi.fn().mockReturnValue(undefined), vi.fn(), "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => true,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C_SUB", user: "U1", text: "more", ts: "169.2", thread_ts: "169.1" } });

    expect(onSubscription).toHaveBeenCalledWith("C_SUB", "169.1", "U1", "more", undefined);
  });

  it("leaves legacy routing unchanged for non-subscribed channels", async () => {
    const onIncoming = vi.fn();
    const onSubscription = vi.fn();
    const sessionLookup = vi.fn().mockReturnValue({ channelId: "C123", channelSlug: "openacp-session-abc1" });
    const router = new SlackEventRouter(
      sessionLookup, onIncoming, "BOT1", "NOTIF", vi.fn(),
      makeConfig({ subscribedChannels: [{ channelId: "C_SUB", trigger: "mention" }] }),
      () => false,
      onSubscription,
    );
    const app = createMockApp();
    router.register(app as any);

    await app._trigger("message", { message: { channel: "C123", user: "U1", text: "hello" } });

    expect(onIncoming).toHaveBeenCalledWith("openacp-session-abc1", "hello", "U1", undefined);
    expect(onSubscription).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: FAIL — constructor does not accept the 7th/8th args; `onSubscription` never called.

- [ ] **Step 3: Implement the router changes**

In `src/event-router.ts`, update the imports and types at the top:

```ts
import type { App } from "@slack/bolt";
import type { SlackSessionMeta, SlackFileInfo, Logger } from "./types.js";
import type { SlackChannelConfig } from "./types.js";
import { classifySubscription } from "./subscription-router.js";
```

Extend the `SlackMessageEvent` interface with the two fields the classifier needs:

```ts
interface SlackMessageEvent {
  bot_id?: string;
  subtype?: string;
  channel: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    url_private: string;
  }>;
}
```

Add the callback type near the existing ones:

```ts
// Callback to dispatch a subscribed-channel message (start or continue a thread session)
export type SubscriptionMessageCallback = (
  channelId: string,
  threadTs: string,
  userId: string,
  text: string,
  files?: SlackFileInfo[],
) => void | Promise<void>;
```

Replace the constructor with two new optional params (placed before `logger`):

```ts
  constructor(
    private sessionLookup: SessionLookup,
    private onIncoming: IncomingMessageCallback,
    private botUserId: string,
    private notificationChannelId: string | undefined,
    private onNewSession: NewSessionCallback,
    private config: SlackChannelConfig,
    private hasThreadSession?: (channelId: string, threadTs: string) => boolean,
    private onSubscriptionMessage?: SubscriptionMessageCallback,
    logger?: Logger,
  ) {
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }
```

Replace the body of `register(app)` with this version (subscription decision first, then the **unchanged** legacy path):

```ts
  register(app: App): void {
    app.message(async ({ message }) => {
      this.log.debug({ message }, "Slack raw message event");

      const msg = message as unknown as SlackMessageEvent;

      const files: SlackFileInfo[] | undefined = msg.files?.map((f) => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        size: f.size,
        url_private: f.url_private,
      }));

      // Subscription path: self-contained decision. Returns "ignore" for any
      // channel not in subscribedChannels, so legacy behavior is untouched.
      const cls = classifySubscription(
        {
          bot_id: msg.bot_id,
          subtype: msg.subtype,
          channel: msg.channel,
          text: msg.text,
          user: msg.user,
          ts: msg.ts,
          thread_ts: msg.thread_ts,
        },
        {
          subscribedChannels: this.config.subscribedChannels ?? [],
          botUserId: this.botUserId,
          allowedUserIds: this.config.allowedUserIds ?? [],
          hasThreadSession: this.hasThreadSession ?? (() => false),
        },
      );
      if (cls.kind !== "ignore") {
        await this.onSubscriptionMessage?.(cls.channelId, cls.threadTs, cls.userId, cls.text, files);
        return;
      }

      // ----- Legacy routing (unchanged) -----
      if (msg.bot_id) return;
      const subtype = msg.subtype;
      if (subtype && subtype !== "file_share") return; // edited, deleted, etc.

      // Ignore thread replies — only channel-level messages route to legacy sessions
      if (msg.thread_ts) return;

      const channelId = msg.channel;
      const text: string = msg.text ?? "";
      const userId: string = msg.user ?? "";

      this.log.debug({ channelId, userId, text }, "Slack message received");

      if (userId === this.botUserId) return;

      if (!this.isAllowedUser(userId)) {
        this.log.warn({ userId }, "slack: message from non-allowed user rejected");
        return;
      }

      const session = this.sessionLookup(channelId);
      if (session) {
        this.log.debug({ channelId, sessionSlug: session.channelSlug }, "Routing to session");
        this.onIncoming(session.channelSlug, text, userId, files);
        return;
      }

      this.log.debug({ channelId, notificationChannelId: this.notificationChannelId }, "No session found for channel");

      if (this.notificationChannelId && channelId === this.notificationChannelId) {
        this.onNewSession(text, userId);
        return;
      }

      if (channelId.startsWith("D")) {
        this.log.debug({ channelId, userId }, "DM received, creating new session");
        this.onNewSession(text, userId);
        return;
      }
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: PASS — the 3 new tests plus all pre-existing ones (legacy `ignores thread replies`, etc. still pass because `C123` is not subscribed).

- [ ] **Step 5: Commit**

```bash
git add src/event-router.ts src/__tests__/event-router.test.ts
git commit -m "feat: route subscribed-channel messages through classifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Adapter wiring — dispatch, hasThreadSession, subscription callback

**Files:**
- Modify: `src/adapter.ts`

This task has no new unit test (it is integration glue exercised by the existing `adapter-lifecycle` / `conformance` suites and the pure-function tests already written). Verify with `npm run build` + `npm test`.

- [ ] **Step 1: Add the `CoreKernel.handleNewSession` userId passthrough import**

At the top of `src/adapter.ts`, add to the existing `./subscription-router.js` consumers:

```ts
import { resolveThreadSession } from "./subscription-router.js";
```

- [ ] **Step 2: Extract `dispatchToSession` from the inline `onIncoming` closure**

Add this private method to the `SlackAdapter` class (place it just above `sendMessage`):

```ts
  /**
   * Forward a user message to core for an existing session, identified by its
   * threadId slug. Handles /command interception and audio attachments. Shared
   * by the legacy event-router path and the channel-subscription path.
   */
  private async dispatchToSession(
    sessionChannelSlug: string,
    text: string,
    userId: string,
    files?: SlackFileInfo[],
  ): Promise<void> {
    const processFiles = async (): Promise<Attachment[] | undefined> => {
      if (!files?.length) return undefined;
      const audioFiles = files.filter((f) => isAudioClip(f));
      if (!audioFiles.length) return undefined;

      const attachments: Attachment[] = [];
      for (const file of audioFiles) {
        const buffer = await this.downloadSlackFile(file.url_private);
        if (!buffer) continue;
        const mimeType = file.mimetype === "video/mp4" ? "audio/mp4" : file.mimetype;
        const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
        if (!sessionId) continue;
        const att = await this.fileService.saveFile(sessionId, file.name, buffer, mimeType);
        attachments.push(att);
      }
      return attachments.length > 0 ? attachments : undefined;
    };

    if (text.startsWith("/")) {
      const handled = await this.tryCommandDispatch(sessionChannelSlug, text, userId);
      if (handled) return;
    }

    const attachments = await processFiles().catch((err) => {
      this.log.error({ err }, "Failed to process audio files");
      return undefined;
    });
    await this.core
      .handleMessage({ channelId: "slack", threadId: sessionChannelSlug, userId, text, attachments })
      .catch((err) => this.log.error({ err }, "handleMessage error"));
  }
```

- [ ] **Step 3: Add `hasThreadSession`**

Add this private method to `SlackAdapter` (place it near `findSessionByChannel`):

```ts
  /** True if a session already owns (channelId, threadTs) — in memory or persisted. */
  private hasThreadSession(channelId: string, threadTs: string): boolean {
    for (const meta of this.sessions.values()) {
      if (meta.channelId === channelId && meta.threadTs === threadTs) return true;
    }
    return !!this.core.sessionManager.getSessionByThread("slack", `${channelId}:${threadTs}`);
  }
```

- [ ] **Step 4: Replace the `SlackEventRouter` construction**

In `start()`, replace the existing `this.eventRouter = new SlackEventRouter( ... )` block. Change the `onIncoming` closure to delegate to `dispatchToSession`, and pass the two new constructor args (`hasThreadSession`, `onSubscriptionMessage`) before `this.log`:

```ts
    this.eventRouter = new SlackEventRouter(
      (slackChannelId) => {
        for (const meta of this.sessions.values()) {
          if (meta.channelId === slackChannelId && !meta.threadTs) return meta;
        }
        return undefined;
      },
      (sessionChannelSlug, text, userId, files) =>
        this.dispatchToSession(sessionChannelSlug, text, userId, files),
      this.botUserId,
      this.slackConfig.notificationChannelId,
      // onNewSession: create a new session with a private channel (legacy/DM path)
      async (text, userId) => {
        try {
          const session = await this.core.handleNewSession("slack", undefined, undefined, { createThread: true });
          if (session.threadId) {
            this.log.debug({ sessionId: session.id, threadId: session.threadId }, "New session created from DM/notification");
            const meta = this.sessions.get(session.id);
            if (meta && userId) {
              try {
                await this.queue.enqueue("conversations.invite", { channel: meta.channelId, users: userId });
                const dmRes = await this.queue.enqueue<{ channel: { id: string } }>("conversations.open", { users: userId });
                const dmChannelId = dmRes?.channel?.id;
                if (dmChannelId) {
                  await this.queue.enqueue("chat.postMessage", {
                    channel: dmChannelId,
                    text: `✅ New session started! Continue the conversation in <#${meta.channelId}>`,
                  });
                }
              } catch (inviteErr) {
                this.log.warn({ err: inviteErr, userId, channelId: meta.channelId }, "Failed to invite user to session channel");
              }
              if (text) {
                await this.core.handleMessage({ channelId: "slack", threadId: session.threadId, userId, text });
              }
            } else {
              this.log.warn({ sessionId: session.id, userId }, "Session channel not ready yet, skipping user invite");
            }
          }
        } catch (err) {
          this.log.error({ err, userId }, "Failed to create new session");
        }
      },
      this.slackConfig,
      (channelId, threadTs) => this.hasThreadSession(channelId, threadTs),
      // onSubscriptionMessage: bind the thread to a session and dispatch
      async (channelId, threadTs, userId, text, files) => {
        try {
          const { meta } = await resolveThreadSession(
            {
              sessions: this.sessions,
              getSessionByThread: (p, t) => this.core.sessionManager.getSessionByThread(p, t),
              handleNewSession: (p, u, t, o) => this.core.handleNewSession(p, u, t, o),
              patchRecord: (sid, patch) => this.core.sessionManager.patchRecord(sid, patch),
            },
            channelId,
            threadTs,
            userId,
          );
          await this.dispatchToSession(meta.channelSlug, text, userId, files);
        } catch (err) {
          this.log.error({ err, channelId, threadTs }, "Failed to handle subscription message");
        }
      },
      this.log,
    );
    this.eventRouter.register(this.app);
```

> Note the legacy `sessionLookup` now excludes subscription sessions (`&& !meta.threadTs`) so a subscribed channel's sessions are never matched by the channel-level legacy lookup.

- [ ] **Step 5: Verify build and full suite**

Run: `npm run build && npm test`
Expected: PASS. Build is clean; all existing tests green (the inline `onIncoming` was moved verbatim into `dispatchToSession`).

- [ ] **Step 6: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: wire channel subscription into the Slack adapter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Thread the output (`thread_ts` on all session posts)

**Files:**
- Modify: `src/text-buffer.ts`, `src/activity-tracker.ts`, `src/adapter.ts`
- Test: `src/__tests__/text-buffer.test.ts`, `src/__tests__/activity-tracker.test.ts`

- [ ] **Step 1: Write the failing test for text-buffer threading**

Add to `src/__tests__/text-buffer.test.ts` (mirror the existing mock-queue style in that file):

```ts
it("includes thread_ts on posts when constructed with a thread", async () => {
  const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
  const queue = { enqueue } as any;
  const buf = new SlackTextBuffer("C_SUB", "169.1", "sess-1", queue);
  buf.append("hello world");
  await buf.flush();
  expect(enqueue).toHaveBeenCalledWith(
    "chat.postMessage",
    expect.objectContaining({ channel: "C_SUB", thread_ts: "169.1" }),
  );
});
```

> If `src/__tests__/text-buffer.test.ts` already constructs `SlackTextBuffer`, update those call sites to the new 4-arg signature `(channelId, threadTs, sessionId, queue)` — pass `undefined` for `threadTs` to preserve their assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/text-buffer.test.ts`
Expected: FAIL — current ctor is `(channelId, sessionId, queue, logger)`; `thread_ts` absent.

- [ ] **Step 3: Implement text-buffer threading**

In `src/text-buffer.ts`, add the `threadTs` ctor param and apply it to the post:

```ts
  constructor(
    private channelId: string,
    private threadTs: string | undefined,
    private sessionId: string,
    private queue: ISlackSendQueue,
    logger?: Logger,
  ) {
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }
```

In `flush()`, change the `chat.postMessage` params to include the thread when set:

```ts
          const result = await this.queue.enqueue("chat.postMessage", {
            channel: this.channelId,
            ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
            text: chunk,
            blocks: [{ type: "section", text: { type: "mrkdwn", text: chunk } }],
          });
```

- [ ] **Step 4: Update the adapter's `getTextBuffer` to pass `threadTs`**

In `src/adapter.ts`, change `getTextBuffer` and its callers:

```ts
  private getTextBuffer(sessionId: string, channelId: string, threadTs?: string): SlackTextBuffer {
    let buf = this.textBuffers.get(sessionId);
    if (!buf) {
      buf = new SlackTextBuffer(channelId, threadTs, sessionId, this.queue, this.log);
      this.textBuffers.set(sessionId, buf);
    }
    return buf;
  }
```

In `handleText`, pass the meta's thread:

```ts
    const buf = this.getTextBuffer(sessionId, meta.channelId, meta.threadTs);
```

- [ ] **Step 5: Write the failing test for activity-tracker threading**

Add to `src/__tests__/activity-tracker.test.ts`:

```ts
it("roots the main message in the outer thread when threadTs is set", async () => {
  const enqueue = vi.fn().mockResolvedValue({ ok: true, ts: "1.1" });
  const queue = { enqueue } as any;
  const tracker = new SlackActivityTracker({
    channelId: "C_SUB",
    sessionId: "sess-1",
    queue,
    outputMode: "medium",
    threadTs: "169.1",
  });
  await tracker.onNewPrompt();
  expect(enqueue).toHaveBeenCalledWith(
    "chat.postMessage",
    expect.objectContaining({ channel: "C_SUB", thread_ts: "169.1" }),
  );
});
```

- [ ] **Step 6: Run both to verify they fail**

Run: `npx vitest run src/__tests__/activity-tracker.test.ts`
Expected: FAIL — `threadTs` not accepted; main message posted without `thread_ts`.

- [ ] **Step 7: Implement activity-tracker threading**

In `src/activity-tracker.ts`, add `threadTs` to the config interface and store it:

```ts
export interface SlackActivityTrackerConfig {
  channelId: string;
  sessionId: string;
  queue: ISlackSendQueue;
  outputMode: OutputMode;
  tunnelService?: TunnelServiceInterface;
  sessionContext?: { id: string; workingDirectory: string };
  /** Outer thread root (subscribed channels). When set, the turn's main message is a reply in it. */
  threadTs?: string;
}
```

Add the field and assign it in the constructor:

```ts
  private rootThreadTs?: string;
```
```ts
    this.rootThreadTs = config.threadTs;
```

In `onNewPrompt()`, post the main message into the outer thread and root the turn there:

```ts
    const result = await this.queue.enqueue<{ ok: boolean; ts: string }>(
      "chat.postMessage",
      {
        channel: this.channelId,
        ...(this.rootThreadTs ? { thread_ts: this.rootThreadTs } : {}),
        blocks,
        text: "Processing...",
      },
    );

    const turn: TurnState = {
      mainMessageTs: result.ts,
      threadTs: this.rootThreadTs ?? result.ts,
      isFinalized: false,
    };
```

In `updateMainMessage()`, thread the fallback re-post too:

```ts
        const result = await this.queue.enqueue<{ ts?: string }>(
          "chat.postMessage",
          {
            channel: this.channelId,
            ...(this.rootThreadTs ? { thread_ts: this.rootThreadTs } : {}),
            blocks,
            text: isComplete ? "Done" : "Processing...",
          },
        );
        if (result?.ts) {
          this.turn.mainMessageTs = result.ts;
          this.turn.threadTs = this.rootThreadTs ?? result.ts;
        }
```

> The existing tool-card / thought posts already use `this.turn.threadTs`. With `rootThreadTs` set, `turn.threadTs` is the outer thread root, so every tool card and thought lands flat in the @mention thread. When unset, behavior is byte-for-byte unchanged.

- [ ] **Step 8: Pass `threadTs` when creating the tracker**

In `src/adapter.ts` `getOrCreateTracker`, add `threadTs` from the session meta:

```ts
  private getOrCreateTracker(sessionId: string, channelId: string): SlackActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    const mode = this.resolveOutputMode(sessionId);
    if (!tracker) {
      const tunnelService = this.core.lifecycleManager?.serviceRegistry?.get("tunnel") as TunnelServiceInterface | undefined;
      const session = this.core.sessionManager.getSession(sessionId);
      const sessionContext = session?.workingDirectory
        ? { id: sessionId, workingDirectory: session.workingDirectory }
        : undefined;
      tracker = new SlackActivityTracker({
        channelId,
        sessionId,
        queue: this.queue,
        outputMode: mode,
        tunnelService,
        sessionContext,
        threadTs: this.getSessionMeta(sessionId)?.threadTs,
      });
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(mode);
    }
    return tracker;
  }
```

- [ ] **Step 9: Thread the remaining direct posts in the adapter**

Add a small helper to `SlackAdapter` (place near `getSessionMeta`):

```ts
  /** Spread into chat.postMessage params to thread output for subscription sessions. */
  private threadParams(meta: SlackSessionMeta): { thread_ts?: string } {
    return meta.threadTs ? { thread_ts: meta.threadTs } : {};
  }
```

Then add `...this.threadParams(meta)` to each session-scoped `chat.postMessage` in these methods:
- `handleSessionEnd` (the `chat.postMessage` to `meta.channelId`)
- `handleError` (same)
- `postFormattedMessage`
- `handleUsage` — the in-thread usage line `chat.postMessage` (the `existingTs ? chat.update : chat.postMessage` branch). Apply only to the `chat.postMessage` arm.
- `sendPermissionRequest` (the `chat.postMessage` posting the buttons)
- `sendSkillCommands` (the `chat.postMessage` arm)

Example for `handleSessionEnd`:

```ts
      await this.queue.enqueue("chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: content.text ?? content.type,
        blocks,
      });
```

> Do NOT add `thread_ts` to `chat.update` / `chat.delete` calls (they target a message by `ts` and do not take it). Do NOT thread the notification-channel posts (completion / permission pings to `notificationChannelId`) — those belong in the notifications channel, not the thread.

- [ ] **Step 10: Run the suite + build**

Run: `npx vitest run src/__tests__/text-buffer.test.ts src/__tests__/activity-tracker.test.ts && npm run build && npm test`
Expected: PASS — new threading tests green; legacy tests green (thread omitted when `threadTs` unset).

- [ ] **Step 11: Commit**

```bash
git add src/text-buffer.ts src/activity-tracker.ts src/adapter.ts src/__tests__/text-buffer.test.ts src/__tests__/activity-tracker.test.ts
git commit -m "feat: thread agent output into the subscribed channel thread

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Safety guards — never archive a subscribed channel; per-thread permission cleanup

**Files:**
- Modify: `src/adapter.ts`, `src/permission-handler.ts`
- Test: `src/__tests__/permission-handler.test.ts`

- [ ] **Step 1: Guard `deleteSessionThread` against archiving a subscribed channel**

In `src/adapter.ts` `deleteSessionThread`, after fetching `meta` and cleaning up permission buttons, skip channel archival when the session is a subscription thread. Replace the archive block:

```ts
    if (meta.threadTs) {
      // Subscription thread session: the channel is a real, shared business
      // channel — never archive it. Only in-memory state is torn down below.
      this.log.info({ sessionId, channelId: meta.channelId }, "Subscription thread ended (channel preserved)");
    } else {
      try {
        await this.channelManager.archiveChannel(meta.channelId);
        this.log.info({ sessionId, channelId: meta.channelId }, "Session channel archived");
      } catch (err) {
        this.log.warn({ err, sessionId }, "Failed to archive Slack channel");
      }
    }
```

- [ ] **Step 2: Guard the `/openacp-archive` command handler**

In `src/adapter.ts`, the `ArchiveCommandDeps.findSessionByChannel` already returns `{ sessionId, meta }`. Update `makeArchiveCommandHandler` to refuse subscription channels. After resolving `found`, add before the archive confirmation:

```ts
    if (found.meta.threadTs) {
      await deps.postEphemeral({
        channel: channelId,
        user: userId,
        text: "This is a subscribed channel — OpenACP will not archive it.",
      });
      return;
    }
```

- [ ] **Step 3: Write the failing test for per-thread permission cleanup**

Add to `src/__tests__/permission-handler.test.ts`:

```ts
it("cleanupRequest removes only the given request, not sibling threads sharing a channel", async () => {
  const enqueue = vi.fn().mockResolvedValue({});
  const queue = { enqueue } as any;
  const handler = new SlackPermissionHandler(queue, vi.fn());
  handler.trackPendingMessage("req-A", "C_SUB", "1.1", []);
  handler.trackPendingMessage("req-B", "C_SUB", "2.2", []);

  await handler.cleanupRequest("req-A");

  // req-A's message is cleared; req-B (a sibling thread in the same channel) is untouched.
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith("chat.update", expect.objectContaining({ channel: "C_SUB", ts: "1.1" }));
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run src/__tests__/permission-handler.test.ts`
Expected: FAIL — `cleanupRequest` is not defined.

- [ ] **Step 5: Implement `cleanupRequest` on the permission handler**

In `src/permission-handler.ts`, add to the `ISlackPermissionHandler` interface:

```ts
  cleanupRequest(requestId: string): Promise<void>;
```

And implement it on `SlackPermissionHandler`:

```ts
  /**
   * Clear the buttons for a single pending request. Used when a session ends so
   * sibling threads sharing the same channel (subscription mode) are untouched —
   * unlike cleanupSession(channelId), which clears every request in a channel.
   */
  async cleanupRequest(requestId: string): Promise<void> {
    const info = this.pendingMessages.get(requestId);
    if (!info) return;
    await this.queue.enqueue("chat.update", {
      channel: info.channelId,
      ts: info.messageTs,
      blocks: [],
    });
    this.pendingMessages.delete(requestId);
  }
```

- [ ] **Step 6: Use per-request cleanup for subscription sessions in `deleteSessionThread`**

In `src/adapter.ts` `deleteSessionThread`, replace the existing `cleanupSession(meta.channelId)` call with a thread-aware variant:

```ts
    try {
      if (meta.threadTs) {
        const sess = this.core.sessionManager.getSession(sessionId);
        const requestId = sess?.permissionGate?.requestId;
        if (requestId) await this.permissionHandler.cleanupRequest(requestId);
      } else {
        await this.permissionHandler.cleanupSession(meta.channelId);
      }
    } catch (err) {
      this.log.warn({ err, sessionId }, "Failed to clean up permission buttons");
    }
```

- [ ] **Step 7: Run the suite + build**

Run: `npx vitest run src/__tests__/permission-handler.test.ts && npm run build && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/adapter.ts src/permission-handler.ts src/__tests__/permission-handler.test.ts
git commit -m "feat: protect subscribed channels from archival; scope permission cleanup per thread

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Restart recovery — restore `threadTs`

**Files:**
- Modify: `src/adapter.ts`

- [ ] **Step 1: Restore `threadTs` in `tryRestoreSessionFromRecord`**

In `src/adapter.ts` `tryRestoreSessionFromRecord`, read and store the persisted thread root so post-restart output re-threads correctly. Update the meta construction:

```ts
    const channelId = record?.platform?.channelId as string | undefined;
    const channelSlug = (record?.platform?.threadId ?? record?.platform?.topicId) as string | undefined;
    const threadTs = record?.platform?.threadTs as string | undefined;
    if (!channelId || !channelSlug) return;
```
```ts
      this.sessions.set(sessionId, { channelId, channelSlug, threadTs });
```

- [ ] **Step 2: Verify build + full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: restore subscription threadTs across restarts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document `subscribedChannels`**

In `README.md`, add a row to the config table:

```markdown
| `subscribedChannels` | Optional. Channels to watch: `[{ "channelId": "C...", "trigger": "mention" \| "all" }]`. Invite the bot to each. Default: `[]` |
```

And add a section after **Output Mode**:

```markdown
### Channel Subscription

Beyond the per-session channels the bot creates, you can point it at **existing**
channels. Invite the bot to the channel and list it under `subscribedChannels`:

```json
"subscribedChannels": [
  { "channelId": "C0123ABCD", "trigger": "mention" }
]
```

- `trigger: "mention"` (default) — the bot starts a session only when a top-level
  message `@mentions` it.
- `trigger: "all"` — every top-level message starts a session.

Each top-level trigger opens a **thread**; the agent works and replies inside that
thread, and any reply in the thread continues the same session (with full context).
Tool-permission requests appear as buttons in the thread. The bot never archives a
subscribed channel.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Slack channel subscription

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] **Run the full suite and build**

Run: `npm test && npm run build`
Expected: All tests pass; clean build.

- [ ] **Manual smoke test (optional, requires a workspace)**

1. Add a `subscribedChannels` entry for a test channel; invite the bot.
2. Post `@OpenACP hello` at the channel top level → a thread opens, the agent replies in-thread.
3. Reply in the thread → the agent continues with context.
4. Trigger a tool that needs permission → buttons appear in-thread; click Allow → the agent continues.
5. Confirm the channel is never archived and that other threads are unaffected.
