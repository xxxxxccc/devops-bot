/**
 * AWS S3 Attachment Provider
 *
 * Uploads attachments to an S3 bucket. Uses dynamic import of @aws-sdk/client-s3
 * so the dependency is only needed when this provider is active.
 *
 * Requires: ATTACHMENT_S3_BUCKET
 * Optional: ATTACHMENT_S3_REGION, ATTACHMENT_S3_PREFIX, ATTACHMENT_S3_CDN_URL
 * Auth: EC2 IAM Role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createLogger } from '../../infra/logger.js'
import { BaseUploader, type UploadFile } from '../uploader.js'

const log = createLogger('attachment:s3')

export class S3Uploader extends BaseUploader {
  private bucket: string
  private region: string
  private prefix: string
  private cdnUrl: string | undefined

  constructor(opts: {
    bucket: string
    region?: string
    prefix?: string
    cdnUrl?: string
  }) {
    super()
    this.bucket = opts.bucket
    this.region = opts.region || 'us-east-1'
    this.prefix = (opts.prefix || 'attachments/').replace(/\/$/, '') + '/'
    this.cdnUrl = opts.cdnUrl?.replace(/\/+$/, '')
  }

  private buildKey(file: UploadFile): string {
    const projectId = file.projectId || '_general'
    const now = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const hash = createHash('sha256').update(`${file.path}-${Date.now()}`).digest('hex').slice(0, 8)
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    return `${this.prefix}${projectId}/${yearMonth}/${hash}-${safeName}`
  }

  async upload(file: UploadFile): Promise<string | undefined> {
    try {
      const moduleName = '@aws-sdk/client-s3'
      const s3: any = await import(moduleName)
      const client = new s3.S3Client({ region: this.region })
      const key = this.buildKey(file)
      const body = readFileSync(file.path)

      await client.send(
        new s3.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: file.mimetype,
        }),
      )

      const url = this.cdnUrl
        ? `${this.cdnUrl}/${key}`
        : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`

      log.info('S3 upload success', { key, url })
      return url
    } catch (err) {
      log.error('S3 upload failed', {
        file: file.filename,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}
