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
npx tsx --test tests/store.test.ts

# Full verification (what CI runs)
# lint_and_test.yaml: biome ci src/ tests/ → npm run typecheck → npm run build → npm test
```

**Biome** is the linter and formatter (`@biomejs/biome`). CI runs `npx biome ci src/ tests/` which is stricter than `biome check`.

## Architecture

### Plugin Format (V1 Module - Critical)

`src/index.ts` exports only `default` as `{ id: 'opencode-memoir', server: MemoirOpenCode }`. Named exports crash OpenCode's loader.

### Dynamic MCP Pattern

The plugin owns a single shared `memoir-mcp` HTTP server (spawned once via `uvx`/`memoir-mcp` with `--http`, started in the `config` hook). It is registered as a **remote** MCP server: `mcp: { memoir: { type: 'remote', url, enabled: true } }`. openCode connects to it, and the plugin's own hooks use the same URL via an internal MCP client (`mcp-client.ts`). One process, no stdio double-spawn. The `mcp` field is NOT in `@opencode-ai/plugin`'s `Hooks` type, but OpenCode's Go runtime accepts it (`return hooks as unknown as Hooks`).

### Source Layout

| File | Lines | Role |
|------|------:|------|
| `src/index.ts` | ~240 | Plugin entry: subagent + MCP registration, all hooks, capture wiring, dispose |
| `src/mcp-client.ts` | ~230 | Single shared HTTP `memoir-mcp` server + internal `Client` + `callMemoirTool` |
| `src/subagent.ts` | ~160 | `memoir` subagent config (`AgentConfig`, mode subagent, `memoir_*` tools only) + `runMemoirSubagent` runner + `resolveMemoirModel`. System prompt is tool-free and loaded from `prompts/subagent-system.tmpl` |
| `src/capture.ts` | ~220 | Per-turn capture orchestration: transcript extraction, min-chars pre-filter, `buildTurnCaptureTask` (renders `prompts/capture-task.tmpl`, injecting the live memoir tool catalog) |
| `src/prompts.ts` | ~25 | `loadPrompt(file)` — reads a `.tmpl` from `prompts/` (dev) or `dist/prompts/` (bundled), cached. The `prompts/` dir holds plain-text prompt templates only (no code): `subagent-system.tmpl` (tool-free subagent system prompt), `capture-task.tmpl` (per-turn capture task, `{{TOOLS_SECTION}}` + `{{TRANSCRIPT}}` placeholders), `onboard.tmpl` (`/memoir:onboard` slash command), `startup-hint.tmpl` + `reminder.tmpl` (main-agent system prompts) |
| `src/store.ts` | ~71 | Branch auto-match, git branch/commit helpers, branch cache; thin wrapper over `deriveStorePath` (logic in `path.ts`) |
| `src/path.ts` | ~40 | Symlink-safe path helpers: `safeRealpath`, `slugify`, `deriveStorePath` (git-root/cwd → `~/.memoir/<slug>`) |
| `src/memory-saver.ts` | ~25 | Message counter for periodic reminders |
| `src/debug.ts` | ~60 | File logger: `infoLog` (always) + `debugLog` (`MEMOIR_DEBUG=1`); dest via `MEMOIR_LOG` |

### Hooks

- **`config`** — Registers the `memoir` subagent (`AgentConfig`, mode `subagent`, `memoir_*` tools only, every other tool denied), the `/memoir:onboard` slash command, and the shared `memoir` remote MCP server
- **`shell.env`** — Injects `MEMOIR_STORE` into shell environment
- **`chat.message`** — Increments message counter, auto-matches memoir branch, then **fire-and-forget captures** the just-completed turn via the `memoir` subagent
- **`experimental.chat.system.transform`** — Startup hint (once/session) + proactive recall (`memoir_summarize` injected as prior context) + periodic reminder (every N messages)
- **`dispose`** — Fires a final capture of each session, optionally saves a session marker, clears all pending state

All hooks wrap their body in try/catch, log via `debugLog()`, never propagate errors. Capture is fire-and-forget: the subagent runs as a detached child session (invisible in the parent timeline) and writes to memoir via `memoir_remember` — the parent session is never blocked or polluted.

## Environment Variables

All optional:

- `MEMOIR_DEBUG=1` — Verbose debug logging to stderr (`[memoir]` prefix). Basic lifecycle logs (server up, capture fired/skipped, recall injected) are always written to stderr regardless.
- `MEMOIR_LOG` — Log destination: unset → `$XDG_STATE_HOME/opencode/memoir-plugin-YYYY-MM-DD.log` (daily rotation, never stderr); `stderr` → live stderr (local debugging); any other value → explicit file path. Logs never pollute the opencode terminal by default.
- `MEMOIR_STORE` — Override store path (passed as `--store` to `memoir-mcp`)
- `MEMOIR_AUTO_SAVE` — Per-turn capture + final capture on dispose. **Enabled by default**; set `=0` to disable
- `MEMOIR_AGENT_MODEL` — Model for the `memoir` subagent, as `provider/model`. Overrides config. Falls back to `config.small_model` → `config.model` → openCode default
- `MEMOIR_CAPTURE_MIN_CHARS` — Local, LLM-free pre-filter; only transcripts at least this long are captured (default: 16, `0` = capture everything)
- `MEMOIR_REMINDER_INTERVAL=N` — Periodic reminder every N messages (default: 5, `0` to disable)

## Tests

8 test files, 61 tests total — Node built-in test runner via `tsx --test`.

| File | Tests | What it covers |
|------|------:|----------------|
| `tests/store.test.ts` | 11 | `deriveStorePath` (5), `currentGitBranch` (1), `branchCache` (3), `callMemoirTool` (1) |
| `tests/memory-saver.test.ts` | 7 | `incrementMsgCount` (3), `shouldRemind` (3), `pruneAll` (1) |
| `tests/subagent.test.ts` | 6 | `resolveMemoirModel` env/chain isolation (6) |
| `tests/capture.test.ts` | 7 | `buildTurnCaptureTask`, `shouldCaptureTurn`, `lastTurnTranscript`, `formatSessionTranscript`, `captureTurn` (fire-and-forget + dedup) |
| `tests/index.test.ts` | 12 | Module shape (1), hook registration & behavior (10), subagent registration (1) |
| `tests/debug.test.ts` | 3 | `MEMOIR_DEBUG` gating |
| `tests/prompts.test.ts` | 3 | `loadPrompt` — loads template verbatim with placeholders, caches (same reference), throws on missing |
| `tests/mcp-client.test.ts` | 4 | `listMemoirTools` — maps `{name, description}` (coerces non-string desc), caches (single server query), `[]` on throw / empty. Cache reset via `closeMemoirClient` in `beforeEach` |

Missing coverage: `autoMatchMemoirBranch` integration, subagent spawn over the live session API.

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
