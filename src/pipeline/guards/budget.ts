import { TripWire } from '../tripwire.js'
import type { PreCallContext, PreCallGuard } from '../tripwire.js'

const MAX_TASK_TOKENS = parseInt(process.env.MAX_TASK_TOKENS || '0', 10)

/**
 * Trips when cumulative token usage exceeds MAX_TASK_TOKENS.
 * Disabled when MAX_TASK_TOKENS=0 (default).
 */
export const BudgetGuard: PreCallGuard = {
  id: 'budget',
  check(ctx: PreCallContext) {
    if (MAX_TASK_TOKENS <= 0) return
    if (ctx.totalTokensUsed > MAX_TASK_TOKENS) {
      throw new TripWire(
        `Token budget exceeded: ${ctx.totalTokensUsed} > ${MAX_TASK_TOKENS}. ` +
          'Wrap up the current work and submit a summary.',
        {
          retry: true,
          maxRetries: 1,
          metadata: { used: ctx.totalTokensUsed, limit: MAX_TASK_TOKENS },
        },
        'budget',
      )
    }
  },
}
