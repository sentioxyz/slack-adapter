# Slack Attachment & Forwarded-Thread Reading — Design

Date: 2026-06-09
Status: Approved

## Problem

Today the Slack adapter only feeds the agent the triggering message's `text`
plus any **audio** files (downloaded via the bot token and saved as local
`Attachment`s). Everything else is dropped:

- File uploads that are images, PDFs, text/log/json/csv, code, archives, etc.
- Slack message `attachments` — including **forwarded / shared messages and
  threads**.
- The rest of the thread's history (only the single triggering message is read).

We want the agent to see the full picture: the whole thread's attachments and
forwarded content, with text delivered inline and binaries available on demand.

## Decisions (from brainstorming)

1. **Binary delivery (image, PDF, other): local auth proxy (lazy).**
   Slack `url_private` requires the bot token to download. The adapter runs a
   small localhost HTTP endpoint that streams the file with the token injected.
   The agent receives a `127.0.0.1` link and downloads only if it needs the
   bytes — no token leakage, no eager download of large binaries.
2. **Text delivery: hybrid.** Inline small text files into the prompt; save
   larger ones as local file `Attachment`s. Forwarded-message text is always
   inlined.
3. **Read scope: full thread history.** Walk the whole Slack thread
   (`conversations.replies`) and collect attachments from every message, plus
   forwarded/shared messages embedded in the triggering message.

## Core assumption

The agent runs on the **same host** as the adapter. This is already true today —
attachments are delivered to the agent as local file paths
(`Attachment.filePath` via `fileService.saveFile`). The localhost proxy relies
on this. If the agent is ever remote, the proxy link must be replaced with a
host-reachable URL (out of scope).

## Data flow

When a message triggers the bot (`dispatchToSession`, and the subscription
dispatch path):

1. **Collect** — gather candidate attachments from:
   - the triggering message's `files[]`,
   - every message in the thread via `conversations.replies` (when
     `readThreadHistory` is on and a `thread_ts` exists),
   - forwarded/shared messages in the triggering message's `attachments[]`
     (their text and any nested files).
2. **Dedupe** by Slack file id. Skip files already surfaced in a prior turn of
   the same thread (per-session "seen file id" set) so repeat turns don't
   re-feed old files.
3. **Classify** each item (see table).
4. **Materialize**:
   - `audio` → download + `saveFile` as audio `Attachment` (unchanged).
   - `text-inline` → fetch bytes, append a fenced, attributed block to the prompt.
   - `text-file` → download + `saveFile` as `type:"file"` `Attachment`.
   - `binary-link` → register with the proxy, append a localhost link to the prompt.
   - forwarded-message **text** → always inlined with attribution.
5. Pass the augmented `text` + `attachments[]` to `core.handleMessage`.

## Classification rules

| Category | Match | Delivery |
|---|---|---|
| audio | `isAudioClip` (existing) | download → audio `Attachment` (unchanged) |
| text-inline | text-ish mimetype **and** size ≤ `attachmentInlineMaxBytes` | fetch → inline in prompt |
| text-file | text-ish mimetype **and** size > threshold | download → file `Attachment` |
| binary-link | everything else (image, pdf, zip, …) | proxy link (lazy) |

"Text-ish" = mimetype starts with `text/` or is a known textual type
(`application/json`, `application/xml`, `application/javascript`, `text/csv`,
etc.). A total inline budget (default 50KB across all inlined files) caps prompt
bloat; overflow is demoted to `binary-link`/file.

## Prompt augmentation format

```
<original message text>

[Forwarded from @alice in #incidents, 2026-06-08]
> original shared message text…

--- Attachment: deploy.log (text/plain, 3.2KB) ---
<inlined file contents>

[Attachments available for download — no auth required, fetch with curl/WebFetch if needed:]
- diagram.png (image/png, 1.2MB): http://127.0.0.1:53517/slack-file/ab12…
- spec.pdf (application/pdf, 800KB): http://127.0.0.1:53517/slack-file/cd34…
```

## Components (isolated units)

- **`attachment-collector.ts`** (pure) — input: triggering message object + an
  injected `fetchThreadReplies(channel, threadTs)`; output: deduped
  `CollectedAttachment[]` (`{id, name, mimetype, size, url_private, source:
  "message"|"thread"|"forward"}`) + extracted forwarded-text blocks. The
  per-thread seen-set filtering is applied here (seen-set injected). Testable
  with a fake fetcher.
- **`attachment-classifier.ts`** (pure) — `classify(att, {inlineMaxBytes})` →
  category. Extends `utils.ts` with `isTextFile`; reuses `isAudioClip`.
- **`file-proxy.ts`** — self-contained `http` server bound to `127.0.0.1` on an
  ephemeral port. `register({url_private, mimetype, name})` → unguessable token
  + URL; `GET /slack-file/:token` streams the file injecting
  `Authorization: Bearer <botToken>`, reusing the existing HTML-login/scope
  detection. TTL-bounded token map. Started in `start()`, closed in `stop()`.
- **adapter wiring** — `dispatchToSession` and the subscription dispatch path
  call collector → classifier → materialize → build augmented prompt, then
  `core.handleMessage`.

## Config additions (`SlackChannelConfigSchema`)

- `attachmentInlineMaxBytes` (default `16384`) — inline-vs-file threshold for
  text files.
- `readThreadHistory` (default `true`) — walk full thread vs. triggering message
  only; escape hatch to limit API calls.

Proxy host/port stay internal (`127.0.0.1`, ephemeral) — not configurable
(YAGNI).

## Error handling & edge cases

- Thread-history fetch fails → degrade to the triggering message's own attachments.
- Download returns HTML (bot missing `files:read`) → skip with a warning; the
  proxy surfaces a 502 at fetch time.
- Inline total budget exceeded → overflow demoted to file/proxy delivery.
- Forwarded shares: extract the shared message's text + its files. Following the
  *full remote thread* behind a share link is out of scope.
- Unknown / expired proxy token → 404.
- No `thread_ts` (channel-level legacy message) → collect only the triggering
  message's own attachments.

## Required Slack scopes

- `files:read` — download file bytes (already needed for audio).
- `channels:history` / `groups:history` / `im:history` / `mpim:history` — read
  thread replies (already granted for subscription channels). Document in README.

## Testing

- **collector** (pure): forwarded-message extraction, dedupe by id, seen-set
  filtering, thread-history merge, fetch-failure degradation.
- **classifier** (pure): mimetype × size matrix → category; inline-budget overflow.
- **file-proxy**: token registration + URL shape; streaming with mocked `fetch`
  (auth header injected, HTML-login → 502, unknown token → 404, TTL expiry).
- **adapter integration**: prompt augmentation text + attachment array with
  mocked `fileService` / `queue` / proxy.

## Out of scope

- Following the full remote thread behind a forwarded share link.
- Remote-agent (non-localhost) file delivery.
- Configurable proxy host/port.
