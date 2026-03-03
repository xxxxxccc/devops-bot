/**
 * Diff Parser — splits PR file changes into reviewable chunks.
 *
 * Strategies:
 * - Filters out generated/lock files
 * - Splits large files by hunk to stay within token limits
 * - Attaches file metadata (path, language, change stats)
 */

import { createLogger } from '../infra/logger.js'

const log = createLogger('diff-parser')

const MAX_PATCH_CHARS = 12_000

const SKIP_PATTERNS = [
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^Gemfile\.lock$/,
  /^Cargo\.lock$/,
  /^go\.sum$/,
  /^poetry\.lock$/,
  /^composer\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.generated\./,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^vendor\//,
  /^node_modules\//,
]

export interface DiffChunk {
  filename: string
  language: string
  status: string
  additions: number
  deletions: number
  patch: string
  truncated: boolean
}

export interface ParsedDiff {
  chunks: DiffChunk[]
  skippedFiles: string[]
  totalFiles: number
}

export function parsePRFiles(
  files: Array<{
    filename: string
    status: string
    additions: number
    deletions: number
    patch: string
  }>,
): ParsedDiff {
  const chunks: DiffChunk[] = []
  const skippedFiles: string[] = []

  for (const file of files) {
    if (shouldSkip(file.filename)) {
      skippedFiles.push(file.filename)
      continue
    }

    if (!file.patch) {
      skippedFiles.push(file.filename)
      continue
    }

    const language = detectLanguage(file.filename)
    let patch = file.patch
    let truncated = false

    if (patch.length > MAX_PATCH_CHARS) {
      patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n... [truncated, ${file.additions + file.deletions} total lines changed]`
      truncated = true
    }

    chunks.push({
      filename: file.filename,
      language,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      truncated,
    })
  }

  if (skippedFiles.length > 0) {
    log.debug(`Skipped ${skippedFiles.length} files`, { skippedFiles })
  }

  return { chunks, skippedFiles, totalFiles: files.length }
}

function shouldSkip(filename: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(filename))
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const langMap: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript/React',
    js: 'JavaScript',
    jsx: 'JavaScript/React',
    py: 'Python',
    rb: 'Ruby',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    kt: 'Kotlin',
    swift: 'Swift',
    cs: 'C#',
    cpp: 'C++',
    c: 'C',
    h: 'C/C++ Header',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    vue: 'Vue',
    svelte: 'Svelte',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    toml: 'TOML',
    md: 'Markdown',
    sql: 'SQL',
    sh: 'Shell',
    dockerfile: 'Dockerfile',
  }
  return langMap[ext] || ext || 'unknown'
}
