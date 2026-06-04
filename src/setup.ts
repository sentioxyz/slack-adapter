// src/setup.ts — Slack app manifest + interactive setup wizard
import type { InstallContext } from '@openacp/plugin-sdk'

export interface SlackManifest {
  version: number
  manifest: {
    display_information: { name: string }
    features: {
      app_home: { messages_tab_enabled: boolean; messages_tab_read_only_enabled: boolean }
      bot_user: { display_name: string; always_online: boolean }
      slash_commands: Array<{ command: string; description: string; should_escape: boolean }>
    }
    oauth_config: { scopes: { bot: string[] } }
    settings: {
      event_subscriptions: { bot_events: string[] }
      interactivity: { is_enabled: boolean }
      socket_mode_enabled: boolean
      token_rotation_enabled: boolean
    }
  }
}

export function generateSlackManifest(): SlackManifest {
  return {
    version: 2,
    manifest: {
      display_information: { name: 'OpenACP' },
      features: {
        app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: 'OpenACP', always_online: true },
        slash_commands: [
          {
            command: '/openacp-archive',
            description: 'Archive current session channel and start fresh',
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            'channels:manage', 'channels:history', 'channels:join', 'channels:read',
            'chat:write', 'chat:write.public',
            'commands',
            'groups:write', 'groups:history', 'groups:read',
            'files:read', 'files:write',
            'im:history',
            'im:write',
          ],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ['message.channels', 'message.groups', 'message.im'] },
        interactivity: { is_enabled: true },
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
  }
}

export async function validateSlackBotToken(
  token: string,
): Promise<{ ok: true; botUsername: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const data = (await res.json()) as { ok: boolean; user?: string; error?: string }
    if (data.ok && data.user) return { ok: true, botUsername: data.user }
    return { ok: false, error: data.error || 'Invalid token' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function setupSlack(ctx: InstallContext): Promise<void> {
  const { terminal, settings } = ctx

  // Non-interactive path: when the Slack credentials are supplied via the
  // environment (e.g. `npm run setup` driven from a .env file, or CI), skip
  // the interactive wizard entirely and persist them directly. This keeps the
  // install hook scriptable; the interactive flow below is the fallback for
  // humans configuring by hand.
  const envBot = process.env.SLACK_BOT_TOKEN?.trim()
  const envApp = process.env.SLACK_APP_TOKEN?.trim()
  const envSigning = process.env.SLACK_SIGNING_SECRET?.trim()
  if (envBot && envApp && envSigning) {
    const envAllowed = (process.env.SLACK_ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((uid) => uid.trim())
      .filter(Boolean)
    await settings.setAll({
      botToken: envBot,
      appToken: envApp,
      signingSecret: envSigning,
      allowedUserIds: envAllowed,
      channelPrefix: process.env.SLACK_CHANNEL_PREFIX?.trim() || 'openacp',
      autoCreateSession: true,
      ...(process.env.SLACK_NOTIFICATION_CHANNEL_ID?.trim()
        ? { notificationChannelId: process.env.SLACK_NOTIFICATION_CHANNEL_ID.trim() }
        : {}),
    })
    terminal.log.success('Slack adapter configured from environment (non-interactive)')
    return
  }

  // Step 1: Show manifest
  const { manifest } = generateSlackManifest()
  const manifestJson = JSON.stringify(manifest, null, 2)

  terminal.note(
    'Step 1: Create your Slack app\n\n' +
    '1. Open https://api.slack.com/apps\n' +
    '2. Click "Create New App" → "From a manifest"\n' +
    '3. Select your workspace\n' +
    '4. Paste this manifest:\n\n' +
    manifestJson + '\n\n' +
    '5. Click Next → Create → Install to Workspace → Allow\n' +
    '6. After install:\n' +
    '   • Bot Token:      OAuth & Permissions → Bot User OAuth Token\n' +
    '   • App Token:      Basic Information → App-Level Tokens → Generate Token\n' +
    '                     (name it anything, select "connections:write" scope)\n' +
    '   • Signing Secret: Basic Information → App Credentials → Signing Secret',
    'Slack App Manifest',
  )

  await terminal.text({ message: 'Press Enter when done...' })

  // Step 2: Credentials
  let botToken = ''
  let validated = false

  while (!validated) {
    botToken = (await terminal.text({
      message: 'Bot Token (xoxb-...):',
      validate: (v) => (!v.trim() ? 'Token cannot be empty' : undefined),
    })).trim()

    const result = await validateSlackBotToken(botToken)
    if (result.ok) {
      terminal.log.success(`Authenticated as @${result.botUsername}`)
      validated = true
    } else {
      terminal.log.error(`Validation failed: ${result.error}`)
      const action = await terminal.select({
        message: 'What to do?',
        options: [
          { value: 'retry', label: 'Re-enter token' },
          { value: 'skip', label: 'Use as-is (skip validation)' },
        ],
      })
      if (action === 'skip') validated = true
    }
  }

  const appToken = (await terminal.text({
    message: 'App Token (xapp-1-...):',
    validate: (v) => {
      const val = v.trim()
      if (!val) return 'App Token cannot be empty'
      if (!val.startsWith('xapp-1-')) return 'App Token must start with xapp-1-'
      return undefined
    },
  })).trim()

  const signingSecret = (await terminal.text({
    message: 'Signing Secret:',
    validate: (v) => (!v.trim() ? 'Signing Secret cannot be empty' : undefined),
  })).trim()

  // Step 3: Optional config
  const allowedRaw = (await terminal.text({
    message: 'Allowed Slack User IDs (comma-separated, or Enter to allow all):',
  })).trim()

  const allowedUserIds = allowedRaw
    ? allowedRaw.split(',').map((uid) => uid.trim()).filter(Boolean)
    : []

  const channelPrefix = (await terminal.text({
    message: 'Channel prefix:',
    placeholder: 'openacp',
  })).trim() || 'openacp'

  // Step 4: Auto-create notification channel
  let notificationChannelId: string | undefined

  try {
    const { WebClient } = await import('@slack/web-api')
    const web = new WebClient(botToken)

    try {
      const createRes = await web.conversations.create({
        name: 'openacp-notifications',
        is_private: true,
      })
      notificationChannelId = (createRes.channel as { id?: string })?.id
      terminal.log.success(`Created #openacp-notifications (${notificationChannelId})`)
    } catch (createErr: unknown) {
      const errCode = (createErr as { data?: { error?: string } })?.data?.error
      if (errCode === 'name_taken') {
        // Look up existing channel
        let cursor = ''
        while (true) {
          const listRes = await web.conversations.list({
            types: 'private_channel',
            cursor,
            limit: 200,
          })
          const channels = (listRes.channels ?? []) as Array<{ id?: string; name?: string }>
          const match = channels.find((ch) => ch.name === 'openacp-notifications')
          if (match?.id) {
            notificationChannelId = match.id
            terminal.log.success(`Using existing #openacp-notifications (${notificationChannelId})`)
            break
          }
          cursor = (listRes.response_metadata as { next_cursor?: string })?.next_cursor ?? ''
          if (!cursor) break
        }
        if (!notificationChannelId) {
          terminal.log.warning('Could not find #openacp-notifications. Set notificationChannelId manually later.')
        }
      } else {
        terminal.log.warning('Could not create notification channel. Set notificationChannelId manually later.')
      }
    }
  } catch {
    terminal.log.warning('Skipped notification channel creation.')
  }

  // Save all settings
  await settings.setAll({
    botToken,
    appToken,
    signingSecret,
    allowedUserIds,
    channelPrefix,
    autoCreateSession: true,
    ...(notificationChannelId ? { notificationChannelId } : {}),
  })

  terminal.log.success('Slack adapter configured!')
}
