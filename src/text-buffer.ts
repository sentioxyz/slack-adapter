// src/text-buffer.ts
// Buffers streamed text chunks per session and flushes as a single Slack message.
// This prevents the "many tiny messages" problem from streaming AI responses.

import type { ISlackSendQueue } from "./send-queue.js";
import type { Logger } from "./types.js";
import { splitMarkdownSafe } from "./utils.js";
import { enqueueWithMarkdownFallback, markdownBlock } from "./markdown-post.js";

const FLUSH_IDLE_MS = 2000; // flush after 2s of no new chunks

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
          // Track last posted message for potential TTS block editing
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
      this.buffer = this.buffer.replace(/\[TTS\][\s\S]*?\[\/TTS\]/g, "").replace(/\s{2,}/g, " ").trim();
      return;
    }

    // Case 2: Already flushed — edit the posted message via chat.update
    if (this.lastMessageTs && this.lastPostedText && /\[TTS\][\s\S]*?\[\/TTS\]/.test(this.lastPostedText)) {
      const cleaned = this.lastPostedText.replace(/\[TTS\][\s\S]*?\[\/TTS\]/g, "").replace(/\s{2,}/g, " ").trim();
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
