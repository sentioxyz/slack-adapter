# Slack Adapter — Parity Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 5 of the 18 parity gaps identified in the May 25 audit — the ones that are small, self-contained, and unblock user-visible bugs.

**Architecture:** All changes confined to `src/adapter.ts`, `src/index.ts`, and `src/setup.ts` plus a settings persistence helper. Listen to `core.eventBus` for `SYSTEM_COMMANDS_READY` (already plumbed in Phase 1 for `session:threadReady`). Persist startup channel ID via `settingsManager.updatePluginSettings()` — same mechanism Telegram uses.

**Tech Stack:** TypeScript, `@openacp/plugin-sdk`, `@slack/bolt`, `@slack/web-api`.

**Out of scope** (deferred to future plans):
- Assistant integration (huge — needs its own brainstorm + spec)
- Pinned control card + `session:configChanged` (needs Block Kit design)
- `PROMPT_WAITING`/`MESSAGE_PROCESSING` (depends on control card)
- Typing indicator (Slack only supports `assistant.threads.setStatus` for AI Assistant apps, not standard bots)
- Attachment size guard (minor)
- Debug tracer (debug-only)
- `tryCommandDispatch` reply callback (depends on CommandRegistry API change)

---

## File Map

| File | Changes |
|------|---------|
| `src/index.ts` | Promote `@openacp/security` to `pluginDependencies`; call `registerEditableFields` in `setup()` |
| `src/adapter.ts` | `/openacp-archive` slash command handler; widen `NotificationMessage` forwarding; persist `startupChannelId` via SettingsAPI; pass `settingsAPI` through constructor |
| `src/setup.ts` | (no change) |
| `src/__tests__/adapter-archive-command.test.ts` | NEW — unit test for archive handler |

---

## Task 1: Move `@openacp/security` to `pluginDependencies`

**Files:**
- Modify: `src/index.ts:11-16`

The adapter unconditionally reads `slackConfig.allowedUserIds`, which is owned by the security plugin's data shape. It is not optional in practice — declare the dependency truthfully so the lifecycle manager can order boot correctly.

- [ ] **Step 1: Edit dependency declarations**

In `src/index.ts`, replace:

```typescript
    essential: false,
    optionalPluginDependencies: {
      '@openacp/security': '^1.0.0',
      '@openacp/notifications': '^1.0.0',
      '@openacp/speech': '^1.0.0',
    },
```

with:

```typescript
    essential: false,
    pluginDependencies: {
      '@openacp/security': '^1.0.0',
    },
    optionalPluginDependencies: {
      '@openacp/notifications': '^1.0.0',
      '@openacp/speech': '^1.0.0',
    },
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: succeeds, zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(slack): promote @openacp/security to required pluginDependencies"
```

---

## Task 2: Register editable fields for the in-app settings UI

**Files:**
- Modify: `src/index.ts` (inside `setup` hook)

Without `registerEditableFields`, the OpenACP settings UI cannot edit Slack credentials at runtime — users have to re-run the install wizard for every change.

- [ ] **Step 1: Add `registerEditableFields` call**

In `src/index.ts`, locate the `setup(ctx)` hook (currently starts with `const config = ctx.pluginConfig as Record<string, unknown>`). Insert the registration as the FIRST line of the hook body:

```typescript
    async setup(ctx: PluginContext) {
      ctx.registerEditableFields([
        { key: 'botToken', displayName: 'Bot Token', type: 'string', scope: 'sensitive', hotReload: false },
        { key: 'appToken', displayName: 'App Token', type: 'string', scope: 'sensitive', hotReload: false },
        { key: 'signingSecret', displayName: 'Signing Secret', type: 'string', scope: 'sensitive', hotReload: false },
        { key: 'notificationChannelId', displayName: 'Notification Channel ID', type: 'string', scope: 'safe', hotReload: false },
        { key: 'channelPrefix', displayName: 'Channel Prefix', type: 'string', scope: 'safe', hotReload: false },
        { key: 'autoCreateSession', displayName: 'Auto-create Startup Session', type: 'toggle', scope: 'safe', hotReload: false },
      ])

      const config = ctx.pluginConfig as Record<string, unknown>
      ctx.log.debug(`Slack plugin config check: keys=${Object.keys(config).join(',')}, hasBotToken=${!!config.botToken}`)
      // ... rest unchanged
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(slack): register editable fields so the settings UI can edit credentials"
```

---

## Task 3: Implement `/openacp-archive` slash command handler

**Files:**
- Modify: `src/adapter.ts` (in `start()`, near the `/outputmode` registration)
- Create: `src/__tests__/adapter-archive-command.test.ts`

The Slack manifest at `src/setup.ts:33` advertises `/openacp-archive`, but no handler is registered. Slack shows the user a timeout error every time they invoke it. The semantics match `deleteSessionThread`: archive the current session's channel and tell the user.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/adapter-archive-command.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

/**
 * Unit test for the /openacp-archive handler logic.
 *
 * The handler is registered inline in adapter.ts:start(); to keep the test
 * isolated from Bolt, we re-export the handler factory below.
 */
import { makeArchiveCommandHandler } from "../adapter.js";

describe("/openacp-archive handler", () => {
  it("archives the channel of the current session and posts an ephemeral confirmation", async () => {
    const archiveChannel = vi.fn().mockResolvedValue(undefined);
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const findSessionByChannel = vi.fn().mockReturnValue({
      sessionId: "sess-1",
      meta: { channelId: "C123", channelSlug: "openacp-x" },
    });
    const ack = vi.fn().mockResolvedValue(undefined);

    const handler = makeArchiveCommandHandler({
      findSessionByChannel,
      archiveChannel,
      postEphemeral,
    });

    await handler({
      ack,
      command: { channel_id: "C123", user_id: "U1" },
    } as any);

    expect(ack).toHaveBeenCalled();
    expect(archiveChannel).toHaveBeenCalledWith("C123");
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U1",
      text: expect.stringMatching(/archived/i),
    });
  });

  it("posts an ephemeral 'no session' message when invoked in an unrelated channel", async () => {
    const archiveChannel = vi.fn();
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const findSessionByChannel = vi.fn().mockReturnValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    const handler = makeArchiveCommandHandler({
      findSessionByChannel,
      archiveChannel,
      postEphemeral,
    });

    await handler({
      ack,
      command: { channel_id: "C999", user_id: "U1" },
    } as any);

    expect(ack).toHaveBeenCalled();
    expect(archiveChannel).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C999",
      user: "U1",
      text: expect.stringMatching(/no.*session/i),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm test -- adapter-archive-command 2>&1 | tail -20
```

Expected: FAIL with "makeArchiveCommandHandler is not exported".

- [ ] **Step 3: Implement `makeArchiveCommandHandler` in `adapter.ts`**

In `src/adapter.ts`, locate the `makeThreadReadyHandler` export (~line 50) and add immediately AFTER it:

```typescript
/** Dependencies for the `/openacp-archive` slash command handler. */
export interface ArchiveCommandDeps {
  findSessionByChannel(channelId: string): { sessionId: string; meta: SlackSessionMeta } | undefined;
  archiveChannel(channelId: string): Promise<void>;
  postEphemeral(args: { channel: string; user: string; text: string }): Promise<void>;
}

/**
 * Build the `/openacp-archive` Bolt slash command handler.
 *
 * Archives the Slack channel of the current session if invoked inside a
 * session channel; otherwise posts an ephemeral message saying no session
 * is bound to this channel. Always ack()s within Slack's 3-second window.
 *
 * Exported so tests can exercise the production handler directly without
 * spinning up Bolt.
 */
export function makeArchiveCommandHandler(deps: ArchiveCommandDeps) {
  return async (args: {
    ack: () => Promise<void>;
    command: { channel_id: string; user_id: string };
  }): Promise<void> => {
    await args.ack();
    const channelId = args.command.channel_id;
    const userId = args.command.user_id;
    const found = deps.findSessionByChannel(channelId);
    if (!found) {
      await deps.postEphemeral({
        channel: channelId,
        user: userId,
        text: "No OpenACP session is bound to this channel.",
      });
      return;
    }
    await deps.archiveChannel(channelId);
    await deps.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Session channel archived. Open the notifications channel to start a new session.",
    });
  };
}
```

Note: `SlackSessionMeta` is already imported at the top of `adapter.ts`.

- [ ] **Step 4: Wire the handler into Bolt in `start()`**

In `src/adapter.ts`, find the `/outputmode` registration (`this.app.command("/outputmode", ...)`). Add this block IMMEDIATELY before it:

```typescript
    // Archive the current session's channel. Manifest declares this command
    // (src/setup.ts:33), so registering a no-op or skipping causes Slack to
    // show users a "timeout" error every time they invoke it.
    this.app.command("/openacp-archive", makeArchiveCommandHandler({
      findSessionByChannel: (cid) => this.findSessionByChannel(cid),
      archiveChannel: async (cid) => {
        const found = this.findSessionByChannel(cid);
        if (found) await this.deleteSessionThread(found.sessionId);
      },
      postEphemeral: async ({ channel, user, text }) => {
        await this.app.client.chat.postEphemeral({ channel, user, text });
      },
    }));
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm test -- adapter-archive-command 2>&1 | tail -10
```

Expected: PASS, both cases.

- [ ] **Step 6: Run full suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: 115/116 pass (113 existing + 2 new + 1 skipped).

- [ ] **Step 7: Commit**

```bash
git add src/adapter.ts src/__tests__/adapter-archive-command.test.ts
git commit -m "feat(slack): implement /openacp-archive slash command handler"
```

---

## Task 4: Forward all notification types via `sendNotification`

**Files:**
- Modify: `src/adapter.ts` — `sendPermissionRequest` (around line 941) so it also pings the notification channel for permission requests

`sendNotification` itself already handles all four types (`completed`, `error`, `permission`, `input_required`) — but nothing CALLS it for permission requests. Telegram pings the notification channel from `permissions.ts` when a request comes in. Slack should do the same.

- [ ] **Step 1: Update `sendPermissionRequest` to also notify**

In `src/adapter.ts`, locate `sendPermissionRequest` (around line 941, returns `Promise<void>`). At the END of the method (after the existing `chat.postMessage` try block), add:

```typescript
    // Also ping the notification channel so users see permission prompts even
    // when they're not actively watching this session's channel. Best-effort:
    // a failure here must not break the underlying permission request.
    if (this.slackConfig.notificationChannelId) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name ?? "Session";
      this.queue.enqueue("chat.postMessage", {
        channel: this.slackConfig.notificationChannelId,
        text: `🔐 *${name}* — Permission needed. <#${meta.channelId}>`,
      }).catch((err) => this.log.warn({ err, sessionId }, "Failed to post permission notification"));
    }
```

- [ ] **Step 2: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: succeeds.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/adapter.ts
git commit -m "feat(slack): ping notification channel on permission requests"
```

---

## Task 5: Persist `startupChannelId` via SettingsAPI

**Files:**
- Modify: `src/index.ts` — create a `settingsAPI` in `setup()` and pass it to the adapter constructor (mirrors Discord pattern at `discord-adapter/src/index.ts:140-143`)
- Modify: `src/adapter.ts` — constructor takes optional `settingsAPI`, `_createStartupSession` calls `settingsAPI.set('startupChannelId', ...)` after creating the channel

Today `_createStartupSession` logs `"configManager.save not available in external plugin context"` and never persists the channel ID. Every restart creates a fresh channel; the old one is orphaned. The fix mirrors what Discord adapter does — accept a `settingsAPI` and call `set` directly.

- [ ] **Step 1: Get the settingsAPI in `index.ts` setup hook**

In `src/index.ts`, modify the `setup(ctx)` hook. Right before `const { SlackAdapter } = await import('./adapter.js')`, add:

```typescript
      // Settings API scoped to this plugin so the adapter can persist
      // startupChannelId without going through legacy core config.
      const core = ctx.core as any
      const settingsAPI = core.lifecycleManager?.settingsManager?.createAPI(ctx.pluginName)
      if (!settingsAPI) {
        ctx.log.warn('SettingsManager not available — startup channel ID will not persist across restarts')
      }
```

Then change the `SlackAdapter` construction to pass it as a 4th arg:

```typescript
      adapter = new SlackAdapter(core, {
        ...config,
        enabled: true,
        maxMessageLength: 3000,
      } as unknown as SlackChannelConfig, ctx.log, settingsAPI)
```

- [ ] **Step 2: Accept `settingsAPI` in `SlackAdapter` constructor**

In `src/adapter.ts`, define a small interface near the top (after `ThreadReadyDeps`):

```typescript
/** Minimal SettingsAPI surface the adapter uses to persist runtime state. */
export interface SettingsAPI {
  set(key: string, value: unknown): Promise<void>;
}
```

Then update the constructor signature (currently `constructor(core: CoreKernel, config: SlackChannelConfig, logger?: Logger)`):

```typescript
  private settingsAPI?: SettingsAPI;

  constructor(
    core: CoreKernel,
    config: SlackChannelConfig,
    logger?: Logger,
    settingsAPI?: SettingsAPI,
  ) {
    super(
      { configManager: core.configManager },
      { ...config as Record<string, unknown>, maxMessageLength: 3000, enabled: config.enabled ?? true } as MessagingAdapterConfig,
    );
    this.core = core;
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.slackConfig = config;
    this.settingsAPI = settingsAPI;
    this.formatter = new SlackFormatter();
    (this as { renderer: IRenderer }).renderer = new SlackRenderer(this.formatter);
  }
```

- [ ] **Step 3: Persist channel ID after creating new startup channel**

In `src/adapter.ts`, locate `_createStartupSession`. In the `else` branch (where a new channel + session is created), replace:

```typescript
        const meta = this.sessions.get(session.id);
        if (meta) {
          // Note: configManager.save not available in external plugin context.
          // The host core should handle config persistence.
          this.log.info({ sessionId: session.id, channelId: meta.channelId }, "Startup channel created");
        }
```

with:

```typescript
        const meta = this.sessions.get(session.id);
        if (meta) {
          this.slackConfig.startupChannelId = meta.channelId;
          if (this.settingsAPI) {
            await this.settingsAPI.set('startupChannelId', meta.channelId).catch((err) => {
              this.log.warn({ err, sessionId: session.id }, 'Failed to persist startupChannelId — next restart will create another channel');
            });
            this.log.info({ sessionId: session.id, channelId: meta.channelId }, "Startup channel created and persisted");
          } else {
            this.log.info({ sessionId: session.id, channelId: meta.channelId }, "Startup channel created (not persisted — settingsAPI missing)");
          }
        }
```

- [ ] **Step 4: Build**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build
```

Expected: succeeds.

- [ ] **Step 5: Run tests**

```bash
pnpm test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/adapter.ts
git commit -m "feat(slack): persist startupChannelId so restarts reuse the same channel"
```

---

## Final Verification

- [ ] **Step 1: Full build + full test suite**

```bash
cd /Users/lucas/openacp-workspace/slack-adapter
pnpm build && pnpm test 2>&1 | tail -10
```

Expected: build clean, 115+ tests pass (113 baseline + 2 new from Task 3), 1 skipped.

- [ ] **Step 2: Bump version**

In `package.json`, change `"version": "2026.525.1"` → `"2026.525.2"`.

```bash
git add package.json && git commit -m "chore: bump to 2026.525.2"
```

- [ ] **Step 3: Verify gaps closed**

| # | Gap (from audit) | Severity | Closed in Task |
|---|------------------|----------|----------------|
| 3 | `/openacp-archive` declared but unimplemented | Critical | Task 3 |
| 2 | startupChannelId never persisted | Critical | Task 5 |
| 8 | notification channel only forwards `completed` | Major | Task 4 |
| 12 | no `registerEditableFields` | Major | Task 2 |
| 15 | `@openacp/security` not in `pluginDependencies` | Minor | Task 1 |

- [ ] **Step 4: Push + PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(slack): parity phase 2 — 5 audit gaps" --body "..."
```

---

## Self-Review

**Spec coverage:** The plan closes 5 of the 18 gaps from the May 25 audit. Three Critical items remain deferred (Assistant integration; pinned control card; event-bus subscriptions for waiting/processing) — these depend on larger design decisions and would each be a multi-day project on their own.

**Placeholder scan:** No TBDs in implementation steps. All code blocks are concrete. The PR body in Step 4 of Final Verification is shown as `"..."` because the assistant fills it in at PR time from the gap table above.

**Type consistency:** `SlackSessionMeta`, `SettingsAPI`, `ArchiveCommandDeps`, and the various handler argument shapes are consistent across all tasks. `findSessionByChannel` returns the same shape in both production and test.

**Remaining gaps NOT in this plan** (require separate spec/plan):

- **Assistant integration** — needs AssistantManager wiring, dedicated channel, welcome flow, message routing
- **Pinned session control card** — needs Block Kit layout, bypass/TTS toggle wiring, `session:configChanged` listener
- **`PROMPT_WAITING`/`MESSAGE_PROCESSING` UX** — needs the control card to live in
- **In-thread usage display** — needs message-edit dance for "latest usage" pattern
- **Skill-command persistence across restarts** — needs `platform.skillMsgId` in session record
- **Typing indicator** — Slack doesn't support typing for bots (only AI Assistant apps); spec needs research
- **Attachment 50MB guard** — small, can fold into a Phase 3
- **`tryCommandDispatch` reply callback** — depends on CommandRegistry change
- **Debug tracer** — debug-only, low priority
