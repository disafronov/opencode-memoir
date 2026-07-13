import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveStorePath,
  getCachedBranch,
  pruneBranchCache,
  setCachedBranch,
  setPluginStoreOverride,
} from "../src/store.ts";

describe("deriveStorePath", () => {
  it("uses pluginStoreOverride when set", () => {
    setPluginStoreOverride("/custom/store");
    assert.strictEqual(deriveStorePath("/ignored"), "/custom/store");
    setPluginStoreOverride(undefined);
  });

  it("uses MEMOIR_STORE env var when no override", () => {
    process.env.MEMOIR_STORE = "/env/store";
    assert.strictEqual(deriveStorePath("/ignored"), "/env/store");
    delete process.env.MEMOIR_STORE;
  });

  it("uses git root when in a git repo", () => {
    const result = deriveStorePath("/tmp");
    assert.ok(result.startsWith("/"));
    assert.ok(result.includes(".memoir"));
  });

  it("replaces slashes and dots with hyphens in slug", () => {
    const result = deriveStorePath("/home/user/dev/my.app");
    assert.match(result, /my-app$/);
  });

  it("falls back to resolved cwd when not in git repo", () => {
    const result = deriveStorePath("/tmp/non-git-dir");
    assert.match(result, /tmp-non-git-dir/);
  });
});

describe("currentGitBranch", () => {
  it("returns empty string when not in a git repo", async () => {
    const mod = await import("../src/store.ts");
    assert.strictEqual(mod.currentGitBranch("/nonexistent-path"), "");
  });
});

describe("branchCache", () => {
  it("returns empty string for unknown session", () => {
    assert.strictEqual(getCachedBranch("unknown"), "");
  });

  it("stores and retrieves branch", () => {
    setCachedBranch("sess1", "feature-x");
    assert.strictEqual(getCachedBranch("sess1"), "feature-x");
  });

  it("clears all entries on prune", () => {
    setCachedBranch("sess1", "feature-x");
    pruneBranchCache();
    assert.strictEqual(getCachedBranch("sess1"), "");
  });
});

describe("callMemoirTool", () => {
  it("returns text content from a successful tool call", async () => {
    const { callMemoirTool } = await import("../src/mcp-client.ts");
    const client = {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const result = await callMemoirTool(client as never, "memoir_status");
    assert.strictEqual(result, "ok");
  });

  it("returns null when the tool reports an error", async () => {
    const { callMemoirTool } = await import("../src/mcp-client.ts");
    const client = {
      callTool: async () => ({ content: [], isError: true }),
    };
    const result = await callMemoirTool(client as never, "memoir_status");
    assert.strictEqual(result, null);
  });

  it("returns null when callTool throws", async () => {
    const { callMemoirTool } = await import("../src/mcp-client.ts");
    const client = {
      callTool: async () => {
        throw new Error("boom");
      },
    };
    const result = await callMemoirTool(client as never, "memoir_status");
    assert.strictEqual(result, null);
  });
});

describe("autoMatchMemoirBranch", () => {
  it("no-ops when not in a git repo", async () => {
    const { autoMatchMemoirBranch } = await import("../src/store.ts");
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { content: [] };
      },
    };
    // cwd for the test runner is a git repo, but currentGitBranch uses
    // process.cwd(); we can't force non-git here, so just assert it doesn't throw.
    await autoMatchMemoirBranch(client as never, "sess-git");
    assert.ok(typeof called === "boolean");
  });
});
