/**
 * TripWire — safety/interrupt mechanism for AI execution.
 *
 * TripWire is an Error subclass that guards can throw to interrupt execution.
 * When retry=true, the reason is injected as feedback and the iteration retries.
 */

export interface TripWireOptions {
  retry: boolean
  maxRetries?: number
  metadata?: Record<string, unknown>
}

export class TripWire extends Error {
  public readonly options: TripWireOptions
  public readonly processorId?: string

  constructor(reason: string, options: TripWireOptions = { retry: false }, processorId?: string) {
    super(reason)
    this.name = 'TripWire'
    this.options = options
    this.processorId = processorId
  }
}

/**
 * Pre-call guard — runs before each AI createMessage call.
 */
export interface PreCallGuard {
  id: string
  check(context: PreCallContext): void
}

export interface PreCallContext {
  iteration: number
  totalTokensUsed: number
  startTime: number
  signal?: AbortSignal
}

/**
 * Tool guard — runs before each tool execution.
 */
export interface ToolGuard {
  id: string
  check(toolName: string, args: Record<string, unknown>): void
}
