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
