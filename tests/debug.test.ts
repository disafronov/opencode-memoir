import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { debugLog } from "../src/debug.ts";

describe("debugLog", () => {
  afterEach(() => {
    delete process.env.MEMOIR_DEBUG;
    mock.reset();
  });

  it("writes nothing when MEMOIR_DEBUG is not set", () => {
    mock.method(process.stderr, "write", () => true);
    debugLog("test message");
    assert.strictEqual(process.stderr.write.mock.calls.length, 0);
  });

  it("writes to stderr when MEMOIR_DEBUG=1", () => {
    process.env.MEMOIR_DEBUG = "1";
    mock.method(process.stderr, "write", () => true);
    debugLog("test message");
    assert.strictEqual(process.stderr.write.mock.calls.length, 1);
    const written = process.stderr.write.mock.calls[0].arguments[0] as string;
    assert.ok(written.startsWith("[memoir "));
    assert.ok(written.includes("test message"));
  });

  it("handles multiple arguments", () => {
    process.env.MEMOIR_DEBUG = "1";
    mock.method(process.stderr, "write", () => true);
    debugLog("part1", "part2", 42);
    const written = process.stderr.write.mock.calls[0].arguments[0] as string;
    assert.ok(written.includes("part1 part2 42"));
  });
});
