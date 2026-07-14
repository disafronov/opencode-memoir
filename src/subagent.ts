import type { AgentConfig } from "@opencode-ai/sdk";
import { log } from "./debug.js";
import { loadPrompt } from "./prompts.js";

// opencode restricts an agent's available tools through its `permission`
// ruleset (NOT a `tools` allowlist — that field is ignored for config agents).
// `visibleTools` hides a tool only when the LAST rule matching its name has
// `{ pattern: "*", action: "deny" }`. So we deny "*" first, then re-allow
// the memoir_* MCP tools (and doom_loop) after it, then deny checkout. Order
// matters: the specific checkout deny must be LAST so findLast keeps branch
// ownership in the plugin while every other memoir tool remains available.
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
export const MEMOIR_CHECKOUT_TOOL = "memoir_memoir_checkout";

// System prompt for the memoir subagent, loaded from prompts/subagent-system.tmpl.
// It is intentionally tool-free: the subagent is locked to the memoir_* tools
// via its `permission` ruleset (see buildMemoirAgent), and opencode already
// exposes those tools to it. The exact tool catalog — names + descriptions — is
// injected per call into the task prompt by buildTurnCaptureTask, so this prompt
// stays generic and reusable across memoir-mcp versions.
const MEMOIR_AGENT_PROMPT = loadPrompt("subagent-system.tmpl");

/**
 * Build the memoir subagent config.
 *
 * Locked to memoir_* tools except checkout (everything else denied) so it can
 * never touch the filesystem, shell, network, or the store-global branch.
 * opencode restricts an agent's tools through its `permission` ruleset — see
 * MemoirAgentSpec for why the checkout deny must follow the broad allow. Mode
 * "subagent" makes
 * opencode spawn it as a detached child session, rendered as a collapsed task
 * (visible in the parent timeline) when prompted via
 * client.session.prompt({ body: { agent: "memoir" } }).
 */
export function buildMemoirAgent(model?: string): MemoirAgentSpec {
  const agent: MemoirAgentSpec = {
    mode: "subagent",
    description:
      "Memoir memory agent — captures durable facts and recalls prior context via the memoir MCP server.",
    prompt: MEMOIR_AGENT_PROMPT,
    permission: {
      "*": "deny",
      doom_loop: "allow",
      "memoir_*": "allow",
      [MEMOIR_CHECKOUT_TOOL]: "deny",
    },
    temperature: 0,
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
  const candidates = [
    process.env.MEMOIR_AGENT_MODEL?.trim(),
    opts.summarizeModel,
    opts.smallModel,
    opts.model,
  ];
  return candidates.find((candidate) => candidate?.includes("/"));
}

/** Queue a visible subtask through OpenCode's supported promptAsync input API. */
export async function runMemoirSubagent(
  client: unknown,
  parentSessionID: string,
  task: string,
): Promise<void> {
  type SubtaskPartInput = {
    type: "subtask";
    agent: string;
    description: string;
    prompt: string;
    command?: string;
  };
  type PromptAsync = (options: {
    path: { id: string };
    body: { parts: SubtaskPartInput[] };
  }) => Promise<unknown>;

  const api = (client as { session?: { promptAsync?: PromptAsync } } | null | undefined)?.session;
  if (!api?.promptAsync) {
    throw new Error("client.session.promptAsync unavailable");
  }

  try {
    await api.promptAsync({
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
    });
    log("memoir subtask accepted (session", parentSessionID, ", task", task.length, "chars)");
  } catch (e) {
    log("runMemoirSubagent failed", e);
    throw e;
  }
}
