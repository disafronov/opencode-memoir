import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin from "../src/index.ts";

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
    const hooks = await plugin.server(undefined, {});
    const config: { command?: Record<string, unknown> } = {};
    await hooks.config(config);
    assert.ok(config.command);
    assert.ok(config.command["memoir:onboard"]);
    assert.strictEqual(
      (config.command["memoir:onboard"] as { description: string }).description,
      "Populate or refresh Memoir onboarding for this project",
    );
  });

  it("returns top-level mcp server (memoir)", async () => {
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

  it("config hook registers the memoir subagent (subagent mode, memoir_* only)", async () => {
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
  });
});
