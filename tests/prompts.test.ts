import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadPrompt } from "../src/prompts.ts";

describe("loadPrompt", () => {
  it("loads a template verbatim with its placeholders intact", () => {
    const text = loadPrompt("subagent-system.tmpl");
    assert.match(text, /# WHO YOU ARE/);
    assert.match(text, /# WHAT TO DO/);
    assert.match(text, /# WHAT NOT TO DO/);
    assert.match(text, /NEVER OUTPUT ANY TEXT/);
    assert.match(text, /NEVER RETURN A RESPONSE/);
    assert.match(text, /NEVER switch the memoir branch/);
    assert.match(text, /!!!$/m);
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
