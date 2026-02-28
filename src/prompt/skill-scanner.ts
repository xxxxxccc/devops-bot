/**
 * Skill Scanner — discovers bundled skills from the skills/ directory.
 *
 * Each skill is a subdirectory containing a SKILL.md with YAML frontmatter
 * (name + description). Only metadata is extracted; full content is loaded
 * on demand by the executor via read_file.
 *
 * Results are cached after the first scan.
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
}

export class SkillScanner {
  private cache: SkillEntry[] | null = null

  /**
   * Scan the bundled skills/ directory and extract metadata.
   * @param projectRoot  Root of the devops-bot installation (contains skills/)
   */
  getSkills(projectRoot: string): SkillEntry[] {
    if (this.cache !== null) return this.cache

    const skillsDir = join(projectRoot, 'skills')
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
            })
          } else {
            log.warn(`Skipping skill ${dir.name}: missing name or description in frontmatter`)
          }
        } catch {
          // SKILL.md doesn't exist or is unreadable — skip silently
        }
      }
    } catch {
      // skills/ directory doesn't exist — that's fine, return empty
    }

    this.cache = entries
    if (entries.length > 0) {
      log.info(`Loaded ${entries.length} skill(s): ${entries.map((s) => s.name).join(', ')}`)
    }
    return entries
  }
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
