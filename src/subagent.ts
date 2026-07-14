import type { AgentConfig } from "@opencode-ai/sdk";
import { debugLog, infoLog } from "./debug.js";

// opencode restricts an agent's available tools through its `permission`
// ruleset (NOT a `tools` allowlist — that field is ignored for config agents).
// `visibleTools` hides a tool only when the LAST rule matching its name has
// `{ pattern: "*", action: "deny" }`. So we deny "*" first, then re-allow
// the memoir_* MCP tools (and doom_loop) after it. Order matters: the
// re-allows must come AFTER "*" so findLast resolves in their favor.
//
// The SDK's AgentConfig.permission type is narrower than what opencode's
// runtime accepts (object form → Permission.fromConfig), hence the loose
// intersection below.
type MemoirAgentPermission = Record<string, string>;
export type MemoirAgentSpec = AgentConfig & {
  permission: MemoirAgentPermission;
  steps?: number;
};

export const MEMOIR_AGENT_NAME = "memoir";

// System prompt for the memoir subagent. It operates the memoir MCP server
// (memoir_* tools) and is locked to those tools only — no filesystem, no
// shell, no network. The per-call task (parts.text) tells it whether to
// capture (extract + remember) or to recall (summarize + get).
const MEMOIR_AGENT_PROMPT = `You are the Memoir memory agent for this coding session.

You manage a git-versioned, taxonomy-structured long-term memory through the
memoir MCP server. You have access ONLY to the following tools:
- memoir_memoir_remember — store a durable fact at an explicit taxonomy path
- memoir_memoir_recall — find relevant memory paths by query
- memoir_memoir_get — read exact memory paths
- memoir_memoir_summarize — list stored taxonomy paths
- memoir_memoir_status — store/branch status
- memoir_memoir_branches — list branches
- memoir_memoir_checkout — switch branch

General rules:
- Record ONLY verified, durable facts: user-stated preferences/constraints,
  project architecture/facts, decisions, and recurring patterns. Do NOT store
  raw conversation, ephemeral todo state, or speculative opinions.
- Use an explicit 3-level taxonomy path for every memoir_memoir_remember call
  (e.g. preferences.coding.languages, project.architecture.layout,
  decisions.api.auth). Never let the classifier guess — you pick the path.
- Prefer updating an existing path (memoir_memoir_get first) over duplicates.
- Be terse. Do not narrate your work back to the user.`;

/**
 * Build the memoir subagent config.
 *
 * Locked to memoir_* tools only (everything else denied) so it can never
 * touch the filesystem, shell, or network. opencode restricts an agent's
 * tools through its `permission` ruleset — see MemoirAgentSpec for why the
 * `*` deny must precede the `memoir_*` allow. Mode "subagent" makes
 * opencode spawn it as a detached child session (invisible in the parent
 * timeline) when prompted via client.session.prompt({ body: { agent: "memoir" } }).
 */
export function buildMemoirAgent(model?: string): MemoirAgentSpec {
  const agent: MemoirAgentSpec = {
    mode: "subagent",
    description:
      "Memoir memory agent — captures durable facts and recalls prior context via the memoir MCP server.",
    prompt: MEMOIR_AGENT_PROMPT,
    permission: { "*": "deny", doom_loop: "allow", "memoir_*": "allow" },
    steps: 8,
  };
  if (model) agent.model = model;
  return agent;
}

interface ModelResolution {
  summarizeModel?: string;
  smallModel?: string;
  model?: string;
}

/**
 * Resolve the model the memoir subagent should use.
 *
 * Priority:
 *   1. MEMOIR_AGENT_MODEL env (provider/model)
 *   2. config.small_model
 *   3. config.model
 *   4. omit — let opencode pick the session default
 *
 * Only "provider/model" shaped values are accepted; anything else is ignored
 * so we never hand opencode a bare model id it cannot resolve.
 */
export function resolveMemoirModel(opts: ModelResolution): string | undefined {
  const env = process.env.MEMOIR_AGENT_MODEL?.trim();
  const candidate = env || opts.summarizeModel || opts.smallModel || opts.model;
  if (!candidate) return undefined;
  return candidate.includes("/") ? candidate : undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Fire-and-forget dispatch of the memoir subagent via promptAsync.
 *
 * In opencode a subagent is a CHILD session spawned by the `task` tool. The
 * native trigger is a `subtask` part in the prompted message: the prompt loop
 * pops it and runs SessionPrompt.handleSubtask, which writes an assistant
 * message (mode = the agent name) plus a TaskTool tool-part, then
 * TaskTool.execute calls sessions.create({ parentID }) and runs the agent in
 * that child session. The UI renders the child as a COLLAPSED subagent inside
 * the parent timeline — exactly like the built-in explorer — never dumping the
 * agent's raw output inline into the main chat stream.
 *
 * The plugin client is the v1 SDK client; its promptAsync takes the
 * `{ path: { id }, body: { parts } }` shape. The running instance is already
 * bound to a working directory, so no `directory` is sent; the child session
 * inherits the parent's cwd/worktree.
 *
 * NOTE: noReply must NOT be set. promptSvc.prompt returns before the loop when
 * noReply is true, so the subtask would never be dispatched. promptAsync
 * itself forks and returns 204 immediately, so the dispatch stays
 * non-blocking for the caller.
 *
 * Errors are caught and routed to debugLog/infoLog so a failed capture never
 * breaks the user's session.
 */
export function runMemoirSubagent(client: unknown, parentSessionID: string, task: string): void {
  type SubtaskPart = {
    type: "subtask";
    agent: string;
    description: string;
    prompt: string;
    command?: string;
  };
  type PromptAsync = (options: {
    path: { id: string };
    body: { parts: SubtaskPart[] };
  }) => Promise<unknown>;

  const api = (client as { session?: { promptAsync?: PromptAsync } } | null | undefined)?.session;
  if (!api?.promptAsync) {
    debugLog("runMemoirSubagent: client.session.promptAsync unavailable");
    return;
  }

  void api
    .promptAsync({
      path: { id: parentSessionID },
      body: {
        parts: [
          {
            type: "subtask",
            agent: MEMOIR_AGENT_NAME,
            description: "memoir capture",
            prompt: task,
            command: "",
          },
        ],
      },
    })
    .catch((e: unknown) => {
      debugLog("runMemoirSubagent failed:", errorMessage(e));
      infoLog("memoir subagent dispatch FAILED:", errorMessage(e));
    });
  infoLog("memoir subagent fired (session", parentSessionID, ", task", task.length, "chars)");
}
