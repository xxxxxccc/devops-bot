/**
 * Processor Pipeline types.
 *
 * An ordered chain of Processor objects that each contribute sections to the
 * prompt context. Replaces monolithic prompt-building functions with a modular,
 * extensible architecture.
 */

import type { Attachment } from '../channels/types.js'
import type { SkillEntry } from '../prompt/skill-scanner.js'

export type PipelineRole = 'dispatcher' | 'executor' | 'reviewer'

export interface PromptSection {
  id: string
  content: string
  priority: number
}

export interface BudgetTracker {
  totalChars: number
  usedChars: number
  remaining: number
}

export interface PipelineContext {
  role: PipelineRole
  chatId?: string
  projectPath: string
  userMessage?: string
  attachments?: Attachment[]

  systemSections: PromptSection[]
  userSections: PromptSection[]

  budget: BudgetTracker

  /** Shared state — processors can read/write arbitrary data */
  state: Map<string, unknown>
}

export interface Processor {
  id: string
  order: number
  roles: PipelineRole[]
  process(ctx: PipelineContext): Promise<PipelineContext>
}

export interface PipelineResult {
  system: string
  user: string
}

/**
 * Typed state accessors for well-known pipeline state keys.
 */
export function getStateValue<T>(ctx: PipelineContext, key: string): T | undefined {
  return ctx.state.get(key) as T | undefined
}

export function setStateValue<T>(ctx: PipelineContext, key: string, value: T): void {
  ctx.state.set(key, value)
}

export interface DispatcherPipelineInput {
  role: 'dispatcher'
  projectPath: string
  chatId?: string
  userMessage: string
  attachments?: Attachment[]
  projectRules: string
  memoryAvailable: boolean

  projectContext?: string
  memorySummary?: string
  detailedMemoryContext?: string
  chatProjects?: Array<{ id: string; gitUrl: string; lastUsed: string }>
  workspaces?: Array<{
    id: string
    context: string
    projects: Array<{
      id: string
      gitUrl: string
      branch: string
      lang?: string
      description?: string
      cloned: boolean
    }>
  }>
  recentChat?: Array<{ role: string; content: string; senderName?: string }>
  senderName?: string
}

export interface ExecutorPipelineInput {
  role: 'executor'
  projectPath: string
  projectRules: string
  taskHasJira: boolean
  taskHasFigma: boolean
  skills?: SkillEntry[]
  sandbox?: { branchName: string; baseBranch: string; submodules?: string[] }
  language?: string
}
