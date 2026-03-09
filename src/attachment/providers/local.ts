/**
 * Local HTTP Attachment Provider
 *
 * Serves attachments from the existing data/attachments/ directory
 * via the bot's Express server. Requires the bot to be reachable
 * from where Issue/PR markdown is rendered.
 *
 * Requires: ATTACHMENT_BASE_URL=https://my-bot.example.com:3200
 */

import { createLogger } from '../../infra/logger.js'
import { BaseUploader, type UploadFile } from '../uploader.js'
import { basename } from 'node:path'

const log = createLogger('attachment:local')

export class LocalUploader extends BaseUploader {
  private baseUrl: string

  constructor(baseUrl: string) {
    super()
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async upload(file: UploadFile): Promise<string | undefined> {
    try {
      const filename = basename(file.path)
      const url = `${this.baseUrl}/attachments/${encodeURIComponent(filename)}`
      log.info('Local attachment URL generated', { filename, url })
      return url
    } catch (err) {
      log.error('Failed to generate local URL', {
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}
