import { TripWire } from '../tripwire.js'
import type { PreCallContext, PreCallGuard } from '../tripwire.js'

const MAX_TASK_DURATION_MS = parseInt(process.env.MAX_TASK_DURATION_MS || '0', 10)

/**
 * Trips when task execution time exceeds MAX_TASK_DURATION_MS.
 * Disabled when MAX_TASK_DURATION_MS=0 (default).
 */
export const TimeGuard: PreCallGuard = {
  id: 'time',
  check(ctx: PreCallContext) {
    if (MAX_TASK_DURATION_MS <= 0) return
    const elapsed = Date.now() - ctx.startTime
    if (elapsed > MAX_TASK_DURATION_MS) {
      const elapsedMin = Math.round(elapsed / 60_000)
      const limitMin = Math.round(MAX_TASK_DURATION_MS / 60_000)
      throw new TripWire(
        `Time limit exceeded: ${elapsedMin}min > ${limitMin}min. ` +
          'Please finish your current changes, commit, and submit a summary.',
        {
          retry: true,
          maxRetries: 1,
          metadata: { elapsedMs: elapsed, limitMs: MAX_TASK_DURATION_MS },
        },
        'time',
      )
    }
  },
}
