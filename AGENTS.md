# AGENTS.md

## What This Repo Is

OpenCode plugin (`opencode-memoir`) that provides git-versioned memory for AI coding agents. TypeScript/Node.js ESM package.

## Critical Commands

```bash
# Development
npm run build          # tsc declarations + esbuild bundle to dist/
npm run typecheck      # tsc --noEmit (strict mode)
npm test              # tsx --test tests/*.test.ts (Node built-in test runner)

# Linting & formatting
npm run lint           # biome check src/ tests/
npm run lint:fix       # biome check --write src/ tests/
npm run format         # biome format --write src/ tests/

# Single test file
npx tsx --test tests/recall-gate.test.ts

# Full verification (what CI runs)
npm run lint && npm run typecheck && npm run build && npm test
```

**Biome** is the linter and formatter (`@biomejs/biome`). CI runs `biome ci src/ tests/` which is stricter than `biome check`.

## Architecture Essentials

### Plugin Format (V1 Module - Critical)

`src/index.ts` must export **only** `default` as `{ id: 'opencode-memoir', server: MemoirOpenCode }`. Named exports crash OpenCode's loader.

### Plugin Factory Pattern

`MemoirOpenCode` is an async function returning an object with hooks/tools. Store path is cached once at init (avoid repeated `execFileSync`).

### Key Files

- `src/index.ts` - Plugin entry: tools, hooks, commands (534 lines)
- `src/store.ts` - CLI resolution, git integration, store paths (~350 lines)
- `src/capture.ts` - Edit tracking, metrics, flush with mutex (~288 lines)
- `src/recall-gate.ts` - Secret pattern detection, recall triggers (~67 lines)
- `src/utils.ts` - SECRET_PATTERN, errorMessage, coercePaths (45 lines). **Must NOT be exported from index.ts** (OpenCode loader treats every export as a plugin)
- `src/debug.ts` - Conditional debug logger (`MEMOIR_DEBUG=1`, 9 lines)

## Conventions

### Error Handling

- **Hooks**: Wrap entire body in try/catch, log via `debugLog()`, never propagate errors
- **Tools**: Return error strings (`"Memoir command failed..."`) instead of throwing
- Use `errorMessage(e)` helper for safe error extraction from `unknown`

### TypeScript Patterns

- ESM-only with `.js` extensions in imports
- Local `type` aliases for arg objects (not interfaces)
- `as` casts for loosely-typed plugin options
- Node built-ins with `node:` prefix
- Numeric separators: `5_000`, `1_024 * 1_024`

### Module-Level State

- ES module imports are read-only bindings
- Use setter functions for mutable state (see `setPluginStoreOverride()`)
- Internal module mutations (`let` at module scope) work fine

### Caching Patterns

- Size-based eviction with `.clear()` on overflow
- FIFO eviction via `evictOldest()` (deletes first Map key)
- Concurrency control via Promise-chain mutex in `capture.ts`

## Gotchas

1. **`runMemoir` never throws** - Returns error strings starting with `"Memoir command failed"`. Check with `.startsWith()`.
2. **Recall gate timing** - Must run synchronously before any `await` in `chat.message` hook (C4 comment in code).
3. **`pushText` replaces, not appends** - Clears all existing parts (`output.parts.length = 0`).
4. **`execFileSync` blocks ~3s** - `deriveStorePath()` runs once at init, then cached.
5. **Conventional Commits required** - Only `feat:`, `fix:`, `perf:`, `revert:`, `refactor:` trigger releases.
6. **Tests excluded from tsc** - `tsconfig.json` include is `src/**/*.ts` only; tests compile separately via `tsx --test`.

## Environment Variables

All optional, feature flags:

- `MEMOIR_DEBUG=1` - Enable debug logging to stderr
- `MEMOIR_NO_CAPTURE=1` - Disable all capture
- `MEMOIR_NO_METRICS=1` - Disable tool metrics
- `MEMOIR_NO_CODE_SUMMARY=1` - Disable edit recording
- `MEMOIR_SANITIZE_SECRETS=0` - Disable secret pattern blocking (default ON)
- `MEMOIR_STORE` - Override store path

## Build Pipeline

Two-stage build:
1. `tsc --declaration --emitDeclarationOnly` - Type declarations only
2. `esbuild` - Bundled ESM, `node:*` and `@opencode-ai/plugin` externalized

`prepublishOnly` runs smoke test verifying V1 module shape `{ id, server }`.

## CI/CD

- PRs: `lint_and_test.yaml` (Biome lint + typecheck → Node 22/24 test matrix)
- Main/release pushes: `semantic.yaml` (semantic-release)
- Version tags: `publish-npm.yaml` (npm trusted publishing)
