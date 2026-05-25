import type { OpenACPPlugin, InstallContext, PluginContext } from '@openacp/plugin-sdk'
import type { SlackChannelConfig } from './types.js'

function createSlackPlugin(): OpenACPPlugin {
  let adapter: { stop(): Promise<void> } | null = null

  return {
    name: '@openacp/slack-adapter',
    version: '1.0.0',
    description: 'Slack adapter with channels and threads',
    essential: false,
    optionalPluginDependencies: {
      '@openacp/security': '^1.0.0',
      '@openacp/notifications': '^1.0.0',
      '@openacp/speech': '^1.0.0',
    },
    permissions: ['services:register', 'kernel:access', 'events:read'],

    async install(ctx: InstallContext) {
      const { terminal, settings, legacyConfig } = ctx

      // Migrate from legacy config if present
      if (legacyConfig) {
        const ch = legacyConfig.channels as Record<string, unknown> | undefined
        const slackCfg = ch?.slack as Record<string, unknown> | undefined
        if (slackCfg?.botToken) {
          await settings.setAll({
            botToken: slackCfg.botToken,
            appToken: slackCfg.appToken,
            signingSecret: slackCfg.signingSecret ?? '',
            channelPrefix: slackCfg.channelPrefix ?? 'openacp',
            allowedUserIds: slackCfg.allowedUserIds ?? [],
            autoCreateSession: slackCfg.autoCreateSession ?? true,
            ...(slackCfg.notificationChannelId ? { notificationChannelId: slackCfg.notificationChannelId } : {}),
          })
          terminal.log.success('Slack settings migrated from legacy config')
          return
        }
      }

      // Interactive setup with manifest
      const { setupSlack } = await import('./setup.js')
      await setupSlack(ctx)
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx

      while (true) {
        const choice = await terminal.select({
          message: 'What to configure?',
          options: [
            { value: 'botToken', label: 'Change bot token' },
            { value: 'appToken', label: 'Change app token' },
            { value: 'channelId', label: 'Change channel ID' },
            { value: 'done', label: 'Done' },
          ],
        })

        if (choice === 'done') break

        if (choice === 'botToken') {
          const val = await terminal.text({
            message: 'New bot token:',
            validate: (v) => (!v.trim() ? 'Token cannot be empty' : undefined),
          })
          await settings.set('botToken', val.trim())
          terminal.log.success('Bot token updated')
        } else if (choice === 'appToken') {
          const val = await terminal.text({
            message: 'New app token:',
            validate: (v) => (!v.trim() ? 'Token cannot be empty' : undefined),
          })
          await settings.set('appToken', val.trim())
          terminal.log.success('App token updated')
        } else if (choice === 'channelId') {
          const val = await terminal.text({ message: 'New channel ID:' })
          await settings.set('channelId', val.trim())
          terminal.log.success('Channel ID updated')
        }
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('Slack settings cleared')
      }
    },

    async setup(ctx: PluginContext) {
      const config = ctx.pluginConfig as Record<string, unknown>
      ctx.log.debug(`Slack plugin config check: keys=${Object.keys(config).join(',')}, hasBotToken=${!!config.botToken}`)
      if (!config.botToken || !config.appToken) {
        ctx.log.info('Slack disabled (missing botToken or appToken)')
        return
      }

      const { SlackAdapter } = await import('./adapter.js')
      // Access the core instance via ctx.core (requires 'kernel:access' permission)
      const core = ctx.core as any
      adapter = new SlackAdapter(core, {
        ...config,
        enabled: true,
        maxMessageLength: 3000,
      } as unknown as SlackChannelConfig, ctx.log)

      ctx.registerService('adapter:slack', adapter)
      ctx.log.info('Slack adapter registered')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
      }
    },
  }
}

export default createSlackPlugin()
