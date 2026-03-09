/**
 * Platform tools — issue and PR operations for the dispatcher.
 *
 * Read tools: list_issues, get_issue, list_prs, get_pr
 * Write tools: create_issue, edit_issue, comment_issue, assign_issue,
 *              add_labels, remove_labels, comment_pr, close_pr
 *
 * Each tool resolves the project's owner/repo from context.projectPath
 * via detectRepo, then delegates to the GitHubClient.
 */

import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'

// ============ Helpers ============

async function resolveRepo(projectPath: string) {
  const { detectRepo } = await import('../sandbox/pr-creator.js')
  const info = await detectRepo(projectPath)
  if (info.platform === 'unknown') {
    throw new Error('Cannot determine repository platform from git remote')
  }
  if (info.platform !== 'github') {
    throw new Error(`Platform "${info.platform}" is not yet supported for this operation`)
  }
  const { getGitHubClient } = await import('../github/client.js')
  const client = await getGitHubClient()
  if (!client.isAvailable) {
    throw new Error('GitHub authentication is not configured')
  }
  return { client, owner: info.owner, repo: info.repo, host: info.host }
}

// ============ Schemas ============

const listIssuesSchema = z.object({
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .describe('Issue state filter (default: open)'),
  labels: z.string().optional().describe('Comma-separated label filter (e.g. "bug,help wanted")'),
})

const getIssueSchema = z.object({
  issue_number: z.number().describe('Issue number'),
})

const editIssueSchema = z.object({
  issue_number: z.number().describe('Issue number'),
  state: z.enum(['open', 'closed']).optional().describe('Set issue state'),
  title: z.string().optional().describe('New title'),
  body: z.string().optional().describe('New body'),
})

const commentIssueSchema = z.object({
  issue_number: z.number().describe('Issue number'),
  body: z.string().describe('Comment text'),
})

const assignIssueSchema = z.object({
  issue_number: z.number().describe('Issue number'),
  assignees: z
    .array(z.string())
    .describe('GitHub usernames to assign (must be repo collaborators)'),
})

const createIssueSchema = z.object({
  title: z.string().describe('Issue title'),
  body: z.string().optional().describe('Issue body (markdown)'),
  labels: z.array(z.string()).optional().describe('Labels to add'),
})

const addLabelsSchema = z.object({
  issue_number: z.number().describe('Issue or PR number'),
  labels: z.array(z.string()).describe('Labels to add'),
})

const removeLabelsSchema = z.object({
  issue_number: z.number().describe('Issue or PR number'),
  labels: z.array(z.string()).describe('Labels to remove'),
})

const listPrsSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)'),
})

const getPrSchema = z.object({
  pr_number: z.number().describe('Pull request number'),
})

const commentPrSchema = z.object({
  pr_number: z.number().describe('Pull request number'),
  body: z.string().describe('Comment text'),
})

const closePrSchema = z.object({
  pr_number: z.number().describe('Pull request number'),
  reopen: z.boolean().optional().describe('Set to true to reopen instead of close'),
})

// ============ Tools ============

const listIssuesTool = defineTool({
  name: 'list_issues',
  category: 'platform-read',
  description: 'List repository issues with optional state and label filters',
  schema: listIssuesSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const issues = await client.listIssues(
      owner,
      repo,
      { state: args.state, labels: args.labels },
      host,
    )
    if (issues.length === 0) return 'No issues found'
    return issues
      .map(
        (i) =>
          `#${i.number} [${i.state}] ${i.title} (by ${i.user}, ${i.created_at.slice(0, 10)})${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}\n  ${i.html_url}`,
      )
      .join('\n')
  },
})

const getIssueTool = defineTool({
  name: 'get_issue',
  category: 'platform-read',
  description: 'Get issue details including body and comments',
  schema: getIssueSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const result = await client.getIssueWithComments(owner, repo, args.issue_number, host)
    if (!result) return 'Failed to fetch issue'
    if ('notFound' in result && result.notFound) return `Issue #${args.issue_number} not found`

    const lines = [
      `## Issue #${args.issue_number} [${result.state}]`,
      '',
      result.body || '(no description)',
    ]

    if (result.comments.length > 0) {
      lines.push('', '---', `### Comments (${result.comments.length})`, '')
      for (const c of result.comments) {
        lines.push(`**${c.user}** (${c.createdAt.slice(0, 10)}):`, c.body, '')
      }
    }
    return lines.join('\n')
  },
})

const editIssueTool = defineTool({
  name: 'edit_issue',
  category: 'platform-write',
  description: 'Update an issue: change state (open/closed), title, or body',
  schema: editIssueSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const opts: { state?: 'open' | 'closed'; title?: string; body?: string } = {}
    if (args.state) opts.state = args.state
    if (args.title) opts.title = args.title
    if (args.body) opts.body = args.body

    if (Object.keys(opts).length === 0) {
      return 'No changes specified'
    }

    const ok = await client.updateIssue(owner, repo, args.issue_number, opts, host)
    if (!ok) return `Failed to update issue #${args.issue_number}`

    const changes = Object.entries(opts)
      .map(([k, v]) => `${k}: ${k === 'body' ? '(updated)' : v}`)
      .join(', ')
    return `Issue #${args.issue_number} updated: ${changes}`
  },
})

const commentIssueTool = defineTool({
  name: 'comment_issue',
  category: 'platform-write',
  description: 'Add a comment to an issue',
  schema: commentIssueSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const ok = await client.createIssueComment(owner, repo, args.issue_number, args.body, host)
    if (!ok) return `Failed to comment on issue #${args.issue_number}`
    return `Comment added to issue #${args.issue_number}`
  },
})

const assignIssueTool = defineTool({
  name: 'assign_issue',
  category: 'platform-write',
  description: 'Assign users to an issue. Assignees must be repository collaborators.',
  schema: assignIssueSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const ok = await client.addAssignees(owner, repo, args.issue_number, args.assignees, host)
    if (!ok) {
      return `Failed to assign issue #${args.issue_number}. Ensure the users are repo collaborators.`
    }
    return `Issue #${args.issue_number} assigned to: ${args.assignees.join(', ')}`
  },
})

const createIssueTool = defineTool({
  name: 'create_issue',
  category: 'platform-write',
  description: 'Create a new issue in the repository',
  schema: createIssueSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const result = await client.createIssue(
      owner,
      repo,
      { title: args.title, body: args.body || '', labels: args.labels },
      host,
    )
    if (!result) return 'Failed to create issue'
    return `Issue #${result.number} created: ${result.url}`
  },
})

const addLabelsTool = defineTool({
  name: 'add_labels',
  category: 'platform-write',
  description: 'Add labels to an issue or pull request',
  schema: addLabelsSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const ok = await client.addLabels(owner, repo, args.issue_number, args.labels, host)
    if (!ok) return `Failed to add labels to #${args.issue_number}`
    return `Labels added to #${args.issue_number}: ${args.labels.join(', ')}`
  },
})

const removeLabelsTool = defineTool({
  name: 'remove_labels',
  category: 'platform-write',
  description: 'Remove labels from an issue or pull request',
  schema: removeLabelsSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const failed: string[] = []
    for (const label of args.labels) {
      const ok = await client.removeLabel(owner, repo, args.issue_number, label, host)
      if (!ok) failed.push(label)
    }
    if (failed.length === args.labels.length)
      return `Failed to remove labels from #${args.issue_number}`
    if (failed.length > 0)
      return `Labels removed from #${args.issue_number}, but failed: ${failed.join(', ')}`
    return `Labels removed from #${args.issue_number}: ${args.labels.join(', ')}`
  },
})

const commentPrTool = defineTool({
  name: 'comment_pr',
  category: 'platform-write',
  description: 'Add a comment to a pull request',
  schema: commentPrSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const ok = await client.createIssueComment(owner, repo, args.pr_number, args.body, host)
    if (!ok) return `Failed to comment on PR #${args.pr_number}`
    return `Comment added to PR #${args.pr_number}`
  },
})

const closePrTool = defineTool({
  name: 'close_pr',
  category: 'platform-write',
  description: 'Close (or reopen) a pull request',
  schema: closePrSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const state = args.reopen ? 'open' : 'closed'
    const ok = await client.updatePR(owner, repo, args.pr_number, { state }, host)
    if (!ok) return `Failed to ${args.reopen ? 'reopen' : 'close'} PR #${args.pr_number}`
    return `PR #${args.pr_number} ${args.reopen ? 'reopened' : 'closed'}`
  },
})

const listPrsTool = defineTool({
  name: 'list_prs',
  category: 'platform-read',
  description: 'List repository pull requests with optional state filter',
  schema: listPrsSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const prs = await client.listPRs(owner, repo, { state: args.state }, host)
    if (prs.length === 0) return 'No pull requests found'
    return prs
      .map(
        (pr) =>
          `#${pr.number} [${pr.state}${pr.draft ? ', draft' : ''}] ${pr.title} (by ${pr.user}, ${pr.head} -> ${pr.base})\n  ${pr.html_url}`,
      )
      .join('\n')
  },
})

const getPrTool = defineTool({
  name: 'get_pr',
  category: 'platform-read',
  description: 'Get detailed info about a pull request (status, files changed, diff stats)',
  schema: getPrSchema,
  async execute(args, context) {
    const { client, owner, repo, host } = await resolveRepo(context.projectPath)
    const pr = await client.getPR(owner, repo, args.pr_number, host)
    if (!pr) return `PR #${args.pr_number} not found or failed to fetch`

    const lines = [
      `## PR #${pr.number} [${pr.state}${pr.draft ? ', draft' : ''}]`,
      `**${pr.title}**`,
      `Author: ${pr.user} | Branch: ${pr.head} -> ${pr.base}`,
      `Files changed: ${pr.changed_files} | +${pr.additions} -${pr.deletions}`,
      `Mergeable: ${pr.mergeable === null ? 'unknown' : pr.mergeable}`,
      `Created: ${pr.created_at.slice(0, 10)} | Updated: ${pr.updated_at.slice(0, 10)}`,
      `URL: ${pr.html_url}`,
    ]

    if (pr.body) {
      lines.push('', '---', '', pr.body)
    }

    return lines.join('\n')
  },
})

export const platformTools: Tool[] = [
  listIssuesTool,
  getIssueTool,
  createIssueTool,
  editIssueTool,
  commentIssueTool,
  assignIssueTool,
  addLabelsTool,
  removeLabelsTool,
  listPrsTool,
  getPrTool,
  commentPrTool,
  closePrTool,
]
