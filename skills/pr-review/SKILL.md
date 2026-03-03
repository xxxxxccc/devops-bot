---
name: pr-review
description: PR code review standards and guidelines. Use when reviewing pull requests, analyzing diffs, or providing code review feedback.
---

# PR Review Guidelines

## Review Priority (highest to lowest)

1. **Security** — vulnerabilities, exposed secrets, injection, auth bypass
2. **Correctness** — logic errors, edge cases, data loss, race conditions
3. **Error Handling** — unhandled exceptions, missing null checks, unclear error messages
4. **Performance** — N+1 queries, unbounded loops, memory leaks, blocking I/O
5. **Maintainability** — unclear naming, DRY violations, missing types, excessive complexity

## What to Flag

- Breaking API changes without versioning
- Missing input validation on public interfaces
- Hardcoded secrets, credentials, or environment-specific values
- Database queries without indexes (when schema is visible)
- Promises without error handling (`.catch` or try/catch)
- Resource leaks (unclosed connections, file handles, timers)

## What NOT to Flag

- Style/formatting issues (handled by linters/formatters)
- Import ordering
- Trailing whitespace
- Minor naming preferences when existing conventions are followed
- Generated files, lock files, build artifacts

## Comment Quality

- Be specific: "Line 42: `users.find()` without `.lean()` returns full Mongoose documents, adding ~30% memory overhead" is better than "Consider performance"
- Suggest fixes: Include a code snippet when the fix is non-obvious
- Explain impact: "This could cause a memory leak in long-running processes because..."
- Acknowledge good patterns: "Good use of discriminated unions here for type safety"

## Severity Levels

- **critical**: Must fix before merge. Security issues, data loss risks, correctness bugs.
- **warning**: Should fix. Performance issues, missing error handling, fragile patterns.
- **suggestion**: Nice to have. Better approaches, minor improvements.
- **nitpick**: Purely optional. Naming tweaks, minor style preferences.
