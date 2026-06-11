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
    const blocks: KnownBlock[] = args.blocks.flatMap((b): KnownBlock[] =>
      b.type === "markdown"
        ? splitSafe(markdownToMrkdwn(b.text)).map(chunk => ({
            type: "section" as const,
            text: { type: "mrkdwn" as const, text: chunk },
          }))
        : [b],
    );
    return await queue.enqueue(method, { ...args, blocks });
  }
}
