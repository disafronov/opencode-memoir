import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { log } from "../src/debug.ts";

const files = new Set<string>();

function useTempLog(): string {
  const file = join(tmpdir(), `memoir-log-test-${process.pid}-${Date.now()}-${files.size}.log`);
  files.add(file);
  process.env.MEMOIR_LOG = file;
  return file;
}

afterEach(() => {
  delete process.env.MEMOIR_DEBUG;
  delete process.env.MEMOIR_LOG;
  for (const file of files) rmSync(file, { force: true });
  files.clear();
});

describe("log", () => {
  it("writes lifecycle messages when MEMOIR_DEBUG is not set", () => {
    const file = useTempLog();
    log("lifecycle event");
    assert.match(readFileSync(file, "utf8"), /^\[memoir .+\] lifecycle event\n$/);
  });

  it("writes lifecycle messages when MEMOIR_DEBUG=1", () => {
    const file = useTempLog();
    process.env.MEMOIR_DEBUG = "1";
    log("lifecycle event");
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /^\[memoir .+\] lifecycle event\n$/);
  });

  it("handles multiple arguments", () => {
    const file = useTempLog();
    process.env.MEMOIR_DEBUG = "1";
    log("part1", "part2", 42);
    assert.match(readFileSync(file, "utf8"), /part1 part2 42/);
  });

  it("renders concise Errors without MEMOIR_DEBUG and supplies the colon", () => {
    const file = useTempLog();
    log("operation failed", new Error("failure detail"));
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /operation failed: failure detail/);
    assert.doesNotMatch(contents, /debug\.test\.ts/);
  });

  it("renders Error stacks with MEMOIR_DEBUG=1", () => {
    const file = useTempLog();
    process.env.MEMOIR_DEBUG = "1";
    log("operation failed", new Error("failure detail"));
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /operation failed: Error: failure detail/);
    assert.match(contents, /debug\.test\.ts/);
  });

  it("uses the configured file path", () => {
    const file = useTempLog();
    process.env.MEMOIR_DEBUG = "1";
    log("configured destination");
    assert.match(readFileSync(file, "utf8"), /configured destination/);
  });
});
