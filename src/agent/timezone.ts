/**
 * Timezone Utility
 *
 * This module provides timezone-related utilities for date formatting
 * and timezone detection throughout the application.
 *
 * Fixed: TD-2025-0114 - Changed from hardcoded America/Belize to proper local timezone detection
 */

/**
 * Get the user's local timezone
 * Uses Intl.DateTimeFormat to detect the actual system timezone
 */
export function getLocalTimezone(): string {
  // Use Intl.DateTimeFormat to get the actual system timezone
  // This properly detects the user's local timezone instead of hardcoding
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timeZone
}

/**
 * Format a date to the user's local timezone
 */
export function formatToLocalTimezone(
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = date instanceof Date ? date : new Date(date)
  const timeZone = getLocalTimezone()

  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }

  return new Intl.DateTimeFormat('zh-CN', { ...defaultOptions, ...options }).format(d)
}

/**
 * Get timezone offset in hours from UTC
 */
export function getTimezoneOffset(timeZone?: string): number {
  const tz = timeZone || getLocalTimezone()
  const now = new Date()

  // Get the time in the target timezone
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  // Get the time in UTC
  const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))

  return (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60)
}

/**
 * Check if a timezone string is valid
 */
export function isValidTimezone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Get all available timezone information
 */
export function getTimezoneInfo() {
  const timeZone = getLocalTimezone()
  const offset = getTimezoneOffset(timeZone)

  return {
    timeZone,
    offset,
    offsetString: `UTC${offset >= 0 ? '+' : ''}${offset}`,
    locale: 'zh-CN',
  }
}
