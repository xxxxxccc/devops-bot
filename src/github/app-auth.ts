/**
 * GitHub App Authentication — JWT generation and installation token lifecycle.
 *
 * Uses Node.js `crypto` module exclusively (no new dependencies).
 *
 * Flow:
 *   1. Generate a short-lived JWT (10 min) signed with the App's private key (RS256)
 *   2. Use JWT to discover the installation ID for a given owner
 *   3. Request an installation access token (valid ~1 hour)
 *   4. Cache tokens with 50-min TTL (refresh before expiry)
 */

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createLogger } from '../infra/logger.js'

const log = createLogger('github-app-auth')

export interface GitHubAppConfig {
  appId: string
  privateKey: string
}

interface CachedToken {
  token: string
  expiresAt: number
}

/**
 * Load GitHub App configuration from environment variables.
 * Returns undefined if not configured (falls back to PAT mode).
 */
export function loadGitHubAppConfig(): GitHubAppConfig | undefined {
  const appId = process.env.GITHUB_APP_ID
  if (!appId) return undefined

  let privateKey: string | undefined

  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH
  if (keyPath) {
    try {
      privateKey = readFileSync(keyPath, 'utf-8')
    } catch (err) {
      log.error('Failed to read GitHub App private key', {
        path: keyPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const keyBase64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64
  if (!privateKey && keyBase64) {
    privateKey = Buffer.from(keyBase64, 'base64').toString('utf-8')
  }

  if (!privateKey) {
    log.warn(
      'GITHUB_APP_ID is set but no private key found. ' +
        'Set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY_BASE64.',
    )
    return undefined
  }

  return { appId, privateKey }
}

export class GitHubAppAuth {
  private readonly config: GitHubAppConfig

  private installationIdCache = new Map<string, number>()
  private tokenCache = new Map<string, CachedToken>()

  constructor(config: GitHubAppConfig) {
    this.config = config
  }

  /**
   * Get an installation access token for a given owner/repo.
   * Tokens are cached for 50 minutes (they last 1 hour).
   */
  async getInstallationToken(owner: string, _repo?: string): Promise<string> {
    const cacheKey = owner.toLowerCase()
    const cached = this.tokenCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token
    }

    const installationId = await this.getInstallationId(owner)
    const jwt = this.generateJWT()

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to get installation token: ${response.status} ${body}`)
    }

    const data = (await response.json()) as { token: string; expires_at: string }

    const token: CachedToken = {
      token: data.token,
      expiresAt: Date.now() + 50 * 60 * 1000,
    }
    this.tokenCache.set(cacheKey, token)

    log.info('Acquired installation token', { owner, expiresAt: data.expires_at })
    return data.token
  }

  /**
   * Generate a JWT signed with RS256 using the App's private key.
   * Valid for 10 minutes per GitHub spec.
   */
  private generateJWT(): string {
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = base64url(
      JSON.stringify({
        iss: this.config.appId,
        iat: now - 60,
        exp: now + 600,
      }),
    )

    const signingInput = `${header}.${payload}`
    const sign = createSign('RSA-SHA256')
    sign.update(signingInput)
    const signature = sign.sign(this.config.privateKey, 'base64url')

    return `${signingInput}.${signature}`
  }

  /**
   * Find the installation ID for an owner (org or user account).
   * Cached indefinitely (installation IDs rarely change).
   */
  private async getInstallationId(owner: string): Promise<number> {
    const key = owner.toLowerCase()
    const cached = this.installationIdCache.get(key)
    if (cached) return cached

    const jwt = this.generateJWT()
    const response = await fetch('https://api.github.com/app/installations', {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to list installations: ${response.status} ${body}`)
    }

    const installations = (await response.json()) as Array<{
      id: number
      account: { login: string }
    }>

    const match = installations.find((i) => i.account.login.toLowerCase() === key)
    if (!match) {
      throw new Error(
        `No GitHub App installation found for "${owner}". ` +
          `Install the App at https://github.com/apps/<your-app>/installations`,
      )
    }

    this.installationIdCache.set(key, match.id)
    log.info('Resolved installation ID', { owner, installationId: match.id })
    return match.id
  }
}

function base64url(data: string): string {
  return Buffer.from(data).toString('base64url')
}
