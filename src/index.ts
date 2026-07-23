import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { dispatchCaptureSnapshot, prepareCaptureTurn } from "./capture.js";
import { log, setProjectContext } from "./debug.js";
import { callMemoirTool, MemoirRuntime } from "./mcp-client.js";
import { deriveStorePath, safeRealpath } from "./path.js";
import { loadPrompt } from "./prompts.js";
import { parseMemoirStatus } from "./status.js";
import { buildMemoirAgent, MEMOIR_AGENT_NAME, resolveMemoirModel } from "./subagent.js";

const execFileAsync = promisify(execFile);

/** Get current git branch without blocking the OpenCode event loop. */
export async function currentGitBranch(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: safeRealpath(cwd),
      encoding: "utf8",
      timeout: 3_000,
    });
    return stdout.trim();
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
    const codeBranch = await currentGitBranch(cwd);
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
  const captureQueues = new Map<string, Promise<void>>();
  const activeCaptures = new Map<string, { done: Promise<void>; resolve: () => void }>();
  let disposing = false;
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

  const trackCapture = (sessionID: string): (() => void) | undefined => {
    if (activeCaptures.has(sessionID)) return undefined;
    let resolve!: () => void;
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    activeCaptures.set(sessionID, { done, resolve });
    return () => finishCapture(sessionID);
  };

  const finishCapture = (sessionID: string): void => {
    const capture = activeCaptures.get(sessionID);
    if (!capture) return;
    activeCaptures.delete(sessionID);
    capture.resolve();

    const sessionApi = (
      sdkClient as
        | { session?: { delete?: (input: { path: { id: string } }) => Promise<unknown> } }
        | null
        | undefined
    )?.session;
    if (sessionApi?.delete) {
      void sessionApi.delete({ path: { id: sessionID } }).catch((e: unknown) => {
        log("failed to delete completed capture session", sessionID, e);
      });
    }
  };

  const drainCaptures = async (timeoutMs = 10_000): Promise<boolean> => {
    const pending = [...activeCaptures.values()].map((capture) => capture.done);
    if (pending.length === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = Promise.all(pending).then(() => true as const);
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) log("capture drain timed out");
    return result;
  };

  const dispatchCapture = (sid: string): void => {
    if (!sdkClient || disposing) return;

    // Start transcript retrieval immediately so every chat.message snapshots
    // its own completed turn even while an earlier dispatch is still pending.
    const snapshot = prepareCaptureTurn(sdkClient, sid).catch((e: unknown) => {
      log("capture snapshot failed", e);
      return null;
    });
    const previous = captureQueues.get(sid) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const prepared = await snapshot;
        if (!prepared) return;

        const client = await connectClient();
        if (client) {
          await branchMatcher.match(client, directory, drainCaptures);
        }
        await dispatchCaptureSnapshot(
          sdkClient,
          sid,
          prepared,
          lastCaptured,
          agentModel,
          trackCapture,
        );
      })
      .catch((e: unknown) => {
        log("dispatchCapture failed", e);
      });

    captureQueues.set(sid, current);
    void current.then(() => {
      if (captureQueues.get(sid) === current) captureQueues.delete(sid);
    });
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

        log("chat.message: submitting capture for previous completed turn", sid);
        dispatchCapture(sid);
      } catch (e) {
        log("chat.message: failed", e);
      }
    },

    event: async (input: {
      event?: { type?: string; properties?: { sessionID?: string } };
    }): Promise<void> => {
      const event = input.event;
      const sessionID = event?.properties?.sessionID;
      if (
        sessionID &&
        (event.type === "session.idle" || event.type === "session.error") &&
        activeCaptures.has(sessionID)
      ) {
        finishCapture(sessionID);
      }
    },

    dispose: async (): Promise<void> => {
      disposing = true;
      await Promise.all([...captureQueues.values()]);
      await drainCaptures();
      captureQueues.clear();
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
