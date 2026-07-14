import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Plugin logging.
 *
 * Logs go to a file (never stderr) so they do not pollute the opencode
 * terminal. The destination is controlled by MEMOIR_LOG:
 *   - unset    → $XDG_STATE_HOME/opencode/memoir-plugin-YYYY-MM-DD.log
 *                (falls back to ~/.local/state/opencode/...; daily rotation)
 *   - "stderr" → stderr, for live local debugging without a separate `tail`
 *   - <path>   → an explicit log file path
 *
 * `infoLog` always writes (lifecycle milestones: server up, capture
 * fired/skipped, recall injected). `debugLog` writes only when MEMOIR_DEBUG=1
 * (verbose internals). For local verification, `tail -f` the log file.
 */

/**
 * Resolve the log destination on each write so MEMOIR_LOG changes (and tests)
 * take effect without a reimport. `null` means "write to stderr".
 */
function resolveLogFile(): string | null {
  const raw = process.env.MEMOIR_LOG;
  if (raw === "stderr") return null;
  if (raw) return raw;
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const date = new Date().toISOString().slice(0, 10);
  return join(stateHome, "opencode", `memoir-plugin-${date}.log`);
}

function writeLog(level: string, args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const line = `[memoir ${ts}] ${level} ${args.map((a) => String(a)).join(" ")}\n`;
  const logFilePath = resolveLogFile();
  if (logFilePath) {
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
      appendFileSync(logFilePath, line);
      return;
    } catch {
      // fall through to stderr if the file is unavailable
    }
  }
  process.stderr.write(line);
}

/** Lifecycle milestones — always written to the log file. */
export function infoLog(...args: unknown[]): void {
  writeLog("info", args);
}

/** Verbose internals — only written when MEMOIR_DEBUG=1. */
export function debugLog(...args: unknown[]): void {
  if (process.env.MEMOIR_DEBUG !== "1") return;
  writeLog("debug", args);
}
