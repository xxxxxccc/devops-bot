/**
 * Tool Policy — lightweight allow/deny filtering for tools.
 *
 * Inspired by OpenClaw's cascading ACL, but tailored for our two-layer
 * architecture.  A policy can reference tool names directly or use
 * category groups (e.g. "group:file-read").
 *
 * Resolution rules:
 *   1. Deny always wins — if a tool matches any deny entry, it's blocked
 *   2. If allow is non-empty, only matching tools pass
 *   3. Empty allow = allow everything (except denied)
 *   4. Wildcard `*` suffix supported (e.g. "jira_*")
 */

import type { Tool } from './types.js'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ToolPolicy {
  /** Tool names or "group:<category>" entries to allow.  Empty = allow all. */
  allow?: string[]
  /** Tool names or "group:<category>" entries to deny.  Deny wins over allow. */
  deny?: string[]
}

/* ------------------------------------------------------------------ */
/*  Predefined profiles                                                */
/* ------------------------------------------------------------------ */

const PROFILES: Record<string, ToolPolicy> = {
  /** Read-only file inspection tools + skill management (Layer 1 default) */
  'read-only': {
    allow: ['group:file-read', 'group:search', 'group:skill'],
  },
  /** All tools enabled (Layer 2 default) */
  full: {},
  /** Safe subset — no shell, no file deletion */
  safe: {
    deny: ['shell_exec', 'shell_stream', 'npm', 'delete_file'],
  },
}

/**
 * Resolve a named profile to a ToolPolicy.
 * Returns an empty policy (allow all) if the name is unknown.
 */
export function resolveProfile(name: string): ToolPolicy {
  return PROFILES[name] ?? {}
}

/**
 * List all available profile names.
 */
export function getProfileNames(): string[] {
  return Object.keys(PROFILES)
}

/* ------------------------------------------------------------------ */
/*  Category → tool name groups                                        */
/* ------------------------------------------------------------------ */

/**
 * Standard category groups.
 * A group entry "group:file-read" expands to these tool names.
 */
const CATEGORY_GROUPS: Record<string, string[]> = {
  'file-read': ['read_file', 'list_directory'],
  'file-write': ['write_file', 'edit_file', 'delete_file'],
  search: ['grep_search', 'glob_search'],
  git: [
    'git_status',
    'git_diff',
    'git_log',
    'git_show',
    'git_branch',
    'git_checkout_branch',
    'git_switch',
    'git_add',
    'git_commit',
    'git_push',
    'git_pull',
    'git_stash',
  ],
  shell: ['shell_exec', 'shell_stream', 'npm'],
  task: ['get_task_history', 'submit_summary'],
  skill: ['find_skills', 'list_installed_skills', 'install_skill', 'create_skill'],
}

/* ------------------------------------------------------------------ */
/*  Filtering logic                                                    */
/* ------------------------------------------------------------------ */

/**
 * Filter a list of tools through a policy.
 *
 * @param tools   All available tools
 * @param policy  The policy to apply
 * @returns       Filtered tool list
 */
export function filterTools(tools: Tool[], policy: ToolPolicy): Tool[] {
  const allowSet = expandEntries(policy.allow)
  const denySet = expandEntries(policy.deny)

  return tools.filter((tool) => {
    // Deny always wins
    if (denySet && matchesTool(tool, denySet)) return false
    // If allow is specified, only matching tools pass
    if (allowSet && !matchesTool(tool, allowSet)) return false
    return true
  })
}

/**
 * Merge multiple policies into one.  Later policies take precedence:
 * deny entries are unioned, allow entries from the last policy with
 * a non-empty allow wins.
 */
export function mergePolicies(...policies: ToolPolicy[]): ToolPolicy {
  const merged: ToolPolicy = {}
  const allDeny: string[] = []

  for (const p of policies) {
    if (p.allow && p.allow.length > 0) {
      merged.allow = p.allow
    }
    if (p.deny) {
      allDeny.push(...p.deny)
    }
  }

  if (allDeny.length > 0) {
    merged.deny = [...new Set(allDeny)]
  }

  return merged
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Expand policy entries into a Set of concrete tool names and wildcard patterns.
 * "group:file-read" → ["read_file", "list_directory"]
 */
function expandEntries(entries: string[] | undefined): Set<string> | null {
  if (!entries || entries.length === 0) return null

  const expanded = new Set<string>()
  for (const entry of entries) {
    if (entry.startsWith('group:')) {
      const groupName = entry.slice(6)
      const tools = CATEGORY_GROUPS[groupName]
      if (tools) {
        for (const t of tools) expanded.add(t)
      } else {
        console.warn(`[ToolPolicy] Unknown group: ${groupName}`)
      }
    } else {
      expanded.add(entry)
    }
  }
  return expanded
}

/**
 * Check if a tool matches any entry in the set.
 * Supports exact match and wildcard suffix (e.g. "jira_*").
 */
function matchesTool(tool: Tool, entries: Set<string>): boolean {
  // Exact match
  if (entries.has(tool.name)) return true

  // Wildcard patterns (e.g. "jira_*")
  for (const entry of entries) {
    if (entry.endsWith('*') && tool.name.startsWith(entry.slice(0, -1))) {
      return true
    }
  }

  return false
}
