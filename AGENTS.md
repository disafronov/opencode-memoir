# AGENTS.md

## What This Repo Is

OpenCode plugin (`opencode-memoir`) that launches the globally installed `memoir-mcp` console script for git-versioned AI memory. Users install it with `uv tool install --python 3.13 "memoir-ai[mcp]"`; the plugin intentionally does not wrap the launch in `uvx`. TypeScript/Node.js ESM package.

## Critical Commands

```bash
# Development
npm run build          # tsc declarations + esbuild bundle to dist/
npm run typecheck      # tsc --noEmit (strict mode)
npm test              # tsx --test tests/*.test.ts (Node built-in test runner)
npm run test:coverage # optional built-in source coverage report

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

Each plugin/project instance owns one `memoir-mcp` HTTP server (spawned directly as `memoir-mcp --store … --http --host 127.0.0.1 --port …`, started in the `config` hook). It is registered as a **remote** MCP server: `mcp: { memoir: { type: 'remote', url, enabled: true } }`. OpenCode connects to it, and the plugin's own hooks use the same URL via an internal MCP client (`mcp-client.ts`). One process per instance, no stdio double-spawn. The direct console-script launch is intentional: commit `01d0724` removed `uvx` because OpenCode's plugin resolver truncated the `uvx --python 3.13` command array. The `mcp` field is NOT in `@opencode-ai/plugin`'s `Hooks` type, but OpenCode's Go runtime accepts it (`return hooks as unknown as Hooks`).

### Source Layout

| File | Lines | Role |
|------|------:|------|
| `src/index.ts` | ~330 | Plugin entry: subagent + MCP registration, all hooks, capture wiring, dispose |
| `src/mcp-client.ts` | ~310 | Instance-owned HTTP `memoir-mcp` process + internal `Client` + cached live tool catalog + `callMemoirTool`; reconnectable lifecycle |
| `src/subagent.ts` | ~165 | Visible, collapsible `memoir` subagent restricted to the dynamic `memoir_*` namespace except store-global checkout + runner + model fallback resolution |
| `src/capture.ts` | ~235 | Per-turn capture orchestration: transcript extraction, min-chars pre-filter, live tool-catalog injection, compact outcome reporting, dispatch dedup/retry |
| `src/capture-lifecycle.ts` | ~60 | Tracks foreground/background memoir tasks and blocks branch checkout until active captures finish |
| `src/prompts.ts` | ~25 | Cached `.tmpl` loader. Capture task has `{{TOOLS_SECTION}}` and `{{TRANSCRIPT}}` placeholders; permissions independently enforce the `memoir_*` boundary |
| `src/store.ts` | ~71 | Explicit-directory store derivation and instance-owned, serialized store-branch matcher |
| `src/path.ts` | ~40 | Symlink-safe path helpers: `safeRealpath`, `slugify`, `deriveStorePath` (git-root/cwd → `~/.memoir/<slug>`) |
| `src/turn-status.ts` | ~20 | Builds the compact per-turn model status from the `memoir_status` response |
| `src/debug.ts` | ~60 | File logger: `infoLog` (always) + `debugLog` (`MEMOIR_DEBUG=1`); dest via `MEMOIR_LOG` |

### Hooks

- **`config`** — Registers the `memoir` subagent (`memoir_*` allowed except store-global checkout, every non-Memoir tool denied), the `/memoir:onboard` slash command, and the project-scoped `memoir` remote MCP server
- **`shell.env`** — Injects `MEMOIR_STORE` into shell environment
- **`chat.message`** — Captures the previous completed turn with a deliberate one-turn delay, increments the counter, auto-matches the memoir branch, and refreshes the compact model status; ignores synthetic and memoir-child messages so capture cannot trigger itself
- **`tool.execute.before` / `tool.execute.after` + `event`** — Tracks actual memoir task execution; foreground ends at `tool.execute.after`, background ends when its known child session becomes idle or errors
- **`experimental.chat.system.transform`** — Compact current status (every model call in the turn) + startup hint and proactive recall (once/session)
- **`dispose`** — Saves session markers only when `MEMOIR_AUTO_SAVE=1` is explicit, closes the instance MCP process, and clears pending state

Runtime hook failures are contained and logged; capture itself is fire-and-forget and does not propagate failures into the user turn. Its child session is intentionally visible as a collapsed subagent in the parent timeline, writes through `memoir_remember`, and returns a compact outcome report to the parent task.

## Environment Variables

All optional:

- `MEMOIR_DEBUG=1` — Adds verbose entries to the configured Memoir log. Basic lifecycle entries (server up, capture fired/skipped, recall injected) are always logged.
- `MEMOIR_LOG` — Log destination: unset → `$XDG_STATE_HOME/opencode/memoir-plugin-YYYY-MM-DD.log` (daily rotation, never stderr); `stderr` → live stderr (local debugging); any other value → explicit file path. Logs never pollute the opencode terminal by default.
- `MEMOIR_STORE` — Override store path (passed as `--store` to `memoir-mcp`)
- `MEMOIR_AUTO_SAVE` — Captures the previous completed turn when the next real user message arrives. **Enabled by default**; set `=0` to disable
- `MEMOIR_AGENT_MODEL` — Model for the `memoir` subagent, as `provider/model`. Overrides config. Falls back to `config.small_model` → `config.model` → openCode default
- `MEMOIR_CAPTURE_MIN_CHARS` — Local, LLM-free pre-filter; only transcripts at least this long are captured (default: 16, `0` = capture everything)
- `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` — Dedicated native-background flag. If unset, OpenCode and the plugin fall back to `OPENCODE_EXPERIMENTAL`; explicit `false` overrides the umbrella flag

## Tests

9 test files, 82 tests total — Node built-in test runner via `tsx --test`.

| File | Tests | What it covers |
|------|------:|----------------|
| `tests/store.test.ts` | 13 | Path derivation, current branch, MCP tool errors, and serialized branch matching |
| `tests/subagent.test.ts` | 8 | Model fallback isolation and dynamic Memoir-namespace permissions |
| `tests/capture.test.ts` | 18 | Transcript extraction, filtering, malformed APIs, live tool prompt, dispatch retry, and dedup |
| `tests/capture-lifecycle.test.ts` | 3 | Foreground/background task tracking, drain completion, and timeout behavior |
| `tests/index.test.ts` | 22 | Module shape, hook behavior, background flag parity, connected recall/status/session-marker flow, self-trigger filtering, and graceful degradation |
| `tests/debug.test.ts` | 5 | Debug gating plus normal file/stderr lifecycle logging |
| `tests/prompts.test.ts` | 3 | `loadPrompt` — loads template verbatim with placeholders, caches (same reference), throws on missing |
| `tests/mcp-client.test.ts` | 8 | Per-instance ownership, real child lifecycle, concurrent start/connect, reconnect, tool-catalog caching, and error recovery |
| `tests/turn-status.test.ts` | 2 | Status formatting, partial responses, and malformed-response degradation |

Remaining integration gap: a full live OpenCode + real `memoir-mcp` protocol
session (the process lifecycle itself is covered with a fixture server).

Latest built-in coverage snapshot: 98.71% lines, 88.13% branches, 94.92%
functions. These are descriptive measurements, not mandatory CI thresholds.

## Build Pipeline

The build first removes `dist/`, then runs two stages:
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
