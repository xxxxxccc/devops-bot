/**
 * Attachment module — pluggable upload storage + download from discussions.
 *
 * Upload:  IM attachments → external storage → URL for Issue/PR markdown
 * Download: Issue/PR discussion images → local disk → Task AI reads via MCP
 */

import { existsSync } from 'node:fs'
import type { Attachment } from '../channels/types.js'
import type { AttachmentUploader, UploadFile } from './uploader.js'
import { createLogger } from '../infra/logger.js'

export type { AttachmentUploader, UploadFile } from './uploader.js'

const log = createLogger('attachment')

let _uploader: AttachmentUploader | undefined | null = null

/**
 * Create the uploader singleton based on ATTACHMENT_STORAGE env var.
 * Returns undefined when no storage is configured (attachments stay local-only).
 */
export async function createUploader(): Promise<AttachmentUploader | undefined> {
  if (_uploader !== null) return _uploader || undefined
  _uploader = await buildUploader()
  return _uploader || undefined
}

async function buildUploader(): Promise<AttachmentUploader | undefined> {
  const storage = process.env.ATTACHMENT_STORAGE?.toLowerCase()
  if (!storage) {
    log.info('No ATTACHMENT_STORAGE configured — attachments will remain local-only')
    return undefined
  }

  switch (storage) {
    case 'github-repo': {
      const repo = process.env.ATTACHMENT_GITHUB_REPO
      if (!repo) {
        log.error('ATTACHMENT_STORAGE=github-repo but ATTACHMENT_GITHUB_REPO is not set')
        return undefined
      }
      const { GitHubRepoUploader } = await import('./providers/github-repo.js')
      log.info('Attachment uploader: github-repo', { repo })
      return new GitHubRepoUploader(repo)
    }

    case 'gitlab-uploads': {
      const project = process.env.ATTACHMENT_GITLAB_PROJECT
      const token =
        process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN || process.env.GL_TOKEN
      if (!project || !token) {
        log.error(
          'ATTACHMENT_STORAGE=gitlab-uploads but ATTACHMENT_GITLAB_PROJECT or GITLAB_TOKEN is not set',
        )
        return undefined
      }
      const { GitLabUploadsUploader } = await import('./providers/gitlab-uploads.js')
      log.info('Attachment uploader: gitlab-uploads', { project })
      return new GitLabUploadsUploader({ project, token })
    }

    case 's3': {
      const bucket = process.env.ATTACHMENT_S3_BUCKET
      if (!bucket) {
        log.error('ATTACHMENT_STORAGE=s3 but ATTACHMENT_S3_BUCKET is not set')
        return undefined
      }
      const { S3Uploader } = await import('./providers/s3.js')
      log.info('Attachment uploader: s3', { bucket })
      return new S3Uploader({
        bucket,
        region: process.env.ATTACHMENT_S3_REGION,
        prefix: process.env.ATTACHMENT_S3_PREFIX,
        cdnUrl: process.env.ATTACHMENT_S3_CDN_URL,
      })
    }

    case 'local': {
      const baseUrl = process.env.ATTACHMENT_BASE_URL
      if (!baseUrl) {
        log.error('ATTACHMENT_STORAGE=local but ATTACHMENT_BASE_URL is not set')
        return undefined
      }
      const { LocalUploader } = await import('./providers/local.js')
      log.info('Attachment uploader: local', { baseUrl })
      return new LocalUploader(baseUrl)
    }

    case 'custom': {
      const url = process.env.ATTACHMENT_CUSTOM_UPLOAD_URL
      if (!url) {
        log.error('ATTACHMENT_STORAGE=custom but ATTACHMENT_CUSTOM_UPLOAD_URL is not set')
        return undefined
      }
      const { CustomUploader } = await import('./providers/custom.js')
      log.info('Attachment uploader: custom', { url })
      return new CustomUploader({ url, headers: process.env.ATTACHMENT_CUSTOM_HEADERS })
    }

    default:
      log.error(`Unknown ATTACHMENT_STORAGE value: "${storage}"`)
      return undefined
  }
}

/**
 * Upload all attachments and populate their `publicUrl` field in-place.
 * Non-destructive: if upload fails, the attachment keeps its local path only.
 */
export async function uploadAttachments(
  attachments: Attachment[],
  projectId?: string,
): Promise<void> {
  const uploader = await createUploader()
  if (!uploader || attachments.length === 0) return

  const validFiles: Array<{ index: number; file: UploadFile }> = []
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (att.publicUrl) continue
    if (!existsSync(att.path)) {
      log.warn('Attachment file not found, skipping upload', { path: att.path })
      continue
    }
    validFiles.push({
      index: i,
      file: {
        path: att.path,
        filename: att.originalname || att.filename,
        mimetype: att.mimetype,
        projectId,
      },
    })
  }

  if (validFiles.length === 0) return

  try {
    const urls = await uploader.uploadBatch(validFiles.map((v) => v.file))
    for (let i = 0; i < validFiles.length; i++) {
      const url = urls[i]
      if (url) {
        attachments[validFiles[i].index].publicUrl = url
      }
    }
    const uploaded = urls.filter(Boolean).length
    log.info('Attachments uploaded', { total: validFiles.length, success: uploaded })
  } catch (err) {
    log.error('uploadAttachments failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
