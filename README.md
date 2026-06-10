# opencode-memoir

OpenCode plugin for [Memoir](https://github.com/zhangfengcdt/memoir): git-versioned, taxonomy-structured memory for coding agents.

The OpenCode counterpart to the Claude Code and Codex Memoir plugins. Derives a per-project store under `~/.memoir/<path-slug>`, resolves the `memoir` CLI with `uvx` fallback, and exposes commands/tools for status, recall, remember, and UI launch.

## Install

Add to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugin": [
    "npm:opencode-memoir"
  ]
}
```

OpenCode resolves the package via npm automatically; no manual download needed.

### Alternative: global install

```bash
npm install -g opencode-memoir
```

Then reference it by path in your config:

```jsonc
{
  "plugin": [
    "opencode-memoir"
  ]
}
```

The plugin auto-resolves the `memoir` CLI: first from `PATH`, then via `uvx --from memoir-ai==<pin> memoir` (no separate install needed).

## Quick start

1. Install the plugin (see above)
2. Run `/memoir:status` in any project to verify the store was created
3. Start saving memories with `/memoir:remember` or let the agent auto-capture

## Store configuration

The plugin uses the same environment variable as the Claude Code plugin:

| Source | Description |
|---|---|
| plugin option `store` | Highest-priority override when the plugin is loaded from `plugin[]` |
| `MEMOIR_STORE` | Portable global/project override |
| auto-derived path | `~/.memoir/<slug>`, where slug = git root (or resolved cwd) with `/` and `.` replaced by `-`; all worktrees share one store |

Example when loading through `plugin[]`:

```jsonc
{
  "plugin": [
    ["npm:opencode-memoir", { "store": "/custom/store/path" }]
  ]
}
```

## Environment variables

All variables are optional. Capture and sanitization are on by default.

| Variable | Effect |
|---|---|
| `MEMOIR_STORE` | Override the derived store path (see above). |
| `MEMOIR_DEBUG=1` | Emit diagnostic logs to stderr (prefixed `[memoir]`). All internal errors are logged here instead of failing silently. Off by default. |
| `MEMOIR_NO_CAPTURE=1` | Disable all capture — no metrics, no code-change tracking, no branch auto-match flush. Superset switch. |
| `MEMOIR_NO_METRICS=1` | Disable per-tool metrics only (`metrics.turn.<branch>`). Code-change tracking still runs. |
| `MEMOIR_NO_CODE_SUMMARY=1` | Disable code-change tracking only (`metrics.code.<branch>`). Metrics still run. |
| `MEMOIR_SANITIZE_SECRETS=0` | Disable the secret-pattern guard on `memoir_remember`. Sanitization is **on** by default; set to `0` only if the guard produces false positives you understand. |

Capture guards are checked at the collection point (`tool.execute.after`) and the flush point (`chat.message`), so setting them mid-session takes effect on the next turn.

## Commands

| Command | Description |
|---|---|
| `/memoir:status` | Show status for the current project store, including project git branch metadata |
| `/memoir:ui` | Launch or reopen the Memoir web UI |
| `/memoir:remember <memory>` | Ask the agent to save an explicit durable memory with a semantic path |
| `/memoir:recall <topic>` | Ask the agent to list and use relevant stored memories |
| `/memoir:onboard` | Populate or refresh the project onboarding snapshot |
| `/memoir:unmerged` | List memoir branches that have diverged from `main` |

## Tools

| Tool | Description |
|---|---|
| `memoir_status` | Run the status helper |
| `memoir_remember` | Save explicit content to one or more semantic paths; refuses secret-like content |
| `memoir_recall` | List memory keys via `summarize` for relevance selection |
| `memoir_get` | Fetch selected exact keys after `memoir_recall` |

## Hooks

The plugin registers eight OpenCode hooks, mirroring the Claude Code plugin's lifecycle:

| Hook | Purpose |
|---|---|
| `config` | Registers slash commands |
| `command.execute.before` | Handles `/memoir:status`, `/memoir:ui`, `/memoir:unmerged` |
| `shell.env` | Injects `MEMOIR_STORE` into shell env |
| `event` | On `session.created`, fetches the taxonomy overview in the background |
| `tool.execute.after` | Accumulates per-tool metrics + file edits for code change audit |
| `chat.message` | Auto-matches memoir branch to git branch, flushes capture, runs recall gate |
| `experimental.chat.system.transform` | Injects taxonomy context + recall instruction |
| `dispose` | Flushes remaining data, prunes session state |

See the [Memoir docs](https://zhangfengcdt.github.io/memoir/) for detailed hook behaviour.

## Memoir CLI resolution

1. `memoir` on `PATH`
2. `uvx --from memoir-ai==<pin> memoir` — ephemeral, pinned
3. `uv tool run --from memoir-ai==<pin> memoir` — pinned fallback

Every command passes an explicit `-s <store>` to keep the project git and Memoir store separate.

## Development

### Prerequisites

- Node.js >= 20
- `memoir` CLI somewhere accessible, OR `uv` installed (the plugin falls back to `uvx`)

### Setup

```bash
npm install
npm run build    # typecheck + emit dist
npm test         # run the test suite (69 tests)
```

### Source layout

| File | Responsibility |
|---|---|
| `src/store.ts` | CLI resolution + runner, git/worktree helpers, store-path derivation, branch management |
| `src/capture.ts` | Edit tracking, per-tool metrics, `flushCapture` (read-merge-write of `metrics.*`) |
| `src/recall-gate.ts` | Secret pattern + sanitization toggle, recall-gate trigger logic |
| `src/index.ts` | Plugin wiring — tool definitions, hooks, command registration |
| `src/debug.ts` | Shared debug logger |

### Tests

```bash
npm test
```

69 tests across 5 files. Run with `tsx --test` (handles `.js` → `.ts` resolution under NodeNext).

To debug hooks locally, run OpenCode with `MEMOIR_DEBUG=1` and watch stderr for `[memoir]` lines.

## Publishing

```bash
# Log in to npm (one-time)
npm login

# Bump version, build, test, publish
npm version patch   # minor | major
npm publish
```

The `prepublishOnly` script runs `build` + `test` automatically. Published files are limited to `dist/` and `README.md` (see `files` in `package.json`).

## License

Apache-2.0
