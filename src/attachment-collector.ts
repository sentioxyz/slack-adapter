// Pure collection + dedup of attachment candidates from the triggering message,
// thread history, and forwarded/shared messages.
import type { SlackFileInfo, ForwardedMessage, CollectedAttachment, RawSlackAttachment } from "./types.js";

/** Minimal thread-message shape the collector needs. */
export interface CollectorThreadMessage {
  bot_id?: string;
  user?: string;
  files?: SlackFileInfo[];
  attachments?: RawSlackAttachment[];
}

export interface CollectInput {
  triggerFiles?: SlackFileInfo[];
  threadMessages?: CollectorThreadMessage[];
  forwards?: ForwardedMessage[];
  /** File ids already surfaced in a prior turn — skipped. */
  seen?: Set<string>;
  /**
   * Identity of the adapter's OWN bot. Used to skip re-feeding our own output
   * (replayed prompts, usage cards, uploads) while still reading third-party
   * bots — e.g. GitHub/CI integration cards, which are often exactly the thread
   * content users want the agent to see.
   */
  selfUserId?: string;
  selfBotId?: string;
}

export interface CollectResult {
  attachments: CollectedAttachment[];
  /** Rendered "[Forwarded from …]\n> text" blocks, always inlined by the caller. */
  forwardedTexts: string[];
}

/**
 * Compose the readable body of a Slack message attachment. Handles both
 * "shared message" forwards (`text`) and integration/bot cards (GitHub, CI, …)
 * whose content lives in `pretext` / `title` (+ `title_link`) / `text`. Falls
 * back to `fallback`, but ignores bracketed placeholders like
 * "[no preview available]". Returns "" when there is nothing readable.
 */
function attachmentBody(a: RawSlackAttachment): string {
  const titleLine = a.title
    ? (a.title_link ? `${a.title} — ${a.title_link}` : a.title)
    : "";
  const body = [a.pretext, titleLine, a.text]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (body) return body;
  const fb = (a.fallback ?? "").trim();
  // Skip placeholder fallbacks (e.g. "[no preview available]") — pure noise.
  return fb && !/^\[.*\]$/.test(fb) ? fb : "";
}

/**
 * Extract forwarded/shared messages and integration cards (text + nested files)
 * from a Slack message's `attachments` array. Attachments with no readable body
 * and no files (e.g. action-button-only blocks, content-less unfurls) are
 * skipped. Pure; reused by the event router (for the triggering message) and by
 * the collector (for every thread-history message), so a forward/card in the
 * thread parent is read even when the @mention is in a separate reply.
 */
export function extractForwards(attachments?: RawSlackAttachment[]): ForwardedMessage[] {
  const out: ForwardedMessage[] = [];
  for (const a of attachments ?? []) {
    const files: SlackFileInfo[] = (a.files ?? []).map((f) => ({
      id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, url_private: f.url_private,
    }));
    const text = attachmentBody(a);
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

export function collectAttachments(input: CollectInput): CollectResult {
  const seen = input.seen ?? new Set<string>();
  const taken = new Set<string>();
  const attachments: CollectedAttachment[] = [];
  const forwardedTexts: string[] = [];
  const seenForwardText = new Set<string>();

  const add = (file: SlackFileInfo, source: CollectedAttachment["source"]) => {
    if (!file?.id) return;
    if (seen.has(file.id) || taken.has(file.id)) return;
    taken.add(file.id);
    attachments.push({ file, source });
  };

  // Render a forward's text block (deduped — the same forward can appear both on
  // the triggering message and in thread history) and collect its nested files.
  const takeForward = (fwd: ForwardedMessage) => {
    const text = (fwd.text ?? "").trim();
    if (text) {
      const where = [fwd.author && `@${fwd.author}`, fwd.channelName && `#${fwd.channelName}`, fwd.ts]
        .filter(Boolean)
        .join(" in ");
      const header = where ? `[Forwarded from ${where}]` : "[Forwarded message]";
      const block = `${header}\n> ${text.replace(/\n/g, "\n> ")}`;
      if (!seenForwardText.has(block)) {
        seenForwardText.add(block);
        forwardedTexts.push(block);
      }
    }
    for (const f of fwd.files ?? []) add(f, "forward");
  };

  // Skip only OUR OWN bot's messages (don't re-feed our replayed prompts, usage
  // cards, or uploads). Third-party bots — GitHub/CI integration cards, other
  // agents — are legitimate thread content and ARE read.
  const isSelf = (m: CollectorThreadMessage): boolean =>
    (!!input.selfUserId && m.user === input.selfUserId) ||
    (!!input.selfBotId && m.bot_id === input.selfBotId);

  // Order matters for source attribution on dedup: message > thread > forward.
  for (const f of input.triggerFiles ?? []) add(f, "message");
  for (const m of input.threadMessages ?? []) {
    if (isSelf(m)) continue;
    for (const f of m.files ?? []) add(f, "thread");
    for (const fwd of extractForwards(m.attachments)) takeForward(fwd);
  }
  for (const fwd of input.forwards ?? []) takeForward(fwd);

  return { attachments, forwardedTexts };
}
