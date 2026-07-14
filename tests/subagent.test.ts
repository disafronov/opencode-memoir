import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMemoirAgent, MEMOIR_CHECKOUT_TOOL, resolveMemoirModel } from "../src/subagent.js";

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe("resolveMemoirModel", () => {
  it("prefers MEMOIR_AGENT_MODEL over config values", () => {
    withEnv("MEMOIR_AGENT_MODEL", "anthropic/claude-haiku", () => {
      const model = resolveMemoirModel({
        summarizeModel: "cfg/sum",
        smallModel: "cfg/small",
        model: "cfg/model",
      });
      assert.equal(model, "anthropic/claude-haiku");
    });
  });

  it("falls back to small_model when env unset", () => {
    withEnv("MEMOIR_AGENT_MODEL", undefined, () => {
      const model = resolveMemoirModel({
        smallModel: "local/fast",
        model: "local/big",
      });
      assert.equal(model, "local/fast");
    });
  });

  it("falls back to model when small_model unset", () => {
    withEnv("MEMOIR_AGENT_MODEL", undefined, () => {
      const model = resolveMemoirModel({ model: "local/big" });
      assert.equal(model, "local/big");
    });
  });

  it("returns undefined when nothing is set", () => {
    withEnv("MEMOIR_AGENT_MODEL", undefined, () => {
      const model = resolveMemoirModel({});
      assert.equal(model, undefined);
    });
  });

  it("rejects bare model ids (no provider/model shape)", () => {
    withEnv("MEMOIR_AGENT_MODEL", undefined, () => {
      const model = resolveMemoirModel({ model: "claude-haiku" });
      assert.equal(model, undefined);
    });
  });

  it("ignores an invalid env override and uses small_model", () => {
    withEnv("MEMOIR_AGENT_MODEL", "bare-model", () => {
      assert.equal(resolveMemoirModel({ smallModel: "local/small" }), "local/small");
    });
  });

  it("restores the env var after the block (isolation)", () => {
    const outer = process.env.MEMOIR_AGENT_MODEL;
    withEnv("MEMOIR_AGENT_MODEL", "x/y", () => {
      assert.equal(resolveMemoirModel({}), "x/y");
    });
    assert.equal(process.env.MEMOIR_AGENT_MODEL, outer);
  });
});

describe("buildMemoirAgent", () => {
  it("allows memoir tools but denies the store-global checkout tool last", () => {
    const agent = buildMemoirAgent("local/small");
    assert.equal(agent.permission["*"], "deny");
    assert.equal(agent.permission["memoir_*"], "allow");
    assert.equal(agent.permission[MEMOIR_CHECKOUT_TOOL], "deny");
    assert.deepEqual(Object.keys(agent.permission), [
      "*",
      "doom_loop",
      "memoir_*",
      MEMOIR_CHECKOUT_TOOL,
    ]);
    assert.equal(agent.temperature, 0);
  });
});
