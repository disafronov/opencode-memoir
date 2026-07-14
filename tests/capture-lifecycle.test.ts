import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CaptureLifecycle } from "../src/capture-lifecycle.js";

describe("CaptureLifecycle", () => {
  it("drains a foreground capture after its task call finishes", async () => {
    const lifecycle = new CaptureLifecycle();
    lifecycle.begin("call-1");
    assert.equal(await lifecycle.drain(1), false);
    lifecycle.finishCall("call-1");
    assert.equal(await lifecycle.drain(1), true);
  });

  it("keeps a background capture active until its child session finishes", async () => {
    const lifecycle = new CaptureLifecycle();
    lifecycle.begin("call-1");
    lifecycle.background("call-1", "child-1");
    assert.equal(await lifecycle.drain(1), false);
    lifecycle.finishSession("other-child");
    assert.equal(await lifecycle.drain(1), false);
    lifecycle.finishSession("child-1");
    assert.equal(await lifecycle.drain(1), true);
  });

  it("clear releases every waiter", async () => {
    const lifecycle = new CaptureLifecycle();
    lifecycle.begin("call-1");
    lifecycle.begin("call-2");
    lifecycle.clear();
    assert.equal(await lifecycle.drain(1), true);
  });
});
