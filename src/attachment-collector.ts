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
