import type { Processor } from '../types.js'

interface ChatProject {
  id: string
  gitUrl: string
  lastUsed: string
}

interface WorkspaceProjectEntry {
  id: string
  gitUrl: string
  branch: string
  lang?: string
  description?: string
  cloned: boolean
}

interface WorkspaceEntry {
  id: string
  context: string
  projects: WorkspaceProjectEntry[]
}

function formatTimeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Injects project list and workspace context into the user prompt.
 * State keys: chatProjects, workspaces
 */
export const WorkspaceProcessor: Processor = {
  id: 'workspace',
  order: 50,
  roles: ['dispatcher'],
  async process(ctx) {
    const chatProjects = (ctx.state.get('chatProjects') as ChatProject[]) || []
    const workspaces = (ctx.state.get('workspaces') as WorkspaceEntry[]) || []
    const hasWorkspaces = workspaces.length > 0
    const parts: string[] = []

    if (chatProjects.length > 0) {
      parts.push('\n## Projects in this chat')
      for (let i = 0; i < chatProjects.length; i++) {
        const p = chatProjects[i]
        const ago = formatTimeAgo(p.lastUsed)
        parts.push(`${i + 1}. \`${p.id}\` (last used: ${ago})`)
      }
      if (chatProjects.length === 1 && !hasWorkspaces) {
        parts.push('\nOnly one project — auto-select it for all intents.')
      }
    } else if (!ctx.projectPath && !hasWorkspaces) {
      parts.push(
        '\n## Projects in this chat',
        'No projects bound. Tell the user to add one with "add project <git URL>" or "add workspace <git URL>".',
      )
    }

    if (hasWorkspaces) {
      for (const ws of workspaces) {
        const wsRepo = ws.id.replace(/^github\.com\//, '')
        parts.push(`\n## Workspace: ${ws.id} (repo: ${wsRepo})`)
        parts.push(
          `To query this workspace repo's issues/PRs, use the \`repo\` parameter: \`"repo": "${wsRepo}"\``,
        )

        if (ws.projects.length > 0) {
          parts.push('\n### Available Sub-Projects')
          parts.push(
            '| ID | Language | Branch | Status | Git URL | Description |',
            '|----|----------|--------|--------|---------|-------------|',
          )
          for (const p of ws.projects) {
            const status = p.cloned ? 'cloned' : 'not yet cloned'
            parts.push(
              `| ${p.id} | ${p.lang || '-'} | ${p.branch} | ${status} | ${p.gitUrl} | ${p.description || '-'} |`,
            )
          }
          parts.push(
            '',
            'When targeting a sub-project, include `targetGitUrl` and `targetBranch` in your response.',
            'The system will clone it on demand if not yet available locally.',
          )
        }

        if (ws.context) {
          const truncated =
            ws.context.length > 4000 ? `${ws.context.slice(0, 4000)}\n... [truncated]` : ws.context
          parts.push('\n### Workspace Guidelines', '', truncated)
        }
      }
    }

    if (parts.length > 0) {
      ctx.userSections.push({ id: 'workspace', content: parts.join('\n'), priority: 50 })
    }
    return ctx
  },
}
