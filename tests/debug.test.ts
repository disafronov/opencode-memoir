import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import { debugLog, infoLog } from "../src/debug.ts";

describe("debugLog", () => {
  afterEach(() => {
    delete process.env.MEMOIR_DEBUG;
    delete process.env.MEMOIR_LOG;
    mock.reset();
  });

  it("writes nothing when MEMOIR_DEBUG is not set", () => {
    process.env.MEMOIR_LOG = "stderr";
    mock.method(process.stderr, "write", () => true);
    debugLog("test message");
    assert.strictEqual((process.stderr.write as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it("writes to stderr when MEMOIR_DEBUG=1 and MEMOIR_LOG=stderr", () => {
    process.env.MEMOIR_DEBUG = "1";
    process.env.MEMOIR_LOG = "stderr";
    mock.method(process.stderr, "write", () => true);
    debugLog("test message");
    const write = process.stderr.write as ReturnType<typeof mock.fn>;
    assert.strictEqual(write.mock.calls.length, 1);
    const written = write.mock.calls[0].arguments[0] as string;
    assert.ok(written.startsWith("[memoir "));
    assert.ok(written.includes("test message"));
  });

  it("handles multiple arguments", () => {
    process.env.MEMOIR_DEBUG = "1";
    process.env.MEMOIR_LOG = "stderr";
    mock.method(process.stderr, "write", () => true);
    debugLog("part1", "part2", 42);
    const write = process.stderr.write as ReturnType<typeof mock.fn>;
    const written = write.mock.calls[0].arguments[0] as string;
    assert.ok(written.includes("part1 part2 42"));
  });
});

describe("infoLog", () => {
  afterEach(() => {
    delete process.env.MEMOIR_LOG;
    mock.reset();
  });

  it("always writes regardless of MEMOIR_DEBUG", () => {
    process.env.MEMOIR_LOG = "stderr";
    mock.method(process.stderr, "write", () => true);
    infoLog("lifecycle event");
    const write = process.stderr.write as ReturnType<typeof mock.fn>;
    assert.strictEqual(write.mock.calls.length, 1);
    assert.ok((write.mock.calls[0].arguments[0] as string).includes("lifecycle event"));
  });

  it("writes to the file named by MEMOIR_LOG", () => {
    const file = join(tmpdir(), `memoir-log-test-${process.pid}-${Date.now()}.log`);
    process.env.MEMOIR_LOG = file;
    try {
      infoLog("to file");
      const contents = readFileSync(file, "utf8");
      assert.ok(contents.includes("to file"));
      assert.ok(contents.includes("info"));
    } finally {
      rmSync(file, { force: true });
    }
  });
});
