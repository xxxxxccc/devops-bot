/**
 * Git operation tools.
 *
 * Two flavors:
 *   - Static tools (gitReadTools): use context.projectPath, suitable for dispatcher
 *   - Factory tools (createGitTools): bound to a fixed path, for sandbox/task runner
 */

import { simpleGit } from 'simple-git'
import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'

// ============ Schemas ============

const emptySchema = z.object({})

const gitDiffSchema = z.object({
  staged: z.boolean().optional().describe('Show staged changes only'),
  file: z.string().optional().describe('Show diff for specific file only'),
})

const gitLogSchema = z.object({
  count: z.number().optional().describe('Number of commits (default: 10)'),
  author: z.string().optional().describe('Filter by author'),
  grep: z.string().optional().describe('Search in commit messages'),
  ref: z
    .string()
    .optional()
    .describe('Branch or ref to show log for (e.g. "dev", "v1.3.9..v1.4.0")'),
})

const gitShowSchema = z.object({
  commit: z.string().optional().describe('Commit hash (default: HEAD)'),
})

const gitBranchSchema = z.object({
  all: z.boolean().optional().describe('Show all branches including remote'),
})

const gitCheckoutBranchSchema = z.object({
  branch: z.string().describe('New branch name'),
  base: z.string().optional().describe('Base branch to checkout from (default: current)'),
})

const gitSwitchSchema = z.object({
  branch: z.string().describe('Branch name to switch to'),
})

const gitAddSchema = z.object({
  files: z.string().optional().describe('Files to stage (default: . for all)'),
})

const gitCommitSchema = z.object({
  message: z.string().describe('Commit message'),
  add: z.boolean().optional().describe('Stage all changes before commit (git commit -a)'),
})

const gitPushSchema = z.object({
  force: z.boolean().optional().describe('Force push (use with caution)'),
})

const gitPullSchema = z.object({
  rebase: z.boolean().optional().describe('Use rebase instead of merge'),
})

const gitStashSchema = z.object({
  message: z.string().optional().describe('Stash message'),
  pop: z.boolean().optional().describe('Pop the latest stash instead of creating'),
})

// ============ Static read-only tools (context-based) ============

export const gitReadTools: Tool[] = [
  defineTool({
    name: 'git_status',
    category: 'git',
    description: 'Get the current git status (branch, modified files, staged changes)',
    schema: emptySchema,
    async execute(_args, context) {
      const git = simpleGit(context.projectPath)
      const status = await git.status()
      return JSON.stringify(
        {
          branch: status.current,
          ahead: status.ahead,
          behind: status.behind,
          staged: status.staged,
          modified: status.modified,
          untracked: status.not_added,
          conflicted: status.conflicted,
        },
        null,
        2,
      )
    },
  }),
  defineTool({
    name: 'git_diff',
    category: 'git',
    description: 'Get the current git diff or diff between refs',
    schema: gitDiffSchema,
    async execute(args, context) {
      const git = simpleGit(context.projectPath)
      const options: string[] = []
      if (args.staged) options.push('--staged')
      if (args.file) options.push('--', args.file)
      const diff = await git.diff(options)
      return diff || 'No changes'
    },
  }),
  defineTool({
    name: 'git_log',
    category: 'git',
    description:
      'Get recent git commits. Use ref param for specific branches or ranges (e.g. "v1.3.9..v1.4.0")',
    schema: gitLogSchema,
    async execute(args, context) {
      const git = simpleGit(context.projectPath)
      const logArgs: string[] = [`-n${args.count || 20}`, '--pretty=format:%h | %ai | %an: %s']
      if (args.author) logArgs.push(`--author=${args.author}`)
      if (args.grep) logArgs.push(`--grep=${args.grep}`)
      if (args.ref) logArgs.push(args.ref)
      const result = await git.raw(['log', ...logArgs])
      return result || 'No commits found'
    },
  }),
  defineTool({
    name: 'git_show',
    category: 'git',
    description: 'Show details and diff of a specific commit',
    schema: gitShowSchema,
    async execute(args, context) {
      const git = simpleGit(context.projectPath)
      const commit = args.commit || 'HEAD'
      return await git.show([commit, '--stat'])
    },
  }),
  defineTool({
    name: 'git_branch',
    category: 'git',
    description: 'List branches (local and optionally remote)',
    schema: gitBranchSchema,
    async execute(args, context) {
      const git = simpleGit(context.projectPath)
      const branches = await git.branch(args.all ? ['-a'] : [])
      const current = branches.current
      return branches.all.map((b: string) => `${b === current ? '* ' : '  '}${b}`).join('\n')
    },
  }),
]

// ============ Factory tools (path-bound, for sandbox) ============

export const createGitTools = (projectPath: string): Tool[] => {
  const git = simpleGit(projectPath)

  return [
    defineTool({
      name: 'git_status',
      category: 'git',
      description: 'Get the current git status',
      schema: emptySchema,
      async execute() {
        const status = await git.status()
        return JSON.stringify(
          {
            branch: status.current,
            ahead: status.ahead,
            behind: status.behind,
            staged: status.staged,
            modified: status.modified,
            untracked: status.not_added,
            conflicted: status.conflicted,
          },
          null,
          2,
        )
      },
    }),
    defineTool({
      name: 'git_diff',
      category: 'git',
      description: 'Get the current git diff',
      schema: gitDiffSchema,
      async execute(args) {
        const options: string[] = []
        if (args.staged) options.push('--staged')
        if (args.file) options.push('--', args.file)

        const diff = await git.diff(options)
        return diff || 'No changes'
      },
    }),
    defineTool({
      name: 'git_log',
      category: 'git',
      description: 'Get recent git commits',
      schema: gitLogSchema,
      async execute(args) {
        const logArgs: string[] = [`-n${args.count || 10}`, '--pretty=format:%h | %ai | %an: %s']
        if (args.author) logArgs.push(`--author=${args.author}`)
        if (args.grep) logArgs.push(`--grep=${args.grep}`)
        if (args.ref) logArgs.push(args.ref)
        const result = await git.raw(['log', ...logArgs])
        return result || 'No commits found'
      },
    }),
    defineTool({
      name: 'git_show',
      category: 'git',
      description: 'Show details of a specific commit',
      schema: gitShowSchema,
      async execute(args) {
        const commit = args.commit || 'HEAD'
        const show = await git.show([commit])
        return show
      },
    }),
    defineTool({
      name: 'git_branch',
      category: 'git',
      description: 'List or manage branches',
      schema: gitBranchSchema,
      async execute(args) {
        const branches = await git.branch(args.all ? ['-a'] : [])
        const current = branches.current

        return branches.all.map((b: string) => `${b === current ? '* ' : '  '}${b}`).join('\n')
      },
    }),
    defineTool({
      name: 'git_checkout_branch',
      category: 'git',
      description: 'Create and checkout a new branch',
      schema: gitCheckoutBranchSchema,
      async execute(args) {
        if (args.base) {
          await git.checkout(args.base)
        }

        await git.checkoutLocalBranch(args.branch)
        return `Created and checked out branch: ${args.branch}`
      },
    }),
    defineTool({
      name: 'git_switch',
      category: 'git',
      description: 'Switch to an existing branch',
      schema: gitSwitchSchema,
      async execute(args) {
        await git.checkout(args.branch)
        return `Switched to branch: ${args.branch}`
      },
    }),
    defineTool({
      name: 'git_add',
      category: 'git',
      description: 'Stage files for commit',
      schema: gitAddSchema,
      async execute(args) {
        const files = args.files || '.'
        await git.add(files)
        return `Staged: ${files}`
      },
    }),
    defineTool({
      name: 'git_commit',
      category: 'git',
      description: 'Create a commit with the staged changes',
      schema: gitCommitSchema,
      async execute(args) {
        const options: string[] = []
        if (args.add) options.push('-a')

        const result = await git.commit(args.message, options)
        return `Committed: ${result.commit} - ${args.message}`
      },
    }),
    defineTool({
      name: 'git_push',
      category: 'git',
      description: 'Push current branch to remote',
      schema: gitPushSchema,
      async execute(args) {
        const branch = (await git.branch()).current
        const options: string[] = ['--set-upstream', 'origin', branch]
        if (args.force) options.push('--force-with-lease')

        await git.push(options)
        return `Pushed branch: ${branch}`
      },
    }),
    defineTool({
      name: 'git_pull',
      category: 'git',
      description: 'Pull latest changes from remote',
      schema: gitPullSchema,
      async execute(args) {
        if (args.rebase) {
          await git.pull(['--rebase'])
        } else {
          await git.pull()
        }
        return 'Pulled latest changes'
      },
    }),
    defineTool({
      name: 'git_stash',
      category: 'git',
      description: 'Stash current changes',
      schema: gitStashSchema,
      async execute(args) {
        if (args.pop) {
          await git.stash(['pop'])
          return 'Popped stash'
        } else if (args.message) {
          await git.stash(['push', '-m', args.message])
          return `Stashed changes: ${args.message}`
        } else {
          await git.stash(['push'])
          return 'Stashed changes'
        }
      },
    }),
  ]
}
