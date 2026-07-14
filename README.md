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
| `MEMOIR_AUTO_SAVE` | Captures the previous completed turn when the next real user message arrives. **Enabled by default**; set `=0` to disable |
| `MEMOIR_AGENT_MODEL` | Model for the `memoir` subagent, as `provider/model`. Falls back to `small_model` → `model` → openCode default |
| `MEMOIR_CAPTURE_MIN_CHARS` | Local pre-filter; only transcripts at least this long are captured (default: 16, `0` = capture everything) |
| `MEMOIR_REMINDER_INTERVAL=N` | Periodic save/recall reminder every N messages (default: 5, 0 to disable) |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | Optional OpenCode feature flag. Runs automatic memoir capture as a native background job; without it, capture uses the compatible foreground path |

## Hooks

| Hook | Purpose |
|---|---|
| `config` | Registers the `memoir` subagent, one project-scoped `memoir-mcp` remote MCP server, and the `/memoir:onboard` slash command |
| `shell.env` | Injects `MEMOIR_STORE` into shell environment |
| `chat.message` | Captures the previous completed turn, tracks real parent messages, and auto-matches the memoir branch; ignores synthetic and memoir-child messages |
| `tool.execute.before` | Marks memoir's `task` invocation with `background: true` when OpenCode background subagents are enabled |
| `experimental.chat.system.transform` | Startup hint (once/session) + proactive recall (`memoir_summarize` injected as prior context) + periodic reminder |
| `dispose` | Optionally saves session markers, closes the project MCP process, and clears instance state |

## How it works

Instead of wrapping the `memoir` CLI and re-implementing tools in TypeScript, this plugin registers `memoir-mcp` as a **remote** MCP server — one HTTP process per plugin/project instance. All memoir tools (`memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_get`, etc.) are available natively to the main LLM.

Capturing is done by a dedicated visible, collapsible `memoir` subagent. It can use the dynamic `memoir_*` tool namespace except for the store-global `memoir_memoir_checkout`; branch checkout remains owned by the plugin so a subagent cannot move the shared store. Every non-Memoir tool remains denied. The capture task includes the live MCP tool names and descriptions so a small local model does not have to infer the catalog. Deterministic settings keep it suitable for that model. On each real `chat.message`, the plugin captures the previous completed turn: the incoming user message has not entered the transcript yet. This one-turn delay prevents capture activity from triggering another capture.

After each real parent-session message, every model call in that turn receives a compact status from `memoir_status`, such as `[memoir] fix6 · memory available (31 memories)`. Synthetic notifications and memoir child activity do not update it, and the status does not instruct the model to perform recall.

- With `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`, the plugin adds `background: true` in `tool.execute.before`. OpenCode runs the child through its native `BackgroundJob` path and immediately releases the parent session.
- Without the flag, the plugin does not add `background`; OpenCode runs the same capture task through the original foreground subagent path. Memory capture remains available, but the parent session may wait for it to finish.
- Before changing the shared memoir branch, the plugin waits for active foreground tasks (`tool.execute.after`) and native background tasks (the known child session's terminal idle/error event). A timeout defers checkout instead of moving the store underneath a running capture.

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
npm run test:coverage # optional source coverage report
```

### Source layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry: MCP registration + all hooks + dispose |
| `src/mcp-client.ts` | Project-scoped MCP process/client lifecycle and tool calls |
| `src/store.ts` | Store path derivation and serialized store-branch matching |
| `src/memory-saver.ts` | Per-session message counter for periodic reminders |
| `src/debug.ts` | Conditional stderr logger (`MEMOIR_DEBUG=1`) |

## Publishing

Releases are fully automated — no manual `npm version` or `npm publish`.

1. Land changes on `main` via PR using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
2. On push to `main`, `.github/workflows/semantic.yaml` runs [semantic-release](https://semantic-release.gitbook.io/)
3. The new tag triggers `.github/workflows/publish-npm.yaml`, which builds and runs `npm publish --provenance`
