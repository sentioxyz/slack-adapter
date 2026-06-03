import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { ISlackSendQueue } from "./send-queue.js";
import type { PermissionOption } from "@openacp/plugin-sdk";

export type PermissionResponseCallback = (requestId: string, optionId: string) => void;

export interface ISlackPermissionHandler {
  register(app: App): void;
  trackPendingMessage(requestId: string, channelId: string, messageTs: string, options?: PermissionOption[]): void;
  cleanupSession(channelId: string): Promise<void>;
  cleanupRequest(requestId: string): Promise<void>;
}

export class SlackPermissionHandler implements ISlackPermissionHandler {
  private pendingMessages = new Map<string, { channelId: string; messageTs: string; options?: PermissionOption[] }>();

  constructor(
    private queue: ISlackSendQueue,
    private onResponse: PermissionResponseCallback,
  ) {}

  trackPendingMessage(requestId: string, channelId: string, messageTs: string, options?: PermissionOption[]): void {
    this.pendingMessages.set(requestId, { channelId, messageTs, options });
  }

  async cleanupSession(channelId: string): Promise<void> {
    for (const [requestId, info] of this.pendingMessages) {
      if (info.channelId !== channelId) continue;
      await this.queue.enqueue("chat.update", {
        channel: info.channelId,
        ts: info.messageTs,
        blocks: [],
      });
      this.pendingMessages.delete(requestId);
    }
  }

  /**
   * Clear the buttons for a single pending request. Used when a session ends so
   * sibling threads sharing the same channel (subscription mode) are untouched —
   * unlike cleanupSession(channelId), which clears every request in a channel.
   */
  async cleanupRequest(requestId: string): Promise<void> {
    const info = this.pendingMessages.get(requestId);
    if (!info) return;
    await this.queue.enqueue("chat.update", {
      channel: info.channelId,
      ts: info.messageTs,
      blocks: [],
    });
    this.pendingMessages.delete(requestId);
  }

  register(app: App): void {
    // Match any action starting with "perm_action_"
    app.action<BlockAction<ButtonAction>>(
      /^perm_action_/,
      async ({ ack, body, action }) => {
        await ack();

        const value: string = action.value ?? "";
        const colonIdx = value.indexOf(":");
        if (colonIdx === -1) return;

        const requestId = value.slice(0, colonIdx);
        const optionId  = value.slice(colonIdx + 1);

        this.onResponse(requestId, optionId);

        // Remove from pending tracking since the user has responded
        const pending = this.pendingMessages.get(requestId);
        this.pendingMessages.delete(requestId);

        // Determine allow/deny: use stored option if available, fall back to heuristic
        const option = pending?.options?.find((o) => o.id === optionId);
        const isAllow = option !== undefined
          ? option.isAllow
          : (optionId.includes("allow") || optionId.includes("yes"));
        const icon = isAllow ? "✅" : "❌";
        const label = isAllow ? "Allowed" : "Denied";
        const userName = body.user?.name ?? body.user?.id ?? "unknown";

        try {
          await this.queue.enqueue("chat.update", {
            channel: body.channel?.id,
            ts: body.message?.ts,
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `🔐 Permission — ${icon} ${label} by @${userName}`,
                  },
                ],
              },
            ],
            text: `Permission ${label}`,
          });
        } catch (err) {
          // Non-critical: log but don't fail
        }
      }
    );
  }
}
