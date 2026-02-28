/**
 * Structured logging system with subsystem loggers, level control, and file output.
 *
 * Usage:
 *   import { createLogger } from '../infra/logger.js'
 *   const log = createLogger('feishu')
 *   log.info('WebSocket connected')
 *   log.error('Failed to send', { chatId, error: err.message })
 *
 * Configuration via environment:
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 *   LOG_FILE=true|false              (default: true, writes to ~/.devops-bot/logs/)
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

interface LogEntry {
  ts: string
  level: LogLevel
  sys: string
  msg: string
  data?: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Level management                                                   */
/* ------------------------------------------------------------------ */

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel]
}

/**
 * Change the global log level at runtime.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

/**
 * Get the current global log level.
 */
export function getLogLevel(): LogLevel {
  return currentLevel
}

/* ------------------------------------------------------------------ */
/*  File output                                                        */
/* ------------------------------------------------------------------ */

const LOG_DIR = join(homedir(), '.devops-bot', 'logs')
const logFileEnabled = process.env.LOG_FILE !== 'false'

/** Ensure log directory exists (called once lazily). */
let logDirReady = false
function ensureLogDir(): void {
  if (logDirReady) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    logDirReady = true
  } catch {
    // Cannot create log directory — disable file logging silently
  }
}

/** Get today's log file path. */
function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]
  return join(LOG_DIR, `devops-bot-${date}.log`)
}

/** Append a JSON line to today's log file. */
function writeToFile(entry: LogEntry): void {
  if (!logFileEnabled) return
  ensureLogDir()
  try {
    appendFileSync(getLogFilePath(), `${JSON.stringify(entry)}\n`)
  } catch {
    // Don't crash on log write failure
  }
}

/* ------------------------------------------------------------------ */
/*  Console output                                                     */
/* ------------------------------------------------------------------ */

/** ANSI color codes for log levels (only when TTY). */
const isTTY = process.stderr.isTTY

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // grey
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
}
const RESET = '\x1b[0m'

function formatConsole(entry: LogEntry): string {
  const time = entry.ts.split('T')[1]?.slice(0, 8) || entry.ts
  const lvl = entry.level.toUpperCase().padEnd(5)
  const sys = entry.sys

  if (isTTY) {
    const color = LEVEL_COLORS[entry.level]
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : ''
    return `${color}${time} ${lvl}${RESET} [${sys}] ${entry.msg}${dataStr}`
  }

  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : ''
  return `${time} ${lvl} [${sys}] ${entry.msg}${dataStr}`
}

/* ------------------------------------------------------------------ */
/*  Logger factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create a logger for a specific subsystem.
 *
 * @param subsystem  Short identifier (e.g., 'feishu', 'dispatcher', 'executor')
 * @returns          Logger instance with debug/info/warn/error methods
 */
export function createLogger(subsystem: string): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(level)) return

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      sys: subsystem,
      msg: message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    }

    // Console output (use stderr to avoid polluting stdout for MCP/pipe scenarios)
    const consoleFn =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.error
    consoleFn(formatConsole(entry))

    // File output
    writeToFile(entry)
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  }
}
