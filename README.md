# opencode-memoir

OpenCode plugin for [Memoir](https://github.com/zhangfengcdt/memoir): git-versioned, taxonomy-structured memory for coding agents.

Launches the globally installed `memoir-mcp` console script and registers it as
a project-scoped remote MCP server.

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
runs in a hidden throwaway session with no parent session, so it does not add a
subtask or response to the active conversation. Each completed turn is
snapshotted immediately; capture dispatch is then queued per parent session and
does not block the `chat.message` hook.

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
| --- | --- |
| `MEMOIR_STORE` | Override store path (passed to memoir-mcp as `--store`) |
| `MEMOIR_DEBUG=1` | Add verbose diagnostics and error stacks to the configured Memoir log; without it, normal lifecycle and concise error messages are still logged |
| `MEMOIR_LOG` | Log destination: unset uses `$XDG_DATA_HOME/opencode/log/memoir/YYYY-MM-DD.log`; `stderr` enables live stderr; any other value is an explicit file path |
| `MEMOIR_AUTO_SAVE` | **Turn capture** (the previous completed turn is saved when the next real user message arrives) is **enabled by default**; set `=0` to disable it |
| `MEMOIR_AGENT_MODEL` | Model for the `memoir` subagent, as `provider/model`. Falls back to `small_model` → `model` → openCode default |
| `MEMOIR_CAPTURE_MIN_CHARS` | Local pre-filter; only transcripts at least this long are captured (default: 16, `0` = capture everything) |

## Hooks

| Hook | Purpose |
| --- | --- |
| `config` | Registers the `memoir` subagent, one project-scoped `memoir-mcp` remote MCP server, and the `/memoir:onboard` slash command |
| `shell.env` | Injects `MEMOIR_STORE` into shell environment |
| `chat.message` | Queues capture of the previous completed turn, auto-matches the memoir branch, and returns without waiting for `promptAsync`; ignores synthetic and memoir-child messages |
| `event` | Completes and deletes hidden capture sessions when they become idle or fail |
| `dispose` | Drains queued and active captures, closes the project MCP process, and clears instance state |

## How it works

Instead of wrapping the `memoir` CLI and re-implementing tools in TypeScript, this plugin registers `memoir-mcp` as a **remote** MCP server — one HTTP process per plugin/project instance. All memoir tools (`memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_get`, etc.) are available natively to the main LLM.

Capturing is done by the dedicated hidden `memoir` subagent. It can use the
dynamic `memoir_*` tool namespace except for the store-global
`memoir_memoir_checkout`; branch checkout remains owned by the plugin so a
subagent cannot move the shared store. Every non-Memoir tool remains denied.
The capture task includes the live MCP tool names and descriptions so a small
local model does not have to infer the catalog.

On each real `chat.message`, the plugin immediately snapshots the previous
completed turn: the incoming user message has not entered the transcript yet.
Only dispatch is serialized per parent session, so a delayed earlier submission
cannot make a later turn disappear from the queue. Branch matching remains
serialized for the shared store. A hidden throwaway session is then created
without a `parentID` and submitted through `promptAsync`. The hook itself does
not wait for that submission, and the subagent is instructed to store memories
without emitting a response. Terminal session events remove completed
throwaway sessions. During shutdown, `dispose` waits for queued submissions and
active capture sessions before closing the owned MCP process.

## Development

### Prerequisites

- Node.js >= 20
- `memoir-ai[mcp]` installed (see Install above)

### Setup

```bash
make install     # install dependencies and Git hooks
npm run build    # typecheck + emit dist
npm test         # run the test suite
```

### Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry: async branch matching, MCP registration, capture queues, hooks, and dispose |
| `src/mcp-client.ts` | Project-scoped MCP process/client lifecycle and tool calls |
| `src/capture.ts` | Transcript extraction, filtering, task construction, and capture dispatch |
| `src/subagent.ts` | Subagent permissions, model selection, and OpenCode task dispatch |
| `src/path.ts` | Symlink-safe project and store path helpers |
| `src/prompts.ts` | Cached prompt-template loader |
| `src/status.ts` | Decoder for `memoir_status` responses used by branch matching |
| `src/debug.ts` | File/stderr lifecycle and debug logger |

## Publishing

Releases are fully automated — no manual `npm version` or `npm publish`.

1. Land changes on `main` via PR using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
2. On push to `main`, `.github/workflows/semantic.yaml` runs [semantic-release](https://semantic-release.gitbook.io/)
3. The new tag triggers `.github/workflows/publish-npm.yaml`, which builds and runs `npm publish --provenance`
