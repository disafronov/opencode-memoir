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
// exposes those tools to it. The task prompt no longer carries the tool catalog
// (it was removed); the subagent relies on its static memoir_* permissions
// instead, so this prompt stays generic and reusable across memoir-mcp versions.
const MEMOIR_AGENT_PROMPT = loadPrompt("subagent-system.tmpl");

/**
 * Build the memoir subagent config.
 *
 * Locked to memoir_* tools except checkout (everything else denied) so it can
 * never touch the filesystem, shell, network, or the store-global branch.
 * opencode restricts an agent's tools through its `permission` ruleset — see
 * MemoirAgentSpec for why the checkout deny must follow the broad allow. Mode
 * "subagent" gives the throwaway session the restricted agent configuration;
 * `hidden: true` and the absence of a parentID keep capture out of the active
 * conversation.
 */
export function buildMemoirAgent(model?: string): MemoirAgentSpec {
  const agent: MemoirAgentSpec = {
    mode: "subagent",
    hidden: true,
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

/**
 * Dispatch a capture task on a throwaway session.
 *
 * Creates a temporary session (no parentID → invisible in the UI), then fires
 * the memoir agent there via promptAsync. The LLM work runs asynchronously;
 * promptAsync returns 204 immediately after forking.
 */
export async function runMemoirSubagent(
  sdkClient: unknown,
  _parentSessionID: string,
  task: string,
  _model?: string,
  onSessionCreated?: (sessionID: string) => (() => void) | undefined,
): Promise<string> {
  type SessionCreate = (options: {
    body?: { title?: string; agent?: string };
  }) => Promise<{ data?: { id: string } }>;
  type SessionPromptAsync = (options: {
    path: { id: string };
    body: { agent?: string; parts: Array<{ type: string; text: string }> };
  }) => Promise<unknown>;

  const sessionApi = (
    sdkClient as
      | { session?: { create?: SessionCreate; promptAsync?: SessionPromptAsync } }
      | null
      | undefined
  )?.session;
  if (!sessionApi?.create || !sessionApi?.promptAsync) {
    throw new Error("SDK client session API unavailable");
  }

  try {
    const createRes = await sessionApi.create({
      body: { title: "capture", agent: MEMOIR_AGENT_NAME },
    });
    const throwawayID = createRes?.data?.id;
    if (!throwawayID) throw new Error("Failed to create throwaway session");
    const rollback = onSessionCreated?.(throwawayID);

    try {
      await sessionApi.promptAsync({
        path: { id: throwawayID },
        body: { agent: MEMOIR_AGENT_NAME, parts: [{ type: "text", text: task }] },
      });
    } catch (e) {
      rollback?.();
      throw e;
    }
    log("memoir capture dispatched to throwaway session", throwawayID);
    return throwawayID;
  } catch (e) {
    log("runMemoirSubagent failed", e);
    throw e;
  }
}
