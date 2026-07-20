import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Plugin logging.
 *
 * Logs go to a file (never stderr) so they do not pollute the opencode
 * terminal. The destination is controlled by MEMOIR_LOG:
 *   - unset    → $X/opencode/log/memoir/YYYY-MM-DD.log
 *                ($X = XDG_DATA_HOME, falls back to ~/.local/share/...)
 *   - "stderr" → stderr, for live local debugging
 *   - <path>   → an explicit log file path
 *
 * The log path is cached and re-resolved only when MEMOIR_LOG or the date changes,
 * so writes are fast (single appendFileSync) after the first call.
 *
 * `log(...)` always writes. MEMOIR_DEBUG=1 adds diagnostic detail: Error
 * objects include their name and stack instead of only their message. For
 * local verification, `tail -f` the log file.
 */

let cachedLogFile: string | null = null;
let cachedLogRaw: string | undefined;
let cachedLogDate: string | undefined;

let projectSlug: string | null = null;

/** Set the project slug for log identification. Called once during config hook. */
export function setProjectContext(slug: string): void {
  projectSlug = slug;
}

/** Reset project context. Used in tests. */
export function resetProjectContext(): void {
  projectSlug = null;
}

function resolveLogFile(): string | null {
  const raw = process.env.MEMOIR_LOG;
  if (raw === "stderr") return null;
  if (raw) return raw;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const date = new Date().toISOString().slice(0, 10);
  return join(dataHome, "opencode", "log", "memoir", `${date}.log`);
}

function getCachedLogFile(): string | null {
  const raw = process.env.MEMOIR_LOG;
  const date = new Date().toISOString().slice(0, 10);
  if (cachedLogRaw !== raw || cachedLogDate !== date) {
    cachedLogFile = resolveLogFile();
    cachedLogRaw = raw;
    cachedLogDate = date;
  }
  return cachedLogFile;
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
  const slug = projectSlug ? `[${projectSlug}] ` : "";
  const line = `[memoir ${ts}] ${slug}${formatArgs(args)}\n`;
  const logFilePath = getCachedLogFile();
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
