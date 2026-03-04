/**
 * PR Review Poller — periodically scans registered projects for PRs
 * that need review (for environments without public webhook access).
 *
 * Follows the same pattern as ApprovalPoller:
 *   - Periodic interval (REVIEW_POLL_INTERVAL_MS)
 *   - Label-based filtering (REVIEW_SCAN_LABELS)
 *   - Deduplication via ReviewStore (reviewed_prs table)
 *   - Head SHA tracking (re-reviews on new commits)
 */

import { createLogger } from '../infra/logger.js'
import type { GitHubClient } from '../github/client.js'
import type { ProjectRegistry } from '../project/registry.js'
import type { ReviewEngine } from './engine.js'
import type { ReviewStore } from './store.js'

const log = createLogger('review-poller')

const REVIEW_AUTO_SCAN = process.env.REVIEW_AUTO_SCAN !== 'false'
const REVIEW_SCAN_LABELS = process.env.REVIEW_SCAN_LABELS
  ? process.env.REVIEW_SCAN_LABELS.split(',').map((l) => l.trim().toLowerCase())
  : []

export interface ReviewPollerDeps {
  reviewEngine: ReviewEngine
  reviewStore: ReviewStore
  githubClient: GitHubClient
  getProjectRegistry: () => Promise<ProjectRegistry | null>
}

export class ReviewPoller {
  private deps: ReviewPollerDeps
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: ReviewPollerDeps, intervalMs = 1_800_000) {
    this.deps = deps
    this.intervalMs = intervalMs
  }

  start(): void {
    if (this.timer) return

    log.info(`Review poller started (interval: ${this.intervalMs}ms)`)
    this.timer = setInterval(() => {
      this.poll().catch((err) =>
        log.error('Review poll cycle failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }, this.intervalMs)

    // Run first poll immediately on startup
    this.poll().catch((err) =>
      log.error('Initial review poll failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      log.info('Review poller stopped')
    }
  }

  async poll(): Promise<void> {
    const registry = await this.deps.getProjectRegistry()
    if (!registry) {
      log.debug('No project registry available, skipping poll')
      return
    }

    const projects = registry.listAll()
    if (projects.length === 0) {
      log.debug('No registered projects, skipping poll')
      return
    }

    log.debug(`Polling ${projects.length} project(s) for reviewable PRs`)

    for (const project of projects) {
      try {
        const parsed = parseGitUrl(project.gitUrl)
        if (!parsed) continue
        await this.pollProject({
          id: project.id,
          owner: parsed.owner,
          repo: parsed.repo,
          host: parsed.host,
          localPath: project.localPath,
        })
      } catch (err) {
        log.warn(`Failed to poll project ${project.id}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async pollProject(project: {
    id: string
    owner: string
    repo: string
    host: string
    localPath: string
  }): Promise<void> {
    const { owner, repo, host } = project
    const gh = this.deps.githubClient

    const prs = await gh.listPRs(owner, repo, { state: 'open' }, host)
    if (prs.length === 0) return

    for (const pr of prs) {
      try {
        if (!this.shouldReview(pr)) continue

        // Get detailed PR info including head commit SHA for deduplication
        const detailed = await gh.getPR(owner, repo, pr.number, host)
        if (!detailed) continue

        const headSHA = detailed.headSHA
        if (this.deps.reviewStore.isReviewed(owner, repo, pr.number, headSHA)) {
          log.debug(`PR #${pr.number} already reviewed at ${headSHA.slice(0, 8)}, skipping`)
          continue
        }

        log.info(`Reviewing PR #${pr.number} in ${owner}/${repo}`, {
          title: pr.title,
          headSHA: headSHA.slice(0, 8),
          trigger: 'poller',
        })

        const result = await this.deps.reviewEngine.reviewPR({
          owner,
          repo,
          prNumber: pr.number,
          host,
          projectPath: project.localPath,
          trigger: 'poller',
        })

        this.deps.reviewStore.markReviewed(
          owner,
          repo,
          pr.number,
          headSHA,
          result.reviewId ?? null,
          'poller',
        )
      } catch (err) {
        log.warn(`Failed to review PR #${pr.number}`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private shouldReview(pr: { draft: boolean; labels: string[] }): boolean {
    if (pr.draft) return false
    if (REVIEW_AUTO_SCAN) return true
    if (REVIEW_SCAN_LABELS.length === 0) return false
    return pr.labels.some((l) => REVIEW_SCAN_LABELS.includes(l.toLowerCase()))
  }
}

function parseGitUrl(gitUrl: string): { owner: string; repo: string; host: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = gitUrl.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/.]+)/)
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] }
  }
  // SSH: git@github.com:owner/repo.git
  const sshMatch = gitUrl.match(/@([^:]+):([^/]+)\/([^/.]+)/)
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] }
  }
  return null
}
