/**
 * Skill Scanner — discovers skills from multiple directories.
 *
 * Scans two sources with priority-based merging:
 *   1. Bundled skills  (devops-bot install dir / skills/)  — lower priority
 *   2. Project skills  (TARGET_PROJECT_PATH / skills/)     — higher priority
 *
 * When the same skill name exists in both, the project version wins.
 * Only metadata (name + description) is extracted; full SKILL.md is loaded
 * on demand by the executor via read_file.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../infra/logger.js'

const log = createLogger('skill-scanner')

export interface SkillEntry {
  /** Unique skill identifier (directory name / frontmatter name) */
  name: string
  /** One-line description shown in the executor prompt */
  description: string
  /** Absolute path to SKILL.md (executor reads this on demand) */
  location: string
  /** Where this skill was loaded from */
  source: 'bundled' | 'project'
}

export class SkillScanner {
  private cache: SkillEntry[] | null = null

  /**
   * Scan skills from bundled + project directories and merge by priority.
   * @param bundledRoot  Root of the devops-bot installation (contains skills/)
   * @param projectPath  Root of the target project (optional, may also contain skills/)
   */
  getSkills(bundledRoot: string, projectPath?: string): SkillEntry[] {
    if (this.cache !== null) return this.cache

    const merged = new Map<string, SkillEntry>()

    for (const entry of scanDir(join(bundledRoot, 'skills'), 'bundled')) {
      merged.set(entry.name, entry)
    }

    if (projectPath) {
      for (const entry of scanDir(join(projectPath, 'skills'), 'project')) {
        merged.set(entry.name, entry)
      }
    }

    const entries = [...merged.values()]
    this.cache = entries

    if (entries.length > 0) {
      const bundled = entries.filter((s) => s.source === 'bundled').length
      const project = entries.filter((s) => s.source === 'project').length
      log.info(`Loaded ${entries.length} skill(s): ${bundled} bundled, ${project} project`)
    }
    return entries
  }

  invalidateCache(): void {
    this.cache = null
  }
}

/* ------------------------------------------------------------------ */
/*  Directory scanner                                                   */
/* ------------------------------------------------------------------ */

function scanDir(skillsDir: string, source: SkillEntry['source']): SkillEntry[] {
  const entries: SkillEntry[] = []
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && !d.name.startsWith('.'),
    )

    for (const dir of dirs) {
      const skillMdPath = join(skillsDir, dir.name, 'SKILL.md')
      try {
        const content = readFileSync(skillMdPath, 'utf-8')
        const meta = parseFrontmatter(content)
        if (meta.name && meta.description) {
          entries.push({
            name: meta.name,
            description: meta.description,
            location: skillMdPath,
            source,
          })
        } else {
          log.warn(`Skipping skill ${dir.name}: missing name or description in frontmatter`)
        }
      } catch {
        // SKILL.md doesn't exist or is unreadable — skip silently
      }
    }
  } catch {
    // directory doesn't exist — that's fine
  }
  return entries
}

/* ------------------------------------------------------------------ */
/*  Frontmatter parser                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extract `name` and `description` from YAML frontmatter (--- delimited).
 * Intentionally minimal — no external YAML dependency.
 */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const yaml = match[1]
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description }
}
