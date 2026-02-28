/**
 * Git 操作工具集
 * 使用 Zod schema 定义参数
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

// ============ Tools Factory ============

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
        const log = await git.log({
          maxCount: args.count || 10,
          ...(args.author ? { author: args.author } : {}),
          ...(args.grep ? { grep: args.grep } : {}),
        })

        return log.all
          .map(
            (c: { hash: string; date: string; author_name: string; message: string }) =>
              `${c.hash.slice(0, 7)} | ${c.date} | ${c.author_name}: ${c.message}`,
          )
          .join('\n')
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
