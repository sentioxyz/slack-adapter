// src/formatter.ts
import type { types } from "@slack/bolt";
import type { OutgoingMessage, PermissionRequest } from "@openacp/plugin-sdk";
import { splitSafe } from "./utils.js";

type KnownBlock = types.KnownBlock;

export interface ISlackFormatter {
  formatOutgoing(message: OutgoingMessage): KnownBlock[];
  formatPermissionRequest(req: PermissionRequest): KnownBlock[];
  formatNotification(text: string): KnownBlock[];
  formatSessionEnd(reason?: string): KnownBlock[];
}

/**
 * Convert a markdown string to Slack mrkdwn format.
 * Handles the most common patterns from AI responses.
 */
export function markdownToMrkdwn(text: string): string {
  return text
    // Fenced code blocks — preserve as-is (Slack supports ``` natively)
    // Headers: # H1 -> placeholder (protected from italic regex)
    .replace(/^#{1,6}\s+(.+)$/gm, "\x00BOLD\x00$1\x00BOLD\x00")
    // Bold: **text** -> placeholder
    .replace(/\*\*(.+?)\*\*/g, "\x00BOLD\x00$1\x00BOLD\x00")
    // Italic: *text* -> _text_ (won't match placeholder tokens)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_")
    // Restore bold/header placeholders -> *text*
    .replace(/\x00BOLD\x00(.+?)\x00BOLD\x00/g, "*$1*")
    // Inline code: `code` — kept as-is (Slack supports backtick)
    // Strikethrough: ~~text~~ -> ~text~
    .replace(/~~(.+?)~~/g, "~$1~")
    // Links: [text](url) -> <url|text>
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
    // Unordered lists: "- item" or "* item" -> "* item"
    .replace(/^[ \t]*[-*]\s+/gm, "\u2022 ")
    // Ordered lists: "1. item" -> "1. item" (already fine in mrkdwn)
    .trim();
}

// Slack mrkdwn text block, max 3000 chars per section
const SECTION_LIMIT = 3000;

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, SECTION_LIMIT) } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

// Slack caps button labels at 75 chars — a longer label rejects the whole
// message with invalid_blocks, so the permission prompt never reaches Slack.
const BUTTON_LABEL_LIMIT = 75;

function buttonLabel(label: string): string {
  return label.length > BUTTON_LABEL_LIMIT
    ? `${label.slice(0, BUTTON_LABEL_LIMIT - 1)}…`
    : label;
}

export class SlackFormatter implements ISlackFormatter {
  formatOutgoing(message: OutgoingMessage): KnownBlock[] {
    switch (message.type) {
      case "text": {
        const text = message.text ?? "";
        if (!text.trim()) return [];
        const converted = markdownToMrkdwn(text);
        return splitSafe(converted).map(chunk => section(chunk));
      }

      // These types are handled by SlackActivityTracker — return empty blocks
      case "thought":
      case "tool_call":
      case "tool_update":
      case "plan":
      case "usage":
        return [];

      case "session_end":
        return this.formatSessionEnd(message.text);

      case "error":
        return [section(`\u26A0\uFE0F *Error:* ${message.text ?? "Unknown error"}`)];

      default:
        return [];
    }
  }

  formatPermissionRequest(req: PermissionRequest): KnownBlock[] {
    return [
      section(`\u{1F510} *Permission Request*\n${req.description}`),
      {
        type: "actions",
        block_id: `perm_${req.id}`,
        elements: req.options.map(opt => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: buttonLabel(opt.label), emoji: true },
          value: `${req.id}:${opt.id}`,
          action_id: `perm_action_${opt.id}_${req.id}`,
          style: (opt.isAllow ? "primary" : "danger") as "primary" | "danger",
        })),
      } as KnownBlock,
    ];
  }

  formatNotification(text: string): KnownBlock[] {
    return [section(text)];
  }

  formatSessionEnd(reason?: string): KnownBlock[] {
    return [
      { type: "divider" },
      context(`\u2705 Session ended${reason ? ` \u2014 ${reason}` : ""}`),
    ];
  }
}
