/**
 * Processor Pipeline Runner.
 *
 * Registers processors, runs them in order, and assembles the final prompt.
 */

import { createLogger } from '../infra/logger.js'
import type {
  BudgetTracker,
  PipelineContext,
  PipelineResult,
  PipelineRole,
  Processor,
} from './types.js'

const log = createLogger('pipeline')

const DEFAULT_BUDGET_CHARS = 200_000

export class ProcessorPipeline {
  private processors: Processor[] = []

  register(processor: Processor): this {
    this.processors.push(processor)
    this.processors.sort((a, b) => a.order - b.order)
    return this
  }

  registerAll(processors: Processor[]): this {
    for (const p of processors) this.register(p)
    return this
  }

  async run(params: {
    role: PipelineRole
    projectPath: string
    chatId?: string
    userMessage?: string
    state?: Map<string, unknown>
    budgetChars?: number
  }): Promise<PipelineResult> {
    const budget: BudgetTracker = {
      totalChars: params.budgetChars ?? DEFAULT_BUDGET_CHARS,
      usedChars: 0,
      remaining: params.budgetChars ?? DEFAULT_BUDGET_CHARS,
    }

    let ctx: PipelineContext = {
      role: params.role,
      chatId: params.chatId,
      projectPath: params.projectPath,
      userMessage: params.userMessage,
      systemSections: [],
      userSections: [],
      budget,
      state: params.state ?? new Map(),
    }

    const applicable = this.processors.filter((p) => p.roles.includes(params.role))

    for (const processor of applicable) {
      try {
        ctx = await processor.process(ctx)
        ctx.budget.usedChars = sumSections(ctx.systemSections) + sumSections(ctx.userSections)
        ctx.budget.remaining = Math.max(0, ctx.budget.totalChars - ctx.budget.usedChars)
      } catch (err) {
        log.warn(`Processor "${processor.id}" failed, skipping`, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return assemble(ctx)
  }
}

function sumSections(sections: Array<{ content: string }>): number {
  return sections.reduce((sum, s) => sum + s.content.length, 0)
}

function assemble(ctx: PipelineContext): PipelineResult {
  const systemParts = [...ctx.systemSections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)

  const userParts = [...ctx.userSections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)

  return {
    system: systemParts.join('\n'),
    user: userParts.join('\n'),
  }
}
