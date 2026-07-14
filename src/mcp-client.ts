import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { debugLog, infoLog } from "./debug.js";
import { safeRealpath } from "./path.js";

interface MemoirClientState {
  client: Client;
}

let state: MemoirClientState | null = null;
let connecting: Promise<Client> | null = null;

// Discovered memoir tool catalog (name + description), cached so we hit the
// server only once per process. Invalidated together with the client.
let cachedTools: MemoirToolInfo[] | null = null;

/** A single discovered memoir MCP tool: its name and human description. */
export interface MemoirToolInfo {
  name: string;
  description: string;
}

// Single shared memoir-mcp HTTP server, spawned and owned by the plugin.
// Both opencode (registered as a remote MCP server) and the plugin's own
// internal client connect to this one process — no second stdio spawn.
let serverProc: ChildProcess | null = null;
let serverUrl: URL | null = null;
let startingServer: Promise<URL> | null = null;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Random free port from the upper (ephemeral) range.
const LOW_PORT = 49152;
const HIGH_PORT = 65535;

function randomHighPort(): number {
  return LOW_PORT + Math.floor(Math.random() * (HIGH_PORT - LOW_PORT + 1));
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickFreeHighPort(tries = 20): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = randomHighPort();
    if (await isPortFree(port)) return port;
  }
  throw new Error("memoir: could not find a free high port for the HTTP server");
}

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error("memoir: HTTP server did not start in time"));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

function cleanup(): void {
  state = null;
  connecting = null;
  cachedTools = null;
}

/**
 * Start the shared memoir-mcp HTTP server on a random free high port and wait
 * until it is listening. Returns the Streamable HTTP URL other clients connect to.
 * Idempotent and concurrency-safe: concurrent callers share one start promise.
 */
export async function startMemoirHttpServer(
  command: string[],
  env?: Record<string, string>,
  cwd?: string,
): Promise<URL> {
  if (serverUrl && serverProc) return serverUrl;
  if (startingServer) return startingServer;

  startingServer = (async () => {
    // In tests, skip spawning a real server — just hand back a placeholder URL.
    if (process.env.NODE_ENV === "test") {
      return new URL("http://127.0.0.1:9/mcp");
    }

    const port = await pickFreeHighPort();
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    // HTTP flags appended to the base command (which already carries --store).
    const args = [...command.slice(1), "--http", "--host", "127.0.0.1", "--port", String(port)];

    const proc = spawn(command[0], args, {
      // Merge with the parent env so PATH (and other essentials) survive —
      // passing only `env` would wipe PATH and break command resolution.
      env: { ...process.env, ...env },
      // Run in the real (symlink-resolved) project dir so memoir-mcp's
      // portable store slug is identical whether the repo is entered via a
      // symlink or its real path.
      cwd: cwd ? safeRealpath(cwd) : process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc = proc;

    // Route the child's stderr to the debug log instead of the UI.
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        if (process.env.MEMOIR_DEBUG === "1") {
          debugLog("memoir-mcp:", chunk.toString().trimEnd());
        }
      });
    }
    proc.on("exit", (code) => {
      debugLog("memoir-mcp HTTP server exited with code", code);
      serverProc = null;
      serverUrl = null;
    });
    proc.on("error", (e) => {
      debugLog("memoir-mcp HTTP server error:", errorMessage(e));
      serverProc = null;
      serverUrl = null;
      startingServer = null;
      throw new Error(`memoir: failed to spawn ${command[0]}: ${errorMessage(e)}`);
    });

    await waitForPort(port);
    serverUrl = url;
    infoLog("memoir-mcp HTTP server up at", url.toString());
    return url;
  })();

  return startingServer;
}

/**
 * Get a lazily-connected singleton MCP client for the shared memoir-mcp HTTP
 * server. Concurrent first-call races share a single connecting promise.
 */
export async function getMemoirClient(
  command: string[],
  env?: Record<string, string>,
): Promise<Client> {
  if (state) return state.client;

  if (!connecting) {
    connecting = (async () => {
      const url = await startMemoirHttpServer(command, env);
      const client = new Client(
        { name: "opencode-memoir", version: "1.0.0" },
        { capabilities: {} },
      );

      const transport = new StreamableHTTPClientTransport(url);

      transport.onclose = () => {
        debugLog("mcp-client: transport closed, resetting state");
        cleanup();
      };

      try {
        await client.connect(transport);
      } catch (e) {
        cleanup();
        throw e;
      }

      state = { client };
      return client;
    })();
  }

  return connecting;
}

/** Close the MCP client and stop the shared HTTP server. */
export async function closeMemoirClient(): Promise<void> {
  if (state) {
    try {
      await state.client.close();
    } catch (e) {
      debugLog("closeMemoirClient: close failed:", errorMessage(e));
    }
    cleanup();
  }
  if (serverProc) {
    try {
      serverProc.kill();
    } catch (e) {
      debugLog("closeMemoirClient: kill failed:", errorMessage(e));
    }
    serverProc = null;
  }
  serverUrl = null;
  startingServer = null;
  connecting = null;
  cachedTools = null;
}

/**
 * Return the memoir server's tool catalog (name + description). The subagent's
 * per-call task prompt is built from this so it always reflects the live
 * server — no hardcoded tool list in source. Cached per process; invalidated
 * when the client/connection is torn down.
 */
export async function listMemoirTools(client: Client): Promise<MemoirToolInfo[]> {
  if (cachedTools) return cachedTools;
  try {
    const res = await client.listTools();
    cachedTools = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
    }));
    return cachedTools;
  } catch (e) {
    debugLog("listMemoirTools failed:", errorMessage(e));
    return [];
  }
}

/**
 * Wrapper around client.callTool that extracts text content.
 * Returns the first `{ type: "text" }` content block's text, or null.
 */
export async function callMemoirTool(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    if (result.isError) {
      debugLog(`callMemoirTool: ${name} returned error`);
      return null;
    }
    for (const block of result.content) {
      if (block.type === "text" && block.text != null) {
        return block.text;
      }
    }
    return null;
  } catch (e) {
    debugLog(`callMemoirTool: ${name} failed:`, errorMessage(e));
    return null;
  }
}
