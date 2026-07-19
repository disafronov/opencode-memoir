import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { currentGitBranch, MemoirBranchMatcher } from "../src/index.ts";
import { deriveStorePath } from "../src/path.ts";

const tempRepos = new Set<string>();

function createGitRepo(branch = "test-branch"): string {
  const cwd = mkdtempSync(join(tmpdir(), "memoir-store-test-"));
  tempRepos.add(cwd);
  execFileSync("git", ["init", "--initial-branch", branch], { cwd, stdio: "ignore" });
  return cwd;
}

afterEach(() => {
  for (const cwd of tempRepos) rmSync(cwd, { recursive: true, force: true });
  tempRepos.clear();
});

describe("deriveStorePath", () => {
  it("uses pluginStoreOverride when set", () => {
    assert.strictEqual(deriveStorePath("/ignored", "/custom/store"), "/custom/store");
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
    const mod = await import("../src/index.ts");
    assert.strictEqual(mod.currentGitBranch("/nonexistent-path"), "");
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

describe("MemoirBranchMatcher", () => {
  it("no-ops when not in a git repo", async () => {
    let called = false;
    const client = {
      callTool: async () => {
        called = true;
        return { content: [] };
      },
    };
    await new MemoirBranchMatcher().match(client as never, "/nonexistent-path");
    assert.strictEqual(called, false);
  });

  it("reads the actual store branch on every match", async () => {
    const cwd = createGitRepo();
    const codeBranch = currentGitBranch(cwd);
    const calls: string[] = [];
    const client = {
      callTool: async (input: { name: string }) => {
        calls.push(input.name);
        return { content: [{ type: "text", text: JSON.stringify({ branch: codeBranch }) }] };
      },
    };
    const matcher = new MemoirBranchMatcher();
    await matcher.match(client as never, cwd);
    await matcher.match(client as never, cwd);
    assert.deepEqual(calls, ["memoir_status", "memoir_status"]);
  });

  it("drains active captures before checkout and rechecks the branch", async () => {
    const cwd = createGitRepo();
    const codeBranch = currentGitBranch(cwd);
    const order: string[] = [];
    let current = "other";
    const client = {
      callTool: async (input: { name: string }) => {
        order.push(input.name);
        if (input.name === "memoir_checkout") current = codeBranch;
        return { content: [{ type: "text", text: JSON.stringify({ branch: current }) }] };
      },
    };
    const matcher = new MemoirBranchMatcher();
    await matcher.match(client as never, cwd, async () => {
      order.push("drain");
      return true;
    });
    assert.deepEqual(order, ["memoir_status", "drain", "memoir_status", "memoir_checkout"]);
  });

  it("defers checkout when active captures do not drain", async () => {
    const cwd = createGitRepo();
    const calls: string[] = [];
    const client = {
      callTool: async (input: { name: string }) => {
        calls.push(input.name);
        return { content: [{ type: "text", text: JSON.stringify({ branch: "other" }) }] };
      },
    };
    await new MemoirBranchMatcher().match(client as never, cwd, async () => false);
    assert.deepEqual(calls, ["memoir_status"]);
  });
});
