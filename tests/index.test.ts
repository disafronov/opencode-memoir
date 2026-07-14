import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import plugin from "../src/index.ts";
import { MemoirRuntime } from "../src/mcp-client.ts";
import { currentGitBranch } from "../src/store.ts";

describe("plugin module shape", () => {
  it("exports default with id and server", () => {
    assert.ok(plugin);
    assert.strictEqual(typeof plugin, "object");
    assert.strictEqual(plugin.id, "opencode-memoir");
    assert.strictEqual(typeof plugin.server, "function");
  });
});

describe("MemoirOpenCode factory", () => {
  it("returns hooks with name memoir", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(hooks.name, "memoir");
  });

  it("returns config hook", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(typeof hooks.config, "function");
  });

  it("returns shell.env hook", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(typeof hooks["shell.env"], "function");
  });

  it("returns chat.message hook", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(typeof hooks["chat.message"], "function");
  });

  it("captures the previous completed turn on the next real chat message", async () => {
    const previousMin = process.env.MEMOIR_CAPTURE_MIN_CHARS;
    process.env.MEMOIR_CAPTURE_MIN_CHARS = "0";
    const connect = mock.method(MemoirRuntime.prototype, "connect", async () => null);
    try {
      let prompts = 0;
      const client = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
              { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
            ],
          }),
          promptAsync: async () => {
            prompts++;
          },
        },
      };
      const hooks = await plugin.server({ client, directory: "/tmp" } as never, {});
      await hooks["chat.message"](
        { sessionID: "parent" },
        { parts: [{ type: "text", text: "hello" }] },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(prompts, 1);
      await hooks.dispose();
    } finally {
      connect.mock.restore();
      if (previousMin === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = previousMin;
    }
  });

  it("waits for promptAsync acceptance but not subagent execution", async () => {
    const previousMin = process.env.MEMOIR_CAPTURE_MIN_CHARS;
    process.env.MEMOIR_CAPTURE_MIN_CHARS = "0";
    const connect = mock.method(MemoirRuntime.prototype, "connect", async () => null);
    try {
      let acceptPrompt!: () => void;
      const accepted = new Promise<void>((resolve) => {
        acceptPrompt = resolve;
      });
      const client = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hello" }] },
              { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
            ],
          }),
          promptAsync: () => accepted,
        },
      };
      const hooks = await plugin.server({ client, directory: "/tmp" } as never, {});
      let finished = false;
      const hookRun = hooks["chat.message"](
        { sessionID: "parent" },
        { parts: [{ type: "text", text: "next" }] },
      ).then(() => {
        finished = true;
      });

      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(finished, false);
      acceptPrompt();
      await hookRun;
      assert.strictEqual(finished, true);
      await hooks.dispose();
    } finally {
      connect.mock.restore();
      if (previousMin === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = previousMin;
    }
  });

  it("ignores memoir subtask and synthetic messages for capture", async () => {
    let prompts = 0;
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        promptAsync: async () => {
          prompts++;
        },
      },
    };
    const hooks = await plugin.server({ client, directory: "/tmp" } as never, {});
    await hooks["chat.message"](
      { sessionID: "subtask-parent" },
      { parts: [{ type: "subtask", agent: "memoir" }] },
    );
    await hooks["chat.message"](
      { sessionID: "synthetic-parent" },
      { parts: [{ type: "text", synthetic: true }] },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(prompts, 0);
    await hooks.dispose();
  });

  it("marks only memoir tasks as native background jobs when enabled", async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";
    try {
      const hooks = await plugin.server(undefined, {});
      const memoir = { args: { subagent_type: "memoir" } };
      await hooks["tool.execute.before"]({ tool: "task" }, memoir);
      assert.strictEqual(memoir.args.background, true);

      const other = { args: { subagent_type: "general" } };
      await hooks["tool.execute.before"]({ tool: "task" }, other);
      assert.strictEqual("background" in other.args, false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previous;
    }
  });

  it("mirrors OpenCode's umbrella experimental flag and explicit override", async () => {
    const previousBackground = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const previousExperimental = process.env.OPENCODE_EXPERIMENTAL;
    process.env.OPENCODE_EXPERIMENTAL = "true";
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    try {
      const hooks = await plugin.server(undefined, {});
      const umbrella = { args: { subagent_type: "memoir" } };
      await hooks["tool.execute.before"]({ tool: "task" }, umbrella);
      assert.strictEqual(umbrella.args.background, true);

      process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "false";
      const overridden = { args: { subagent_type: "memoir" } };
      await hooks["tool.execute.before"]({ tool: "task" }, overridden);
      assert.strictEqual("background" in overridden.args, false);
      await hooks.dispose();
    } finally {
      if (previousBackground === undefined)
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackground;
      if (previousExperimental === undefined) delete process.env.OPENCODE_EXPERIMENTAL;
      else process.env.OPENCODE_EXPERIMENTAL = previousExperimental;
    }
  });

  it("tracks foreground memoir tasks through tool.execute.after", async () => {
    const hooks = await plugin.server({ client: {}, directory: "/tmp" } as never, {});
    const args = { subagent_type: "memoir" };
    await hooks["tool.execute.before"]({ tool: "task", callID: "call-fg" }, { args });
    await hooks["tool.execute.after"]({ tool: "task", callID: "call-fg", args }, {});
    await hooks.dispose();
  });

  it("tracks background memoir tasks until the child session becomes idle", async () => {
    const previous = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true";
    try {
      const hooks = await plugin.server({ client: {}, directory: "/tmp" } as never, {});
      const args = { subagent_type: "memoir" };
      await hooks["tool.execute.before"]({ tool: "task", callID: "call-bg" }, { args });
      await hooks["tool.execute.after"](
        { tool: "task", callID: "call-bg", args },
        { metadata: { background: true, sessionId: "child-bg" } },
      );
      await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "child-bg" } },
      });
      await hooks.dispose();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previous;
    }
  });

  it("finishes a known background memoir task when its child errors", async () => {
    const hooks = await plugin.server({ client: {}, directory: "/tmp" } as never, {});
    const args = { subagent_type: "memoir" };
    await hooks["tool.execute.before"]({ tool: "task", callID: "call-error" }, { args });
    await hooks["tool.execute.after"](
      { tool: "task", callID: "call-error", args },
      { metadata: { background: true, sessionId: "child-error" } },
    );
    await hooks.event({
      event: { type: "session.error", properties: { sessionID: "child-error" } },
    });
    await hooks.dispose();
  });

  it("leaves memoir tasks foreground when native background jobs are disabled", async () => {
    const previousBackground = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    const previousExperimental = process.env.OPENCODE_EXPERIMENTAL;
    delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
    delete process.env.OPENCODE_EXPERIMENTAL;
    try {
      const hooks = await plugin.server(undefined, {});
      const output = { args: { subagent_type: "memoir" } };
      await hooks["tool.execute.before"]({ tool: "task" }, output);
      assert.strictEqual("background" in output.args, false);
    } finally {
      if (previousBackground === undefined)
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
      else process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = previousBackground;
      if (previousExperimental === undefined) delete process.env.OPENCODE_EXPERIMENTAL;
      else process.env.OPENCODE_EXPERIMENTAL = previousExperimental;
    }
  });

  it("returns system.transform hook", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(typeof hooks["experimental.chat.system.transform"], "function");
  });

  it("returns dispose hook", async () => {
    const hooks = await plugin.server(undefined, {});
    assert.strictEqual(typeof hooks.dispose, "function");
  });

  it("config hook registers memoir:onboard command", async () => {
    const start = mock.method(
      MemoirRuntime.prototype,
      "start",
      async () => new URL("http://127.0.0.1:43210/mcp"),
    );
    try {
      const hooks = await plugin.server(undefined, {});
      const config: { command?: Record<string, unknown> } = {};
      await hooks.config(config);
      assert.ok(config.command);
      assert.ok(config.command["memoir:onboard"]);
      assert.strictEqual(
        (config.command["memoir:onboard"] as { description: string }).description,
        "Populate or refresh Memoir onboarding for this project",
      );
    } finally {
      start.mock.restore();
    }
  });

  it("returns top-level mcp server (memoir)", async () => {
    const start = mock.method(
      MemoirRuntime.prototype,
      "start",
      async () => new URL("http://127.0.0.1:43210/mcp"),
    );
    try {
      const hooks = await plugin.server(undefined, {});
      const config = {} as Record<string, unknown>;
      await (hooks.config as (c: Record<string, unknown>) => Promise<void>)(config);
      const mcp = (hooks as { mcp?: Record<string, unknown> }).mcp;
      assert.ok(mcp);
      assert.ok(mcp.memoir);
      const mcpServer = mcp.memoir as {
        type: string;
        url: string;
        enabled?: boolean;
      };
      assert.strictEqual(mcpServer.type, "remote");
      assert.ok(mcpServer.url.startsWith("http://"));
    } finally {
      start.mock.restore();
    }
  });

  it("shell.env injects MEMOIR_STORE", async () => {
    const hooks = await plugin.server(undefined, {});
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"]({}, output);
    assert.ok(output.env.MEMOIR_STORE);
  });

  it("dispose runs without error", async () => {
    const hooks = await plugin.server(undefined, {});
    await hooks.dispose();
  });

  it("config hook registers the memoir subagent without branch checkout", async () => {
    const start = mock.method(
      MemoirRuntime.prototype,
      "start",
      async () => new URL("http://127.0.0.1:43210/mcp"),
    );
    try {
      const hooks = await plugin.server({ client: {}, directory: "/tmp" } as never, {});
      const config: {
        agent?: Record<string, { mode?: string; permission?: Record<string, string> }>;
      } = {};
      await (hooks.config as (c: typeof config) => Promise<void>)(config);
      assert.ok(config.agent);
      const agent = config.agent.memoir;
      assert.ok(agent);
      assert.strictEqual(agent.mode, "subagent");
      const perm = agent.permission ?? {};
      assert.strictEqual(perm["*"], "deny");
      assert.strictEqual(perm["memoir_*"], "allow");
      assert.strictEqual(perm.memoir_memoir_checkout, "deny");
    } finally {
      start.mock.restore();
    }
  });

  it("runs the connected branch, recall, status, and session-marker flow", async () => {
    const previousAutoSave = process.env.MEMOIR_AUTO_SAVE;
    process.env.MEMOIR_AUTO_SAVE = "1";
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const codeBranch = currentGitBranch(process.cwd());
    const mcpClient = {
      listTools: async () => ({
        tools: [{ name: "memoir_remember", description: "Store durable memory" }],
      }),
      callTool: async (input: { name: string; arguments?: Record<string, unknown> }) => {
        calls.push(input);
        const text =
          input.name === "memoir_summarize"
            ? JSON.stringify({ total: 29, namespaces: { default: { preferences: 29 } } })
            : input.name === "memoir_status"
              ? JSON.stringify({ branch: codeBranch, memory_count: 31 })
              : "ok";
        return { content: [{ type: "text", text }] };
      },
    };
    const start = mock.method(
      MemoirRuntime.prototype,
      "start",
      async () => new URL("http://127.0.0.1:43210/mcp"),
    );
    const connect = mock.method(MemoirRuntime.prototype, "connect", async () => mcpClient as never);
    try {
      const capturePrompts: string[] = [];
      const sdkClient = {
        session: {
          messages: async () => ({
            data: [
              { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "remember" }] },
              { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "saved" }] },
            ],
          }),
          promptAsync: async (input: { body: { parts: Array<{ prompt: string }> } }) => {
            capturePrompts.push(input.body.parts[0].prompt);
          },
        },
      };
      const hooks = await plugin.server(
        { client: sdkClient, directory: process.cwd() } as never,
        {},
      );
      const config = {
        model: "provider/main",
        mcp: { existing: { type: "local" } },
        agent: { existing: { mode: "primary" } },
        command: { existing: { description: "keep" } },
      };
      await hooks.config(config as never);

      for (let i = 0; i < 5; i++) {
        await hooks["chat.message"](
          { sessionID: "parent" },
          { parts: [{ type: "text", text: `message ${i}` }] },
        );
      }

      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "parent" }, output);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(output.system.some((line) => line.includes('"total":29')));
      assert.ok(output.system.some((line) => line.includes(`memory available (31 memories)`)));

      const second = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "parent" }, second);
      assert.ok(second.system.some((line) => line.includes(`memory available (31 memories)`)));
      assert.ok(second.system.every((line) => !line.includes('"total":29')));

      await hooks.dispose();
      assert.ok(calls.some((call) => call.name === "memoir_summarize"));
      assert.ok(calls.some((call) => call.name === "memoir_status"));
      assert.ok(calls.some((call) => call.name === "memoir_remember"));
      assert.ok(
        capturePrompts.some((prompt) =>
          prompt.includes("memoir_memoir_remember — Store durable memory"),
        ),
      );
      assert.strictEqual(start.mock.callCount(), 1);
      assert.ok(connect.mock.callCount() >= 1);
    } finally {
      start.mock.restore();
      connect.mock.restore();
      if (previousAutoSave === undefined) delete process.env.MEMOIR_AUTO_SAVE;
      else process.env.MEMOIR_AUTO_SAVE = previousAutoSave;
    }
  });

  it("degrades cleanly when server startup and internal connection fail", async () => {
    const start = mock.method(MemoirRuntime.prototype, "start", async () => {
      throw "start failed";
    });
    const connect = mock.method(MemoirRuntime.prototype, "connect", async () => {
      throw "connect failed";
    });
    try {
      const hooks = await plugin.server({ client: {}, directory: "/tmp" } as never, {});
      const config = { mcp: { existing: { type: "local" } } };
      await hooks.config(config as never);
      assert.deepStrictEqual(config.mcp, {
        existing: { type: "local" },
      });
      await hooks["chat.message"]({ sessionID: "parent" }, { parts: [] });
      await hooks["experimental.chat.system.transform"]({ sessionID: "parent" }, { system: [] });
      await hooks.dispose();
    } finally {
      start.mock.restore();
      connect.mock.restore();
    }
  });
});
