/**
 * GitLab Project Uploads Attachment Provider
 *
 * Uses the official GitLab Project Uploads API:
 *   POST /api/v4/projects/:id/uploads
 *
 * Requires: ATTACHMENT_GITLAB_PROJECT=org/repo
 * Auth: Reuses GITLAB_TOKEN.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createLogger } from '../../infra/logger.js'
import { BaseUploader, type UploadFile } from '../uploader.js'

const log = createLogger('attachment:gitlab-uploads')

export class GitLabUploadsUploader extends BaseUploader {
  private projectPath: string
  private host: string
  private token: string

  constructor(opts: { project: string; host?: string; token: string }) {
    super()
    this.projectPath = opts.project
    this.host = opts.host || 'gitlab.com'
    this.token = opts.token
  }

  async upload(file: UploadFile): Promise<string | undefined> {
    try {
      const projectId = encodeURIComponent(this.projectPath)
      const url = `https://${this.host}/api/v4/projects/${projectId}/uploads`

      const fileData = readFileSync(file.path)
      const blob = new Blob([fileData], { type: file.mimetype })
      const form = new FormData()
      form.append('file', blob, basename(file.path))

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': this.token },
        body: form,
      })

      if (!resp.ok) {
        const errBody = await resp.text()
        log.error('GitLab upload failed', {
          status: resp.status,
          body: errBody.slice(0, 300),
        })
        return undefined
      }

      const data = (await resp.json()) as { full_path?: string; markdown?: string; url?: string }
      const resultUrl = data.full_path
        ? `https://${this.host}${data.full_path}`
        : data.url
          ? `https://${this.host}${data.url}`
          : undefined

      if (resultUrl) {
        log.info('GitLab upload success', { url: resultUrl })
      }
      return resultUrl
    } catch (err) {
      log.error('GitLab upload error', {
        file: file.filename,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}
