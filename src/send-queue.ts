import PQueue from "p-queue";
import type { WebClient } from "@slack/web-api";

export type SlackMethod =
  | "chat.postMessage"
  | "chat.update"
  | "chat.delete"
  | "conversations.create"
  | "conversations.rename"
  | "conversations.archive"
  | "conversations.invite"
  | "conversations.join"
  | "conversations.unarchive"
  | "conversations.info"
  | "conversations.open"
  | "conversations.replies"
  | "reactions.add"
  | "reactions.remove";

// Requests per minute per method (Slack Tier definitions)
const METHOD_RPM: Record<SlackMethod, number> = {
  "chat.postMessage":      50,   // Tier 3
  "chat.update":           50,   // Tier 3
  "chat.delete":           50,   // Tier 3
  "conversations.create":  20,   // Tier 2
  "conversations.rename":  20,   // Tier 2
  "conversations.archive": 20,   // Tier 2
  "conversations.invite":  20,   // Tier 2
  "conversations.join":    20,   // Tier 2
  "conversations.unarchive": 20, // Tier 2
  "conversations.info":      50, // Tier 3
  "conversations.open":      50, // Tier 3
  "conversations.replies":   50, // Tier 3
  "reactions.add":           50, // Tier 3
  "reactions.remove":        50, // Tier 3
};

export interface ISlackSendQueue {
  enqueue<T = unknown>(method: SlackMethod, params: Record<string, unknown>): Promise<T>;
}

export class SlackSendQueue implements ISlackSendQueue {
  private queues = new Map<SlackMethod, PQueue>();

  constructor(private client: WebClient) {
    for (const [method, rpm] of Object.entries(METHOD_RPM) as [SlackMethod, number][]) {
      // Spread requests evenly across the minute
      this.queues.set(method, new PQueue({
        interval: Math.ceil(60_000 / rpm),
        intervalCap: 1,
        carryoverConcurrencyCount: true,
      }));
    }
  }

  async enqueue<T = unknown>(method: SlackMethod, params: Record<string, unknown>): Promise<T> {
    const queue = this.queues.get(method);
    if (!queue) throw new Error(`Unknown Slack method: ${method}`);
    return queue.add(() => this.client.apiCall(method, params) as Promise<T>);
  }
}
