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
 * `log(...)` always writes. MEMOIR_DEBUG=1 adds diagnostic detail: Error
 * objects include their name and stack instead of only their message. For
 * local verification, `tail -f` the log file.
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

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    if (process.env.MEMOIR_DEBUG === "1") {
      return value.stack ?? `${value.name}: ${value.message}`;
    }
    return value.message;
  }
  return String(value);
}

function formatArgs(args: unknown[]): string {
  const [message, ...details] = args;
  if (typeof message === "string" && details[0] instanceof Error) {
    return `${message.replace(/:\s*$/, "")}: ${details.map(formatValue).join(" ")}`;
  }
  return args.map(formatValue).join(" ");
}

function writeLog(args: unknown[]): void {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const line = `[memoir ${ts}] ${formatArgs(args)}\n`;
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

/** Single logging entrypoint; MEMOIR_DEBUG=1 controls detail, not emission. */
export function log(...args: unknown[]): void {
  writeLog(args);
}
