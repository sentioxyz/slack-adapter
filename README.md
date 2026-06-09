# @openacp/slack-adapter

Slack messaging platform adapter plugin for [OpenACP](https://github.com/Open-ACP/OpenACP).

## Installation

```bash
openacp plugin install @openacp/slack-adapter
```

## Configuration

Add to your `~/.openacp/config.json`:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "adapter": "@openacp/slack-adapter",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "signingSecret": "...",
      "channelPrefix": "openacp",
      "notificationChannelId": "C...",
      "allowedUserIds": [],
      "autoCreateSession": true,
      "outputMode": "medium"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `botToken` | Bot User OAuth Token (`xoxb-…`) |
| `appToken` | App-Level Token (`xapp-…`) for Socket Mode |
| `signingSecret` | Signing Secret from Basic Information |
| `channelPrefix` | Prefix for session channel names. Default: `openacp` |
| `notificationChannelId` | Optional. Channel ID for system notifications |
| `allowedUserIds` | Optional. Restrict access to specific Slack user IDs |
| `autoCreateSession` | Create a startup session on boot. Default: `true` |
| `outputMode` | Default verbosity: `"low"`, `"medium"`, or `"high"`. Default: `"medium"` |
| `attachmentInlineMaxBytes` | Text files ≤ this size (bytes) are inlined into the prompt; larger ones are saved as files. Default: `16384` |
| `readThreadHistory` | Walk the full thread for attachments from every message, not just the triggering one. Default: `true` |
| `subscribedChannels` | Optional. Channels to watch: `[{ "channelId": "C...", "trigger": "mention" \| "all" }]`. Invite the bot to each. Default: `[]` |

### Output Mode

The adapter renders agent activity in real time using Slack threads:

- **Low** 🔇 — minimal indicator only (`🔧 Processing...` → `✅ Done`)
- **Medium** 📊 — tool names + running count in the main message; tool cards in thread
- **High** 🔍 — full detail: tool input/output, diffs, viewer links, thinking in thread

Change the mode on the fly with `/outputmode low|medium|high`, or open an interactive modal with `/outputmode`. Requires the slash command to be registered in the Slack app settings — see the [setup guide](https://docs.openacp.dev/platform-setup/slack).

### Channel Subscription

Beyond the per-session channels the bot creates, you can point it at **existing**
channels. Invite the bot to the channel and list it under `subscribedChannels`:

```json
"subscribedChannels": [
  { "channelId": "C0123ABCD", "trigger": "mention" }
]
```

- `trigger: "mention"` (default) — the bot starts a session only when a top-level
  message `@mentions` it.
- `trigger: "all"` — every top-level message starts a session.

Each top-level trigger opens a **thread**; the agent works and replies inside that
thread, and any reply in the thread continues the same session (with full context).
Tool-permission requests appear as buttons in the thread. The bot never archives a
subscribed channel.

### Attachments

The bot reads files and forwarded/shared messages from the thread, not just the
message body:

- **Text** (`.txt`, `.log`, `.json`, `.csv`, code) — small files are inlined into
  the prompt; larger ones are attached as files.
- **Forwarded messages** — their text is inlined with attribution.
- **Binaries** (images, PDFs, …) — surfaced as `localhost` download links served
  by the adapter, which injects the bot token. The agent (same host) downloads
  them only if it needs the bytes.

Requires the `files:read` scope (file downloads) plus the relevant history scopes
(`channels:history`, `groups:history`, `im:history`, `mpim:history`) for reading
thread replies.

## Development

```bash
npm install
npm run build
npm test

# Install locally for testing
openacp plugin install /path/to/slack-plugin
```

## License

MIT
