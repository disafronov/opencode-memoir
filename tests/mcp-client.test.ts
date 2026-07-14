import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeMemoirClient, listMemoirTools } from "../src/mcp-client.ts";

// listMemoirTools caches its result in module state. Reset that cache before
// each test so assertions about errors / empty catalogs are not masked by a
// prior successful call. closeMemoirClient nulls the cache and is a no-op for
// the server in the test env (nothing was spawned).
describe("listMemoirTools", () => {
  beforeEach(async () => {
    await closeMemoirClient();
  });

  afterEach(async () => {
    await closeMemoirClient();
  });

  it("maps tools to {name, description}, coercing non-string descriptions to empty", async () => {
    let calls = 0;
    const client = {
      listTools: async () => {
        calls++;
        return {
          tools: [
            { name: "memoir_remember", description: "store a durable fact" },
            { name: "memoir_get", description: undefined },
            { name: "memoir_summarize", description: 123 },
          ],
        };
      },
    };
    const tools = await listMemoirTools(client as never);
    assert.deepEqual(tools, [
      { name: "memoir_remember", description: "store a durable fact" },
      { name: "memoir_get", description: "" },
      { name: "memoir_summarize", description: "" },
    ]);
    assert.strictEqual(calls, 1);
  });

  it("caches the catalog so the server is queried only once", async () => {
    let calls = 0;
    const client = {
      listTools: async () => {
        calls++;
        return { tools: [{ name: "memoir_remember", description: "store" }] };
      },
    };
    await listMemoirTools(client as never);
    await listMemoirTools(client as never);
    assert.strictEqual(calls, 1);
  });

  it("returns [] when listTools throws", async () => {
    const client = {
      listTools: async () => {
        throw new Error("server down");
      },
    };
    const tools = await listMemoirTools(client as never);
    assert.deepEqual(tools, []);
  });

  it("returns [] for an empty tool list", async () => {
    const client = {
      listTools: async () => ({ tools: [] }),
    };
    const tools = await listMemoirTools(client as never);
    assert.deepEqual(tools, []);
  });
});
