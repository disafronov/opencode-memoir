import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  autoMatchMemoirBranch,
  branchExistsInMemoir,
  codeGitBranch,
  getCurrentBranch,
  readMemoirValue,
  setStoreTestOverrides,
} from "../src/store.ts";

const TEST_STORE = "/tmp/test-memoir-store";

describe("getCurrentBranch", () => {
  afterEach(() => {
    setStoreTestOverrides({});
  });

  it("returns branch name from memoir status", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: '{"branch":"main"}' }),
    });
    const result = await getCurrentBranch(TEST_STORE);
    assert.strictEqual(result, "main");
  });

  it("returns unknown when branch missing from status", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: "{}" }),
    });
    const result = await getCurrentBranch(TEST_STORE);
    assert.strictEqual(result, "unknown");
  });

  it("returns unknown on CLI error", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => {
        throw new Error("fail");
      },
    });
    const result = await getCurrentBranch(TEST_STORE);
    assert.strictEqual(result, "unknown");
  });
});

describe("codeGitBranch", () => {
  afterEach(() => {
    setStoreTestOverrides({});
  });

  it("returns current git branch", async () => {
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "feature-x\n" }),
    });
    const result = await codeGitBranch();
    assert.strictEqual(result, "feature-x");
  });

  it("returns empty string for detached HEAD", async () => {
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "\n" }),
    });
    const result = await codeGitBranch();
    assert.strictEqual(result, "");
  });

  it("returns empty string on git error", async () => {
    setStoreTestOverrides({
      execFileAsyncFn: async () => {
        throw new Error("fail");
      },
    });
    const result = await codeGitBranch();
    assert.strictEqual(result, "");
  });
});

describe("branchExistsInMemoir", () => {
  afterEach(() => {
    setStoreTestOverrides({});
  });

  it("returns true when branch exists", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: '{"branches":["main","dev"]}' }),
    });
    const result = await branchExistsInMemoir(TEST_STORE, "dev");
    assert.strictEqual(result, true);
  });

  it("returns false when branch not found", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: '{"branches":["main"]}' }),
    });
    const result = await branchExistsInMemoir(TEST_STORE, "dev");
    assert.strictEqual(result, false);
  });

  it("returns false for empty name", async () => {
    // No mock needed — function returns early without CLI call
    setStoreTestOverrides({
      runMemoirFn: async () => {
        throw new Error("should not be called");
      },
    });
    const result = await branchExistsInMemoir(TEST_STORE, "");
    assert.strictEqual(result, false);
  });

  it("returns false on CLI error", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => {
        throw new Error("fail");
      },
    });
    const result = await branchExistsInMemoir(TEST_STORE, "dev");
    assert.strictEqual(result, false);
  });
});

describe("autoMatchMemoirBranch", () => {
  afterEach(() => {
    setStoreTestOverrides({});
  });

  it("returns current when already matched", async () => {
    // codeGitBranch -> main, getCurrentBranch -> main
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "main\n" }),
      runMemoirFn: async (args) => {
        const joined = args.join(" ");
        if (joined.includes("status")) return { ok: true, stdout: '{"branch":"main"}' };
        return { ok: true, stdout: "" };
      },
    });
    const result = await autoMatchMemoirBranch(TEST_STORE);
    assert.strictEqual(result, "main");
  });

  it("creates branch from main when missing, then checkouts", async () => {
    // codeGitBranch -> dev, getCurrentBranch -> main, branchExists -> false
    // expect: create branch dev --from main, then checkout dev
    const calls: string[][] = [];
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "dev\n" }),
      runMemoirFn: async (args) => {
        calls.push(args);
        const joined = args.join(" ");
        if (joined.includes("status")) return { ok: true, stdout: '{"branch":"main"}' };
        if (joined.includes("branch") && joined.includes("--json"))
          return { ok: true, stdout: '{"branches":["main"]}' };
        if (joined.includes("branch") && joined.includes("--from"))
          return { ok: true, stdout: "ok" };
        if (joined.includes("checkout")) return { ok: true, stdout: "ok" };
        return { ok: true, stdout: "" };
      },
    });
    const result = await autoMatchMemoirBranch(TEST_STORE);
    assert.strictEqual(result, "dev");

    // Verify both create and checkout were called
    const createCall = calls.find((c) => c.includes("branch") && c.includes("--from"));
    assert.ok(createCall, "expected branch --from call");
    const checkoutCall = calls.find((c) => c.includes("checkout"));
    assert.ok(checkoutCall, "expected checkout call");
  });

  it("checkouts existing branch without creating", async () => {
    // codeGitBranch -> dev, getCurrentBranch -> main, branchExists -> true
    // expect: only checkout dev, no create
    const calls: string[][] = [];
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "dev\n" }),
      runMemoirFn: async (args) => {
        calls.push(args);
        const joined = args.join(" ");
        if (joined.includes("status")) return { ok: true, stdout: '{"branch":"main"}' };
        if (joined.includes("branch") && joined.includes("--json"))
          return { ok: true, stdout: '{"branches":["main","dev"]}' };
        if (joined.includes("checkout")) return { ok: true, stdout: "ok" };
        return { ok: true, stdout: "" };
      },
    });
    const result = await autoMatchMemoirBranch(TEST_STORE);
    assert.strictEqual(result, "dev");

    // Verify no create call was made
    const createCall = calls.find((c) => c.includes("branch") && c.includes("--from"));
    assert.strictEqual(createCall, undefined, "should not call branch --from");
    const checkoutCall = calls.find((c) => c.includes("checkout"));
    assert.ok(checkoutCall, "expected checkout call");
  });

  it("falls back when code branch empty (detached HEAD)", async () => {
    // codeGitBranch -> "" (detached), getCurrentBranch -> main
    // Returns main without any branch operations
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "\n" }),
      runMemoirFn: async (args) => {
        const joined = args.join(" ");
        if (joined.includes("status")) return { ok: true, stdout: '{"branch":"main"}' };
        throw new Error("should not be called");
      },
    });
    const result = await autoMatchMemoirBranch(TEST_STORE);
    assert.strictEqual(result, "main");
  });

  it("falls back to current on checkout failure", async () => {
    // codeGitBranch -> dev, getCurrentBranch -> main, branchExists -> true
    // checkout returns error string -> getCurrentBranch returns main
    setStoreTestOverrides({
      execFileAsyncFn: async () => ({ stdout: "dev\n" }),
      runMemoirFn: async (args) => {
        const joined = args.join(" ");
        if (joined.includes("status")) return { ok: true, stdout: '{"branch":"main"}' };
        if (joined.includes("branch") && joined.includes("--json"))
          return { ok: true, stdout: '{"branches":["main","dev"]}' };
        if (joined.includes("checkout"))
          return { ok: false, error: "Memoir command failed: checkout fail" };
        return { ok: true, stdout: "" };
      },
    });
    const result = await autoMatchMemoirBranch(TEST_STORE);
    assert.strictEqual(result, "main");
  });
});

describe("readMemoirValue", () => {
  afterEach(() => {
    setStoreTestOverrides({});
  });

  it("returns content of first item", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: '{"items":[{"value":{"content":"hello"}}]}' }),
    });
    const result = await readMemoirValue(TEST_STORE, "some.key");
    assert.strictEqual(result, "hello");
  });

  it("returns empty string when items array is empty", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => ({ ok: true, stdout: '{"items":[]}' }),
    });
    const result = await readMemoirValue(TEST_STORE, "some.key");
    assert.strictEqual(result, "");
  });

  it("uses default namespace when not specified", async () => {
    let capturedArgs: string[] = [];
    setStoreTestOverrides({
      runMemoirFn: async (args) => {
        capturedArgs = args;
        return { ok: true, stdout: '{"items":[{"value":{"content":"val"}}]}' };
      },
    });
    await readMemoirValue(TEST_STORE, "some.key");
    // The args should contain -n default
    const nIndex = capturedArgs.indexOf("-n");
    assert.notStrictEqual(nIndex, -1, "expected -n flag in args");
    assert.ok(nIndex + 1 < capturedArgs.length, "expected namespace value after -n");
    assert.strictEqual(capturedArgs[nIndex + 1], "default");
  });

  it("returns empty string on CLI error", async () => {
    setStoreTestOverrides({
      runMemoirFn: async () => {
        throw new Error("fail");
      },
    });
    const result = await readMemoirValue(TEST_STORE, "some.key");
    assert.strictEqual(result, "");
  });
});
