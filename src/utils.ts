/** Shared helpers for the Memoir OpenCode plugin.
 *
 * IMPORTANT: these must NOT be exported from index.ts — OpenCode's plugin
 * loader treats every module export as a plugin and throws
 * "Plugin export is not a function" on non-function exports.
 */

export function coercePaths(path: string | string[] | undefined): string[] {
  if (!path) return [];
  return Array.isArray(path) ? path.filter(Boolean) : [path];
}

/** Format JSON string with 2-space indentation. Passes non-JSON through unchanged. */
export function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Max keys memoir_get accepts to avoid hitting OS arg-length limits. */
export const MEMOIR_GET_MAX_KEYS = 20;

export const SECRET_PATTERN = new RegExp(
  [
    // Generic secret assignments
    "(?:password|passwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?key|private[_-]?key)\\s*[=:]\\s*['\"]?[^\\s'\"]{8,}",
    // AWS secret keys
    "(?:aws[_-]?secret[_-]?access[_-]?key|aws_secret)\\s*[=:]\\s*['\"]?[A-Za-z0-9/+=]{40}",
    // Connection strings with embedded credentials
    "(?:postgres|mysql|mongodb|redis|amqp)://[^\\s:]+:[^\\s@]+@[^\\s]+",
    // Generic connection strings with passwords
    "://[^\\s:]+:[^\\s@]+@",
    // PEM private keys
    "-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----",
    // Generic high-entropy secret assignments
    "(?:secret|credential|key|password)\\s*[=:]\\s*['\"][A-Za-z0-9+/=_-]{20,}['\"]",
  ].join("|"),
);

/** Safely extract a display string from an unknown thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
