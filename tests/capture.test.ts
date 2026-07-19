import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/capture.js";
import {
  captureTurn,
  formatSessionTranscript,
  lastTurnTranscript,
  shouldCaptureTurn,
} from "../src/capture.js";

const userMsg = (id: string, text: string): ChatMessage => ({
  info: { id, role: "user" },
  parts: [{ type: "text", text }],
});

const assistantMsg = (id: string, text: string): ChatMessage => ({
  info: { id, role: "assistant" },
  parts: [{ type: "text", text }],
});

type FakePromptAsyncInput = {
  path: { id: string };
  body: {
    parts: Array<{
      type: string;
      agent?: string;
      prompt?: string;
      description?: string;
      command?: string;
    }>;
  };
};

describe("formatSessionTranscript", () => {
  it("renders roles and skips non-text messages", () => {
    const out = formatSessionTranscript([
      userMsg("u1", "hello"),
      assistantMsg("a1", "hi there"),
      { info: { id: "x", role: "tool" }, parts: [{ type: "json", text: "{}" }] },
    ]);
    assert.match(out, /USER/);
    assert.match(out, /hello/);
    assert.match(out, /ASSISTANT/);
    assert.match(out, /hi there/);
    assert.doesNotMatch(out, /tool/);
  });

  it("renders system and unknown roles and joins text parts", () => {
    const out = formatSessionTranscript([
      { info: { role: "system" }, parts: [{ type: "text", text: "rules" }] },
      {
        info: { role: "critic" },
        parts: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { parts: [{ type: "text", text: "fallback" }] },
    ]);
    assert.match(out, /SYSTEM\nrules/);
    assert.match(out, /CRITIC\nfirst\nsecond/);
    assert.match(out, /UNKNOWN\nfallback/);
  });
});

describe("lastTurnTranscript", () => {
  it("returns the last user+assistant exchange", () => {
    const msgs = [
      userMsg("u1", "first question"),
      assistantMsg("a1", "first answer"),
      userMsg("u2", "second question"),
      assistantMsg("a2", "second answer"),
    ];
    const out = lastTurnTranscript(msgs);
    assert.ok(out);
    assert.match(out, /second question/);
    assert.match(out, /second answer/);
    assert.doesNotMatch(out, /first question/);
  });

  it("returns null when no completed assistant turn exists", () => {
    const msgs = [userMsg("u1", "just a question")];
    assert.equal(lastTurnTranscript(msgs), null);
  });

  it("returns null when an assistant answer has no preceding user", () => {
    assert.equal(lastTurnTranscript([assistantMsg("a1", "orphan answer")]), null);
  });
});

describe("shouldCaptureTurn", () => {
  it("respects the min-chars pre-filter", () => {
    assert.equal(shouldCaptureTurn("short", 16), false);
    assert.equal(shouldCaptureTurn("a reasonably long turn worth capturing", 16), true);
  });

  it("captures everything when min-chars is 0", () => {
    assert.equal(shouldCaptureTurn("x", 0), true);
    assert.equal(shouldCaptureTurn(null, 0), false);
  });

  it("uses the default threshold for an invalid environment value", () => {
    const previous = process.env.MEMOIR_CAPTURE_MIN_CHARS;
    process.env.MEMOIR_CAPTURE_MIN_CHARS = "not-a-number";
    try {
      assert.equal(shouldCaptureTurn("short"), false);
      assert.equal(shouldCaptureTurn("long enough transcript"), true);
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = previous;
    }
  });
});

describe("captureTurn", () => {
  it("quietly skips unavailable, invalid, and incomplete transcript APIs", async () => {
    const seen = new Map<string, string>();
    await captureTurn(null, "missing", seen);
    await captureTurn({ session: { messages: async () => ({ data: {} }) } }, "invalid", seen);
    await captureTurn({ session: { messages: async () => ({ data: [] }) } }, "empty", seen);
    await captureTurn(
      { session: { messages: async () => ({ data: [userMsg("u1", "question")] }) } },
      "incomplete",
      seen,
    );
    assert.strictEqual(seen.size, 0);
  });

  it("marks a below-threshold turn as seen without dispatching it", async () => {
    const previous = process.env.MEMOIR_CAPTURE_MIN_CHARS;
    process.env.MEMOIR_CAPTURE_MIN_CHARS = "1000";
    let prompts = 0;
    try {
      const client = {
        session: {
          messages: async () => ({ data: [userMsg("u1", "q"), assistantMsg("a1", "a")] }),
          promptAsync: async () => {
            prompts++;
          },
        },
      };
      const seen = new Map<string, string>();
      await captureTurn(client, "sid", seen);
      assert.strictEqual(prompts, 0);
      assert.strictEqual(seen.get("sid"), "a1");
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = previous;
    }
  });

  it("swallows transcript retrieval errors", async () => {
    const client = {
      session: {
        messages: async () => {
          throw "messages failed";
        },
      },
    };
    await captureTurn(client, "sid", new Map());
  });

  it("is a no-op and never throws when MEMOIR_AUTO_SAVE=0", async () => {
    const prev = process.env.MEMOIR_AUTO_SAVE;
    process.env.MEMOIR_AUTO_SAVE = "0";
    try {
      const captured: string[] = [];
      const fakeClient = {
        session: {
          messages: async () => ({ data: [userMsg("u1", "q"), assistantMsg("a1", "a")] }),
          promptAsync: async (input: FakePromptAsyncInput) => {
            captured.push(input.body.parts[0].prompt ?? "");
          },
        },
      };
      const seen = new Map<string, string>();
      await captureTurn(fakeClient, "sid", seen);
      assert.equal(captured.length, 0);
    } finally {
      if (prev === undefined) delete process.env.MEMOIR_AUTO_SAVE;
      else process.env.MEMOIR_AUTO_SAVE = prev;
    }
  });

  it("fires the subagent for a completed turn above the min-chars filter", async () => {
    const prevSave = process.env.MEMOIR_AUTO_SAVE;
    const prevMin = process.env.MEMOIR_CAPTURE_MIN_CHARS;
    delete process.env.MEMOIR_AUTO_SAVE;
    process.env.MEMOIR_CAPTURE_MIN_CHARS = "0";
    try {
      let prompted: { type?: string; agent?: string; prompt?: string; directory?: string } | null =
        null as {
          type?: string;
          agent?: string;
          prompt?: string;
          directory?: string;
        } | null;
      const fakeClient = {
        session: {
          messages: async () => ({
            data: [
              userMsg("u1", "How do I configure the plugin?"),
              assistantMsg("a1", "You set mcp.memoir in opencode.jsonc and reload."),
            ],
          }),
          promptAsync: async (input: FakePromptAsyncInput) => {
            // The plugin client is the v1 SDK client, whose promptAsync takes
            // the { path, body } shape (NOT the flat v2 shape). A subagent is
            // dispatched as a `subtask` part, not inline text.
            const part = input.body.parts[0];
            prompted = {
              type: part.type,
              agent: part.agent,
              prompt: part.prompt,
              directory: (input as { directory?: string }).directory,
            };
          },
        },
      };
      const seen = new Map<string, string>();
      await captureTurn(fakeClient, "sid", seen);
      assert.ok(prompted);
      assert.equal(prompted?.type, "subtask");
      assert.equal(prompted?.agent, "memoir");
      assert.match(prompted?.prompt ?? "", /How do I configure/);
      // The v1 SDK client's promptAsync takes { path, body } with no
      // `directory` field — the instance is already directory-bound. Assert
      // directory is never sent.
      assert.equal(prompted?.directory, undefined);

      // deduped on the second call (same last assistant id)
      const again = new Map<string, string>(seen);
      await captureTurn(fakeClient, "sid", again);
      assert.equal(again.get("sid"), seen.get("sid"));
    } finally {
      if (prevSave === undefined) delete process.env.MEMOIR_AUTO_SAVE;
      else process.env.MEMOIR_AUTO_SAVE = prevSave;
      if (prevMin === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = prevMin;
    }
  });
});
