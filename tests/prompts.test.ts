import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPrompt } from "../src/prompts.ts";

describe("loadPrompt", () => {
  it("loads a template verbatim with its placeholders intact", () => {
    const text = loadPrompt("subagent-system.tmpl");
    assert.match(text, /Every time you receive input/);
    assert.match(text, /NEVER OUTPUT ANY TEXT/);
    assert.match(text, /NO RESPONSE AT ALL/);
  });

  it("returns the same cached string reference on repeated calls", () => {
    const a = loadPrompt("subagent-system.tmpl");
    const b = loadPrompt("subagent-system.tmpl");
    assert.strictEqual(a, b);
  });

  it("throws for a missing template", () => {
    assert.throws(() => loadPrompt("does-not-exist.tmpl"));
  });
});
