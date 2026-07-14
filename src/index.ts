import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { captureTurn } from "./capture.js";
import { debugLog, infoLog } from "./debug.js";
import {
  callMemoirTool,
  closeMemoirClient,
  getMemoirClient,
  listMemoirTools,
  type MemoirToolInfo,
  startMemoirHttpServer,
} from "./mcp-client.js";
import { incrementMsgCount, pruneAll, sessionMsgCount, shouldRemind } from "./memory-saver.js";
import { safeRealpath } from "./path.js";
import { loadPrompt } from "./prompts.js";
import {
  autoMatchMemoirBranch,
  deriveStorePath,
  pruneBranchCache,
  setPluginStoreOverride,
} from "./store.js";
import { buildMemoirAgent, MEMOIR_AGENT_NAME, resolveMemoirModel } from "./subagent.js";

const sessionsWithStartupHint = new Set<string>();
// Per-session id of the last captured assistant message — dedupes capture
// so a turn is written to memoir at most once.
const lastCaptured = new Map<string, string>();

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

const MemoirOpenCode: Plugin = async (input, rawOptions) => {
  const opts = (rawOptions ?? {}) as { store?: string };
  if (opts.store) setPluginStoreOverride(opts.store);

  const storePath = deriveStorePath();
  // SDK client (for subagent spawning + transcript reads) and working dir come
  // from the plugin input. Guard for callers that pass no input.
  const pluginInput = (input ?? {}) as PluginInput;
  const sdkClient = pluginInput.client;
  const directory = safeRealpath(pluginInput.directory ?? process.cwd());

  const mcpCommand = ["memoir-mcp"];
  if (storePath) {
    mcpCommand.push("--store", storePath);
  }

  const environment = storePath ? { MEMOIR_STORE: storePath } : undefined;

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
      return await getMemoirClient(mcpCommand, environment);
    } catch (e) {
      debugLog("plugin: failed to connect memoir client:", errorMessage(e));
      return null;
    }
  };

  // Fetch the live memoir tool catalog once (cached in mcp-client). Skipped in
  // tests so the config/chat hooks never reach for a real server. Returns []
  // on any failure so callers degrade to a tool-free prompt.
  const discoverMemoirTools = async (): Promise<MemoirToolInfo[]> => {
    if (process.env.NODE_ENV === "test") return [];
    const client = await connectClient();
    return client ? listMemoirTools(client) : [];
  };

  const hooks: Record<string, unknown> = {
    name: "memoir",

    config: async (config: Config): Promise<void> => {
      debugLog("config hook: mcpCommand =", JSON.stringify(mcpCommand));

      try {
        const url = await startMemoirHttpServer(mcpCommand, environment, directory);
        mcpServer = { type: "remote", url: url.toString(), enabled: true };
        infoLog("memoir MCP server registered at", url.toString(), "| store:", storePath);
      } catch (e) {
        debugLog("config hook: failed to start memoir HTTP server:", errorMessage(e));
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
      infoLog("memoir subagent registered | model:", agentModel ?? "(opencode default)");

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
        debugLog("shell.env: failed:", errorMessage(e));
      }
    },

    "chat.message": async (
      input: { sessionID: string; agent?: string; messageID?: string; variant?: string },
      _output: { parts?: Array<{ type: string; text: string }> },
    ): Promise<void> => {
      try {
        const sid = input.sessionID ?? "default";
        incrementMsgCount(sid);

        const client = await connectClient();
        if (client) {
          await autoMatchMemoirBranch(client, sid);
        }

        // Fire-and-forget: capture the just-completed turn into memoir via the
        // subagent. Never await — a slow/down model must not stall the user.
        infoLog("chat.message: firing capture for session", sid);
        void captureTurn(sdkClient, sid, directory, lastCaptured, await discoverMemoirTools());
      } catch (e) {
        debugLog("chat.message: failed:", errorMessage(e));
      }
    },

    "tool.execute.before": async (
      input: { tool: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      try {
        if (input.tool !== "task" || output.args?.subagent_type !== MEMOIR_AGENT_NAME) return;
        if (!backgroundSubagentsEnabled()) {
          debugLog(
            "memoir task remains foreground: OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is disabled",
          );
          return;
        }

        // A `subtask` prompt part does not expose TaskTool's `background`
        // parameter. SessionPrompt passes the mutable task arguments through
        // this hook immediately before TaskTool.execute, so opt only memoir's
        // capture task into OpenCode's native BackgroundJob path here.
        output.args.background = true;
        infoLog("memoir capture task promoted to native background job");
      } catch (e) {
        debugLog("tool.execute.before: failed:", errorMessage(e));
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ): Promise<void> => {
      try {
        const sid = input.sessionID ?? "default";

        if (input.sessionID && !sessionsWithStartupHint.has(sid)) {
          sessionsWithStartupHint.add(sid);
          infoLog("system.transform: startup hint injected for session", sid);

          // Hint: the main agent owns proactive recall/store via memory tools.
          // Tool names are intentionally omitted — the agent already sees its
          // allowed memoir_* tools, so naming them here would just be hardcode.
          // The text lives in prompts/startup-hint.tmpl for easy editing.
          output.system?.unshift(loadPrompt("startup-hint.tmpl"));

          // Proactive context: surface what memoir already holds + the active
          // store status so the agent starts oriented. Both are cheap and
          // LLM-free. The client is fetched once and reused for both calls.
          const client = await connectClient();
          if (client) {
            if (process.env.MEMOIR_SUMMARIZE !== "0") {
              const summary = await callMemoirTool(client, "memoir_summarize", {
                depth: 1,
              });
              if (summary) {
                output.system?.unshift(
                  `[memoir] Prior context already stored (memoir):\n${summary}`,
                );
                infoLog("system.transform: proactive recall injected for session", sid);
              }
            } else {
              infoLog("system.transform: recall skipped (MEMOIR_SUMMARIZE=0)");
            }

            const status = await callMemoirTool(client, "memoir_status", {});
            if (status) {
              output.system?.unshift(`[memoir] Memory store status:\n${status}`);
              infoLog("system.transform: store status injected for session", sid);
            }
          }
        }

        const count = sessionMsgCount.get(sid) ?? 0;
        if (shouldRemind(count)) {
          // Text in prompts/reminder.tmpl; tool-free by design (see hint above).
          output.system?.push(loadPrompt("reminder.tmpl"));
        }
      } catch (e) {
        debugLog("system.transform: failed:", errorMessage(e));
      }
    },

    dispose: async (): Promise<void> => {
      try {
        // Final capture of the session's last turn before teardown.
        if (sdkClient) {
          const tools = await discoverMemoirTools();
          for (const sid of lastCaptured.keys()) {
            infoLog("dispose: final capture for session", sid);
            void captureTurn(sdkClient, sid, directory, lastCaptured, tools);
          }
        }

        if (process.env.MEMOIR_AUTO_SAVE === "1") {
          const client = await connectClient();
          if (client) {
            for (const [sid, count] of sessionMsgCount) {
              await callMemoirTool(client, "memoir_remember", {
                content: `Session ended — ${count} user messages exchanged`,
                path: `session.${sid}`,
                merge_policy: "replace",
              });
            }
          }
        }
      } catch (e) {
        debugLog("dispose: save failed:", errorMessage(e));
      }
      sessionsWithStartupHint.clear();
      pruneBranchCache();
      pruneAll();
      lastCaptured.clear();
      await closeMemoirClient();
    },
  };

  return hooks;
};

const plugin: PluginModule = {
  id: "opencode-memoir",
  server: MemoirOpenCode,
};

export default plugin;
