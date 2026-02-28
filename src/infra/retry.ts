/**
 * Generic retry utility with exponential backoff, jitter, and error classification.
 *
 * Usage:
 *   const result = await retry(() => anthropic.messages.create(...))
 *   const result = await retry(() => feishuClient.im.message.create(...), { maxAttempts: 5 })
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number
  /** Initial delay between retries in ms. Default: 1000 */
  baseDelayMs?: number
  /** Maximum delay between retries in ms. Default: 30000 */
  maxDelayMs?: number
  /** Backoff multiplier per attempt. Default: 2 */
  backoffMultiplier?: number
  /** Add random jitter to delays. Default: true */
  jitter?: boolean
  /** Custom predicate: should we retry this error? Default: isTransientError */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** Called before each retry (for logging). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

/* ------------------------------------------------------------------ */
/*  Core retry function                                                */
/* ------------------------------------------------------------------ */

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn        The async function to retry
 * @param options   Retry configuration
 * @returns         The result of `fn` on success
 * @throws          The last error if all attempts fail
 */
export async function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3
  const baseDelayMs = options?.baseDelayMs ?? 1000
  const maxDelayMs = options?.maxDelayMs ?? 30000
  const backoffMultiplier = options?.backoffMultiplier ?? 2
  const jitter = options?.jitter ?? true
  const shouldRetry = options?.shouldRetry ?? isTransientError
  const onRetry = options?.onRetry

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (attempt >= maxAttempts || !shouldRetry(error, attempt)) {
        throw error
      }

      // Calculate delay: exponential backoff with optional jitter
      let delay = Math.min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs)

      // Check for retry-after header (Anthropic, HTTP 429)
      const retryAfterMs = extractRetryAfter(error)
      if (retryAfterMs) {
        delay = Math.max(delay, retryAfterMs)
      }

      // Add jitter: +/- 25% randomness
      if (jitter) {
        const jitterRange = delay * 0.25
        delay += Math.random() * jitterRange * 2 - jitterRange
      }

      delay = Math.round(delay)
      onRetry?.(error, attempt, delay)

      await sleep(delay)
    }
  }

  throw lastError
}

/* ------------------------------------------------------------------ */
/*  Error classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Default error classifier: returns true for transient/retryable errors.
 *
 * Retryable:
 *   - Anthropic: rate_limit_error, overloaded_error, api_error (5xx)
 *   - OpenAI: server_error, rate_limit_exceeded, insufficient_quota (429)
 *   - Network: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET
 *   - HTTP: 429, 500, 502, 503, 504
 *
 * Not retryable:
 *   - Anthropic: authentication_error, invalid_request_error, not_found_error
 *   - OpenAI: invalid_api_key, model_not_found
 *   - HTTP: 400, 401, 403, 404
 *   - All other errors
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false

  const message = error instanceof Error ? error.message : String(error)
  const lowerMsg = message.toLowerCase()

  // Anthropic API error types (from error.type or error.error.type)
  const errorType = extractErrorType(error)
  if (errorType) {
    const retryableTypes = new Set([
      'rate_limit_error',
      'overloaded_error',
      'api_error',
      'internal_server_error',
      'server_error',
      'rate_limit_exceeded',
      'insufficient_quota',
    ])
    if (retryableTypes.has(errorType)) return true
    const nonRetryableTypes = new Set([
      'authentication_error',
      'invalid_request_error',
      'not_found_error',
      'permission_error',
      'invalid_api_key',
      'model_not_found',
    ])
    if (nonRetryableTypes.has(errorType)) return false
  }

  // Network errors
  const networkErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_SOCKET']
  for (const code of networkErrors) {
    if (lowerMsg.includes(code.toLowerCase()) || getErrorCode(error) === code) return true
  }

  // HTTP status codes
  const status = getStatusCode(error)
  if (status !== null) {
    return status === 429 || status >= 500
  }

  // Generic transient keywords
  if (
    lowerMsg.includes('rate_limit') ||
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('service unavailable') ||
    lowerMsg.includes('gateway timeout') ||
    lowerMsg.includes('internal server error')
  ) {
    return true
  }

  return false
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Extract error type from Anthropic API errors or similar structured errors.
 */
function extractErrorType(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const err = error as Record<string, unknown>

  // Anthropic SDK: error.error.type
  if (err.error && typeof err.error === 'object') {
    const inner = err.error as Record<string, unknown>
    if (typeof inner.type === 'string') return inner.type
  }

  // Direct type field
  if (typeof err.type === 'string') return err.type

  // error.name (e.g., "RateLimitError")
  if (err instanceof Error && err.name) {
    const name = err.name.toLowerCase()
    if (name.includes('ratelimit')) return 'rate_limit_error'
    if (name.includes('overloaded')) return 'overloaded_error'
  }

  return null
}

/**
 * Extract retry-after from error headers (Anthropic returns this on 429).
 * Returns delay in milliseconds or null.
 */
function extractRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const err = error as Record<string, unknown>

  // Anthropic SDK: error.headers['retry-after']
  const headers = err.headers as Record<string, string> | undefined
  if (headers) {
    const retryAfter = headers['retry-after']
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(seconds)) return Math.ceil(seconds * 1000)
    }
  }

  return null
}

/**
 * Extract HTTP status code from error object.
 */
function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const err = error as Record<string, unknown>
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  return null
}

/**
 * Extract error code (e.g., 'ECONNRESET') from error object.
 */
function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const err = error as Record<string, unknown>
  if (typeof err.code === 'string') return err.code
  return null
}
