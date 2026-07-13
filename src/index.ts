import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import { debugLog } from "./debug.js";
import {
  callMemoirTool,
  closeMemoirClient,
  getMemoirClient,
  startMemoirHttpServer,
} from "./mcp-client.js";
import { incrementMsgCount, pruneAll, sessionMsgCount, shouldRemind } from "./memory-saver.js";
import {
  autoMatchMemoirBranch,
  deriveStorePath,
  pruneBranchCache,
  setPluginStoreOverride,
} from "./store.js";

const sessionsWithStartupHint = new Set<string>();

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const MemoirOpenCode: Plugin = async (_input, rawOptions) => {
  const opts = (rawOptions ?? {}) as { store?: string };
  if (opts.store) setPluginStoreOverride(opts.store);

  const storePath = deriveStorePath();

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

  const hooks: Record<string, unknown> = {
    name: "memoir",

    config: async (config: Config): Promise<void> => {
      debugLog("config hook: mcpCommand =", JSON.stringify(mcpCommand));

      try {
        const url = await startMemoirHttpServer(mcpCommand, environment);
        mcpServer = { type: "remote", url: url.toString(), enabled: true };
      } catch (e) {
        debugLog("config hook: failed to start memoir HTTP server:", errorMessage(e));
        mcpServer = undefined;
      }

      const mcp = config.mcp ?? {};
      if (mcpServer) mcp.memoir = mcpServer;
      config.mcp = mcp;

      // Register on the returned hooks object too — opencode reads hooks.mcp
      // for the MCP server, and it must reflect the (now known) URL. Assigning
      // at return time would capture the pre-config undefined value.
      if (mcpServer) hooks.mcp = { memoir: mcpServer };

      config.command = config.command ?? {};
      config.command["memoir:onboard"] = {
        description: "Populate or refresh Memoir onboarding for this project",
        template: `Populate or refresh Memoir onboarding for the current project.

Workflow:
- First obtain a project file tree to understand structure.
- Start studying from project documentation.
- Continue only based on what the tree and documentation show.

Memory rules:
- Record only verified facts from files/docs/code or explicit user statements.
- Do not write inferred user thoughts, intentions, preferences, or opinions.
- Do not use preferences.* paths unless the user explicitly stated a preference.
- If a fact is your interpretation, do not save it; report it as uncertain instead.

Then call memoir_memoir_remember with replace=true for durable onboarding facts. Use namespace codebase:onboard in git repositories and project:onboard outside git.`,
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
      input: { sessionID?: string },
      _output: { parts?: Array<{ type: string; text: string }> },
    ): Promise<void> => {
      try {
        const sid = input.sessionID ?? "default";
        incrementMsgCount(sid);

        const client = await connectClient();
        if (client) {
          await autoMatchMemoirBranch(client, sid);
        }
      } catch (e) {
        debugLog("chat.message: failed:", errorMessage(e));
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
          output.system?.unshift(
            '[memoir] You have Memoir MCP tools (memoir_memoir_recall, memoir_memoir_remember, memoir_memoir_get, memoir_memoir_summarize, memoir_memoir_status, memoir_memoir_branches, memoir_memoir_checkout).\nSAVE (memoir_memoir_remember) after: task completion, user stating preferences/constraints, discovering project facts. RECALL (memoir_memoir_recall \u2192 memoir_memoir_get) at session start for prior context, when user asks about prior work.\nNamespaces: "default" (user context), "codebase:onboard" (project facts in git repos). Taxonomy paths: preferences.*, project.*, codebase.*, decisions.*, learning.*.',
          );
        }

        const count = sessionMsgCount.get(sid) ?? 0;
        if (shouldRemind(count)) {
          output.system?.push(
            "\n[memoir] Reminder: Use memoir_memoir_remember to save context, memoir_memoir_recall to retrieve prior context.",
          );
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
