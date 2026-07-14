import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../src/capture.js";
import {
  buildTurnCaptureTask,
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
});

describe("buildTurnCaptureTask", () => {
  it("embeds the transcript and imposes silence + taxonomy rules", () => {
    const task = buildTurnCaptureTask("USER\nhi\nASSISTANT\nhello", [
      { name: "memoir_memoir_remember", description: "store a durable fact at a taxonomy path" },
    ]);
    assert.match(task, /SILENT/);
    assert.match(task, /memoir_memoir_remember/);
    assert.match(task, /store a durable fact at a taxonomy path/);
    assert.match(task, /USER/);
    assert.match(task, /hello/);
  });

  it("omits the tool section when no tools are supplied", () => {
    const task = buildTurnCaptureTask("USER\nhi\nASSISTANT\nhello");
    assert.doesNotMatch(task, /Available memory tools/);
    assert.match(task, /SILENT/);
  });
});

describe("captureTurn", () => {
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
      await captureTurn(fakeClient, "sid", "/tmp", seen);
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
      await captureTurn(fakeClient, "sid", "/tmp", seen);
      assert.ok(prompted);
      assert.equal(prompted?.type, "subtask");
      assert.equal(prompted?.agent, "memoir");
      assert.match(prompted?.prompt ?? "", /TURN TRANSCRIPT/);
      // The v1 SDK client's promptAsync takes { path, body } with no
      // `directory` field — the instance is already directory-bound. Assert
      // directory is never sent.
      assert.equal(prompted?.directory, undefined);

      // deduped on the second call (same last assistant id)
      const again = new Map<string, string>(seen);
      await captureTurn(fakeClient, "sid", "/tmp", again);
      assert.equal(again.get("sid"), seen.get("sid"));
    } finally {
      if (prevSave === undefined) delete process.env.MEMOIR_AUTO_SAVE;
      else process.env.MEMOIR_AUTO_SAVE = prevSave;
      if (prevMin === undefined) delete process.env.MEMOIR_CAPTURE_MIN_CHARS;
      else process.env.MEMOIR_CAPTURE_MIN_CHARS = prevMin;
    }
  });
});
