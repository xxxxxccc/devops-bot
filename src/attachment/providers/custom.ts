/**
 * Custom Webhook Attachment Provider
 *
 * POSTs attachments as multipart/form-data to a user-provided URL.
 * Expects a JSON response with a `url` field.
 *
 * Requires: ATTACHMENT_CUSTOM_UPLOAD_URL
 * Optional: ATTACHMENT_CUSTOM_HEADERS (e.g. "Authorization: Bearer xxx")
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createLogger } from '../../infra/logger.js'
import { BaseUploader, type UploadFile } from '../uploader.js'

const log = createLogger('attachment:custom')

export class CustomUploader extends BaseUploader {
  private uploadUrl: string
  private headers: Record<string, string>

  constructor(opts: { url: string; headers?: string }) {
    super()
    this.uploadUrl = opts.url
    this.headers = {}
    if (opts.headers) {
      for (const line of opts.headers.split(';')) {
        const idx = line.indexOf(':')
        if (idx > 0) {
          this.headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
      }
    }
  }

  async upload(file: UploadFile): Promise<string | undefined> {
    try {
      const fileData = readFileSync(file.path)
      const blob = new Blob([fileData], { type: file.mimetype })
      const form = new FormData()
      form.append('file', blob, basename(file.path))
      form.append('filename', file.filename)
      form.append('mimetype', file.mimetype)
      if (file.projectId) form.append('projectId', file.projectId)

      const resp = await fetch(this.uploadUrl, {
        method: 'POST',
        headers: this.headers,
        body: form,
      })

      if (!resp.ok) {
        const errBody = await resp.text()
        log.error('Custom upload failed', {
          status: resp.status,
          body: errBody.slice(0, 300),
        })
        return undefined
      }

      const data = (await resp.json()) as { url?: string }
      if (data.url) {
        log.info('Custom upload success', { url: data.url })
        return data.url
      }

      log.warn('Custom upload response missing url field')
      return undefined
    } catch (err) {
      log.error('Custom upload error', {
        file: file.filename,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}
