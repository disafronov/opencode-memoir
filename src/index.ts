import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { captureTurn } from "./capture.js";
import { log, setProjectContext } from "./debug.js";
import { callMemoirTool, MemoirRuntime } from "./mcp-client.js";
import { deriveStorePath, safeRealpath } from "./path.js";
import { loadPrompt } from "./prompts.js";
import { parseMemoirStatus } from "./status.js";
import { buildMemoirAgent, MEMOIR_AGENT_NAME, resolveMemoirModel } from "./subagent.js";

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
  const lastCaptured = new Map<string, string>();
  const capturePending = new Set<string>();
  let agentModel: string | undefined;

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
    if (!sdkClient || capturePending.has(sid)) return;
    capturePending.add(sid);
    try {
      await captureTurn(sdkClient, sid, lastCaptured, agentModel);
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
      setProjectContext(basename(storePath));

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
      agentModel = resolveMemoirModel({
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

        const client = await connectClient();
        if (client) {
          await branchMatcher.match(client, directory);
        }

        log("chat.message: submitting capture for previous completed turn", sid);
        await dispatchCapture(sid);
      } catch (e) {
        log("chat.message: failed", e);
      }
    },

    dispose: async (): Promise<void> => {
      branchMatcher.clear();
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
