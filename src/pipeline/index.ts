/**
 * Processor Pipeline — modular prompt assembly.
 *
 * Opt-in via USE_PROCESSOR_PIPELINE=true. When disabled, existing prompt
 * builders are used unchanged.
 */

export { ProcessorPipeline } from './runner.js'
export { extractWorkingMemoryUpdate } from './processors/working-memory.js'
export type {
  PipelineContext,
  PipelineResult,
  PipelineRole,
  Processor,
  PromptSection,
  BudgetTracker,
  DispatcherPipelineInput,
  ExecutorPipelineInput,
} from './types.js'

import { ProcessorPipeline } from './runner.js'
import type { DispatcherPipelineInput, ExecutorPipelineInput, PipelineResult } from './types.js'
import { IdentityProcessor } from './processors/identity.js'
import { SafetyProcessor } from './processors/safety.js'
import { ProjectRulesProcessor } from './processors/project-rules.js'
import { MemoryProcessor } from './processors/memory.js'
import { WorkspaceProcessor } from './processors/workspace.js'
import { ConversationProcessor } from './processors/conversation.js'
import { SkillsProcessor } from './processors/skills.js'
import { SandboxProcessor } from './processors/sandbox.js'
import { ToolsProcessor } from './processors/tools.js'
import { IntegrationProcessor } from './processors/integration.js'
import { LanguageProcessor } from './processors/language.js'
import { AttachmentProcessor } from './processors/attachment.js'
import { WorkingMemoryProcessor } from './processors/working-memory.js'

export function isPipelineEnabled(): boolean {
  return process.env.USE_PROCESSOR_PIPELINE === 'true'
}

const ALL_PROCESSORS = [
  IdentityProcessor,
  SafetyProcessor,
  ProjectRulesProcessor,
  MemoryProcessor,
  WorkspaceProcessor,
  ConversationProcessor,
  WorkingMemoryProcessor,
  SkillsProcessor,
  SandboxProcessor,
  ToolsProcessor,
  IntegrationProcessor,
  LanguageProcessor,
  AttachmentProcessor,
]

let _pipeline: ProcessorPipeline | null = null

export function getDefaultPipeline(): ProcessorPipeline {
  if (!_pipeline) {
    _pipeline = new ProcessorPipeline()
    _pipeline.registerAll(ALL_PROCESSORS)
  }
  return _pipeline
}

/**
 * Build dispatcher prompts via the processor pipeline.
 */
export async function buildDispatcherPromptsViaPipeline(
  input: DispatcherPipelineInput,
): Promise<PipelineResult> {
  const pipeline = getDefaultPipeline()
  const state = new Map<string, unknown>()

  state.set('projectRules', input.projectRules)
  state.set('memoryAvailable', input.memoryAvailable)
  state.set('projectContext', input.projectContext)
  state.set('memorySummary', input.memorySummary)
  state.set('detailedMemoryContext', input.detailedMemoryContext)
  state.set('chatProjects', input.chatProjects)
  state.set('workspaces', input.workspaces)
  state.set('recentChat', input.recentChat)
  state.set('senderName', input.senderName)

  return pipeline.run({
    role: 'dispatcher',
    projectPath: input.projectPath,
    chatId: input.chatId,
    userMessage: input.userMessage,
    state,
  })
}

/**
 * Build executor prompts via the processor pipeline.
 */
export async function buildExecutorPromptsViaPipeline(
  input: ExecutorPipelineInput,
): Promise<PipelineResult> {
  const pipeline = getDefaultPipeline()
  const state = new Map<string, unknown>()

  state.set('projectRules', input.projectRules)
  state.set('skills', input.skills)
  state.set('sandbox', input.sandbox)
  state.set('taskHasJira', input.taskHasJira)
  state.set('taskHasFigma', input.taskHasFigma)
  state.set('language', input.language)

  return pipeline.run({
    role: 'executor',
    projectPath: input.projectPath,
    state,
  })
}
