import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "./debug.js";
import { safeRealpath } from "./path.js";

interface MemoirClientState {
  client: Client;
}

export type MemoirToolInfo = {
  name: string;
  description: string;
};

type ClientConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

export type MemoirRuntimeDependencies = {
  createClientConnection?: (url: URL) => ClientConnection;
};

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

/**
 * One memoir-mcp process and internal MCP client owned by one plugin instance.
 * OpenCode can host several project directories in one process, so none of
 * this state may live at module scope.
 */
export class MemoirRuntime {
  private state: MemoirClientState | null = null;
  private connecting: Promise<Client> | null = null;
  private serverProc: ChildProcess | null = null;
  private serverUrl: URL | null = null;
  private serverPort: number | null = null;
  private startingServer: Promise<URL> | null = null;
  private tools: MemoirToolInfo[] | null = null;

  constructor(
    private readonly command: string[],
    private readonly env?: Record<string, string>,
    private readonly cwd?: string,
    private readonly dependencies: MemoirRuntimeDependencies = {},
  ) {}

  private cleanupClient(): void {
    this.state = null;
    this.connecting = null;
    this.tools = null;
  }

  async start(): Promise<URL> {
    if (this.serverUrl && this.serverProc) return this.serverUrl;
    if (this.startingServer) return this.startingServer;

    const start = (async () => {
      // In tests, skip spawning a real server — just hand back a placeholder URL.
      if (process.env.NODE_ENV === "test") {
        return new URL("http://127.0.0.1:9/mcp");
      }

      // Keep the first selected port for this plugin instance. OpenCode stores
      // the remote URL during config and cannot be pointed at a new random URL
      // after a child-process crash.
      const port = this.serverPort ?? (await pickFreeHighPort());
      this.serverPort = port;
      const url = new URL(`http://127.0.0.1:${port}/mcp`);

      // HTTP flags appended to the base command (which already carries --store).
      const args = [
        ...this.command.slice(1),
        "--http",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ];

      const proc = spawn(this.command[0], args, {
        // Merge with the parent env so PATH (and other essentials) survive —
        // passing only `env` would wipe PATH and break command resolution.
        env: { ...process.env, ...this.env },
        // Run in the real (symlink-resolved) project dir so memoir-mcp's
        // portable store slug is identical whether the repo is entered via a
        // symlink or its real path.
        cwd: this.cwd ? safeRealpath(this.cwd) : process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.serverProc = proc;

      // Route the child's stderr to the debug log instead of the UI.
      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          log("memoir-mcp:", chunk.toString().trimEnd());
        });
      }
      proc.on("exit", (code) => {
        log("memoir-mcp HTTP server exited with code", code);
        // close() may already have killed this process and started another.
        // A late exit from the old child must not wipe the replacement state.
        if (this.serverProc !== proc) return;
        this.serverProc = null;
        this.serverUrl = null;
        this.startingServer = null;
        this.cleanupClient();
      });

      await new Promise<void>((resolve, reject) => {
        proc.once("spawn", resolve);
        proc.once("error", reject);
      }).catch((e: unknown) => {
        throw new Error(`memoir: failed to spawn ${this.command[0]}: ${errorMessage(e)}`);
      });

      await waitForPort(port);
      this.serverUrl = url;
      log("memoir-mcp HTTP server up at", url.toString());
      return url;
    })();

    this.startingServer = start;
    try {
      return await start;
    } catch (e) {
      this.startingServer = null;
      this.serverUrl = null;
      if (this.serverProc) this.serverProc.kill();
      this.serverProc = null;
      throw e;
    }
  }

  /** Get the lazily-connected internal client for this plugin instance. */
  async connect(): Promise<Client> {
    if (this.state) return this.state.client;

    if (!this.connecting) {
      this.connecting = (async () => {
        const url = await this.start();
        const { client, transport } = this.dependencies.createClientConnection?.(url) ?? {
          client: new Client({ name: "opencode-memoir", version: "1.0.0" }, { capabilities: {} }),
          transport: new StreamableHTTPClientTransport(url),
        };

        transport.onclose = () => {
          log("mcp-client: transport closed, resetting state");
          this.cleanupClient();
        };

        try {
          await client.connect(transport);
        } catch (e) {
          this.cleanupClient();
          throw e;
        }

        this.state = { client };
        return client;
      })();
    }

    return this.connecting;
  }

  /** Discover the live tool catalog once per connection for the small-model prompt. */
  async listTools(client: Client): Promise<MemoirToolInfo[]> {
    if (this.tools) return this.tools;
    try {
      const result = await client.listTools();
      this.tools = (result.tools ?? []).map((tool) => ({
        // OpenCode exposes remote MCP tools as <server>_<raw-name>. The server
        // is registered as "memoir", so the prompt must use the same names the
        // subagent actually sees (for example memoir_memoir_remember).
        name: `memoir_${tool.name}`,
        description: typeof tool.description === "string" ? tool.description : "",
      }));
      return this.tools;
    } catch (e) {
      log("MemoirRuntime.listTools failed", e);
      return [];
    }
  }

  /** Close the MCP client and stop this instance's HTTP server. */
  async close(): Promise<void> {
    if (this.state) {
      try {
        await this.state.client.close();
      } catch (e) {
        log("closeMemoirClient: close failed", e);
      }
      this.cleanupClient();
    }
    if (this.serverProc) {
      const proc = this.serverProc;
      this.serverProc = null;
      try {
        await new Promise<void>((resolve) => {
          if (proc.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 1_000);
          timer.unref();
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          proc.once("error", () => {
            clearTimeout(timer);
            resolve();
          });
          proc.kill();
        });
      } catch (e) {
        log("closeMemoirClient: kill failed", e);
      }
    }
    this.serverUrl = null;
    this.startingServer = null;
    this.connecting = null;
    this.tools = null;
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
      log(`callMemoirTool: ${name} returned error`);
      return null;
    }
    for (const block of result.content) {
      if (block.type === "text" && block.text != null) {
        return block.text;
      }
    }
    return null;
  } catch (e) {
    log(`callMemoirTool: ${name} failed`, e);
    return null;
  }
}
