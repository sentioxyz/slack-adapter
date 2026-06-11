# Slack Markdown Block Rendering — Design

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan

## Problem

Outgoing AI text is converted to Slack mrkdwn by `markdownToMrkdwn()` (`src/formatter.ts:19`), a regex pipeline with structural defects:

1. **Code is not protected.** Bold/italic/list regexes rewrite content inside ``` fences and inline backticks — `**kwargs`, `*ptr`, and `- ` lines inside code get mangled.
2. **Tables are not handled.** Pipe tables render as raw `|---|` noise.
3. **Image syntax** `![alt](url)` becomes `!<url|alt>`.
4. **Nested lists are flattened** (indentation stripped).
5. No Slack entity escaping (`& < >`), no `***bold italic***`, headers lose hierarchy.

Regex patching can't fix this class of bug — it's not a parser.

## Decision

Send AI text as **raw markdown** via Slack's Block Kit [`markdown` block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/) (`{ type: "markdown", text }`). Slack parses and renders server-side: real tables, syntax-highlighted code blocks, correct nesting and escaping. No client-side conversion, no new dependencies.

Alternatives rejected:
- **Fix the regex pipeline** — permanently chasing edge cases; escaping near-impossible to do correctly in string replacement.
- **`slackify-markdown`** — correct (remark-based) but adds ~30 transitive deps, still doesn't solve tables, and renders worse than native markdown blocks (no real tables, no syntax highlighting).

## Live verification (2026-06-11, #bot-school C0B8DE2S4UD, bot `botfather`)

| Case | Result |
|---|---|
| Bold/italic/strike/headers/lists/quote/link/code fence/task list | ✅ Server translates one markdown block → `header`/`rich_text`/`divider` blocks; code inside fences untouched |
| Pipe table (with inline formatting in cells) | ✅ Translated to a native `table` block |
| `![alt](url)`, raw `< > &` | ✅ Accepted; image renders as hyperlink (same as current behavior); no entity escaping needed |
| 11,942-char markdown block | ✅ ok |
| 13,606-char markdown block | ❌ `msg_too_long` |
| Two markdown blocks in one message | ✅ ok (12k limit is cumulative per payload) |

`@slack/types` (via bolt 4.6) already includes `MarkdownBlock` in `KnownBlock` — no type workarounds.

## Design

### New utility: `splitMarkdownSafe(text, limit = MARKDOWN_SAFE_LIMIT)` (`src/utils.ts`)

`MARKDOWN_SAFE_LIMIT = 11500` (margin under the 12,000 cumulative cap for fence re-opening overhead).

Unlike `splitSafe`, it is **fence-aware**:
- Prefer splitting at a paragraph boundary (`\n\n`) outside a code fence; fall back to the last newline, then hard cut.
- If a forced cut lands inside a ``` fence: close the fence at the cut (`\n```\n`) and re-open it (` ```lang\n `, preserving the language tag) at the start of the next chunk.
- Tables are not specially handled — a table large enough to straddle 11.5k is out of scope (degrades to split text, still readable).

`splitSafe` stays for mrkdwn paths (sections, fallback).

### Send-path changes

**`src/text-buffer.ts` (primary path — all streamed AI text):**
- `flush()` no longer calls `markdownToMrkdwn`. Split raw buffer with `splitMarkdownSafe`; post each chunk as its own message: `blocks: [{ type: "markdown", text: chunk }]`, `text: chunk` (notification fallback, ≤11.5k is fine).
- `stripTtsBlock()`'s `chat.update` likewise sends a markdown block.

**`src/formatter.ts`:**
- `formatOutgoing` text case: if `text.length <= MARKDOWN_SAFE_LIMIT`, return `[{ type: "markdown", text }]`. If longer (rare — only non-streamed system text hits this), fall back to the legacy `markdownToMrkdwn` + `splitSafe` sections, since `formatOutgoing`'s contract is "blocks for one message" and the 12k cap is cumulative.
- `error` / `session_end` / permission / notification / context blocks: **unchanged** (short app-generated mrkdwn, no conversion problem).
- `markdownToMrkdwn()` is retained for: the oversize fallback above, the runtime fallback below, and `renderSystemMessage`.

**`src/renderer.ts`:** `renderText` inherits the formatter change automatically. Other render methods unchanged.

### Runtime fallback

The markdown block is a newer platform feature; guard against workspaces/editions where it's unavailable. A shared helper (used by `text-buffer.flush` and adapter `postFormattedMessage`):

```
post with markdown block
  └─ on invalid_blocks → retry once with markdownToMrkdwn(chunk) + section blocks
```

Only `invalid_blocks` triggers the fallback (`msg_too_long` etc. are real errors and surface as today). Log a warning on fallback so we notice if a workspace lacks support.

### Explicit non-goals

- No Block Kit `table` block authoring (server-side translation already produces it from pipe tables).
- No change to ActivityTracker / tool cards / permission UI.
- Posted-message block structure differs from what we send (server-side translation, e.g. 1 markdown block → N blocks). Nothing may rely on reading back the blocks of a posted message; today only `ts` and our own chunk text are tracked, which stays valid.

### Known rendering degradations (accepted)

- All header levels render at the same size.
- `![alt](url)` renders as a hyperlink, not an inline image (parity with current behavior).

## Testing

- `splitMarkdownSafe` unit tests: passthrough under limit; paragraph-boundary split; fence straddling (close + reopen with language tag); single line > limit (hard cut); CJK text.
- `formatter` tests: text → single markdown block; oversize text → legacy section fallback; existing `markdownToMrkdwn` tests stay (function retained).
- `text-buffer` tests: flush posts markdown block per chunk; `invalid_blocks` triggers one section-fallback retry; `stripTtsBlock` update uses a markdown block.
- Manual: live test matrix above already executed against the real API.

## Affected files

| File | Change |
|---|---|
| `src/utils.ts` | Add `splitMarkdownSafe` + `MARKDOWN_SAFE_LIMIT` |
| `src/text-buffer.ts` | Flush/update via markdown blocks; runtime fallback |
| `src/formatter.ts` | `formatOutgoing` text case → markdown block; keep `markdownToMrkdwn` |
| `src/adapter.ts` | `postFormattedMessage` uses shared fallback helper |
| `src/__tests__/` | New `split-markdown.test.ts`; update formatter/text-buffer tests |
