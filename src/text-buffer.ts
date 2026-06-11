// src/text-buffer.ts
// Buffers streamed text chunks per session and flushes as a single Slack message.
// This prevents the "many tiny messages" problem from streaming AI responses.

import type { ISlackSendQueue } from "./send-queue.js";
import type { Logger } from "./types.js";
import { splitMarkdownSafe } from "./utils.js";
import { enqueueWithMarkdownFallback, markdownBlock } from "./markdown-post.js";

const FLUSH_IDLE_MS = 2000; // flush after 2s of no new chunks

/** Remove [TTS]...[/TTS] blocks; tidy the seam without flattening markdown
 * structure (newlines are significant in markdown blocks). */
function stripTts(text: string): string {
  return text
    .replace(/\[TTS\][\s\S]*?\[\/TTS\]/g, "")
    .replace(/[ \t]{2,}/g, " ")   // collapse runs of spaces/tabs only
    .replace(/\n{3,}/g, "\n\n")   // cap blank-line runs left by the removal
    .trim();
}

export class SlackTextBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private lastMessageTs: string | undefined;
  private lastPostedText: string | undefined;
  private log: Logger;

  constructor(
    private channelId: string,
    private threadTs: string | undefined,
    private sessionId: string,
    private queue: ISlackSendQueue,
    logger?: Logger,
  ) {
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  }

  append(text: string): void {
    if (!text) return;
    this.buffer += text;
    this.resetTimer();
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((err) => this.log.error({ err, sessionId: this.sessionId }, "Text buffer flush error"));
    }, FLUSH_IDLE_MS);
  }

  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const text = this.buffer.trim();
    if (!text) return;
    this.buffer = "";
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }

    this.flushPromise = (async () => {
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
          // Track last posted message for potential TTS block editing.
          // Note: only the final chunk of a multi-chunk flush is editable here;
          // a TTS marker buried in an earlier chunk of a >11.5k response won't
          // be stripped (acceptable: TTS blocks are short and come at the end).
          this.lastMessageTs = (result as { ts?: string } | undefined)?.ts;
          this.lastPostedText = chunk;
        }
      } finally {
        this.flushPromise = undefined;
        // Re-flush if content arrived while we were flushing
        if (this.buffer.trim()) {
          await this.flush();
        }
      }
    })();

    return this.flushPromise;
  }

  destroy(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.buffer = "";
  }

  /** Remove [TTS]...[/TTS] blocks — from buffer if unflushed, or edit posted message */
  async stripTtsBlock(): Promise<void> {
    // Case 1: TTS block still in unflushed buffer
    if (/\[TTS\][\s\S]*?\[\/TTS\]/.test(this.buffer)) {
      this.buffer = stripTts(this.buffer);
      return;
    }

    // Case 2: Already flushed — edit the posted message via chat.update
    if (this.lastMessageTs && this.lastPostedText && /\[TTS\][\s\S]*?\[\/TTS\]/.test(this.lastPostedText)) {
      const cleaned = stripTts(this.lastPostedText);
      if (cleaned) {
        await enqueueWithMarkdownFallback(this.queue, "chat.update", {
          channel: this.channelId,
          ts: this.lastMessageTs,
          text: cleaned,
          blocks: [markdownBlock(cleaned)],
        }, this.log);
      }
      this.lastPostedText = cleaned;
    }
  }
}
