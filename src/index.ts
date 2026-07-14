import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { captureTurn } from "./capture.js";
import { CaptureLifecycle } from "./capture-lifecycle.js";
import { debugLog, infoLog } from "./debug.js";
import { callMemoirTool, MemoirRuntime } from "./mcp-client.js";
import { safeRealpath } from "./path.js";
import { loadPrompt } from "./prompts.js";
import { deriveStorePath, MemoirBranchMatcher } from "./store.js";
import { buildMemoirAgent, MEMOIR_AGENT_NAME, resolveMemoirModel } from "./subagent.js";
import { buildTurnStatus } from "./turn-status.js";

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
  const sessionsWithStartupHint = new Set<string>();
  const parentSessions = new Set<string>();
  const lastCaptured = new Map<string, string>();
  const capturePending = new Set<string>();
  const captureLifecycle = new CaptureLifecycle();
  const messageCounts = new Map<string, number>();
  const turnStatus = new Map<string, string>();

  // The plugin owns a single shared memoir-mcp HTTP server (started in the
  // config hook). opencode connects to it as a remote MCP server; the plugin's
  // own hooks use the same URL via the internal client. One process, no stdio
  // double-spawn. Populated once the HTTP server is up.
  let mcpServer: { type: "remote"; url: string; enabled: boolean } | undefined;

  // Plugin's own MCP client (separate from the LLM-facing mcpServer).
  // Lazily connected on first use so merely loading the plugin — or running
  // hooks that never touch memoir — spawns no subprocess.
  const connectClient = async () => {
    if (process.env.NODE_ENV === "test") return null;
    try {
      return await runtime.connect();
    } catch (e) {
      debugLog("plugin: failed to connect memoir client:", errorMessage(e));
      return null;
    }
  };

  const discoverTools = async () => {
    const client = await connectClient();
    return client ? runtime.listTools(client) : [];
  };

  const dispatchCapture = async (sid: string): Promise<void> => {
    if (!sdkClient || !parentSessions.has(sid) || capturePending.has(sid)) return;
    capturePending.add(sid);
    try {
      const client = await connectClient();
      if (client) await branchMatcher.match(client, directory, () => captureLifecycle.drain());
      await captureTurn(sdkClient, sid, directory, lastCaptured, await discoverTools());
    } catch (e) {
      debugLog("dispatchCapture failed:", errorMessage(e));
    } finally {
      capturePending.delete(sid);
    }
  };

  const hooks: Record<string, unknown> = {
    name: "memoir",

    config: async (config: Config): Promise<void> => {
      debugLog("config hook: mcpCommand =", JSON.stringify(mcpCommand));

      try {
        const url = await runtime.start();
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
          const status = await callMemoirTool(client, "memoir_status", {});
          const line = buildTurnStatus(status);
          if (line) turnStatus.set(sid, line);
          else turnStatus.delete(sid);
        }

        // chat.message runs before the new user message is persisted, so the
        // transcript still ends at the previous completed assistant turn.
        // This deliberate one-turn delay avoids capture triggering its own
        // session activity (and therefore recursively triggering itself).
        infoLog("chat.message: firing capture for previous completed turn", sid);
        void dispatchCapture(sid);
      } catch (e) {
        debugLog("chat.message: failed:", errorMessage(e));
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
        debugLog("tool.execute.after: failed:", errorMessage(e));
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
        debugLog("event: failed:", errorMessage(e));
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ): Promise<void> => {
      try {
        const sid = input.sessionID ?? "default";

        const status = turnStatus.get(sid);
        if (status) output.system?.push(status);

        if (input.sessionID && parentSessions.has(sid) && !sessionsWithStartupHint.has(sid)) {
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
      } catch (e) {
        debugLog("system.transform: failed:", errorMessage(e));
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
        debugLog("dispose: save failed:", errorMessage(e));
      }
      sessionsWithStartupHint.clear();
      parentSessions.clear();
      capturePending.clear();
      captureLifecycle.clear();
      branchMatcher.clear();
      messageCounts.clear();
      turnStatus.clear();
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
