# AGENTS.md

## What This Repo Is

OpenCode plugin (`opencode-memoir`) that dynamically loads the `memoir-mcp` Python MCP server via `uvx` for git-versioned AI memory. TypeScript/Node.js ESM package.

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

**Biome** is the linter and formatter (`@biomejs/biome`). CI runs `npx biome ci src/ tests/` which is stricter than `biome check`.

## Architecture

### Plugin Format (V1 Module - Critical)

`src/index.ts` exports only `default` as `{ id: 'opencode-memoir', server: MemoirOpenCode }`. Named exports crash OpenCode's loader.

### Dynamic MCP Pattern

Returns `mcp: { memoir: { type: 'local', command: 'uvx', args: [...] } }` to register the memoir-mcp server. The `mcp` field is NOT in `@opencode-ai/plugin`'s `Hooks` type, but OpenCode's Go runtime accepts it (`return hooks as unknown as Hooks`).

### Source Layout

| File | Lines | Role |
|------|------:|------|
| `src/index.ts` | ~150 | Plugin entry: MCP registration + all hooks + dispose |
| `src/store.ts` | ~115 | Store path derivation, branch auto-match, `callMemoir` CLI helper |
| `src/memory-saver.ts` | ~25 | Message counter for periodic reminders |
| `src/debug.ts` | 9 | Conditional stderr logger (`MEMOIR_DEBUG=1`) |

### Hooks

- **`config`** — Registers `/memoir:onboard` slash command for project onboarding
- **`shell.env`** — Injects `MEMOIR_STORE` into shell environment
- **`chat.message`** — Increments message counter, auto-matches memoir branch
- **`experimental.chat.system.transform`** — Startup hint (once/session) + periodic reminder (every N messages)
- **`dispose`** — Saves session marker, clears all pending state

All hooks wrap their body in try/catch, log via `debugLog()`, never propagate errors.

## Environment Variables

All optional:

- `MEMOIR_DEBUG=1` — Debug logging to stderr (`[memoir]` prefix)
- `MEMOIR_STORE` — Override store path (passed as `--store` to memoir-mcp)
- `MEMOIR_AUTO_SAVE=0` — Disable auto-save on completion/dispose (default: enabled)
- `MEMOIR_REMINDER_INTERVAL=N` — Periodic reminder every N messages (default: 5, 0 to disable)

## Tests

No test files currently. The recall-gate tests were removed when the gate was removed in favor of simpler prompt-based recall guidance.

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

## Conventional Commits

Only `feat:`, `fix:`, `perf:`, `revert:`, `refactor:` produce releases. `docs:`/`test:`/`chore:` etc. do not.

## TypeScript Patterns

- ESM-only with `.js` extensions in imports
- Local `type` aliases (not interfaces)
- `as` casts for loosely-typed plugin options and the `mcp` field
- Node built-ins with `node:` prefix
