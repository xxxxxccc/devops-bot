/**
 * Lightweight concurrency utilities — no external dependencies.
 */

export interface ConcurrentResult<T> {
  status: 'fulfilled' | 'rejected'
  value?: T
  reason?: unknown
}

/**
 * Run async tasks with a concurrency limit (like p-limit / Promise.allSettled hybrid).
 * Never throws — returns settled results for every task.
 */
export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<ConcurrentResult<T>[]> {
  const results: ConcurrentResult<T>[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]() }
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}
