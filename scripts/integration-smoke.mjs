import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Optional live protocol check. Requires a build, opencode, and memoir-mcp.
// A deterministic local model isolates this test from paid/provider inference.
const root = mkdtempSync(join(tmpdir(), "memoir-integration-"));
const project = join(root, "project");
const plugin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const logFile = join(root, "memoir.log");
const content = "The user prefers Vim as their editor.";
let modelRequests = 0;
let captureRequests = 0;
let failedRequests = 0;
let base;
let child;
let client;
let output = "";
const transcripts = [];

const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const transcript = body.messages?.find(
      (m) => typeof m.content === "string" && m.content.startsWith("USER\n"),
    )?.content;
    const capture = transcript !== undefined;
    const toolResult = body.messages?.at(-1)?.role === "tool";
    modelRequests++;
    if (capture) {
      captureRequests++;
      const names = body.tools.map((tool) => tool.function.name);
      assert.ok(names.every((name) => name.startsWith("memoir_")));
      assert.ok(!names.includes("memoir_memoir_checkout"));
      if (!toolResult) transcripts.push(transcript);
      // Force a real OpenCode session.error once, then exercise plugin retry.
      if (failedRequests === 0) {
        failedRequests++;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Intentional integration capture failure",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `smoke-${modelRequests}`, object: "chat.completion.chunk", created: 1, model: "capture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    emit({ role: "assistant" });
    if (capture && !toolResult) {
      const name = body.tools.find((tool) => tool.function.name.endsWith("memoir_remember"))
        ?.function.name;
      assert.ok(name);
      emit({
        tool_calls: [
          {
            index: 0,
            id: "remember-editor",
            type: "function",
            function: {
              name,
              arguments: JSON.stringify({
                content,
                path: "preferences.editor.choice",
                merge_policy: "replace",
              }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: capture ? "" : "Your preference for Vim is acknowledged and confirmed." });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    response.destroy(error);
  }
});

async function until(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Integration check timed out${last ? `: ${last.message}` : ""}`);
}

async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function decode(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

try {
  mkdirSync(project);
  execFileSync("git", ["init", "--initial-branch=smoke-main"], { cwd: project, stdio: "ignore" });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const config = join(root, "opencode.json");
  writeFileSync(
    config,
    JSON.stringify({
      plugin: [pathToFileURL(plugin).href],
      model: "smoke/capture",
      small_model: "smoke/capture",
      provider: {
        smoke: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local integration model",
          options: {
            baseURL: `http://127.0.0.1:${model.address().port}/v1`,
            apiKey: "local-smoke",
          },
          models: { capture: { name: "Capture", limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  );
  child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG: config,
      OPENCODE_CONFIG_DIR: join(root, "config"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      MEMOIR_STORE: join(root, "store"),
      MEMOIR_LOG: logFile,
      MEMOIR_AUTO_SAVE: "1",
      MEMOIR_CAPTURE_MIN_CHARS: "0",
      MEMOIR_AGENT_MODEL: "smoke/capture",
      OPENCODE_SERVER_PASSWORD: "",
    },
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-16_000);
    });
  base = await until(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`OpenCode exited: ${output}`);
    return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  const loaded = await api("/config");
  assert.strictEqual(loaded.agent.memoir.hidden, true);
  assert.strictEqual((await api("/mcp")).memoir.status, "connected");
  client = new Client({ name: "memoir-integration", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(loaded.mcp.memoir.url)));
  const initial = decode(await client.callTool({ name: "memoir_status", arguments: {} }));
  assert.strictEqual(initial.branch, null);
  const parent = await api("/session", { title: "Integration parent" });
  for (const text of ["My preferred editor is Vim.", "Please confirm my preference."]) {
    const answer = await api(`/session/${parent.id}/message`, { parts: [{ type: "text", text }] });
    assert.ok(answer.parts.some((part) => part.type === "text" && part.text.includes("Vim")));
  }
  await until(async () => {
    const status = decode(await client.callTool({ name: "memoir_status", arguments: {} }));
    return status.memory_count === 1;
  });
  await until(async () => (await api("/session")).every((session) => session.id === parent.id));
  const saved = decode(
    await client.callTool({
      name: "memoir_get",
      arguments: { keys: ["preferences.editor.choice"] },
    }),
  );
  assert.ok(JSON.stringify(saved).includes(content));
  const status = decode(await client.callTool({ name: "memoir_status", arguments: {} }));
  assert.strictEqual(status.branch, "smoke-main");
  assert.strictEqual(failedRequests, 1);
  assert.strictEqual(transcripts.length, 2);
  assert.strictEqual(transcripts[0], transcripts[1]);
  assert.ok(readFileSync(logFile, "utf8").includes("retrying failed capture"));
  console.log(
    `Live integration passed: OpenCode + memoir-mcp, ${captureRequests} capture model requests, one background retry, verified memory, branch, permissions, and session cleanup.`,
  );
} catch (error) {
  console.error(output);
  if (readFileSyncSafe(logFile)) console.error(readFileSyncSafe(logFile));
  throw error;
} finally {
  await client?.close().catch(() => {});
  if (base) await api("/instance/dispose", {}).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  }
  await new Promise((resolve) => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
