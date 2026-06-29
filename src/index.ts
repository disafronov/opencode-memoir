import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import { debugLog } from "./debug.js";
import { incrementMsgCount, pruneAll, sessionMsgCount, shouldRemind } from "./memory-saver.js";
import {
  autoMatchMemoirBranch,
  callMemoir,
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

  const mcpCommand = ["uvx", "--from", "memoir-ai[mcp]", "memoir-mcp"];
  if (storePath) {
    mcpCommand.push("--store", storePath);
  }

  const hooks: Record<string, unknown> = {
    name: "memoir",

    config: async (config: Config): Promise<void> => {
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

Then call memoir_remember with replace=true for durable onboarding facts. Use namespace codebase:onboard in git repositories and project:onboard outside git.`,
      };

      // Register memoir MCP server
      const mcp = config.mcp ?? {};
      mcp.memoir = {
        type: "local" as const,
        command: mcpCommand,
        environment: storePath ? { MEMOIR_STORE: storePath } : undefined,
      };
      config.mcp = mcp;
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

        await autoMatchMemoirBranch(storePath, sid);
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
            '[memoir] You have Memoir MCP tools (memoir_recall, memoir_remember, memoir_get, memoir_summarize, memoir_status, memoir_branches, memoir_checkout).\nSAVE (memoir_remember) after: task completion, user stating preferences/constraints, discovering project facts. RECALL (memoir_recall \u2192 memoir_get) at session start for prior context, when user asks about prior work.\nNamespaces: "default" (user context), "codebase:onboard" (project facts in git repos). Taxonomy paths: preferences.*, project.*, codebase.*, decisions.*, learning.*.',
          );
        }

        const count = sessionMsgCount.get(sid) ?? 0;
        if (shouldRemind(count)) {
          output.system?.push(
            "\n[memoir] Reminder: Use memoir_remember to save context, memoir_recall to retrieve prior context.",
          );
        }
      } catch (e) {
        debugLog("system.transform: failed:", errorMessage(e));
      }
    },

    dispose: async (): Promise<void> => {
      try {
        if (process.env.MEMOIR_AUTO_SAVE === "1") {
          for (const [sid, count] of sessionMsgCount) {
            await callMemoir(
              [
                "remember",
                `session.${sid}`,
                "--message",
                `Session ended — ${count} user messages exchanged`,
              ],
              storePath,
            );
          }
        }
      } catch (e) {
        debugLog("dispose: save failed:", errorMessage(e));
      }
      sessionsWithStartupHint.clear();
      pruneBranchCache();
      pruneAll();
    },
  };

  return hooks;
};

const plugin: PluginModule = {
  id: "opencode-memoir",
  server: MemoirOpenCode,
};

export default plugin;
