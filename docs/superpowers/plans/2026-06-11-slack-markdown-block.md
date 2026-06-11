# Slack Markdown Block Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send AI text as raw markdown via Slack's native `markdown` Block Kit block, replacing the lossy regex `markdownToMrkdwn` conversion on the main text paths.

**Architecture:** A new fence-aware splitter (`splitMarkdownSafe`) chunks raw markdown under the 12k cumulative markdown-block limit. A new `markdown-post.ts` module wraps `queue.enqueue` with a one-shot fallback: if Slack rejects a payload containing markdown blocks with `invalid_blocks`, retry once with legacy mrkdwn sections. The two text send-paths (`text-buffer` streaming flush, `formatter.formatOutgoing` text case) switch to markdown blocks; everything else (permission UI, activity tracker, context blocks) stays mrkdwn. `markdownToMrkdwn` is retained for fallbacks and `renderSystemMessage`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, `@slack/bolt` 4.6 (`KnownBlock` already includes `MarkdownBlock`).

**Spec:** `docs/superpowers/specs/2026-06-11-slack-markdown-block-design.md`

**Key facts from live verification (2026-06-11):**
- `{ type: "markdown", text }` is accepted by `chat.postMessage`; Slack server-side translates it into `header`/`rich_text`/`table`/`divider` blocks and stores ONLY the translation. The stored `text` field is verbatim the fallback we pass — agent-to-agent context reading depends on `text` being the **full raw chunk**, never a summary.
- Cumulative limit for all markdown blocks in one payload: 12,000 chars (13.6k → `msg_too_long`). We use a 11,500 safety limit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/utils.ts` | Shared utilities | Add `MARKDOWN_SAFE_LIMIT`, `splitMarkdownSafe` (+ internal segment helpers) |
| `src/markdown-post.ts` | Markdown-block posting with mrkdwn fallback | Create: `markdownBlock()`, `enqueueWithMarkdownFallback()` |
| `src/formatter.ts` | Block generation | `formatOutgoing` text case → markdown block (oversize → legacy sections) |
| `src/text-buffer.ts` | Streaming flush (primary AI text path) | Flush + `stripTtsBlock` via markdown blocks with fallback |
| `src/adapter.ts` | `postFormattedMessage` | Route through `enqueueWithMarkdownFallback` |
| `src/__tests__/split-markdown.test.ts` | Splitter tests | Create |
| `src/__tests__/markdown-post.test.ts` | Fallback helper tests | Create |
| `src/__tests__/formatter.test.ts` | Formatter tests | Update text-case expectations |
| `src/__tests__/text-buffer.test.ts` | Buffer tests | Add markdown-block + fallback cases |

No renderer change: `renderText` delegates to `formatter.formatOutgoing` and inherits the new behavior. No other test file asserts text→section behavior (verified by grep).

---

### Task 1: `splitMarkdownSafe` in `src/utils.ts`

**Files:**
- Modify: `src/utils.ts` (append after `splitSafe`, line 65)
- Test: `src/__tests__/split-markdown.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/split-markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitMarkdownSafe, MARKDOWN_SAFE_LIMIT } from "../utils.js";

describe("splitMarkdownSafe", () => {
  it("returns single chunk when under limit", () => {
    const text = "# Title\n\nSome **bold** text.";
    expect(splitMarkdownSafe(text)).toEqual([text]);
  });

  it("splits at paragraph boundary, all chunks under limit", () => {
    const para = "word ".repeat(100).trim(); // 499 chars
    const text = Array.from({ length: 10 }, (_, i) => `Para ${i}: ${para}`).join("\n\n");
    const chunks = splitMarkdownSafe(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    // splits land between paragraphs: every chunk starts at a "Para N:" head
    for (const c of chunks) expect(c.startsWith("Para ")).toBe(true);
    // no content lost
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("closes and reopens a code fence straddling the cut, preserving language", () => {
    const codeLines = Array.from({ length: 200 }, (_, i) => `line_${i} = compute(${i})`).join("\n");
    const text = `Intro paragraph.\n\n\`\`\`python\n${codeLines}\n\`\`\`\n\nOutro.`;
    const chunks = splitMarkdownSafe(text, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1500);
      // every chunk must have balanced fences (even count of ``` lines)
      const fences = c.split("\n").filter(l => l.trimEnd().match(/^\s{0,3}```/)).length;
      expect(fences % 2).toBe(0);
    }
    // continuation chunks reopen with the language tag
    const reopened = chunks.slice(1).filter(c => c.includes("```python"));
    expect(reopened.length).toBeGreaterThan(0);
    // no code line lost
    for (let i = 0; i < 200; i++) {
      expect(chunks.join("\n")).toContain(`line_${i} = compute(${i})`);
    }
  });

  it("hard-cuts a single line longer than the limit", () => {
    const text = "x".repeat(5000);
    const chunks = splitMarkdownSafe(text, 2000);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("")).toBe(text);
  });

  it("does not split inside a fence when the fence fits in one chunk", () => {
    const fence = "```js\nconst a = 1;\nconst b = 2;\n```";
    const text = `${"p ".repeat(900)}\n\n${fence}\n\nTail.`;
    const chunks = splitMarkdownSafe(text, 1900);
    const withFence = chunks.find(c => c.includes("const a = 1;"));
    expect(withFence).toBeDefined();
    expect(withFence).toContain("```js\nconst a = 1;\nconst b = 2;\n```");
  });

  it("handles CJK text (no word boundaries) by cutting at newlines", () => {
    const line = "中文内容测试".repeat(50); // 300 chars, no spaces
    const text = Array.from({ length: 10 }, () => line).join("\n");
    const chunks = splitMarkdownSafe(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n")).toBe(text); // cuts land on newlines, nothing lost
  });

  it("exports a default limit under Slack's 12k cumulative cap", () => {
    expect(MARKDOWN_SAFE_LIMIT).toBeLessThanOrEqual(11500);
    const text = "a".repeat(30000);
    for (const c of splitMarkdownSafe(text)) {
      expect(c.length).toBeLessThanOrEqual(MARKDOWN_SAFE_LIMIT);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/split-markdown.test.ts`
Expected: FAIL — `splitMarkdownSafe` is not exported from `../utils.js`.

- [ ] **Step 3: Implement in `src/utils.ts`**

Append after `splitSafe` (end of file):

```ts
/** Safety limit for Slack markdown blocks. The platform cap is 12,000 chars
 * cumulative across all markdown blocks in one payload (verified live:
 * 11,942 ok, 13,606 → msg_too_long); the margin absorbs fence re-opening. */
export const MARKDOWN_SAFE_LIMIT = 11500;

type MarkdownSegment =
  | { kind: "text"; body: string }
  | { kind: "fence"; opener: string; body: string };

/** Split markdown into alternating plain-text and complete ``` fence segments. */
function parseMarkdownSegments(text: string): MarkdownSegment[] {
  const segs: MarkdownSegment[] = [];
  let buf: string[] = [];
  let fence: { opener: string; lines: string[] } | null = null;

  for (const line of text.split("\n")) {
    if (fence) {
      if (/^\s{0,3}```\s*$/.test(line)) {
        segs.push({ kind: "fence", opener: fence.opener, body: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
    } else if (/^\s{0,3}```/.test(line)) {
      if (buf.length) { segs.push({ kind: "text", body: buf.join("\n") }); buf = []; }
      fence = { opener: line.trimEnd(), lines: [] };
    } else {
      buf.push(line);
    }
  }
  // Stream may end mid-fence — emit what we have (it gets closed when wrapped).
  if (fence) segs.push({ kind: "fence", opener: fence.opener, body: fence.lines.join("\n") });
  else if (buf.length) segs.push({ kind: "text", body: buf.join("\n") });
  return segs;
}

/** Split plain text preferring paragraph boundaries, then lines, then hard cut. */
function splitAtBoundaries(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split raw markdown into chunks of at most `limit` chars without breaking
 * code fences: a fence straddling a cut is closed at the cut and re-opened
 * (with its info string, e.g. ```python) at the start of the next chunk.
 * Used for Slack markdown blocks, where the 12k limit is cumulative per
 * payload, so each chunk is posted as its own message.
 */
export function splitMarkdownSafe(text: string, limit = MARKDOWN_SAFE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  // 1. Flatten segments into limit-sized pieces (fences wrapped per piece).
  const pieces: string[] = [];
  for (const seg of parseMarkdownSegments(text)) {
    if (seg.kind === "text") {
      pieces.push(...splitAtBoundaries(seg.body, limit).filter(p => p.length > 0));
    } else {
      const wrap = (body: string) => `${seg.opener}\n${body}\n\`\`\``;
      if (wrap(seg.body).length <= limit) {
        pieces.push(wrap(seg.body));
      } else {
        const overhead = seg.opener.length + 5; // opener + \n … \n```
        pieces.push(...splitAtBoundaries(seg.body, limit - overhead).map(wrap));
      }
    }
  }

  // 2. Greedily pack pieces back into chunks.
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!cur) { cur = p; continue; }
    if (cur.length + 1 + p.length <= limit) cur += "\n" + p;
    else { chunks.push(cur); cur = p; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
```

Design note on packing: pieces produced by splitting one oversize text segment are each near `limit`, so the greedy pack never merges two of them (their joined size exceeds `limit`) — paragraph round-trips therefore reconstruct exactly. Merging only happens between small pieces from *different* segments (e.g. intro text + a short fence), where the single `"\n"` joiner matches the original line boundary.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/split-markdown.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run full suite to check for regressions**

Run: `npx vitest run`
Expected: all green (no existing code calls `splitMarkdownSafe` yet).

- [ ] **Step 6: Commit**

```bash
git add src/utils.ts src/__tests__/split-markdown.test.ts
git commit -m "feat: add fence-aware splitMarkdownSafe for markdown blocks"
```

---

### Task 2: `src/markdown-post.ts` — markdown block + `invalid_blocks` fallback

**Files:**
- Create: `src/markdown-post.ts`
- Test: `src/__tests__/markdown-post.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/markdown-post.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { markdownBlock, enqueueWithMarkdownFallback } from "../markdown-post.js";

const platformError = (code: string) => Object.assign(new Error(code), { data: { error: code } });

describe("markdownBlock", () => {
  it("builds a markdown block", () => {
    expect(markdownBlock("# hi")).toEqual({ type: "markdown", text: "# hi" });
  });
});

describe("enqueueWithMarkdownFallback", () => {
  it("posts markdown blocks as-is on success", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
    const args = { channel: "C1", text: "**hi**", blocks: [markdownBlock("**hi**")] };
    const res = await enqueueWithMarkdownFallback({ enqueue } as any, "chat.postMessage", args);
    expect(res).toEqual({ ts: "1.1" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("chat.postMessage", args);
  });

  it("falls back to mrkdwn sections on invalid_blocks", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce(platformError("invalid_blocks"))
      .mockResolvedValueOnce({ ts: "2.2" });
    const res = await enqueueWithMarkdownFallback(
      { enqueue } as any,
      "chat.postMessage",
      { channel: "C1", text: "**bold** raw", blocks: [markdownBlock("**bold** raw")] },
    );
    expect(res).toEqual({ ts: "2.2" });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks[0].type).toBe("section");
    expect(retry.blocks[0].text.text).toBe("*bold* raw"); // converted to mrkdwn
  });

  it("rethrows non-invalid_blocks errors without retrying", async () => {
    const enqueue = vi.fn().mockRejectedValue(platformError("msg_too_long"));
    await expect(enqueueWithMarkdownFallback(
      { enqueue } as any,
      "chat.postMessage",
      { channel: "C1", text: "x", blocks: [markdownBlock("x")] },
    )).rejects.toThrow("msg_too_long");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rethrows invalid_blocks when no markdown block is present", async () => {
    const enqueue = vi.fn().mockRejectedValue(platformError("invalid_blocks"));
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] as any;
    await expect(enqueueWithMarkdownFallback(
      { enqueue } as any, "chat.postMessage", { channel: "C1", blocks },
    )).rejects.toThrow("invalid_blocks");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("splits oversize fallback text into multiple sections", async () => {
    const long = "y".repeat(7000); // > 3000 section limit, fits one markdown block
    const enqueue = vi.fn()
      .mockRejectedValueOnce(platformError("invalid_blocks"))
      .mockResolvedValueOnce({ ts: "3.3" });
    await enqueueWithMarkdownFallback(
      { enqueue } as any, "chat.postMessage",
      { channel: "C1", text: long, blocks: [markdownBlock(long)] },
    );
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks.length).toBeGreaterThan(1);
    for (const b of retry.blocks) {
      expect(b.type).toBe("section");
      expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/markdown-post.test.ts`
Expected: FAIL — cannot resolve `../markdown-post.js`.

- [ ] **Step 3: Create `src/markdown-post.ts`**

```ts
// src/markdown-post.ts
// Posting helpers for Slack's native markdown block, with a one-shot fallback
// to legacy mrkdwn sections for workspaces where the block type is rejected.

import type { types } from "@slack/bolt";
import type { ISlackSendQueue, SlackMethod } from "./send-queue.js";
import type { Logger } from "./types.js";
import { markdownToMrkdwn } from "./formatter.js";
import { splitSafe } from "./utils.js";

type KnownBlock = types.KnownBlock;

export function markdownBlock(text: string): KnownBlock {
  return { type: "markdown", text };
}

/**
 * Enqueue chat.postMessage / chat.update whose blocks may contain markdown
 * blocks. If Slack rejects the payload with `invalid_blocks` (workspace or
 * edition without markdown block support), retry once with every markdown
 * block converted to legacy mrkdwn section blocks. All other errors, and
 * payloads without markdown blocks, propagate unchanged.
 */
export async function enqueueWithMarkdownFallback(
  queue: ISlackSendQueue,
  method: SlackMethod,
  args: Record<string, unknown> & { blocks: KnownBlock[] },
  log?: Logger,
): Promise<unknown> {
  try {
    return await queue.enqueue(method, args);
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    const hasMarkdown = args.blocks.some(b => b.type === "markdown");
    if (code !== "invalid_blocks" || !hasMarkdown) throw err;

    log?.warn({ method }, "markdown block rejected (invalid_blocks); falling back to mrkdwn sections");
    const blocks = args.blocks.flatMap(b =>
      b.type === "markdown"
        ? splitSafe(markdownToMrkdwn((b as { text: string }).text)).map(chunk => ({
            type: "section" as const,
            text: { type: "mrkdwn" as const, text: chunk },
          }))
        : [b],
    );
    return await queue.enqueue(method, { ...args, blocks });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/markdown-post.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/markdown-post.ts src/__tests__/markdown-post.test.ts
git commit -m "feat: markdown block post helper with invalid_blocks fallback"
```

---

### Task 3: `formatter.formatOutgoing` text case → markdown block

**Files:**
- Modify: `src/formatter.ts:63-70` (text case)
- Test: `src/__tests__/formatter.test.ts` (update 2 tests, add 2)

- [ ] **Step 1: Update the tests (they will fail against current code)**

In `src/__tests__/formatter.test.ts`, replace the first test (`"text message returns section blocks"`, lines 8-12) with:

```ts
  it("text message returns a single markdown block with raw text", () => {
    const blocks = fmt.formatOutgoing({ type: "text", text: "# Hi\n\n**bold** | table |" } as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("markdown");
    expect((blocks[0] as any).text).toBe("# Hi\n\n**bold** | table |"); // raw passthrough, no conversion
  });
```

Replace the `"long text (>3000 chars) is split into multiple sections"` test (lines 39-44) with:

```ts
  it("text up to the markdown limit stays a single markdown block", () => {
    const long = "x".repeat(4000); // > old 3000 section limit, < 11500
    const blocks = fmt.formatOutgoing({ type: "text", text: long } as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("markdown");
  });

  it("oversize text (> MARKDOWN_SAFE_LIMIT) falls back to mrkdwn sections", () => {
    const long = "**b** ".repeat(2500); // 15000 chars > 11500
    const blocks = fmt.formatOutgoing({ type: "text", text: long } as any);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.type).toBe("section");
    expect((blocks[0] as any).text.text).toContain("*b*"); // converted
  });
```

The `markdownToMrkdwn` describe-block stays unchanged — the function is retained for fallbacks and `renderSystemMessage`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/__tests__/formatter.test.ts`
Expected: FAIL — text case still returns section blocks.

- [ ] **Step 3: Implement in `src/formatter.ts`**

Update the import at line 4:

```ts
import { splitSafe, MARKDOWN_SAFE_LIMIT } from "./utils.js";
```

Replace the text case in `formatOutgoing` (lines 65-70):

```ts
      case "text": {
        const text = message.text ?? "";
        if (!text.trim()) return [];
        if (text.length <= MARKDOWN_SAFE_LIMIT) {
          // Raw markdown — Slack parses and renders it server-side.
          return [{ type: "markdown", text }];
        }
        // The 12k markdown-block limit is cumulative per payload and this
        // method's contract is "blocks for one message" — oversize one-shot
        // text degrades to legacy mrkdwn sections instead of failing.
        const converted = markdownToMrkdwn(text);
        return splitSafe(converted).map(chunk => section(chunk));
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/formatter.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npx vitest run`
Expected: all green (only formatter.test.ts asserted the old text-case behavior — verified by grep).

- [ ] **Step 6: Commit**

```bash
git add src/formatter.ts src/__tests__/formatter.test.ts
git commit -m "feat: formatOutgoing text emits native markdown block"
```

---

### Task 4: `text-buffer` — flush and TTS-strip via markdown blocks

**Files:**
- Modify: `src/text-buffer.ts:7-8` (imports), `:51-66` (flush), `:92-104` (stripTtsBlock)
- Test: `src/__tests__/text-buffer.test.ts` (add 3 tests)

- [ ] **Step 1: Add the failing tests**

Append inside the `describe("SlackTextBuffer", ...)` block of `src/__tests__/text-buffer.test.ts`:

```ts
  it("posts raw markdown as a markdown block with full text fallback", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "1.1" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("# Title\n\n**bold** and `**kwargs` stay raw");
    await buf.flush();

    const [method, params] = enqueue.mock.calls[0];
    expect(method).toBe("chat.postMessage");
    expect(params.blocks).toEqual([
      { type: "markdown", text: "# Title\n\n**bold** and `**kwargs` stay raw" },
    ]);
    // Stored `text` is what other agents read back as thread context —
    // it must be the FULL raw chunk, never a summary or converted dialect.
    expect(params.text).toBe("# Title\n\n**bold** and `**kwargs` stay raw");
  });

  it("falls back to mrkdwn sections when markdown block is rejected", async () => {
    const enqueue = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }))
      .mockResolvedValueOnce({ ts: "2.2" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("**bold**");
    await buf.flush();

    expect(enqueue).toHaveBeenCalledTimes(2);
    const retry = enqueue.mock.calls[1][1];
    expect(retry.blocks[0].type).toBe("section");
    expect(retry.blocks[0].text.text).toBe("*bold*");
  });

  it("stripTtsBlock edits the posted message with a markdown block", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ts: "9.9" });
    const buf = new SlackTextBuffer("C123", undefined, "sess1", { enqueue } as any);
    buf.append("Answer text [TTS]spoken[/TTS]");
    await buf.flush();
    await buf.stripTtsBlock();

    const updateCall = enqueue.mock.calls.find((c: any) => c[0] === "chat.update");
    expect(updateCall).toBeDefined();
    expect(updateCall![1].blocks).toEqual([{ type: "markdown", text: "Answer text" }]);
    expect(updateCall![1].text).toBe("Answer text");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/text-buffer.test.ts`
Expected: the 3 new tests FAIL (current code posts section blocks with converted text).

- [ ] **Step 3: Implement in `src/text-buffer.ts`**

Replace the imports at lines 7-8:

```ts
import { splitMarkdownSafe } from "./utils.js";
import { enqueueWithMarkdownFallback, markdownBlock } from "./markdown-post.js";
```

(`markdownToMrkdwn` and `splitSafe` are no longer imported here.)

Replace the flush body (lines 51-66, inside `this.flushPromise = (async () => { try { ... } ...`):

```ts
      try {
        const chunks = splitMarkdownSafe(text);
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          const result = await enqueueWithMarkdownFallback(this.queue, "chat.postMessage", {
            channel: this.channelId,
            ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
            // `text` doubles as the notification fallback AND the thread-context
            // source other agents read back — always the full raw chunk.
            text: chunk,
            blocks: [markdownBlock(chunk)],
          }, this.log);
          // Track last posted message for potential TTS block editing
          this.lastMessageTs = (result as { ts?: string } | undefined)?.ts;
          this.lastPostedText = chunk;
        }
      } finally {
```

Replace the `chat.update` call in `stripTtsBlock` (lines 96-101):

```ts
        await enqueueWithMarkdownFallback(this.queue, "chat.update", {
          channel: this.channelId,
          ts: this.lastMessageTs,
          text: cleaned,
          blocks: [markdownBlock(cleaned)],
        }, this.log);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/text-buffer.test.ts`
Expected: PASS — all tests including the 6 pre-existing ones (they assert on `params.text`, which still carries the chunk).

- [ ] **Step 5: Commit**

```bash
git add src/text-buffer.ts src/__tests__/text-buffer.test.ts
git commit -m "feat: stream flush posts native markdown blocks"
```

---

### Task 5: adapter `postFormattedMessage` uses the fallback helper

**Files:**
- Modify: `src/adapter.ts:1743-1760` (`postFormattedMessage`)

This is the only adapter send-site whose blocks can contain a markdown block (via `formatOutgoing`'s text case). `handleSessionEnd`/`handleError` post `session_end`/`error` blocks (never markdown) and stay unchanged. The codebase never instantiates `SlackAdapter` in tests — verification is typecheck + full suite.

- [ ] **Step 1: Implement**

Add to the imports in `src/adapter.ts` (alongside the existing `./` imports near the top):

```ts
import { enqueueWithMarkdownFallback } from "./markdown-post.js";
```

In `postFormattedMessage` (line 1743), replace the `this.queue.enqueue(...)` call:

```ts
    try {
      await enqueueWithMarkdownFallback(this.queue, "chat.postMessage", {
        channel: meta.channelId,
        ...this.threadParams(meta),
        text: content.text ?? content.type,
        blocks,
      }, this.log);
    } catch (err) {
      this.log.error({ err, sessionId, type: content.type }, "Failed to post Slack message");
    }
```

- [ ] **Step 2: Typecheck and run full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean typecheck, all tests green.

- [ ] **Step 3: Commit**

```bash
git add src/adapter.ts
git commit -m "feat: postFormattedMessage routes through markdown fallback helper"
```

---

### Task 6: Final verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-06-11-slack-markdown-block-design.md` (status line)

- [ ] **Step 1: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 2: Optional live smoke test (needs the bot token)**

Post a real message through the built code path is not practical standalone; instead re-verify the API contract directly (same as design-phase verification):

```bash
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"channel":"C0B8DE2S4UD","text":"smoke: implementation done","blocks":[{"type":"markdown","text":"## Smoke\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(\"**kwargs intact\")\n```"}]}'
```

Expected: `"ok":true`, stored blocks translated to `header`/`table`/`rich_text`.

- [ ] **Step 3: Mark spec implemented**

In `docs/superpowers/specs/2026-06-11-slack-markdown-block-design.md`, change the status line:

```markdown
**Status:** Implemented (see docs/superpowers/plans/2026-06-11-slack-markdown-block.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-11-slack-markdown-block-design.md
git commit -m "docs: mark markdown block spec implemented"
```
