import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTurnStatus } from "../src/turn-status.js";

describe("buildTurnStatus", () => {
  it("formats the branch and memory count", () => {
    assert.equal(
      buildTurnStatus('{"branch":"fix6","memory_count":31}'),
      "[memoir] fix6 · memory available (31 memories)",
    );
  });

  it("degrades invalid and partial responses", () => {
    assert.equal(
      buildTurnStatus('{"branch":"main","memory_count":2}'),
      "[memoir] main · memory available (2 memories)",
    );
    assert.equal(buildTurnStatus('{"branch":"main"}'), "[memoir] main");
    assert.equal(buildTurnStatus('{"memory_count":2}'), "[memoir] memory available (2 memories)");
    assert.equal(buildTurnStatus('{"branch":1,"memory_count":"2"}'), "");
    assert.equal(buildTurnStatus(null), "");
    assert.equal(buildTurnStatus("invalid"), "");
  });
});
