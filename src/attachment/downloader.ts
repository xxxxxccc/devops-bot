/**
 * Attachment Downloader — extracts image URLs from markdown and downloads
 * them to local disk so Task AI can inspect them via MCP `read_file`.
 *
 * Fallback strategy for private GitHub repos:
 *   1. Try with GitHub App token (Authorization header)
 *   2. Try unauthenticated (semi-public user-attachments URLs)
 *   3. Give up — keep original URL + alt-text in prompt for context
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Attachment } from '../channels/types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('attachment:downloader')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ATTACHMENTS_DIR = join(__dirname, '..', '..', 'data', 'attachments')

if (!existsSync(ATTACHMENTS_DIR)) {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true })
}

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const PER_IMAGE_TIMEOUT_MS = 10_000
const TOTAL_TIMEOUT_MS = 30_000

const IMAGE_URL_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g

interface DownloadedImage {
  altText: string
  url: string
  attachment?: Attachment
  error?: string
}

/**
 * Extract image URLs from markdown, download them to local disk.
 * Returns downloaded attachments + fallback entries for failures.
 */
export async function extractAndDownloadImages(
  markdownBody: string,
  githubToken?: string,
): Promise<{
  attachments: Attachment[]
  fallbacks: Array<{ altText: string; url: string; note: string }>
}> {
  const matches: Array<{ altText: string; url: string }> = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  const re = new RegExp(IMAGE_URL_RE.source, IMAGE_URL_RE.flags)
  while ((match = re.exec(markdownBody)) !== null) {
    const url = match[2]
    if (!seen.has(url)) {
      seen.add(url)
      matches.push({ altText: match[1], url })
    }
  }

  if (matches.length === 0) {
    return { attachments: [], fallbacks: [] }
  }

  log.info('Extracting images from markdown', { count: matches.length })

  const totalDeadline = Date.now() + TOTAL_TIMEOUT_MS
  const results: DownloadedImage[] = []

  for (const { altText, url } of matches) {
    if (Date.now() >= totalDeadline) {
      log.warn('Total download timeout reached, skipping remaining images')
      results.push({ altText, url, error: 'total timeout' })
      continue
    }

    const remaining = totalDeadline - Date.now()
    const timeout = Math.min(PER_IMAGE_TIMEOUT_MS, remaining)
    const result = await downloadImage(url, altText, timeout, githubToken)
    results.push(result)
  }

  const attachments: Attachment[] = []
  const fallbacks: Array<{ altText: string; url: string; note: string }> = []

  for (const r of results) {
    if (r.attachment) {
      attachments.push(r.attachment)
    } else {
      fallbacks.push({
        altText: r.altText,
        url: r.url,
        note: r.error || 'download failed',
      })
    }
  }

  log.info('Image extraction complete', {
    downloaded: attachments.length,
    failed: fallbacks.length,
  })

  return { attachments, fallbacks }
}

async function downloadImage(
  url: string,
  altText: string,
  timeoutMs: number,
  githubToken?: string,
): Promise<DownloadedImage> {
  // Strategy 1: With GitHub token (for raw.githubusercontent.com, etc.)
  if (githubToken && isGitHubUrl(url)) {
    const result = await attemptDownload(url, altText, timeoutMs, {
      Authorization: `Bearer ${githubToken}`,
    })
    if (result.attachment) return result
    log.debug('Token-authenticated download failed, trying unauthenticated', { url })
  }

  // Strategy 2: Unauthenticated (user-attachments are often semi-public)
  const result = await attemptDownload(url, altText, timeoutMs)
  if (result.attachment) return result

  log.warn('Image download failed', { url, altText, error: result.error })
  return result
}

async function attemptDownload(
  url: string,
  altText: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<DownloadedImage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(url, {
      headers: { ...headers, Accept: 'image/*,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!resp.ok) {
      return { altText, url, error: `HTTP ${resp.status}` }
    }

    const contentLength = Number(resp.headers.get('content-length') || '0')
    if (contentLength > MAX_FILE_SIZE) {
      return {
        altText,
        url,
        error: `file too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
      }
    }

    const contentType = resp.headers.get('content-type') || 'image/png'
    const ext = extensionFromContentType(contentType, url)
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
    const filePath = join(ATTACHMENTS_DIR, filename)

    if (!resp.body) {
      return { altText, url, error: 'empty response body' }
    }

    const nodeStream = Readable.fromWeb(resp.body as any)
    await pipeline(nodeStream, createWriteStream(filePath))

    // Verify size after download
    const stat = statSync(filePath)
    if (stat.size > MAX_FILE_SIZE) {
      return {
        altText,
        url,
        error: `downloaded file too large (${Math.round(stat.size / 1024 / 1024)}MB)`,
      }
    }

    const displayName = altText || filenameFromUrl(url) || filename

    return {
      altText,
      url,
      attachment: {
        filename,
        originalname: displayName,
        path: filePath,
        mimetype: contentType.split(';')[0].trim(),
        publicUrl: url,
      },
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { altText, url, error: 'timeout' }
    }
    return { altText, url, error: (err as Error).message || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

function isGitHubUrl(url: string): boolean {
  return (
    url.includes('github.com') ||
    url.includes('githubusercontent.com') ||
    url.includes('github.githubassets.com')
  )
}

function extensionFromContentType(ct: string, url: string): string {
  const mime = ct.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
  }
  if (map[mime]) return map[mime]

  // Fallback: try URL extension
  const urlExt = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase()
  if (urlExt && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(urlExt)) {
    return urlExt
  }

  return 'png'
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname
    const segments = path.split('/')
    const last = segments[segments.length - 1]
    if (last && last.includes('.')) return decodeURIComponent(last)
  } catch {
    // ignore
  }
  return undefined
}
