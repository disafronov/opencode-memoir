import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveMemoirModel } from "../src/subagent.js";

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

  it("restores the env var after the block (isolation)", () => {
    const outer = process.env.MEMOIR_AGENT_MODEL;
    withEnv("MEMOIR_AGENT_MODEL", "x/y", () => {
      assert.equal(resolveMemoirModel({}), "x/y");
    });
    assert.equal(process.env.MEMOIR_AGENT_MODEL, outer);
  });
});
