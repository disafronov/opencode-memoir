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

  it("config hook registers mcp server", async () => {
    const hooks = await plugin.server(undefined, {});
    const config: { mcp?: Record<string, unknown> } = {};
    await hooks.config(config);
    assert.ok(config.mcp);
    assert.ok(config.mcp.memoir);
    const mcpServer = config.mcp.memoir as {
      type: string;
      command: string[];
      environment?: Record<string, string>;
    };
    assert.strictEqual(mcpServer.type, "local");
    assert.ok(mcpServer.command[0] === "uvx");
    assert.ok(mcpServer.command.includes("memoir-mcp"));
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
});
