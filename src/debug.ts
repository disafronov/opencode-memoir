/**
 * Debug logger writing to stderr. Prefixes with [memoir] for easy filtering.
 * Only writes when MEMOIR_DEBUG=1 is set.
 */
export function debugLog(...args: unknown[]): void {
  if (process.env.MEMOIR_DEBUG !== "1") return;
  const ts = new Date().toISOString();
  process.stderr.write(`[memoir ${ts}] ${args.map((a) => String(a)).join(" ")}\n`);
}
