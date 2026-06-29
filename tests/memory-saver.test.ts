import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { incrementMsgCount, pruneAll, sessionMsgCount, shouldRemind } from "../src/memory-saver.ts";

describe("incrementMsgCount", () => {
  afterEach(() => pruneAll());

  it("returns 1 on first increment", () => {
    assert.strictEqual(incrementMsgCount("sess1"), 1);
  });

  it("increments on subsequent calls", () => {
    incrementMsgCount("sess1");
    assert.strictEqual(incrementMsgCount("sess1"), 2);
    assert.strictEqual(incrementMsgCount("sess1"), 3);
  });

  it("uses separate count per session", () => {
    incrementMsgCount("sess1");
    incrementMsgCount("sess1");
    assert.strictEqual(incrementMsgCount("sess2"), 1);
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
    incrementMsgCount("sess1");
    incrementMsgCount("sess2");
    pruneAll();
    assert.strictEqual(sessionMsgCount.size, 0);
  });
});
