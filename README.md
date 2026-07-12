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
| `MEMOIR_AUTO_SAVE=1` | Auto-save session marker on dispose (default: disabled) |
| `MEMOIR_REMINDER_INTERVAL=N` | Periodic save/recall reminder every N messages (default: 5, 0 to disable) |

## Hooks

| Hook | Purpose |
|---|---|
| `config` | Registers `memoir-mcp` as a dynamic MCP server; adds `/memoir:onboard` slash command |
| `shell.env` | Injects `MEMOIR_STORE` into shell environment |
| `chat.message` | Increments message counter; auto-matches memoir branch to current git branch |
| `experimental.chat.system.transform` | Startup hint (once/session); periodic save/recall reminder |
| `dispose` | Optionally saves session marker; clears all pending state |

## How it works

Instead of wrapping the `memoir` CLI and re-implementing tools in TypeScript, this plugin registers `memoir-mcp` as a dynamic MCP server. OpenCode starts the server via the `memoir-mcp` command, and all memoir tools (`memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_get`, etc.) are available natively to the LLM.

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

