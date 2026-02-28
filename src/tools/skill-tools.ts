/**
 * Skill Management Tools
 *
 * Tools for finding and installing skills from the open agent skills ecosystem.
 * These tools use `npx skills` CLI under the hood.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'
import { type Tool, defineTool } from '../core/types.js'
import { createLogger } from '../infra/logger.js'

const log = createLogger('skill-tools')

// ============ Constants ============

/** Default skills directory relative to the project root */
const SKILLS_DIR = 'skills'

// ============ Schemas ============

const findSkillsSchema = z.object({
  query: z.string().describe('Search query to find skills (e.g., "react", "testing", "design")'),
})

const listInstalledSkillsSchema = z.object({})

const installSkillSchema = z.object({
  source: z
    .string()
    .describe(
      'Skill source - can be: 1) skill name from skills.sh (e.g., "vercel-labs/skills/react-best-practices"), 2) GitHub repo path (e.g., "owner/repo/path/to/skill"), or 3) full GitHub URL',
    ),
  name: z
    .string()
    .optional()
    .describe('Optional custom name for the installed skill (defaults to skill name from source)'),
})

const createSkillSchema = z.object({
  name: z
    .string()
    .describe(
      'Skill name in kebab-case (e.g., "react-best-practices", "api-error-handling"). This will be the directory name.',
    ),
  description: z
    .string()
    .describe(
      'One-line description of what this skill does and when to use it. This is crucial for the AI to decide when to load the skill.',
    ),
  content: z
    .string()
    .describe(
      'The main content/instructions of the skill in Markdown format. Include: when to apply, step-by-step guidance, code examples, and pitfalls to avoid.',
    ),
})

// ============ Helpers ============

/**
 * Get the skills directory path for a project
 */
function getSkillsDir(projectPath: string): string {
  return join(projectPath, SKILLS_DIR)
}

/**
 * Ensure the skills directory exists
 */
function ensureSkillsDir(projectPath: string): string {
  const skillsDir = getSkillsDir(projectPath)
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }
  return skillsDir
}

/**
 * Run `npx skills find` command and return results
 */
async function runSkillsFind(query: string): Promise<string> {
  try {
    // Use spawn for better control over the process
    return new Promise((resolve, reject) => {
      const child = spawn('npx', ['skills', 'find', query], {
        timeout: 30000,
        shell: true,
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout || 'No skills found matching your query.')
        } else {
          // Even if exit code is non-zero, return stdout if available
          if (stdout) {
            resolve(stdout)
          } else {
            reject(new Error(stderr || `Command exited with code ${code}`))
          }
        }
      })

      child.on('error', (err) => {
        reject(err)
      })
    })
  } catch (error) {
    log.error('Failed to run skills find', { query, error })
    throw new Error(
      `Failed to search for skills: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Install a skill using `npx skills add`
 */
async function runSkillsAdd(source: string, targetDir: string): Promise<string> {
  try {
    log.info('Installing skill', { source, targetDir })

    return new Promise((resolve, reject) => {
      // npx skills add <source> --path <targetDir>
      const child = spawn('npx', ['skills', 'add', source, '--path', targetDir], {
        timeout: 60000,
        shell: true,
        cwd: targetDir,
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout || 'Skill installed successfully.')
        } else {
          // Check if there's useful output despite non-zero exit
          if ((stdout && stdout.includes('installed')) || stdout.includes('success')) {
            resolve(stdout)
          } else {
            reject(new Error(stderr || stdout || `Installation failed with code ${code}`))
          }
        }
      })

      child.on('error', (err) => {
        reject(err)
      })
    })
  } catch (error) {
    log.error('Failed to install skill', { source, error })
    throw new Error(
      `Failed to install skill: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Parse skill source to extract the skill name
 */
function extractSkillName(source: string): string {
  // Handle various formats:
  // - "vercel-labs/skills/react-best-practices" -> "react-best-practices"
  // - "https://github.com/owner/repo/tree/main/skills/my-skill" -> "my-skill"
  // - "owner/repo/skills/my-skill" -> "my-skill"

  // Remove URL parts
  const path = source
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/^skills\.sh\//, '')
    .replace(/\/tree\/[^/]+\//, '/')

  // Get the last segment
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] || 'unknown-skill'
}

/**
 * List installed skills in the project
 */
function listInstalledSkills(projectPath: string): { name: string; description: string }[] {
  const skillsDir = getSkillsDir(projectPath)
  if (!existsSync(skillsDir)) {
    return []
  }

  const skills: { name: string; description: string }[] = []

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(skillsDir, entry.name, 'SKILL.md')
        if (existsSync(skillMdPath)) {
          const content = readFileSync(skillMdPath, 'utf-8')
          // Parse YAML frontmatter
          const match = content.match(/^---\n([\s\S]*?)\n---/)
          let description = 'No description'
          if (match) {
            const descMatch = match[1].match(/description:\s*(.+)/)
            if (descMatch) {
              description = descMatch[1].trim()
            }
          }
          skills.push({ name: entry.name, description })
        }
      }
    }
  } catch (error) {
    log.error('Failed to list skills', { error })
  }

  return skills
}

// ============ Tools ============

export const findSkillsTool = defineTool({
  name: 'find_skills',
  category: 'skill',
  description:
    'Search for available skills in the open agent skills ecosystem. Use this when user asks to find, search, or discover skills for specific use cases.',
  schema: findSkillsSchema,
  async execute(args) {
    const result = await runSkillsFind(args.query)
    return result
  },
})

export const listInstalledSkillsTool = defineTool({
  name: 'list_installed_skills',
  category: 'skill',
  description: 'List all skills currently installed in the project.',
  schema: listInstalledSkillsSchema,
  async execute(_args, context) {
    const skills = listInstalledSkills(context.projectPath)

    if (skills.length === 0) {
      return 'No skills installed yet. Use install_skill to add skills to the project.'
    }

    const lines = ['Installed skills:', '']
    for (const skill of skills) {
      lines.push(`- **${skill.name}**: ${skill.description}`)
    }
    return lines.join('\n')
  },
})

export const installSkillTool = defineTool({
  name: 'install_skill',
  category: 'skill',
  description:
    'Install a skill from the skills.sh ecosystem or GitHub. Use this when user provides a skills.sh link, GitHub path, or asks to install a known external skill.',
  schema: installSkillSchema,
  async execute(args, context) {
    const skillsDir = ensureSkillsDir(context.projectPath)
    const skillName = args.name || extractSkillName(args.source)
    const targetPath = join(skillsDir, skillName)

    // Check if skill already exists
    if (existsSync(targetPath)) {
      return `Skill "${skillName}" is already installed at ${targetPath}. To reinstall, please remove it first.`
    }

    // Create target directory
    mkdirSync(targetPath, { recursive: true })

    try {
      const result = await runSkillsAdd(args.source, skillsDir)
      log.info('Skill installed successfully', { skillName, targetPath })

      // Verify installation
      const skillMdPath = join(targetPath, 'SKILL.md')
      if (existsSync(skillMdPath)) {
        return `✅ Skill "${skillName}" installed successfully at ${targetPath}\n\nThe skill is now available for the executor to use when relevant tasks are processed.\n\nInstallation output:\n${result}`
      }

      return `Skill installation completed. Output:\n${result}`
    } catch (error) {
      // Clean up failed installation
      try {
        const { rmSync } = await import('node:fs')
        rmSync(targetPath, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
      throw error
    }
  },
})

export const createSkillTool = defineTool({
  name: 'create_skill',
  category: 'skill',
  description:
    'Create a custom skill from scratch. Use this when: 1) user wants to summarize past conversations/decisions into a skill, 2) user provides SKILL.md-like content to add, 3) user describes a workflow or guideline they want to codify. IMPORTANT: Before calling, first read skills/skill-creator/SKILL.md for best practices if it exists. Only call when you have ALL required info (name, description with WHAT+WHEN triggers, content). If info is incomplete, ask user first.',
  schema: createSkillSchema,
  async execute(args, context) {
    const skillsDir = ensureSkillsDir(context.projectPath)

    // Validate name format (kebab-case)
    const namePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
    if (!namePattern.test(args.name)) {
      return `Invalid skill name "${args.name}". Please use kebab-case (e.g., "react-best-practices", "api-error-handling").`
    }

    const targetPath = join(skillsDir, args.name)

    // Check if skill already exists
    if (existsSync(targetPath)) {
      return `Skill "${args.name}" already exists at ${targetPath}. Choose a different name or remove the existing skill first.`
    }

    // Build SKILL.md content
    const skillMdContent = buildSkillMdContent(args.name, args.description, args.content)

    // Create skill directory and file
    try {
      mkdirSync(targetPath, { recursive: true })
      const skillMdPath = join(targetPath, 'SKILL.md')
      writeFileSync(skillMdPath, skillMdContent, 'utf-8')

      log.info('Custom skill created', { name: args.name, path: targetPath })

      return `✅ Skill "${args.name}" created successfully at ${targetPath}

**Description:** ${args.description}

The skill is now available for the Task AI executor. It will be automatically loaded when processing relevant tasks.

You can view or edit the skill at: \`${skillMdPath}\``
    } catch (error) {
      // Clean up on failure
      try {
        const { rmSync } = await import('node:fs')
        rmSync(targetPath, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(
        `Failed to create skill: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
})

/**
 * Build SKILL.md content with proper frontmatter
 */
function buildSkillMdContent(name: string, description: string, content: string): string {
  // Check if content already has frontmatter
  if (content.trim().startsWith('---')) {
    // Content already has frontmatter, use as-is but ensure name/description are set
    const frontmatterEnd = content.indexOf('---', 3)
    if (frontmatterEnd !== -1) {
      const frontmatter = content.slice(3, frontmatterEnd).trim()
      const body = content.slice(frontmatterEnd + 3).trim()

      // Parse existing frontmatter and merge with provided values
      const hasName = /^name:/m.test(frontmatter)
      const hasDesc = /^description:/m.test(frontmatter)

      let newFrontmatter = frontmatter
      if (!hasName) {
        newFrontmatter = `name: ${name}\n${newFrontmatter}`
      }
      if (!hasDesc) {
        newFrontmatter = `${newFrontmatter}\ndescription: ${description}`
      }

      return `---\n${newFrontmatter}\n---\n\n${body}`
    }
  }

  // Build new SKILL.md with frontmatter
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${toTitleCase(name)}`,
    '',
    content.trim(),
    '',
  ]

  return lines.join('\n')
}

/**
 * Convert kebab-case to Title Case
 */
function toTitleCase(str: string): string {
  return str
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ============ Export ============

export const skillTools: Tool[] = [
  findSkillsTool,
  listInstalledSkillsTool,
  installSkillTool,
  createSkillTool,
]
