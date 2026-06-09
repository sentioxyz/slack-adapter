// Pure collection + dedup of attachment candidates from the triggering message,
// thread history, and forwarded/shared messages.
import type { SlackFileInfo, ForwardedMessage, CollectedAttachment, RawSlackAttachment } from "./types.js";

/** Minimal thread-message shape the collector needs. */
export interface CollectorThreadMessage {
  bot_id?: string;
  files?: SlackFileInfo[];
  attachments?: RawSlackAttachment[];
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

/**
 * Extract forwarded/shared messages (text + nested files) from a Slack message's
 * `attachments` array. Attachments with neither text nor files (e.g.
 * content-less link unfurls) are skipped. Pure; reused by the event router (for
 * the triggering message) and by the collector (for every thread-history
 * message), so a forward in the thread parent is read even when the @mention is
 * in a separate reply.
 */
export function extractForwards(attachments?: RawSlackAttachment[]): ForwardedMessage[] {
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

  // Order matters for source attribution on dedup: message > thread > forward.
  for (const f of input.triggerFiles ?? []) add(f, "message");
  for (const m of input.threadMessages ?? []) {
    if (m.bot_id) continue; // never re-feed the bot's own uploads or forwards
    for (const f of m.files ?? []) add(f, "thread");
    for (const fwd of extractForwards(m.attachments)) takeForward(fwd);
  }
  for (const fwd of input.forwards ?? []) takeForward(fwd);

  return { attachments, forwardedTexts };
}
