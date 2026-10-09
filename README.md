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

The plugin derives a store path under `~/.memoir/` from the project repository.
Linked Git worktrees of the same repository share that store by default.
Override via `MEMOIR_STORE` env var or `store` plugin option:

```jsonc
{
  "plugin": [
    ["opencode-memoir", { "store": "/custom/store/path" }]
  ]
}
```

Run only one active OpenCode instance per Memoir store. Concurrent instances
sharing a store are unsupported, including instances in different Git worktrees:
one instance can switch the store's branch while another is still capturing,
causing memories to be saved on the wrong branch. Finish one instance before
starting another, or configure a separate store for each concurrent instance.
Separate stores have independent memory and history. This restriction also
applies to multiple project instances hosted by a single OpenCode server.

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
`CaptureCoordinator` serializes branch matching and capture submission together
across parent sessions within each plugin instance. Snapshots are read immediately,
so a delayed earlier submission cannot make a later turn disappear from the queue.
An accepted capture is tracked before the next submission may switch branches;
switching waits for active captures to finish. Within that instance, captures on the same branch can
continue running in parallel after submission. A hidden throwaway session is created
without a `parentID` and submitted through `promptAsync`. The hook itself does
not wait for that submission, and the subagent is instructed to store memories
without emitting a response. Terminal session events remove completed
throwaway sessions. During shutdown, `dispose` waits for queued submissions and
active capture sessions before closing the owned MCP process. Capture state distinguishes
prompt acceptance from terminal completion. A background `session.error` triggers
one retry of the original snapshot on the same project branch. Further errors,
a branch change, or shutdown stop retries. Completion means the subagent finished;
it can legitimately decide that there is nothing durable to store.

## Development

### Prerequisites

- Node.js >= 20
- `memoir-ai[mcp]` installed (see Install above)

### Setup

```bash
make install     # install dependencies and Git hooks
npm run build    # typecheck + emit dist
npm test         # run the test suite
make integration # optional live OpenCode + memoir-mcp protocol check
```

The integration check requires `opencode` and `memoir-mcp` on PATH. It uses a
temporary Git project, isolated OpenCode configuration/data, and a temporary
Memoir store. A deterministic local OpenAI-compatible endpoint triggers a
background error and verifies one retry, memory persistence, branch selection,
subagent tool permissions, and temporary-session cleanup. OpenCode may download
the configured `@ai-sdk/openai-compatible` provider package; no external model
inference or provider credentials are required. Temporary services and files are
removed after the check.

### Source layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry: async branch matching, MCP registration, hooks, and dispose |
| `src/capture-coordinator.ts` | Capture queues, deduplication state, hidden-session tracking, and shutdown |
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
