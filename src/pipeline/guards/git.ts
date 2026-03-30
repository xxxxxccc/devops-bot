import { TripWire } from '../tripwire.js'
import type { ToolGuard } from '../tripwire.js'

const PROTECTED_BRANCHES = new Set(['main', 'master', 'production', 'release'])

/**
 * Block dangerous git operations: force push, branch deletion on protected branches.
 */
export const GitGuard: ToolGuard = {
  id: 'git',
  check(toolName: string, args: Record<string, unknown>) {
    const shortName = toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName
    if (shortName !== 'shell_exec') return

    const command = (args.command as string) || ''
    if (!command.startsWith('git')) return

    if (/git\s+push\s+.*--force/.test(command) || /git\s+push\s+-f\b/.test(command)) {
      throw new TripWire(
        'Force push is blocked by safety guard. Use regular push or create a new branch.',
        { retry: true, maxRetries: 1 },
        'git',
      )
    }

    const branchDeleteMatch = command.match(/git\s+branch\s+-[dD]\s+(\S+)/)
    if (branchDeleteMatch) {
      const branch = branchDeleteMatch[1]
      if (PROTECTED_BRANCHES.has(branch)) {
        throw new TripWire(
          `Deleting protected branch "${branch}" is blocked by safety guard.`,
          { retry: false },
          'git',
        )
      }
    }

    const pushDeleteMatch = command.match(/git\s+push\s+\S+\s+:(\S+)/)
    if (pushDeleteMatch) {
      const branch = pushDeleteMatch[1]
      if (PROTECTED_BRANCHES.has(branch)) {
        throw new TripWire(
          `Deleting remote protected branch "${branch}" is blocked by safety guard.`,
          { retry: false },
          'git',
        )
      }
    }
  },
}
