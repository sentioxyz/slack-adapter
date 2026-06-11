// src/utils.ts
// Shared utilities for Slack adapter modules.

import type { SlackFileInfo } from "./types.js";

/** True only for HTTPS Slack-owned hosts — used to gate where the bot token may
 * be sent when downloading url_private files (defense-in-depth against SSRF via
 * forged forwarded-message URLs). */
export function isSlackFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)slack\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Detect Slack audio clips — MIME type or filename pattern */
export function isAudioClip(file: SlackFileInfo): boolean {
  return (file.mimetype === "video/mp4" && file.name?.startsWith("audio_message")) ||
         file.mimetype?.startsWith("audio/");
}

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

const SECTION_LIMIT = 3000;

/**
 * Split text at nearest newline boundary before `limit`.
 * Does NOT track code fence state — a triple-backtick block straddling
 * the boundary will be split mid-block.
 * Used by SlackFormatter and SlackTextBuffer to avoid exceeding Slack's
 * 3000-char section limit.
 */
export function splitSafe(text: string, limit = SECTION_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

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
