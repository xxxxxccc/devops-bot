/**
 * Project Scanner — scans the target project for context and rules.
 *
 * Reads package.json, README, recursive directory tree, and AGENTS.md/CLAUDE.md
 * so both Layer 1 (dispatcher) and Layer 2 (executor) know what they're working with.
 * Results are cached after the first scan.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createLogger } from '../infra/logger.js'

const log = createLogger('scanner')

/** Directories to skip during recursive scanning */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  '.output',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

export class ProjectScanner {
  /** Cached context string — scanned once, then reused */
  private contextCache: string | null = null
  /** Cached project rules content — scanned once, then reused */
  private rulesCache: string | null = null

  /* ---------------------------------------------------------------- */
  /*  Project context (package.json, README, directory tree)           */
  /* ---------------------------------------------------------------- */

  /**
   * Return a markdown-formatted project overview.
   * Includes package.json highlights, README excerpt, and directory tree.
   */
  getProjectContext(projectPath: string | undefined): string {
    if (this.contextCache !== null) return this.contextCache

    if (!projectPath) {
      this.contextCache = ''
      return ''
    }

    const parts: string[] = []
    const projectName = basename(projectPath)
    parts.push(`## Target Project: ${projectName}`)
    parts.push(`Path: ${projectPath}`)

    this.appendPackageInfo(parts, projectPath)
    this.appendReadme(parts, projectPath)
    this.appendDirectoryTree(parts, projectPath)

    this.contextCache = parts.join('\n')
    log.info(`Context scanned (${this.contextCache.length} chars)`)
    return this.contextCache
  }

  /* ---------------------------------------------------------------- */
  /*  Project rules (AGENTS.md / CLAUDE.md)                            */
  /* ---------------------------------------------------------------- */

  /**
   * Read the target project's AGENTS.md or CLAUDE.md (whichever exists first).
   * Returns the raw content string, or empty string if neither exists.
   */
  getProjectRules(projectPath: string | undefined): string {
    if (this.rulesCache !== null) return this.rulesCache

    if (!projectPath) {
      this.rulesCache = ''
      return ''
    }

    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const content = readFileSync(join(projectPath, name), 'utf-8')
        if (content.trim()) {
          this.rulesCache = content.trim()
          log.info(`Loaded project rules from ${name} (${this.rulesCache.length} chars)`)
          return this.rulesCache
        }
      } catch {
        // Try next name
      }
    }

    this.rulesCache = ''
    log.info('No AGENTS.md or CLAUDE.md found in target project')
    return ''
  }

  /* ---------------------------------------------------------------- */
  /*  Private helpers                                                  */
  /* ---------------------------------------------------------------- */

  private appendPackageInfo(parts: string[], projectPath: string): void {
    try {
      const pkgRaw = readFileSync(join(projectPath, 'package.json'), 'utf-8')
      const pkg = JSON.parse(pkgRaw)
      const info: string[] = []
      if (pkg.name) info.push(`Name: ${pkg.name}`)
      if (pkg.version) info.push(`Version: ${pkg.version}`)
      if (pkg.description) info.push(`Description: ${pkg.description}`)
      if (pkg.scripts) {
        info.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`)
      }

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      const depNames = Object.keys(allDeps)
      if (depNames.length > 0) {
        const keyDeps = depNames.filter((d) =>
          /^(react|vue|angular|next|nuxt|electron|express|fastify|nest|typescript|vite|webpack|tailwind|prisma|drizzle)/i.test(
            d,
          ),
        )
        info.push(`Key Dependencies: ${keyDeps.join(', ') || '(none detected)'}`)
        info.push(`Total Dependencies: ${depNames.length}`)
      }
      parts.push('\n### package.json')
      parts.push(info.join('\n'))
    } catch {
      // No package.json or not a Node project
    }
  }

  private appendReadme(parts: string[], projectPath: string): void {
    for (const name of ['README.md', 'readme.md', 'README.rst', 'README']) {
      try {
        const readme = readFileSync(join(projectPath, name), 'utf-8')
        const truncated =
          readme.length > 1500 ? `${readme.slice(0, 1500)}\n... (truncated)` : readme
        parts.push(`\n### ${name}`)
        parts.push(truncated)
        break
      } catch {
        // Try next name
      }
    }
  }

  private appendDirectoryTree(parts: string[], projectPath: string): void {
    try {
      const tree = ProjectScanner.scanDirectory(projectPath, 3)
      if (tree.length > 0) {
        parts.push('\n### Directory Structure')
        parts.push(tree.join('\n'))
      }
    } catch {
      // Can't read directory
    }
  }

  /**
   * Recursively scan a directory and return an indented tree of file/folder names.
   * Skips hidden files, node_modules, and common non-source directories.
   */
  static scanDirectory(dirPath: string, maxDepth: number, depth = 0): string[] {
    if (depth >= maxDepth) return []

    const lines: string[] = []
    const indent = '  '.repeat(depth)

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`)
          lines.push(
            ...ProjectScanner.scanDirectory(join(dirPath, entry.name), maxDepth, depth + 1),
          )
        } else {
          lines.push(`${indent}${entry.name}`)
        }
      }
    } catch {
      // Permission denied or other read error
    }

    return lines
  }
}
