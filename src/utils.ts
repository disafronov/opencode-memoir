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
