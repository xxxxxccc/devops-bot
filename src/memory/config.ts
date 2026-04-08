/**
 * Per-project memory extraction configuration.
 *
 * Reads `.devops-bot.json` from the project root to load custom
 * extraction prompts and memory types. Caches results per path.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../infra/logger.js'
import type { MemoryExtractionConfig } from './types.js'

const log = createLogger('memory-config')

/** Cache to avoid re-reading config files */
const configCache = new Map<string, MemoryExtractionConfig | null>()

/**
 * Load memory extraction config for a project.
 *
 * Reads `{projectPath}/.devops-bot.json` and extracts the `memory` key.
 * Returns null if the file doesn't exist or has no memory config.
 * Results are cached per project path.
 */
export function loadExtractionConfig(projectPath: string): MemoryExtractionConfig | null {
  if (configCache.has(projectPath)) {
    return configCache.get(projectPath)!
  }

  let config: MemoryExtractionConfig | null = null
  try {
    const configPath = join(projectPath, '.devops-bot.json')
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    if (parsed.memory && typeof parsed.memory === 'object') {
      const mem = parsed.memory as Record<string, unknown>
      config = {}

      if (Array.isArray(mem.customTypes)) {
        config.customTypes = mem.customTypes.filter(
          (t: unknown) =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as Record<string, unknown>).name === 'string' &&
            typeof (t as Record<string, unknown>).description === 'string',
        ) as MemoryExtractionConfig['customTypes']
      }
      if (typeof mem.conversationPrompt === 'string') {
        config.conversationPrompt = mem.conversationPrompt
      }
      if (typeof mem.taskResultPrompt === 'string') {
        config.taskResultPrompt = mem.taskResultPrompt
      }
      if (Array.isArray(mem.extractTypes)) {
        config.extractTypes = mem.extractTypes.filter(
          (t: unknown) => typeof t === 'string',
        ) as string[]
      }

      log.debug(`Loaded memory config from ${configPath}`, {
        customTypes: config.customTypes?.length ?? 0,
        hasConversationPrompt: !!config.conversationPrompt,
        hasTaskResultPrompt: !!config.taskResultPrompt,
      })
    }
  } catch {
    // File doesn't exist or is invalid — use defaults
  }

  configCache.set(projectPath, config)
  return config
}

/** Clear the config cache (for testing or hot-reload). */
export function clearConfigCache(): void {
  configCache.clear()
}

/* ------------------------------------------------------------------ */
/*  Default type instructions                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_TYPES = [
  { name: 'decision', description: 'Technical decisions made (what was chosen, why)' },
  { name: 'context', description: 'Project context learned (architecture, conventions)' },
  { name: 'preference', description: 'User preferences discovered (code style, tools)' },
  { name: 'issue', description: 'Problems or issues mentioned (bugs, tech debt)' },
]

/**
 * Build the type instruction section for extraction prompts.
 * Merges built-in types with any custom types from config.
 */
export function buildTypeInstructions(config: MemoryExtractionConfig | null): string {
  const customTypes = config?.customTypes || []
  const allTypes = [...DEFAULT_TYPES, ...customTypes]
  const activeTypes = config?.extractTypes
    ? allTypes.filter((t) => config.extractTypes!.includes(t.name))
    : allTypes
  return activeTypes.map((t) => `- "${t.name}": ${t.description}`).join('\n')
}
