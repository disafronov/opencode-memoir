import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "./debug.js";
import { safeRealpath } from "./path.js";

interface MemoirClientState {
  client: Client;
}

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

  constructor(
    private readonly command: string[],
    private readonly env?: Record<string, string>,
    private readonly cwd?: string,
    private readonly dependencies: MemoirRuntimeDependencies = {},
  ) {}

  private cleanupClient(): void {
    this.state = null;
    this.connecting = null;
  }

  async start(): Promise<URL> {
    if (this.serverUrl && this.serverProc) return this.serverUrl;
    if (this.startingServer) return this.startingServer;

    const start = (async (): Promise<URL> => {
      // Retry loop: pickFreeHighPort has a TOCTOU gap (isPortFree → spawn).
      // If waitForPort times out the port is likely taken — kill the child and
      // retry with a fresh port.
      const maxTries = 5;
      for (let attempt = 0; attempt < maxTries; attempt++) {
        const port = this.serverPort ?? (await pickFreeHighPort());
        this.serverPort = port;
        const url = new URL(`http://127.0.0.1:${port}/mcp`);

        const args = [
          ...this.command.slice(1),
          "--http",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
        ];

        const proc = spawn(this.command[0], args, {
          env: { ...process.env, ...this.env },
          cwd: this.cwd ? safeRealpath(this.cwd) : process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });

        if (proc.stderr) {
          proc.stderr.on("data", (chunk: Buffer) => {
            log("memoir-mcp:", chunk.toString().trimEnd());
          });
        }

        const exited = new Promise<number | null>((resolve) => {
          proc.once("exit", (code) => resolve(code));
        });

        await new Promise<void>((resolve, reject) => {
          proc.once("spawn", resolve);
          proc.once("error", reject);
        }).catch((e: unknown) => {
          throw new Error(`memoir: failed to spawn ${this.command[0]}: ${errorMessage(e)}`);
        });

        this.serverProc = proc;

        try {
          await waitForPort(port);
        } catch {
          // Port may be taken — kill the child and retry.
          proc.kill();
          await exited;
          this.serverProc = null;
          this.serverUrl = null;
          this.serverPort = null;
          this.cleanupClient();
          continue;
        }

        // Late-exit guard: the port check succeeded but another session may
        // have already torn this child down. Only register the URL if our proc
        // is still the active one.
        if (this.serverProc === proc) {
          this.serverUrl = url;
          log("memoir-mcp HTTP server up at", url.toString());
          return url;
        }

        this.serverUrl = url;
        log("memoir-mcp HTTP server up at", url.toString());
        return url;
      }

      throw new Error("memoir: could not start HTTP server after several retries");
    })();

    this.startingServer = start;
    try {
      return await start;
    } catch (e) {
      this.startingServer = null;
      this.serverUrl = null;
      if (this.serverProc) this.serverProc.kill();
      this.serverProc = null;
      this.serverPort = null;
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
          const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            resolve();
          }, 1_000);
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
      arguments: args ?? {},
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
