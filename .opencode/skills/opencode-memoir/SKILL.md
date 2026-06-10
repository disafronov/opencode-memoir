# opencode-memoir plugin

OpenCode plugin for [Memoir](https://github.com/zhangfengcdt/memoir): git-versioned, taxonomy-structured memory for coding agents.

Load this skill when working on the plugin itself. For general usage, see `README.md`.

## Quick reference

```bash
npm install          # install deps
npm run build        # tsc compile → dist/
npm test             # 70 tests via tsx --test
npm run typecheck    # tsc --noEmit
npm pack --dry-run   # preview publish contents
npm publish          # requires npm login
```

## Architecture

5 source modules under `src/`:

| Module | File | Responsibility |
|---|---|---|
| **store** | `src/store.ts` | CLI resolution + runner, git/worktree helpers, store-path derivation, branch management, per-store mutex, store creation lock |
| **capture** | `src/capture.ts` | Edit tracking, per-tool metrics, `flushCapture` (read-merge-write of `metrics.*`), session isolation via `Map<sessionID, ...>` |
| **recall-gate** | `src/recall-gate.ts` | Secret pattern + sanitization toggle, recall-gate trigger logic, pending-recall tracking |
| **index** | `src/index.ts` | Plugin wiring — 4 tool definitions, 8 hooks, command registration |
| **debug** | `src/debug.ts` | `debugLog(...)` — stderr logging under `MEMOIR_DEBUG=1` |

Tests under `tests/` — 5 files, 70 tests. Run with `tsx --test`.

### Hooks (8 total)

`config` → `command.execute.before` → `shell.env` → `event` (session.created) → `tool.execute.after` → `chat.message` → `experimental.chat.system.transform` → `dispose`

### Tool-system contract

- `tool.execute.after` accumulates into per-session maps — never reads the store
- `chat.message` snapshots + drains per-session state, then calls `flushCapture` (the only writer)
- `flushCapture` uses a **per-store mutex** (promise-chain FIFO) to serialize reads/writes
- **Atomic swap**: data grabbed and replaced with empty containers inside the lock closes the window between snapshot and drain
- **Branch snapshot**: `chat.message` snapshots `cachedBranch` *before* calling `autoMatchMemoirBranch`, preventing cross-branch misattribution

## Current state: 9.5/10

### What's solid
- 70 tests, 0 failures, clean build
- Session isolation: pendingEdits/toolMetrics/cachedBranch per `Map<sessionID>`
- Per-store FIFO mutex (no concurrent memoir writes to same store)
- 15s timeout on all CLI calls (no hangs)
- **Write-failure safety**: atomic swap + data restoration on I/O failure (no data loss)
- Secret sanitization with disable toggle (`MEMOIR_SANITIZE_SECRETS=0`) + word-boundary patterns
- `memoir_get` key limit (max 20) prevents OS arg-length crashes
- macOS compat (`path.resolve` instead of `realpath -m`)
- Non-git cwds handled (scratch git dir for `memoir new`)
- Escape hatches: `MEMOIR_NO_CAPTURE`, `MEMOIR_NO_METRICS`, `MEMOIR_NO_CODE_SUMMARY`
- Initial context injection via `event`(session.created) + `experimental.chat.system.transform`
- Caching: `memoirResolved` (skip redundant fallback probing), `_noGitCache` (skip failing git calls)
- GitHub Actions CI (Node 20 + 22 on push/PR)
- ISO timestamp in debug logs
- Expanded edit-tool tracking (ApplyPatch, MultiFileEdit)

### What's missing / next steps

| Priority | What | Why |
|---|---|---|
| **High** | Publish to npm (`npm publish`) | `npm pack --dry-run` clean. CI ready. Just needs `npm publish`. |
| **Medium** | Integration tests with real memoir CLI | Currently smoke-test only (self-skips without CLI). Useful before major releases |
| **Future** | `memoir_remember` edit dedup | Tool-tracking already captures edits, could cross-reference |

### Cannot do (SDK limitation)

The OpenCode plugin SDK has no LLM invocation API, no transcript access in server plugins. Therefore:
- **No auto-capture of facts** (Claude Code does this via Haiku)
- **No code-change summary via LLM** (Claude Code uses Haiku)
- **No statusline widget** (TUI API not exposed to server plugins)

All three are deliberate design gaps vs Claude Code — the plugin relies on prompt-engineering (system prompt instructions in `memoir:remember` template) + `SECRET_PATTERN` regex instead.

## Critical rules for AI

- **Never commit or push without explicit user permission.**
- **Never skip `npm run build && npm test` before committing.** TypeScript won't save you from runtime test failures.
- **Use `debugLog(...)` for diagnostics, not `console.log`.** Writes to stderr only under `MEMOIR_DEBUG=1`.
- **Import with `.js` extensions** — module resolution is `NodeNext`, so `from './foo.js'` resolves to `foo.ts`.
- **Async-first.** All hooks are async. Prefer `execFileAsync` over `execFileSync`.
- **Errors at boundaries only.** Wrap hooks in try/catch; let internal functions throw if preconditions are violated.
- **Never add `catch {}`** — always `catch (e) { debugLog(...) }` at minimum.
- **Don't bypass the session isolation pattern.** Every session-scoped state goes into a `Map<sessionID, ...>`.

## Publishing

```bash
npm login                          # one-time
npm version patch                  # or minor / major
npm publish                        # prepublishOnly runs build + test
```

After publish, users add `"npm:opencode-memoir"` to their OpenCode config.
