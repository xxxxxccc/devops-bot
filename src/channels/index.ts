/**
 * IM Platform factory.
 *
 * Creates the appropriate platform based on configuration.
 */

import type { IMPlatform, IMPlatformType } from './types.js'

export {
  type IMPlatform,
  type IMPlatformType,
  type IMMessage,
  type IMCard,
  type Attachment,
  type ExtractedLink,
} from './types.js'

/**
 * Create an IM platform from environment variables.
 */
export async function createPlatform(type?: IMPlatformType): Promise<IMPlatform> {
  const platformType = type || (process.env.IM_PLATFORM as IMPlatformType) || 'feishu'

  switch (platformType) {
    case 'feishu': {
      const appId = process.env.FEISHU_APP_ID
      const appSecret = process.env.FEISHU_APP_SECRET
      if (!appId || !appSecret) {
        throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for Feishu platform')
      }
      const { FeishuChannel } = await import('./feishu/index.js')
      return new FeishuChannel({ appId, appSecret })
    }
    case 'slack': {
      const botToken = process.env.SLACK_BOT_TOKEN
      const appToken = process.env.SLACK_APP_TOKEN
      if (!botToken || !appToken) {
        throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required for Slack platform')
      }
      const { SlackChannel } = await import('./slack/index.js')
      return new SlackChannel({ botToken, appToken })
    }
    default:
      throw new Error(`Unknown IM platform: ${platformType}`)
  }
}
