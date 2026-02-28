# Code Conventions

## TypeScript & Module System

This project uses **TypeScript with ESM** (`"module": "NodeNext"` in tsconfig).

### Import Rules

```typescript
// ✅ Correct: .js extension (required by NodeNext)
import { getMemoryStore } from './store.js'
import type { MemoryItem } from './types.js'

// ✅ Correct: node: protocol for builtins
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// ❌ Wrong: no extension
import { getMemoryStore } from './store'

// ❌ Wrong: no node: protocol
import { readFile } from 'fs/promises'
```

### Type Safety

- `strict: true` is enabled in tsconfig
- `noUnusedLocals` and `noUnusedParameters` are enabled
- `noImplicitReturns` is enabled
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use `as const` for literal types and immutable values
- **Never use `enum`** — use `const` object + `typeof` instead (see example below)

## Biome (Formatter + Linter)

All formatting and linting is handled by [Biome](https://biomejs.dev/). Config in `biome.json`.

### Style

| Rule | Setting |
|------|---------|
| Quotes | Single |
| Semicolons | As needed (omit when possible) |
| Trailing commas | All |
| Indent | 2 spaces |
| Line width | 100 |
| Line ending | LF |

### Key Linter Rules

| Rule | Enforcement |
|------|-------------|
| `noVar` | Error (use `const` / `let`) |
| `useConst` | Error for `.ts` files |
| `noCommonJs` | Error (ESM only) |
| `noEmptyBlockStatements` | Error (use `console.warn` in catch) |
| `noExplicitAny` | Off (allowed when needed) |
| `noUnusedVariables` | Error |

### Running Checks

```bash
# Check formatting + linting (no auto-fix)
pnpm check

# Auto-fix formatting
pnpm format

# Lint only
pnpm lint
```

## Coding Patterns

### No Enums — Use `as const` Objects

```typescript
// ✅ Good: const object + typeof
const MemoryType = {
  Decision: 'decision',
  Context: 'context',
  Preference: 'preference',
  Issue: 'issue',
  TaskInput: 'task_input',
  TaskResult: 'task_result',
} as const

type MemoryType = (typeof MemoryType)[keyof typeof MemoryType]
// => 'decision' | 'context' | 'preference' | 'issue' | 'task_input' | 'task_result'

// ❌ Bad: enum (generates unnecessary runtime code, poor tree-shaking)
enum MemoryType {
  Decision = 'decision',
  Context = 'context',
}
```

Union types (`'a' | 'b' | 'c'`) are also fine for simple cases where you don't need a named constant object.

### Prefer Early Returns

```typescript
// ✅ Good
function process(input: string | null): string {
  if (!input) return 'default'
  if (input.length > 100) return input.slice(0, 100)
  return input.toUpperCase()
}

// ❌ Avoid: deep nesting
function process(input: string | null): string {
  if (input) {
    if (input.length <= 100) {
      return input.toUpperCase()
    } else {
      return input.slice(0, 100)
    }
  } else {
    return 'default'
  }
}
```

### Error Handling in Async Code

```typescript
// ✅ Good: catch with meaningful handling
try {
  const data = await readFile(path, 'utf-8')
  return JSON.parse(data)
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return defaultValue // File not found is expected
  }
  throw err // Re-throw unexpected errors
}

// ✅ Good: non-blocking error in fire-and-forget
await platform.sendText(chatId, message).catch((e) => console.warn('[IM] reply failed:', e))

// ❌ Bad: empty catch
try { ... } catch {}
```

### Template Literals Over Concatenation

```typescript
// ✅ Good
console.log(`[MemoryStore] Loaded ${count} items from ${types} categories`)

// ❌ Avoid
console.log('[MemoryStore] Loaded ' + count + ' items from ' + types + ' categories')
```

### parseInt Radix

```typescript
// ✅ Always specify radix
const threshold = parseInt(process.env.MEMORY_EXTRACT_THRESHOLD || '5', 10)

// ❌ Missing radix
const threshold = parseInt(process.env.MEMORY_EXTRACT_THRESHOLD || '5')
```

## Tool Implementation Pattern

Tools in `src/tools/` follow the `Tool` interface:

```typescript
interface Tool {
  name: string
  description: string
  schema: z.ZodType
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>
  category?: string
  enabled?: boolean
}
```

Rules:
- Tools should be pure functions (no side effects beyond their stated purpose)
- Return descriptive error messages — the AI agent reads them to decide next steps
- Shell tool must reject dangerous commands via blocklist
- Prefer `defineTool(...)` in `src/core/types.ts` for typed args inference

## Dependencies Policy

- Do not add new dependencies without clear justification
- Prefer Node.js built-in modules (`node:fs`, `node:path`, `node:crypto`, etc.)
- Keep the bundle minimal for fast startup
- Use `pnpm add <package>` (never npm or yarn)
