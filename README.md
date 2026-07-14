# opencode-memoir

OpenCode plugin for [Memoir](https://github.com/zhangfengcdt/memoir): git-versioned, taxonomy-structured memory for coding agents.

Dynamically loads the `memoir-mcp` MCP server.

## Install

Prerequisite: install the Memoir CLI and MCP server first:

```bash
uv tool install --python 3.13 "memoir-ai[mcp]"
```

Then add the plugin to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugin": [
    "opencode-memoir"
  ]
}
```

OpenCode downloads and resolves the package from npm automatically. To pin a version, append it: `"opencode-memoir@1.0.0"`.

## Quick start

1. Install the plugin (see above)
2. Start coding — the agent can use `memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_get` MCP tools automatically

Automatic capture works without additional OpenCode flags. By default, capture
runs through the regular foreground subagent path for compatibility with older
OpenCode installations.

To run capture as a native background task, enable OpenCode's experimental
background-subagent support before starting OpenCode:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

With this flag, capture no longer blocks the parent session while the memoir
subagent extracts and stores durable facts.

## Store configuration

The plugin delegates store path resolution to `memoir-mcp`. Override via `MEMOIR_STORE` env var or `store` plugin option:

```jsonc
{
  "plugin": [
    ["opencode-memoir", { "store": "/custom/store/path" }]
  ]
}
```

## Environment variables

All optional:

| Variable | Effect |
|---|---|
| `MEMOIR_STORE` | Override store path (passed to memoir-mcp as `--store`) |
| `MEMOIR_DEBUG=1` | Emit diagnostic logs to stderr (prefixed `[memoir]`) |
| `MEMOIR_AUTO_SAVE` | Per-turn capture + final capture on dispose. **Enabled by default**; set `=0` to disable |
| `MEMOIR_AGENT_MODEL` | Model for the `memoir` subagent, as `provider/model`. Falls back to `small_model` → `model` → openCode default |
| `MEMOIR_CAPTURE_MIN_CHARS` | Local pre-filter; only transcripts at least this long are captured (default: 16, `0` = capture everything) |
| `MEMOIR_REMINDER_INTERVAL=N` | Periodic save/recall reminder every N messages (default: 5, 0 to disable) |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | Optional OpenCode feature flag. Runs automatic memoir capture as a native background job; without it, capture uses the compatible foreground path |

## Hooks

| Hook | Purpose |
|---|---|
| `config` | Registers the `memoir` subagent (capture + recall), the shared `memoir-mcp` remote MCP server, and the `/memoir:onboard` slash command |
| `shell.env` | Injects `MEMOIR_STORE` into shell environment |
| `chat.message` | Increments message counter; auto-matches memoir branch; fire-and-forget captures the completed turn via the `memoir` subagent |
| `tool.execute.before` | Marks memoir's `task` invocation with `background: true` when OpenCode background subagents are enabled |
| `experimental.chat.system.transform` | Startup hint (once/session) + proactive recall (`memoir_summarize` injected as prior context) + periodic reminder |
| `dispose` | Fires a final capture of each session; optionally saves a session marker; clears all pending state |

## How it works

Instead of wrapping the `memoir` CLI and re-implementing tools in TypeScript, this plugin registers `memoir-mcp` as a **remote** MCP server — a single shared HTTP process spawned by the plugin. All memoir tools (`memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_get`, etc.) are available natively to the LLM.

Capturing is done by a dedicated `memoir` subagent (mode `subagent`, restricted to `memoir_*` tools). On each completed turn, `chat.message` dispatches a `task` for that subagent.

- With `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, the plugin adds `background: true` in `tool.execute.before`. OpenCode runs the child through its native `BackgroundJob` path and immediately releases the parent session.
- Without the flag, the plugin does not add `background`; OpenCode runs the same capture task through the original foreground subagent path. Memory capture remains available, but the parent session may wait for it to finish.

At session start, `experimental.chat.system.transform` injects a recall hint plus a `memoir_summarize` snapshot so the agent begins with prior context.

## Development

### Prerequisites

- Node.js >= 20
- `memoir-ai[mcp]` installed (see Install above)

### Setup

```bash
npm install
npm run build    # typecheck + emit dist
npm test         # run the test suite
```

### Source layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: MCP registration + all hooks + dispose |
| `src/store.ts` | Store path derivation, branch auto-match, `callMemoir` CLI helper |
| `src/memory-saver.ts` | Per-session message counter for periodic reminders |
| `src/debug.ts` | Conditional stderr logger (`MEMOIR_DEBUG=1`) |

## Publishing

Releases are fully automated — no manual `npm version` or `npm publish`.

1. Land changes on `main` via PR using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
2. On push to `main`, `.github/workflows/semantic.yaml` runs [semantic-release](https://semantic-release.gitbook.io/)
3. The new tag triggers `.github/workflows/publish-npm.yaml`, which builds and runs `npm publish --provenance`
