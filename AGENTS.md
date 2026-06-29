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
# lint_and_test.yaml: biome ci src/ tests/ → npm run typecheck → npm run build → npm test
```

**Biome** is the linter and formatter (`@biomejs/biome`). CI runs `npx biome ci src/ tests/` which is stricter than `biome check`. VCS integration reads `.gitignore` + `.ignore`.

## Architecture Essentials

### Plugin Format (V1 Module - Critical)

`src/index.ts` exports only `default` as `{ id: 'opencode-memoir', server: MemoirOpenCode }`. Named exports crash OpenCode's loader.

### Plugin Factory Pattern

`MemoirOpenCode` returns an object with hooks/tools. Store path is cached once at init (avoid repeated `execFileSync`).

### Source Layout

| File | Lines | Role |
|------|------:|------|
| `src/store.ts` | 473 | CLI resolution (`memoir`/`uvx`/`uv` fallback), `deriveStorePath()`, `ensureStore()`, `runMemoir()`, git/worktree helpers, branch auto-match |
| `src/capture.ts` | 360 | `flushCapture()` (read-merge-write of `metrics.code.*` / `metrics.turn.*`), per-session edit/metrics state, Promise-chain mutex |
| `src/memoir-ops.ts` | 191 | `statusJson()`, `launchUi()` (spawns detached process, polls for URL), `unmergedBranchesText()` |
| `src/tools.ts` | 160 | `memoir_status`, `memoir_remember`, `memoir_recall`, `memoir_get` tool definitions via `@opencode-ai/plugin` |
| `src/capture-hooks.ts` | 125 | Hook wiring: `shell.env` (injects `MEMOIR_STORE`), `tool.execute.after` (metrics + edits), `chat.message` (recall gate + auto-match branch + flush) |
| `src/index.ts` | 116 | Plugin entry: tool registration, all 8 hooks, dispose cleanup |
| `src/session-context.ts` | 103 | Background taxonomy fetch on `session.created`, system prompt injection for taxonomy context + recall instruction |
| `src/commands.ts` | 77 | Slash command registration (`/memoir:status`, `:ui`, `:remember`, `:recall`, `:onboard`, `:unmerged`), secret sanitization in `/memoir:remember` |
| `src/recall-gate.ts` | 72 | `shouldTriggerRecall()` — positive-list pattern gate mirroring Claude Code's UserPromptSubmit logic |
| `src/utils.ts` | 45 | `SECRET_PATTERN`, `errorMessage()`, `coercePaths()`, `MEMOIR_GET_MAX_KEYS`. **Must NOT be re-exported from index.ts** |
| `src/debug.ts` | 9 | Conditional stderr logger (`MEMOIR_DEBUG=1`) |

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

- ES module imports are read-only bindings — use setter functions for mutable state (e.g., `setPluginStoreOverride()`, `setStoreTestOverrides()`, `setCliOverrides()`)
- Internal module mutations (`let` at module scope) work fine

### Caching Patterns

- Size-based eviction with `.clear()` or FIFO via `evictOldest()` (deletes first Map/Set key)
- TTL-based eviction in `_noGitCache` (5 min) and `branchMatchCache` (5s)
- Concurrency control via Promise-chain mutex in `capture.ts` (`flushQueues`) and `store.ts` (`storeCreateQueues`)

## Gotchas

1. **`runMemoir` never throws** — Returns `{ ok: true, stdout } | { ok: false, error }`. Check `.ok`.
2. **Recall gate timing** — `chat.message` hook runs `shouldTriggerRecall()` synchronously before any `await` (C4 comment in `capture-hooks.ts:84`).
3. **`pushText` replaces, not appends** — Clears all existing parts (`output.parts.length = 0`) in `commands.ts`.
4. **`execFileSync` blocks ~3s** — `deriveStorePath()` runs once at init, then cached.
5. **Store creation in non-git dirs** — `ensureStore()` creates a scratch git directory before `memoir new` (the `.git` requirement of prolly-tree).
6. **Conventional Commits required** — Only `feat:`, `fix:`, `perf:`, `revert:`, `refactor:` produce releases. `docs:`/`test:`/`chore:` etc. do not.
7. **Tests excluded from tsc** — `tsconfig.json` `include` is `src/**/*.ts` only; tests compile via `tsx --test`.
8. **`captureTest` tests require `memoir` CLI** — `tests/capture.test.ts` and `tests/store-async.test.ts` mock CLI but still need `ensureStore`. `tests/integration.test.ts` self-skips when CLI unavailable.

## Environment Variables

All optional, on by default:

- `MEMOIR_DEBUG=1` — Debug logging to stderr (`[memoir]` prefix)
- `MEMOIR_NO_CAPTURE=1` — Disable all capture (metrics + edits + auto-match + flush)
- `MEMOIR_NO_METRICS=1` — Disable per-tool metrics only
- `MEMOIR_NO_CODE_SUMMARY=1` — Disable edit recording only
- `MEMOIR_SANITIZE_SECRETS=0` — Disable secret pattern blocking (default ON)
- `MEMOIR_STORE` — Override store path

## Build Pipeline

Two-stage build:
1. `tsc --declaration --emitDeclarationOnly` — Type declarations
2. `esbuild` — Bundled ESM, `node:*` and `@opencode-ai/plugin` externalized

`prepublishOnly` runs build + test + smoke check (validates V1 module `{ id, server }` shape).

## CI/CD

- **PRs**: `lint_and_test.yaml` — `biome ci` → `typecheck` → `build` → `test` (Node 24/26 matrix)
- **PRs + schedule**: `audit.yaml` — `npm audit --audit-level=high` (Node 20/22)
- **Push to main (non-release commits)**: `semantic.yaml` release job — runs semantic-release via Docker (`ghcr.io/disafronov/semantic-release:latest`), updates CHANGELOG, tags `vx.y.z`
- **Push to release**: `semantic.yaml` release job + sync back to main (ff or rebase)
- **Push to main (release commits)**: `semantic.yaml` rebase job — rebases all non-draft non-deps PRs onto main
- **Version tags (`v*`)**: `publish-npm.yaml` — `npm publish --provenance --access public`
