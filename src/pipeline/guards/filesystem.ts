import { resolve } from 'node:path'
import { TripWire } from '../tripwire.js'
import type { ToolGuard } from '../tripwire.js'

/**
 * Block file writes outside the sandbox/project path.
 * The sandbox path must be set via setSandboxPath() before use.
 */
class FileSystemGuardImpl implements ToolGuard {
  id = 'filesystem'
  private sandboxPath: string | null = null

  setSandboxPath(path: string): void {
    this.sandboxPath = resolve(path)
  }

  check(toolName: string, args: Record<string, unknown>): void {
    if (!this.sandboxPath) return

    const writeMethods = new Set(['write_file', 'edit_file', 'delete_file', 'shell_exec'])

    const shortName = toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName
    if (!writeMethods.has(shortName)) return

    const filePath = (args.path || args.file_path || args.filepath) as string | undefined
    if (!filePath) return

    const resolved = resolve(filePath)
    if (!resolved.startsWith(this.sandboxPath)) {
      throw new TripWire(
        `File operation blocked: "${resolved}" is outside the sandbox "${this.sandboxPath}".`,
        { retry: true, maxRetries: 2 },
        'filesystem',
      )
    }
  }
}

export const FileSystemGuard = new FileSystemGuardImpl()
