import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySaver, shouldRemind } from "../src/memory-saver.ts";

describe("incrementMsgCount", () => {
  it("returns 1 on first increment", () => {
    const saver = new MemorySaver();
    assert.strictEqual(saver.increment("sess1"), 1);
  });

  it("increments on subsequent calls", () => {
    const saver = new MemorySaver();
    saver.increment("sess1");
    assert.strictEqual(saver.increment("sess1"), 2);
    assert.strictEqual(saver.increment("sess1"), 3);
  });

  it("uses separate count per session", () => {
    const saver = new MemorySaver();
    saver.increment("sess1");
    saver.increment("sess1");
    assert.strictEqual(saver.increment("sess2"), 1);
  });
});

describe("shouldRemind", () => {
  const defaultInterval = 5;

  it("returns false for count <= 1", () => {
    assert.strictEqual(shouldRemind(0), false);
    assert.strictEqual(shouldRemind(1), false);
  });

  it("returns false when count is not a multiple of interval", () => {
    assert.strictEqual(shouldRemind(2), false);
    assert.strictEqual(shouldRemind(3), false);
  });

  it("returns true at the interval boundary", () => {
    assert.strictEqual(shouldRemind(defaultInterval), true);
    assert.strictEqual(shouldRemind(10), true);
  });
});

describe("pruneAll", () => {
  it("clears all session counts", () => {
    const saver = new MemorySaver();
    saver.increment("sess1");
    saver.increment("sess2");
    saver.clear();
    assert.strictEqual(saver.counts.size, 0);
  });
});
