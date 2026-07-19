import { execFileSync } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { captureTurn } from "./capture.js";
import { CaptureLifecycle } from "./capture-lifecycle.js";
import { log } from "./debug.js";
import { callMemoirTool, MemoirRuntime } from "./mcp-client.js";
import { deriveStorePath, safeRealpath } from "./path.js";
import { loadPrompt } from "./prompts.js";
import { parseMemoirStatus } from "./status.js";
import { buildMemoirAgent, MEMOIR_AGENT_NAME, resolveMemoirModel } from "./subagent.js";

function envFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  return value === "1" || value === "true";
}

function backgroundSubagentsEnabled(): boolean {
  return (
    envFlag("OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS") ??
    envFlag("OPENCODE_EXPERIMENTAL") ??
    false
  );
}

/** Get current git branch (empty string if not in a git repo). */
export function currentGitBranch(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: safeRealpath(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Track the actual branch of one memoir store. The checkout is store-global,
 * so a per-session cache would become stale as soon as another session changed
 * the branch.
 */
export class MemoirBranchMatcher {
  private matching: Promise<void> = Promise.resolve();

  match(client: Client, cwd: string, drain?: () => Promise<boolean>): Promise<void> {
    const next = this.matching.then(() => this.matchNow(client, cwd, drain));
    this.matching = next.catch(() => undefined);
    return next;
  }

  private async currentBranch(client: Client): Promise<string> {
    const raw = await callMemoirTool(client, "memoir_status");
    return parseMemoirStatus(raw).branch ?? "";
  }

  private async matchNow(
    client: Client,
    cwd: string,
    drain?: () => Promise<boolean>,
  ): Promise<void> {
    const codeBranch = currentGitBranch(cwd);
    if (!codeBranch) return;

    if ((await this.currentBranch(client)) === codeBranch) return;
    if (drain && !(await drain())) return;
    // A capture or external client may have changed HEAD while we waited.
    if ((await this.currentBranch(client)) === codeBranch) return;

    // memoir_checkout (per the v0.2.4 contract) switches to a branch, creating
    // it on demand when `create` is true. A single call replaces the old
    // branches-list → branch → checkout CLI sequence.
    await callMemoirTool(client, "memoir_checkout", {
      target: codeBranch,
      create: true,
    });
  }

  clear(): void {
    this.matching = Promise.resolve();
  }
}

const MemoirOpenCode: Plugin = async (input, rawOptions) => {
  const opts = (rawOptions ?? {}) as { store?: string };
  // SDK client (for subagent spawning + transcript reads) and working dir come
  // from the plugin input. Guard for callers that pass no input.
  const pluginInput = (input ?? {}) as PluginInput;
  const sdkClient = pluginInput.client;
  const directory = safeRealpath(pluginInput.directory ?? process.cwd());
  const storePath = deriveStorePath(directory, opts.store);

  const mcpCommand = ["memoir-mcp"];
  if (storePath) {
    mcpCommand.push("--store", storePath);
  }

  const environment = storePath ? { MEMOIR_STORE: storePath } : undefined;
  const runtime = new MemoirRuntime(mcpCommand, environment, directory);
  const branchMatcher = new MemoirBranchMatcher();
  const parentSessions = new Set<string>();
  const lastCaptured = new Map<string, string>();
  const capturePending = new Set<string>();
  const captureLifecycle = new CaptureLifecycle();
  const messageCounts = new Map<string, number>();

  // The plugin owns a single shared memoir-mcp HTTP server (started in the
  // config hook). opencode connects to it as a remote MCP server; the plugin's
  // own hooks use the same URL via the internal client. One process, no stdio
  // double-spawn. Populated once the HTTP server is up.
  let mcpServer: { type: "remote"; url: string; enabled: boolean } | undefined;

  // Plugin's own MCP client (separate from the LLM-facing mcpServer).
  // Lazily connected on first use so merely loading the plugin — or running
  // hooks that never touch memoir — spawns no subprocess.
  const connectClient = async () => {
    try {
      return await runtime.connect();
    } catch (e) {
      log("plugin: failed to connect memoir client", e);
      return null;
    }
  };

  const dispatchCapture = async (sid: string): Promise<void> => {
    if (!sdkClient || !parentSessions.has(sid) || capturePending.has(sid)) return;
    capturePending.add(sid);
    try {
      const client = await connectClient();
      if (client) await branchMatcher.match(client, directory, () => captureLifecycle.drain());
      await captureTurn(sdkClient, sid, lastCaptured);
    } catch (e) {
      log("dispatchCapture failed", e);
    } finally {
      capturePending.delete(sid);
    }
  };

  const hooks: Record<string, unknown> = {
    name: "memoir",

    config: async (config: Config): Promise<void> => {
      log("config hook: mcpCommand =", JSON.stringify(mcpCommand));

      try {
        const url = await runtime.start();
        mcpServer = { type: "remote", url: url.toString(), enabled: true };
        log("memoir MCP server registered at", url.toString(), "| store:", storePath);
      } catch (e) {
        log("config hook: failed to start memoir HTTP server", e);
        mcpServer = undefined;
      }

      const mcp = config.mcp ?? {};
      if (mcpServer) mcp.memoir = mcpServer;
      config.mcp = mcp;

      // Register on the returned hooks object too — opencode reads hooks.mcp
      // for the MCP server, and it must reflect the (now known) URL.
      if (mcpServer) hooks.mcp = { memoir: mcpServer };

      // Register the memoir subagent (capture + recall). Its model resolves
      // from MEMOIR_AGENT_MODEL → small_model → model → opencode default.
      // opencode reads the agent from `config.agent` (singular), not `agents`.
      const agentModel = resolveMemoirModel({
        summarizeModel: process.env.MEMOIR_AGENT_MODEL,
        smallModel: (config as { small_model?: string }).small_model,
        model: (config as { model?: string }).model,
      });
      const agentField = config as unknown as {
        agent?: Record<string, AgentConfig>;
      };
      agentField.agent = {
        ...(agentField.agent ?? {}),
        [MEMOIR_AGENT_NAME]: buildMemoirAgent(agentModel) as unknown as AgentConfig,
      };
      log("memoir subagent registered | model:", agentModel ?? "(opencode default)");
      log(
        "memoir capture execution mode:",
        backgroundSubagentsEnabled() ? "native background" : "foreground",
        "| OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS:",
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ?? "(unset)",
        "| OPENCODE_EXPERIMENTAL:",
        process.env.OPENCODE_EXPERIMENTAL ?? "(unset)",
      );

      config.command = config.command ?? {};
      config.command["memoir:onboard"] = {
        description: "Populate or refresh Memoir onboarding for this project",
        template: loadPrompt("onboard.tmpl"),
      };
    },

    "shell.env": async (
      _input: unknown,
      output: { env: Record<string, string> },
    ): Promise<void> => {
      try {
        if (storePath) {
          output.env.MEMOIR_STORE = storePath;
        }
      } catch (e) {
        log("shell.env: failed", e);
      }
    },

    "chat.message": async (
      input: { sessionID: string; agent?: string; messageID?: string; variant?: string },
      output: {
        parts?: Array<{ type: string; text?: string; synthetic?: boolean; agent?: string }>;
      },
    ): Promise<void> => {
      try {
        const sid = input.sessionID ?? "default";
        const parts = output.parts ?? [];
        const isMemoirSubtask = parts.some(
          (part) => part.type === "subtask" && part.agent === MEMOIR_AGENT_NAME,
        );
        const isSynthetic = parts.length > 0 && parts.every((part) => part.synthetic === true);
        if (input.agent === MEMOIR_AGENT_NAME || isMemoirSubtask || isSynthetic) return;

        parentSessions.add(sid);
        messageCounts.set(sid, (messageCounts.get(sid) ?? 0) + 1);

        const client = await connectClient();
        if (client) {
          await branchMatcher.match(client, directory, () => captureLifecycle.drain());
        }

        // chat.message runs before the new user message is persisted, so the
        // transcript still ends at the previous completed assistant turn.
        // This deliberate one-turn delay avoids capture triggering its own
        // session activity (and therefore recursively triggering itself).
        // promptAsync returns 204 after forking the prompt in OpenCode. Await
        // that acceptance so the visible capture task is queued before this
        // hook releases the parent prompt; subagent execution is not awaited.
        log("chat.message: submitting capture for previous completed turn", sid);
        await dispatchCapture(sid);
      } catch (e) {
        log("chat.message: failed", e);
      }
    },

    "tool.execute.before": async (
      input: { tool: string; callID: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      try {
        if (input.tool !== "task" || output.args?.subagent_type !== MEMOIR_AGENT_NAME) return;
        captureLifecycle.begin(input.callID);
        if (!backgroundSubagentsEnabled()) {
          log(
            "memoir task remains foreground: OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is disabled",
          );
          return;
        }

        // A `subtask` prompt part does not expose TaskTool's `background`
        // parameter. SessionPrompt passes the mutable task arguments through
        // this hook immediately before TaskTool.execute, so opt only memoir's
        // capture task into OpenCode's native BackgroundJob path here.
        output.args.background = true;
        log("memoir capture task promoted to native background job");
      } catch (e) {
        log("tool.execute.before: failed", e);
      }
    },

    "tool.execute.after": async (
      input: { tool: string; callID: string; args?: Record<string, unknown> },
      output?: { metadata?: { background?: boolean; sessionId?: string } },
    ): Promise<void> => {
      try {
        if (input.tool !== "task" || input.args?.subagent_type !== MEMOIR_AGENT_NAME) return;
        const childSessionID = output?.metadata?.sessionId;
        if (output?.metadata?.background === true && childSessionID) {
          captureLifecycle.background(input.callID, childSessionID);
          return;
        }
        captureLifecycle.finishCall(input.callID);
      } catch (e) {
        log("tool.execute.after: failed", e);
        captureLifecycle.finishCall(input.callID);
      }
    },

    event: async (input: { event?: { type?: string; properties?: { sessionID?: string } } }) => {
      try {
        const event = input.event;
        if (event?.type !== "session.idle" && event?.type !== "session.error") return;
        const sessionID = event.properties?.sessionID;
        if (sessionID) captureLifecycle.finishSession(sessionID);
      } catch (e) {
        log("event: failed", e);
      }
    },

    dispose: async (): Promise<void> => {
      try {
        if (process.env.MEMOIR_AUTO_SAVE === "1") {
          const client = await connectClient();
          if (client) {
            for (const [sid, count] of messageCounts) {
              await callMemoirTool(client, "memoir_remember", {
                content: `Session ended — ${count} user messages exchanged`,
                path: `session.${sid}`,
                merge_policy: "replace",
              });
            }
          }
        }
      } catch (e) {
        log("dispose: save failed", e);
      }
      parentSessions.clear();
      capturePending.clear();
      captureLifecycle.clear();
      branchMatcher.clear();
      messageCounts.clear();
      lastCaptured.clear();
      await runtime.close();
    },
  };

  return hooks;
};

const plugin: PluginModule = {
  id: "opencode-memoir",
  server: MemoirOpenCode,
};

export default plugin;
