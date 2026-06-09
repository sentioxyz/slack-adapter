# Slack Attachment & Forwarded-Thread Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the agent the full Slack thread's attachments and forwarded/shared messages — inlining small text, saving large text as files, and serving binaries (image/PDF/…) lazily through a localhost auth proxy that injects the bot token.

**Architecture:** Pure helpers do the parsing/classification; the adapter orchestrates I/O. The event router extracts forwarded messages from `msg.attachments` and passes them through. The adapter collects files across the thread (reusing the existing `conversations.replies` pagination), classifies each, then materializes: inline text into the prompt, save large text as `Attachment`s, and register binaries with a self-contained localhost HTTP proxy. A per-session "seen file id" set prevents re-feeding the same files on later turns.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Node `http`/`crypto`, `@slack/web-api`, `@openacp/plugin-sdk`.

Reference spec: `docs/superpowers/specs/2026-06-09-slack-attachment-reading-design.md`

---

## File Structure

- `src/types.ts` — **modify**: add `ForwardedMessage`, `CollectedAttachment`, `AttachmentCategory`; add `files`/`bot_id` already on `ThreadContextMessage` lives in adapter.ts — extend there; add config fields.
- `src/utils.ts` — **modify**: add `isTextFile`.
- `src/attachment-classifier.ts` — **create**: pure `classifyAttachment`.
- `src/attachment-collector.ts` — **create**: pure `collectAttachments`.
- `src/file-proxy.ts` — **create**: `SlackFileProxy` localhost server.
- `src/event-router.ts` — **modify**: extract `forwards` from `msg.attachments`, widen callbacks.
- `src/adapter.ts` — **modify**: extend `ThreadContextMessage` with `files`; extract `fetchThreadMessages`; add `buildAttachmentPayload`; wire proxy lifecycle + seen-set; thread `extras` through `dispatchToSession` and both callback closures.
- `README.md` — **modify**: document config + scopes.

Tests live in `src/__tests__/` (Vitest), mirroring existing files.

---

## Task 1: `isTextFile` helper

**Files:**
- Modify: `src/utils.ts`
- Test: `src/__tests__/utils-text-file.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/utils-text-file.test.ts
import { describe, expect, it } from "vitest";
import { isTextFile } from "../utils.js";

function f(mimetype: string, name = "x") {
  return { id: "F1", name, mimetype, size: 0, url_private: "https://files.slack.com/x" };
}

describe("isTextFile", () => {
  it("treats text/* as text", () => {
    expect(isTextFile(f("text/plain"))).toBe(true);
    expect(isTextFile(f("text/csv"))).toBe(true);
    expect(isTextFile(f("text/markdown"))).toBe(true);
  });

  it("treats known textual application types as text", () => {
    expect(isTextFile(f("application/json"))).toBe(true);
    expect(isTextFile(f("application/xml"))).toBe(true);
    expect(isTextFile(f("application/javascript"))).toBe(true);
    expect(isTextFile(f("application/x-yaml"))).toBe(true);
  });

  it("rejects binary types", () => {
    expect(isTextFile(f("image/png"))).toBe(false);
    expect(isTextFile(f("application/pdf"))).toBe(false);
    expect(isTextFile(f("audio/mpeg"))).toBe(false);
    expect(isTextFile(f("application/octet-stream"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/utils-text-file.test.ts`
Expected: FAIL — `isTextFile` is not exported.

- [ ] **Step 3: Implement**

Add to `src/utils.ts` (after `isAudioClip`):

```ts
/** Textual application/* subtypes that should be treated as text, not binary. */
const TEXTUAL_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-httpd-php",
  "application/sql",
]);

/** Detect text-like Slack files (inlineable or saveable as a text attachment). */
export function isTextFile(file: SlackFileInfo): boolean {
  const mime = file.mimetype ?? "";
  if (mime.startsWith("text/")) return true;
  return TEXTUAL_APPLICATION_TYPES.has(mime);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/utils-text-file.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils.ts src/__tests__/utils-text-file.test.ts
git commit -m "feat: add isTextFile helper for attachment classification"
```

---

## Task 2: Shared attachment types

**Files:**
- Modify: `src/types.ts`

No test (type-only). Verified by `tsc` in later tasks.

- [ ] **Step 1: Add types to `src/types.ts`**

Append after the `SlackFileInfo` interface:

```ts
/**
 * A forwarded / shared message extracted from a Slack message's `attachments`
 * array. Slack represents a shared message as an attachment carrying the
 * original author, channel, text, and any files.
 */
export interface ForwardedMessage {
  author?: string;       // author_name, falling back to author_id
  channelName?: string;  // channel_name of the source
  ts?: string;           // ts of the shared message
  text: string;          // shared message body (may be empty)
  files: SlackFileInfo[]; // files attached to the shared message
}

/** A file candidate collected from the triggering message, thread, or a forward. */
export interface CollectedAttachment {
  file: SlackFileInfo;
  source: "message" | "thread" | "forward";
}

/** How an attachment is delivered to the agent. */
export type AttachmentCategory = "audio" | "text-inline" | "text-file" | "binary";
```

- [ ] **Step 2: Add config fields**

In `SlackChannelConfigSchema` (in `src/types.ts`), add before the closing `})`:

```ts
  /**
   * Text files at or below this size (bytes) are inlined into the prompt;
   * larger text files are saved as file attachments. Default 16 KiB.
   */
  attachmentInlineMaxBytes: z.number().int().positive().default(16384),
  /**
   * When true (default), the adapter walks the full Slack thread
   * (conversations.replies) to collect attachments from every message, not just
   * the triggering one. Set false to limit API calls to the triggering message.
   */
  readThreadHistory: z.boolean().default(true),
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add forwarded-message + attachment types and config fields"
```

---

## Task 3: Attachment classifier

**Files:**
- Create: `src/attachment-classifier.ts`
- Test: `src/__tests__/attachment-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/attachment-classifier.test.ts
import { describe, expect, it } from "vitest";
import { classifyAttachment } from "../attachment-classifier.js";

function f(mimetype: string, size: number, name = "x") {
  return { id: "F1", name, mimetype, size, url_private: "https://files.slack.com/x" };
}
const opts = { inlineMaxBytes: 100 };

describe("classifyAttachment", () => {
  it("classifies audio first", () => {
    expect(classifyAttachment(f("audio/mpeg", 9999), opts)).toBe("audio");
    expect(classifyAttachment(f("video/mp4", 9999, "audio_message_x.mp4"), opts)).toBe("audio");
  });

  it("inlines small text", () => {
    expect(classifyAttachment(f("text/plain", 50), opts)).toBe("text-inline");
    expect(classifyAttachment(f("application/json", 100), opts)).toBe("text-inline");
  });

  it("saves large text as file", () => {
    expect(classifyAttachment(f("text/plain", 101), opts)).toBe("text-file");
  });

  it("treats everything else as binary", () => {
    expect(classifyAttachment(f("image/png", 10), opts)).toBe("binary");
    expect(classifyAttachment(f("application/pdf", 10), opts)).toBe("binary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/attachment-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/attachment-classifier.ts
// Pure classification of Slack files into delivery categories.
import type { SlackFileInfo, AttachmentCategory } from "./types.js";
import { isAudioClip, isTextFile } from "./utils.js";

export function classifyAttachment(
  file: SlackFileInfo,
  opts: { inlineMaxBytes: number },
): AttachmentCategory {
  if (isAudioClip(file)) return "audio";
  if (isTextFile(file)) {
    return (file.size ?? 0) <= opts.inlineMaxBytes ? "text-inline" : "text-file";
  }
  return "binary";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/attachment-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/attachment-classifier.ts src/__tests__/attachment-classifier.test.ts
git commit -m "feat: add attachment classifier"
```

---

## Task 4: Attachment collector

**Files:**
- Create: `src/attachment-collector.ts`
- Test: `src/__tests__/attachment-collector.test.ts`

Note: the collector consumes thread messages typed as `{ bot_id?: string; files?: SlackFileInfo[] }`. This matches the `ThreadContextMessage` shape extended in Task 6; the collector defines its own minimal input type to stay decoupled.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/attachment-collector.test.ts
import { describe, expect, it } from "vitest";
import { collectAttachments } from "../attachment-collector.js";
import type { SlackFileInfo, ForwardedMessage } from "../types.js";

function file(id: string, name = id, mimetype = "image/png"): SlackFileInfo {
  return { id, name, mimetype, size: 1, url_private: `https://files.slack.com/${id}` };
}

describe("collectAttachments", () => {
  it("collects from trigger, thread, and forwards", () => {
    const forwards: ForwardedMessage[] = [
      { author: "alice", channelName: "incidents", ts: "1", text: "see this", files: [file("F3")] },
    ];
    const res = collectAttachments({
      triggerFiles: [file("F1")],
      threadMessages: [{ files: [file("F2")] }],
      forwards,
    });
    const ids = res.attachments.map((a) => a.file.id).sort();
    expect(ids).toEqual(["F1", "F2", "F3"]);
    expect(res.attachments.find((a) => a.file.id === "F1")!.source).toBe("message");
    expect(res.attachments.find((a) => a.file.id === "F2")!.source).toBe("thread");
    expect(res.attachments.find((a) => a.file.id === "F3")!.source).toBe("forward");
    expect(res.forwardedTexts[0]).toContain("alice");
    expect(res.forwardedTexts[0]).toContain("see this");
  });

  it("dedupes by file id (first occurrence wins)", () => {
    const res = collectAttachments({
      triggerFiles: [file("F1")],
      threadMessages: [{ files: [file("F1")] }],
    });
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].source).toBe("message");
  });

  it("skips files already in the seen set", () => {
    const res = collectAttachments({
      triggerFiles: [file("F1"), file("F2")],
      seen: new Set(["F1"]),
    });
    expect(res.attachments.map((a) => a.file.id)).toEqual(["F2"]);
  });

  it("skips files from bot messages in the thread", () => {
    const res = collectAttachments({
      threadMessages: [{ bot_id: "B1", files: [file("F9")] }],
    });
    expect(res.attachments).toHaveLength(0);
  });

  it("omits forwarded text entries that have no text", () => {
    const res = collectAttachments({
      forwards: [{ text: "", files: [file("F4")] }],
    });
    expect(res.forwardedTexts).toHaveLength(0);
    expect(res.attachments.map((a) => a.file.id)).toEqual(["F4"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/attachment-collector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/attachment-collector.ts
// Pure collection + dedup of attachment candidates from the triggering message,
// thread history, and forwarded/shared messages.
import type { SlackFileInfo, ForwardedMessage, CollectedAttachment } from "./types.js";

/** Minimal thread-message shape the collector needs. */
export interface CollectorThreadMessage {
  bot_id?: string;
  files?: SlackFileInfo[];
}

export interface CollectInput {
  triggerFiles?: SlackFileInfo[];
  threadMessages?: CollectorThreadMessage[];
  forwards?: ForwardedMessage[];
  /** File ids already surfaced in a prior turn — skipped. */
  seen?: Set<string>;
}

export interface CollectResult {
  attachments: CollectedAttachment[];
  /** Rendered "[Forwarded from …]\n> text" blocks, always inlined by the caller. */
  forwardedTexts: string[];
}

export function collectAttachments(input: CollectInput): CollectResult {
  const seen = input.seen ?? new Set<string>();
  const taken = new Set<string>();
  const attachments: CollectedAttachment[] = [];

  const add = (file: SlackFileInfo, source: CollectedAttachment["source"]) => {
    if (!file?.id) return;
    if (seen.has(file.id) || taken.has(file.id)) return;
    taken.add(file.id);
    attachments.push({ file, source });
  };

  // Order matters for source attribution on dedup: message > thread > forward.
  for (const f of input.triggerFiles ?? []) add(f, "message");
  for (const m of input.threadMessages ?? []) {
    if (m.bot_id) continue; // never re-feed the bot's own uploads
    for (const f of m.files ?? []) add(f, "thread");
  }
  const forwardedTexts: string[] = [];
  for (const fwd of input.forwards ?? []) {
    const text = (fwd.text ?? "").trim();
    if (text) {
      const where = [fwd.author && `@${fwd.author}`, fwd.channelName && `#${fwd.channelName}`, fwd.ts]
        .filter(Boolean)
        .join(" in ");
      const header = where ? `[Forwarded from ${where}]` : "[Forwarded message]";
      forwardedTexts.push(`${header}\n> ${text.replace(/\n/g, "\n> ")}`);
    }
    for (const f of fwd.files ?? []) add(f, "forward");
  }

  return { attachments, forwardedTexts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/attachment-collector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/attachment-collector.ts src/__tests__/attachment-collector.test.ts
git commit -m "feat: add attachment collector with dedup and seen-set"
```

---

## Task 5: Localhost file proxy

**Files:**
- Create: `src/file-proxy.ts`
- Test: `src/__tests__/file-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/file-proxy.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackFileProxy } from "../file-proxy.js";

let proxy: SlackFileProxy | undefined;
afterEach(async () => { await proxy?.stop(); proxy = undefined; });

function okFetch(body: string, contentType = "application/pdf") {
  return vi.fn(async (_url: string, init?: any) => {
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  });
}

describe("SlackFileProxy", () => {
  it("streams the upstream file with the bot token injected", async () => {
    const fetchImpl = okFetch("PDFBYTES");
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: fetchImpl as any });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    expect(url.startsWith(proxy.baseUrl)).toBe(true);

    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("PDFBYTES");

    const init = (fetchImpl as any).mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer xoxb-123");
  });

  it("returns 404 for unknown tokens", async () => {
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: okFetch("x") as any });
    await proxy.start();
    const resp = await fetch(`${proxy.baseUrl}/slack-file/nope`);
    expect(resp.status).toBe(404);
  });

  it("returns 502 when Slack responds with an HTML login page", async () => {
    const htmlFetch = vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: htmlFetch as any });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    const resp = await fetch(url);
    expect(resp.status).toBe(502);
  });

  it("returns 404 for expired tokens", async () => {
    let t = 1000;
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: okFetch("x") as any, ttlMs: 50, now: () => t });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    t = 2000; // advance past ttl
    const resp = await fetch(url);
    expect(resp.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/file-proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/file-proxy.ts
// Self-contained localhost HTTP proxy that streams Slack url_private files to
// the (same-host) agent, injecting the bot token. Agents fetch lazily; no token
// is ever exposed to the agent.
import http from "node:http";
import crypto from "node:crypto";
import type { Logger } from "./types.js";

export interface FileProxyEntry {
  url_private: string;
  mimetype: string;
  name: string;
}

interface StoredEntry extends FileProxyEntry {
  expiresAt: number;
}

export interface FileProxyOptions {
  botToken: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class SlackFileProxy {
  private server?: http.Server;
  private port?: number;
  private entries = new Map<string, StoredEntry>();
  private readonly botToken: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: FileProxyOptions) {
    this.botToken = opts.botToken;
    this.log = opts.log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve();
      });
    });
    this.log.info({ port: this.port }, "Slack file proxy listening");
  }

  get baseUrl(): string {
    if (this.port === undefined) throw new Error("SlackFileProxy not started");
    return `http://127.0.0.1:${this.port}`;
  }

  /** Register a file and return a localhost URL the agent can download. */
  register(entry: FileProxyEntry): string {
    const token = crypto.randomBytes(16).toString("hex");
    this.entries.set(token, { ...entry, expiresAt: this.now() + this.ttlMs });
    return `${this.baseUrl}/slack-file/${token}`;
  }

  async stop(): Promise<void> {
    this.entries.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/slack-file\/([a-f0-9]+)$/.exec(req.url ?? "");
    const token = match?.[1];
    const entry = token ? this.entries.get(token) : undefined;
    if (!entry || entry.expiresAt < this.now()) {
      if (entry) this.entries.delete(token!);
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const upstream = await this.fetchImpl(entry.url_private, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const ct = upstream.headers.get("content-type") ?? "";
      if (!upstream.ok || ct.includes("text/html")) {
        this.log.warn({ name: entry.name, status: upstream.status }, "Slack file proxy upstream failed (bad status or HTML login — check files:read scope)");
        res.writeHead(502).end("upstream error");
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        "content-type": entry.mimetype || ct || "application/octet-stream",
        "content-length": String(buf.length),
        "content-disposition": `inline; filename="${entry.name.replace(/"/g, "")}"`,
      }).end(buf);
    } catch (err) {
      this.log.error({ err, name: entry.name }, "Slack file proxy error");
      res.writeHead(502).end("upstream error");
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/file-proxy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/file-proxy.ts src/__tests__/file-proxy.test.ts
git commit -m "feat: add localhost Slack file proxy with auth injection"
```

---

## Task 6: Expose `fetchThreadMessages` (carry files through thread fetch)

**Files:**
- Modify: `src/adapter.ts` (`ThreadContextMessage` interface ~line 99; `fetchThreadContext` ~line 170)
- Test: `src/__tests__/fetch-thread-messages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/fetch-thread-messages.test.ts
import { describe, expect, it, vi } from "vitest";
import { fetchThreadMessages } from "../adapter.js";

const log = { info() {}, warn: vi.fn(), error() {}, debug() {} };

describe("fetchThreadMessages", () => {
  it("returns messages with their files across pages", async () => {
    const enqueue = vi.fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "1", user: "U1", files: [{ id: "F1", name: "a", mimetype: "image/png", size: 1, url_private: "u" }] }],
        has_more: true,
        response_metadata: { next_cursor: "c1" },
      })
      .mockResolvedValueOnce({ messages: [{ ts: "2", user: "U2" }], has_more: false });

    const msgs = await fetchThreadMessages(enqueue as any, log as any, "C1", "1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].files?.[0].id).toBe("F1");
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/fetch-thread-messages.test.ts`
Expected: FAIL — `fetchThreadMessages` not exported.

- [ ] **Step 3: Implement**

In `src/adapter.ts`, extend `ThreadContextMessage` (currently ~line 99):

```ts
export interface ThreadContextMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: import("./types.js").SlackFileInfo[];
}
```

Then refactor `fetchThreadContext` (~line 170) to delegate to a new exported `fetchThreadMessages`. Replace the body of `fetchThreadContext` so the pagination lives in `fetchThreadMessages`:

```ts
/**
 * Page through a Slack thread via conversations.replies (oldest → newest,
 * following the forward cursor) and return the raw messages. Pagination and
 * truncation-logging behavior is shared by thread-context rendering and
 * attachment collection. The Slack call is NOT wrapped — callers degrade.
 */
export async function fetchThreadMessages(
  enqueue: <T = unknown>(method: "conversations.replies", params: Record<string, unknown>) => Promise<T>,
  log: Logger,
  channelId: string,
  threadTs: string,
  maxPages = 10,
): Promise<ThreadContextMessage[]> {
  const PAGE_LIMIT = 200;
  const collected: ThreadContextMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const params: Record<string, unknown> = { channel: channelId, ts: threadTs, limit: PAGE_LIMIT };
    if (cursor) params.cursor = cursor;
    const res = await enqueue<{
      messages?: ThreadContextMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>("conversations.replies", params);

    collected.push(...(res?.messages ?? []));
    pages += 1;
    cursor = res?.has_more ? res?.response_metadata?.next_cursor : undefined;
    if (cursor && pages >= maxPages) { truncated = true; break; }
  } while (cursor);

  if (truncated) {
    log.warn(
      { channelId, threadTs, collected: collected.length, maxPages },
      "Thread exceeds context page cap; oldest messages omitted from prepended history",
    );
  }
  return collected;
}

export async function fetchThreadContext(
  enqueue: <T = unknown>(method: "conversations.replies", params: Record<string, unknown>) => Promise<T>,
  log: Logger,
  channelId: string,
  threadTs: string,
  triggerTs?: string,
  maxPages = 10,
): Promise<string> {
  const collected = await fetchThreadMessages(enqueue, log, channelId, threadTs, maxPages);
  return renderThreadContext(collected, triggerTs);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/fetch-thread-messages.test.ts src/__tests__/adapter-lifecycle.test.ts`
Expected: PASS (new test passes; existing thread-context tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/fetch-thread-messages.test.ts
git commit -m "refactor: extract fetchThreadMessages carrying files"
```

---

## Task 7: Event router — extract forwarded messages

**Files:**
- Modify: `src/event-router.ts`
- Test: `src/__tests__/event-router.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/event-router.test.ts` a new describe block. (Use existing helpers in that file if present; otherwise this standalone block works — it tests the pure extractor.)

```ts
import { extractForwards } from "../event-router.js";

describe("extractForwards", () => {
  it("returns [] when no attachments", () => {
    expect(extractForwards(undefined)).toEqual([]);
    expect(extractForwards([])).toEqual([]);
  });

  it("maps shared-message attachments to ForwardedMessage", () => {
    const fwds = extractForwards([
      {
        author_name: "alice",
        channel_name: "incidents",
        ts: "111.2",
        text: "look here",
        files: [{ id: "F1", name: "log.txt", mimetype: "text/plain", size: 10, url_private: "u" }],
      },
    ]);
    expect(fwds).toHaveLength(1);
    expect(fwds[0]).toMatchObject({ author: "alice", channelName: "incidents", ts: "111.2", text: "look here" });
    expect(fwds[0].files[0].id).toBe("F1");
  });

  it("skips attachments with neither text nor files (e.g. link unfurls without content)", () => {
    expect(extractForwards([{ title: "just a link" }])).toEqual([]);
  });

  it("falls back to author_id when author_name is absent", () => {
    const fwds = extractForwards([{ author_id: "U9", text: "hi" }]);
    expect(fwds[0].author).toBe("U9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: FAIL — `extractForwards` not exported.

- [ ] **Step 3: Implement**

In `src/event-router.ts`:

1. Add the import: `import type { SlackSessionMeta, SlackFileInfo, ForwardedMessage, Logger } from "./types.js";`
2. Extend the `SlackMessageEvent` interface with `attachments`:

```ts
  attachments?: Array<{
    author_name?: string;
    author_id?: string;
    channel_name?: string;
    ts?: string;
    text?: string;
    files?: Array<{ id: string; name: string; mimetype: string; size: number; url_private: string }>;
  }>;
```

3. Add the exported pure extractor (after the `SlackMessageEvent` interface):

```ts
/** Extract forwarded/shared messages (text + nested files) from a Slack
 * message's `attachments` array. Attachments with neither text nor files
 * (e.g. content-less link unfurls) are skipped. Exported for unit testing. */
export function extractForwards(
  attachments: SlackMessageEvent["attachments"],
): ForwardedMessage[] {
  const out: ForwardedMessage[] = [];
  for (const a of attachments ?? []) {
    const files: SlackFileInfo[] = (a.files ?? []).map((f) => ({
      id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url_private: f.url_private,
    }));
    const text = (a.text ?? "").trim();
    if (!text && files.length === 0) continue;
    out.push({
      author: a.author_name ?? a.author_id,
      channelName: a.channel_name,
      ts: a.ts,
      text,
      files,
    });
  }
  return out;
}
```

4. Widen both callback types to carry forwards:

```ts
export type IncomingMessageCallback = (
  sessionId: string, text: string, userId: string,
  files?: SlackFileInfo[], forwards?: ForwardedMessage[],
) => void | Promise<void>;

export type SubscriptionMessageCallback = (
  channelId: string, threadTs: string, userId: string, text: string,
  files?: SlackFileInfo[],
  opts?: { midThread?: boolean; triggerTs?: string; forwards?: ForwardedMessage[] },
) => void | Promise<void>;
```

5. In `register`, compute forwards and pass them through. After the `files` mapping (~line 88) add:

```ts
      const forwards = extractForwards(msg.attachments);
```

Update the subscription dispatch (~line 115) so `opts` always carries forwards:

```ts
        const opts =
          cls.kind === "sub-start"
            ? { midThread: cls.midThread, triggerTs: cls.triggerTs, forwards }
            : { forwards };
        await this.onSubscriptionMessage?.(cls.channelId, cls.threadTs, cls.userId, cls.text, files, opts);
```

Update the legacy `onIncoming` call (~line 147):

```ts
        this.onIncoming(session.channelSlug, text, userId, files, forwards);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/event-router.test.ts`
Expected: PASS (existing + new cases)

- [ ] **Step 5: Commit**

```bash
git add src/event-router.ts src/__tests__/event-router.test.ts
git commit -m "feat: extract forwarded messages in the event router"
```

---

## Task 8: Adapter — build attachment payload (prompt additions + attachments)

**Files:**
- Modify: `src/adapter.ts`
- Test: `src/__tests__/build-attachment-payload.test.ts`

This task adds a pure-ish builder that takes already-collected/classified inputs and produces `{ promptAdditions, attachments }`, using injected I/O so it is testable without a live Slack client. The adapter method in Task 9 wires the real I/O into it.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/build-attachment-payload.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildAttachmentPayload } from "../adapter.js";
import type { SlackFileInfo } from "../types.js";

function file(id: string, name: string, mimetype: string, size: number): SlackFileInfo {
  return { id, name, mimetype, size, url_private: `https://files.slack.com/${id}` };
}

describe("buildAttachmentPayload", () => {
  it("inlines small text, saves large text, links binaries, and inlines forwards", async () => {
    const download = vi.fn(async (url: string) => Buffer.from(`bytes:${url}`));
    const saveFile = vi.fn(async (_sid: string, name: string, _buf: Buffer, mime: string) => ({
      type: "file", filePath: `/tmp/${name}`, fileName: name, mimeType: mime, size: 1,
    }));
    const registerProxy = vi.fn((f: SlackFileInfo) => `http://127.0.0.1:1/slack-file/${f.id}`);

    const res = await buildAttachmentPayload({
      sessionId: "s1",
      inlineMaxBytes: 100,
      collected: [
        { file: file("F1", "small.txt", "text/plain", 10), source: "message" },
        { file: file("F2", "big.log", "text/plain", 9999), source: "thread" },
        { file: file("F3", "diagram.png", "image/png", 5000), source: "message" },
      ],
      forwardedTexts: ["[Forwarded from @alice]\n> hello"],
      download,
      saveFile,
      registerProxy,
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });

    // forwarded text inlined
    expect(res.promptAdditions).toContain("[Forwarded from @alice]");
    // small text inlined with filename + contents
    expect(res.promptAdditions).toContain("small.txt");
    expect(res.promptAdditions).toContain("bytes:https://files.slack.com/F1");
    // binary listed as a download link
    expect(res.promptAdditions).toContain("http://127.0.0.1:1/slack-file/F3");
    expect(res.promptAdditions).toContain("diagram.png");
    // large text saved as a file attachment
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].fileName).toBe("big.log");
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(registerProxy).toHaveBeenCalledTimes(1);
    // every successfully-handled file id is reported for the seen-set
    expect(res.surfacedIds.sort()).toEqual(["F1", "F2", "F3"]);
  });

  it("skips a file whose download fails but still surfaces the rest", async () => {
    const download = vi.fn(async (url: string) => (url.endsWith("F1") ? null : Buffer.from("ok")));
    const saveFile = vi.fn(async (_s: string, name: string, _b: Buffer, mime: string) => ({
      type: "file", filePath: `/tmp/${name}`, fileName: name, mimeType: mime, size: 1,
    }));
    const res = await buildAttachmentPayload({
      sessionId: "s1",
      inlineMaxBytes: 5,
      collected: [{ file: file("F1", "a.txt", "text/plain", 1), source: "message" }],
      forwardedTexts: [],
      download,
      saveFile,
      registerProxy: vi.fn(),
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });
    expect(res.promptAdditions).toBe("");
    expect(res.attachments).toHaveLength(0);
    expect(res.surfacedIds).toEqual([]);
  });

  it("returns empty additions when nothing is collected", async () => {
    const res = await buildAttachmentPayload({
      sessionId: "s1", inlineMaxBytes: 100, collected: [], forwardedTexts: [],
      download: vi.fn(), saveFile: vi.fn(), registerProxy: vi.fn(),
      log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    });
    expect(res.promptAdditions).toBe("");
    expect(res.attachments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/build-attachment-payload.test.ts`
Expected: FAIL — `buildAttachmentPayload` not exported.

- [ ] **Step 3: Implement**

Add to `src/adapter.ts` (top-level export, near the other pure helpers like `renderThreadContext`). Import `classifyAttachment` and the attachment types at the top of the file:

```ts
import { classifyAttachment } from "./attachment-classifier.js";
import type { CollectedAttachment } from "./types.js";
// `Attachment`, `SlackFileInfo`, `Logger` are already imported in adapter.ts.
```

```ts
/** Total bytes of inlined text allowed before remaining text is demoted to a
 * download link, to keep the prompt from ballooning. */
const INLINE_TEXT_BUDGET = 50_000;

export interface BuildAttachmentPayloadInput {
  sessionId: string;
  inlineMaxBytes: number;
  collected: CollectedAttachment[];
  forwardedTexts: string[];
  /** Download bytes for a file's url_private (auth handled by caller). */
  download: (url: string) => Promise<Buffer | null>;
  /** Persist a buffer as a session Attachment. */
  saveFile: (sessionId: string, fileName: string, data: Buffer, mimeType: string) => Promise<Attachment>;
  /** Register a binary with the proxy and return a download URL. */
  registerProxy: (file: SlackFileInfo) => string;
  log: Logger;
}

export interface BuildAttachmentPayloadResult {
  promptAdditions: string;
  attachments: Attachment[];
  /** Ids successfully surfaced this turn (added to the per-thread seen-set). */
  surfacedIds: string[];
}

export async function buildAttachmentPayload(
  input: BuildAttachmentPayloadInput,
): Promise<BuildAttachmentPayloadResult> {
  const attachments: Attachment[] = [];
  const surfacedIds: string[] = [];
  const inlineBlocks: string[] = [...input.forwardedTexts];
  const linkLines: string[] = [];
  let inlineUsed = 0;

  for (const { file } of input.collected) {
    const category = classifyAttachment(file, { inlineMaxBytes: input.inlineMaxBytes });
    try {
      if (category === "text-inline" && inlineUsed + (file.size ?? 0) <= INLINE_TEXT_BUDGET) {
        const buf = await input.download(file.url_private);
        if (!buf) continue;
        inlineUsed += buf.length;
        inlineBlocks.push(`--- Attachment: ${file.name} (${file.mimetype}, ${file.size}B) ---\n${buf.toString("utf8")}`);
        surfacedIds.push(file.id);
      } else if (category === "text-file" || category === "audio") {
        const buf = await input.download(file.url_private);
        if (!buf) continue;
        const mime = file.mimetype === "video/mp4" ? "audio/mp4" : file.mimetype;
        const att = await input.saveFile(input.sessionId, file.name, buf, mime);
        attachments.push(att);
        surfacedIds.push(file.id);
      } else {
        // binary (or inline text over budget) → lazy proxy link
        const url = input.registerProxy(file);
        linkLines.push(`- ${file.name} (${file.mimetype}, ${file.size}B): ${url}`);
        surfacedIds.push(file.id);
      }
    } catch (err) {
      input.log.warn({ err, file: file.name }, "Failed to materialize attachment; skipping");
    }
  }

  const sections: string[] = [];
  if (inlineBlocks.length) sections.push(inlineBlocks.join("\n\n"));
  if (linkLines.length) {
    sections.push(
      "[Attachments available for download — no auth required, fetch with curl/WebFetch if needed:]\n" +
        linkLines.join("\n"),
    );
  }
  return { promptAdditions: sections.join("\n\n"), attachments, surfacedIds };
}
```

Note: `audio` is routed through `saveFile` here (matching today's behavior) so the existing audio path can later delegate to this builder; binaries use the proxy.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/build-attachment-payload.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapter.ts src/__tests__/build-attachment-payload.test.ts
git commit -m "feat: add buildAttachmentPayload (inline/file/link materialization)"
```

---

## Task 9: Adapter wiring — proxy lifecycle, collection, dispatch

**Files:**
- Modify: `src/adapter.ts`
- Test: `src/__tests__/adapter-lifecycle.test.ts` (only to confirm nothing breaks); manual reasoning for wiring.

This task connects the pieces. No new pure logic, so it reuses the unit-tested helpers; verification is the full suite + `tsc`.

- [ ] **Step 1: Add fields and imports**

Near the top imports of `src/adapter.ts`:

```ts
import { SlackFileProxy } from "./file-proxy.js";
import { collectAttachments } from "./attachment-collector.js";
import type { ForwardedMessage } from "./types.js";
```

Add instance fields (near `private fileService!: FileServiceInterface;`):

```ts
  private fileProxy?: SlackFileProxy;
  /** file ids already surfaced to the agent, keyed by session channel slug */
  private surfacedFiles = new Map<string, Set<string>>();
```

- [ ] **Step 2: Start the proxy in `start()`**

After `this.webClient = new WebClient(botToken);` (~line 399) and once `botToken` is known, add (best-effort — a proxy failure must not block startup):

```ts
    try {
      this.fileProxy = new SlackFileProxy({ botToken: botToken!, log: this.log });
      await this.fileProxy.start();
    } catch (err) {
      this.log.warn({ err }, "Failed to start Slack file proxy; binary attachments will be skipped");
      this.fileProxy = undefined;
    }
```

- [ ] **Step 3: Stop the proxy in `stop()`**

In `async stop()` (~line 794), before/after the existing teardown add:

```ts
    await this.fileProxy?.stop().catch((err) => this.log.warn({ err }, "Error stopping Slack file proxy"));
    this.fileProxy = undefined;
```

- [ ] **Step 4: Extend `dispatchToSession` to collect + materialize attachments**

Replace the current `dispatchToSession` (the `processFiles`/audio-only block) with a version that uses the builder. New signature adds an `extras` bag:

```ts
  private async dispatchToSession(
    sessionChannelSlug: string,
    text: string,
    userId: string,
    files?: SlackFileInfo[],
    extras?: { channelId?: string; threadTs?: string; triggerTs?: string; forwards?: ForwardedMessage[] },
  ): Promise<void> {
    if (text.startsWith("/")) {
      const handled = await this.tryCommandDispatch(sessionChannelSlug, text, userId);
      if (handled) return;
    }

    let dispatchText = text;
    let attachments: Attachment[] | undefined;

    try {
      const sessionId = this.core.sessionManager.getSessionByThread("slack", sessionChannelSlug)?.id;
      if (sessionId && this.fileProxy) {
        // Optionally walk the full thread for files from every message.
        let threadMessages: ThreadContextMessage[] | undefined;
        if (this.slackConfig.readThreadHistory !== false && extras?.channelId && extras?.threadTs) {
          try {
            threadMessages = await fetchThreadMessages(
              (method, params) => this.queue.enqueue(method, params),
              this.log, extras.channelId, extras.threadTs,
            );
          } catch (err) {
            this.log.warn({ err }, "Failed to fetch thread history for attachments; using triggering message only");
          }
        }

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

        if (payload.promptAdditions) dispatchText = `${text}\n\n${payload.promptAdditions}`;
        if (payload.attachments.length) attachments = payload.attachments;
      }
    } catch (err) {
      this.log.error({ err }, "Failed to process attachments; dispatching message text only");
    }

    await this.core
      .handleMessage({ channelId: "slack", threadId: sessionChannelSlug, userId, text: dispatchText, attachments })
      .catch((err) => this.log.error({ err }, "handleMessage error"));
  }
```

- [ ] **Step 5: Pass `extras` from both call sites**

Legacy `onIncoming` closure (~line 400). The callback now receives `forwards`; resolve the session's channelId from the lookup:

```ts
      (sessionChannelSlug, text, userId, files, forwards) => {
        const meta = [...this.sessions.values()].find((m) => m.channelSlug === sessionChannelSlug);
        return this.dispatchToSession(sessionChannelSlug, text, userId, files, {
          channelId: meta?.channelId,
          threadTs: meta?.threadTs,
          forwards,
        });
      },
```

Subscription closure (~line 578). It already has `channelId`/`threadTs`; pull `forwards`/`triggerTs` from `opts`:

```ts
          await this.dispatchToSession(meta.channelSlug, dispatchText, userId, files, {
            channelId,
            threadTs,
            triggerTs: opts?.triggerTs,
            forwards: opts?.forwards,
          });
```

- [ ] **Step 6: Verify the whole suite + types**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — all tests green, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: wire attachment collection, proxy, and dispatch into the adapter"
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document config + scopes**

Add rows to the config table in `README.md` for `attachmentInlineMaxBytes` and `readThreadHistory`, and add a short "Attachments" subsection after "Channel Subscription":

```markdown
| `attachmentInlineMaxBytes` | Text files ≤ this size (bytes) are inlined into the prompt; larger ones are saved as files. Default: `16384` |
| `readThreadHistory` | Walk the full thread for attachments from every message, not just the triggering one. Default: `true` |

### Attachments

The bot reads files and forwarded/shared messages from the thread, not just the
message body:

- **Text** (`.txt`, `.log`, `.json`, `.csv`, code) — small files are inlined into
  the prompt; larger ones are attached as files.
- **Forwarded messages** — their text is inlined with attribution.
- **Binaries** (images, PDFs, …) — surfaced as `localhost` download links served
  by the adapter, which injects the bot token. The agent (same host) downloads
  them only if it needs the bytes.

Requires the `files:read` scope (file downloads) plus the relevant history scopes
(`channels:history`, `groups:history`, `im:history`, `mpim:history`) for reading
thread replies.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document attachment reading config and scopes"
```

---

## Self-Review Notes (completed by plan author)

- **Spec coverage:** full-thread collection (Task 6/9), forwarded messages (Task 7), text inline/file hybrid (Task 8), binary lazy proxy (Task 5/8), seen-set dedup (Task 4/9), config fields (Task 2), graceful degradation (Task 8/9), scopes/docs (Task 10). All spec sections mapped.
- **Type consistency:** `classifyAttachment`, `collectAttachments`, `buildAttachmentPayload`, `SlackFileProxy.register`, `extractForwards`, `fetchThreadMessages` signatures are consistent across tasks; `ForwardedMessage`/`CollectedAttachment`/`AttachmentCategory` defined once in Task 2 and reused.
- **No placeholders:** every code step is complete and runnable.
- **Assumption (from spec):** agent runs on the same host as the adapter (localhost proxy). Documented in the spec's "Core assumption".
```
