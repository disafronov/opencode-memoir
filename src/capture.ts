import { log } from "./debug.js";
import type { MemoirToolInfo } from "./mcp-client.js";
import { loadPrompt } from "./prompts.js";
import { MEMOIR_CHECKOUT_TOOL, runMemoirSubagent } from "./subagent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  info?: { id?: string; role?: string };
  parts?: ChatPart[];
}

// Minimal structural view of the SDK client we use to pull a session transcript.
// The SDK exposes this as `client.session.messages` (singular `session`).
type SessionMessagesClient = {
  session: {
    messages(input: {
      path: { id: string };
      query?: { limit?: number };
    }): Promise<{ data?: unknown }>;
  };
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CAPTURE_MIN_CHARS = 16;

function captureMinChars(): number {
  const raw = process.env.MEMOIR_CAPTURE_MIN_CHARS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_CAPTURE_MIN_CHARS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_CAPTURE_MIN_CHARS;
}

function autoSaveEnabled(): boolean {
  // ENABLED by default; only an explicit "0" disables it.
  return process.env.MEMOIR_AUTO_SAVE !== "0";
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

function messageText(msg: ChatMessage): string {
  const parts = msg.parts ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

function formatRole(role: string | undefined): string {
  switch (role) {
    case "user":
      return "USER";
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    default:
      return (role ?? "unknown").toUpperCase();
  }
}

/**
 * Render a list of messages into a plain-text transcript.
 * Skips empty (no text) messages so tool-only turns stay quiet.
 */
export function formatSessionTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = messageText(m);
      if (!text) return null;
      return `${formatRole(m.info?.role)}\n${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

/**
 * Extract the most recent completed turn: the last assistant message that has
 * text, plus the user message(s) immediately preceding it. Returns null when
 * there is no completed assistant turn yet.
 */
export function lastTurnTranscript(messages: ChatMessage[]): string | null {
  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === "assistant" && messageText(messages[i])) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return null;

  const userIdx = (() => {
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].info?.role === "user") return i;
    }
    return -1;
  })();
  if (userIdx < 0) return null;

  const turn = messages.slice(userIdx, assistantIdx + 1);
  return formatSessionTranscript(turn);
}

/**
 * Local, LLM-free pre-filter. When MEMOIR_CAPTURE_MIN_CHARS (default 16) is
 * > 0, only transcripts at least that long are worth sending to the subagent.
 * A value of 0 disables the filter (capture everything).
 */
export function shouldCaptureTurn(
  transcript: string | null,
  minChars = captureMinChars(),
): transcript is string {
  if (minChars <= 0) return transcript !== null && transcript.length > 0;
  return transcript !== null && transcript.length >= minChars;
}

// ---------------------------------------------------------------------------
// Task builder (mirrors plugins/claude-code/hooks/stop_capture.tmpl)
// ---------------------------------------------------------------------------

const CAPTURE_TASK_TEMPLATE = loadPrompt("capture-task.tmpl");

/**
 * Build the capture task handed to the memoir subagent. It applies the
 * durability checks, writes each fact with an explicit 3-level taxonomy path,
 * and returns a compact report based only on confirmed tool outcomes.
 */
export function buildTurnCaptureTask(transcript: string, tools: MemoirToolInfo[] = []): string {
  const captureTools = tools.filter((tool) => tool.name !== MEMOIR_CHECKOUT_TOOL);
  const toolsSection = captureTools.length
    ? `Available memory tools (name — what it does):\n${captureTools
        .map((tool) => `- ${tool.name} — ${tool.description}`)
        .join("\n")}\n`
    : "";
  return CAPTURE_TASK_TEMPLATE.replace("{{TOOLS_SECTION}}", toolsSection).replace(
    "{{TRANSCRIPT}}",
    transcript,
  );
}

// ---------------------------------------------------------------------------
// Capture orchestration
// ---------------------------------------------------------------------------

function lastAssistantMessageId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === "assistant" && messageText(messages[i])) {
      return messages[i].info?.id ?? null;
    }
  }
  return null;
}

/**
 * Capture the latest completed turn of a session into memoir via the subagent.
 *
 * Fire-and-forget: the caller should NOT await the subagent's completion.
 * Deduped per session by the last assistant message id, so a turn is written
 * at most once. Skips entirely when MEMOIR_AUTO_SAVE=0.
 *
 * @param client   SDK client (transcript source + subagent spawner)
 * @param sessionID parent session id
 * @param directory working directory for the child session (unused — the
 *   running opencode instance is already bound to it; kept for call stability)
 * @param lastCaptured per-session map of already-captured assistant ids
 */
export async function captureTurn(
  client: unknown,
  sessionID: string,
  _directory: string,
  lastCaptured: Map<string, string>,
  tools: MemoirToolInfo[] = [],
): Promise<void> {
  if (!autoSaveEnabled()) {
    log("captureTurn: MEMOIR_AUTO_SAVE=0, skipping");
    return;
  }
  log("captureTurn: started for session", sessionID);

  try {
    const api = (client as SessionMessagesClient | null | undefined)?.session;
    if (!api?.messages) {
      log("captureTurn: client.session.messages unavailable");
      log("captureTurn: skipped — session messages API unavailable");
      return;
    }

    const res = await api.messages({
      path: { id: sessionID },
      query: { limit: 50 },
    });
    const raw = res.data;
    const messages: ChatMessage[] = Array.isArray(raw) ? (raw as ChatMessage[]) : [];
    if (messages.length === 0) return;

    const turnId = lastAssistantMessageId(messages);
    if (!turnId) return;
    if (lastCaptured.get(sessionID) === turnId) {
      log("captureTurn: skipped — already captured this turn");
      return;
    }

    const transcript = lastTurnTranscript(messages);
    if (!shouldCaptureTurn(transcript)) {
      log("captureTurn: skipped — transcript below min-chars");
      lastCaptured.set(sessionID, turnId);
      return;
    }

    log("captureTurn: submitting memoir subtask (transcript", transcript.length, "chars)");
    await runMemoirSubagent(client, sessionID, buildTurnCaptureTask(transcript, tools));
    lastCaptured.set(sessionID, turnId);
  } catch (e) {
    log("captureTurn failed", e);
  }
}
