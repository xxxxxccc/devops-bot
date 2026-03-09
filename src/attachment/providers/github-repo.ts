/**
 * GitHub Repo Attachment Provider
 *
 * Uploads attachments to a dedicated GitHub repository using the Git Tree API
 * for batch commits. Files are stored at: {projectId}/{year-mm}/{hash8}-{name}
 *
 * Requires: ATTACHMENT_GITHUB_REPO=owner/repo
 * Auth: Reuses GitHub App token or PAT from the main GitHub client.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createLogger } from '../../infra/logger.js'
import { BaseUploader, type UploadFile } from '../uploader.js'

const log = createLogger('attachment:github-repo')

interface GitTreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string
}

export class GitHubRepoUploader extends BaseUploader {
  private owner: string
  private repo: string
  private host: string
  private branch = 'main'

  constructor(repoSlug: string, host = 'github.com') {
    super()
    const parts = repoSlug.split('/')
    if (parts.length !== 2) throw new Error(`Invalid ATTACHMENT_GITHUB_REPO: "${repoSlug}"`)
    this.owner = parts[0]
    this.repo = parts[1]
    this.host = host
  }

  private get apiBase(): string {
    return this.host === 'github.com' ? 'https://api.github.com' : `https://${this.host}/api/v3`
  }

  private blobUrl(filePath: string): string {
    return `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${filePath}`
  }

  private async getToken(): Promise<string | undefined> {
    const { getGitHubClient } = await import('../../github/client.js')
    const client = await getGitHubClient()
    return client.getToken(this.owner, this.repo)
  }

  private buildStoragePath(file: UploadFile): string {
    const projectId = file.projectId || '_general'
    const now = new Date()
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const hash = createHash('sha256').update(`${file.path}-${Date.now()}`).digest('hex').slice(0, 8)
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    return `${projectId}/${yearMonth}/${hash}-${safeName}`
  }

  override async upload(file: UploadFile): Promise<string | undefined> {
    const urls = await this.uploadBatch([file])
    return urls[0]
  }

  override async uploadBatch(files: UploadFile[]): Promise<Array<string | undefined>> {
    if (files.length === 0) return []

    const token = await this.getToken()
    if (!token) {
      log.warn('No GitHub token available for attachment upload')
      return files.map(() => undefined)
    }

    try {
      const headSha = await this.getHeadSha(token)
      if (!headSha) return files.map(() => undefined)

      const headCommit = await this.getCommit(token, headSha)
      if (!headCommit) return files.map(() => undefined)

      const treeEntries: GitTreeEntry[] = []
      const storagePaths: string[] = []

      for (const file of files) {
        try {
          const content = readFileSync(file.path)
          const base64 = content.toString('base64')
          const storagePath = this.buildStoragePath(file)
          storagePaths.push(storagePath)

          const blobSha = await this.createBlob(token, base64)
          if (!blobSha) {
            storagePaths[storagePaths.length - 1] = ''
            continue
          }

          treeEntries.push({
            path: storagePath,
            mode: '100644',
            type: 'blob',
            sha: blobSha,
          })
        } catch (err) {
          log.warn('Failed to read/upload attachment', {
            file: file.filename,
            error: err instanceof Error ? err.message : String(err),
          })
          storagePaths.push('')
        }
      }

      if (treeEntries.length === 0) {
        log.warn('No attachments could be prepared for upload')
        return files.map(() => undefined)
      }

      const newTreeSha = await this.createTree(token, headCommit.treeSha, treeEntries)
      if (!newTreeSha) return files.map(() => undefined)

      const projectId = files[0]?.projectId || '_general'
      const message = `attach: ${projectId} (${treeEntries.length} file${treeEntries.length > 1 ? 's' : ''})`
      const newCommitSha = await this.createCommitObj(token, message, newTreeSha, headSha)
      if (!newCommitSha) return files.map(() => undefined)

      const updated = await this.updateRef(token, newCommitSha)
      if (!updated) return files.map(() => undefined)

      log.info('Batch upload complete', {
        files: treeEntries.length,
        commit: newCommitSha.slice(0, 8),
      })

      return storagePaths.map((p) => (p ? this.blobUrl(p) : undefined))
    } catch (err) {
      log.error('Batch upload failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return files.map(() => undefined)
    }
  }

  /* ---- Git Data API helpers ---- */

  private async getHeadSha(token: string): Promise<string | undefined> {
    const data = await this.apiGet<{ object: { sha: string } }>(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/ref/heads/${this.branch}`,
      token,
    )
    return data?.object?.sha
  }

  private async getCommit(token: string, sha: string): Promise<{ treeSha: string } | undefined> {
    const data = await this.apiGet<{ tree: { sha: string } }>(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/commits/${sha}`,
      token,
    )
    return data ? { treeSha: data.tree.sha } : undefined
  }

  private async createBlob(token: string, base64Content: string): Promise<string | undefined> {
    const data = await this.apiPost<{ sha: string }>(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/blobs`,
      token,
      { content: base64Content, encoding: 'base64' },
    )
    return data?.sha
  }

  private async createTree(
    token: string,
    baseTree: string,
    entries: GitTreeEntry[],
  ): Promise<string | undefined> {
    const data = await this.apiPost<{ sha: string }>(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/trees`,
      token,
      { base_tree: baseTree, tree: entries },
    )
    return data?.sha
  }

  private async createCommitObj(
    token: string,
    message: string,
    tree: string,
    parent: string,
  ): Promise<string | undefined> {
    const data = await this.apiPost<{ sha: string }>(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/commits`,
      token,
      { message, tree, parents: [parent] },
    )
    return data?.sha
  }

  private async updateRef(token: string, sha: string): Promise<boolean> {
    try {
      const resp = await fetch(
        `${this.apiBase}/repos/${this.owner}/${this.repo}/git/refs/heads/${this.branch}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sha }),
        },
      )
      if (!resp.ok) {
        log.error('updateRef failed', { status: resp.status })
        return false
      }
      return true
    } catch (err) {
      log.error('updateRef error', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  private async apiGet<T>(url: string, token: string): Promise<T | undefined> {
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (!resp.ok) {
        log.error('API GET failed', { url, status: resp.status })
        return undefined
      }
      return (await resp.json()) as T
    } catch (err) {
      log.error('API GET error', { url, error: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }

  private async apiPost<T>(
    url: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<T | undefined> {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const errBody = await resp.text()
        log.error('API POST failed', { url, status: resp.status, body: errBody.slice(0, 300) })
        return undefined
      }
      return (await resp.json()) as T
    } catch (err) {
      log.error('API POST error', { url, error: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
}
