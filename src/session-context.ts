import { runMemoir } from './store.js';
import { pendingRecall } from './recall-gate.js';
import { errorMessage, tryPrettyJson } from './utils.js';
import { debugLog } from './debug.js';

/** Cached session init context (taxonomy overview). Fetched once, injected per-session. */
let initContext: string | null = null;
let initContextFetched = false;
/**
 * Tracks sessions that have received initial context injection.
 * Uses a Map with timestamp so stale entries can be evicted.
 * Cleaned on dispose. Sessions older than 1 hour are considered stale.
 */
const SESSION_CONTEXT_TTL_MS = 60 * 60 * 1000;
const sessionsWithContext = new Map<string, number>();

/** Check if a session has received context (and prune stale entries opportunistically). */
function hasSessionContext(sessionID: string): boolean {
  const ts = sessionsWithContext.get(sessionID);
  if (ts === undefined) return false;
  if (Date.now() - ts > SESSION_CONTEXT_TTL_MS) {
    sessionsWithContext.delete(sessionID);
    return false;
  }
  return true;
}

/** Mark a session as having received context. */
function markSessionContext(sessionID: string): void {
  sessionsWithContext.set(sessionID, Date.now());
}

/** Prune all stale session entries. */
function pruneStaleSessions(): void {
  const now = Date.now();
  for (const [id, ts] of sessionsWithContext) {
    if (now - ts > SESSION_CONTEXT_TTL_MS) sessionsWithContext.delete(id);
  }
}

export async function handleEvent(storeRoot: string, input: { event: { type: string } }): Promise<void> {
  if (input.event.type === 'session.created' && !initContextFetched) {
    initContextFetched = true;
    (async () => {
      try {
        const taxonomyResult = await runMemoir(
          ['--json', '-s', storeRoot, 'summarize', '--depth', '3', '-n', 'default'],
          { cwd: storeRoot }
        );
        if (!taxonomyResult.ok) {
          throw new Error(taxonomyResult.error);
        }
        const pretty = tryPrettyJson(taxonomyResult.stdout);
        initContext = `[memoir] Available taxonomy paths:\n${pretty}`;
      } catch (e: unknown) {
        debugLog('event: taxonomy fetch failed, will retry on next session:', errorMessage(e));
        // Allow a later session to retry — the store may not have been ready yet.
        initContextFetched = false;
      }
    })().catch(() => { initContextFetched = false; });
  }
}

export async function handleSystemTransform(input: unknown, output: unknown): Promise<void> {
  try {
    const typedInput = input as { sessionID?: string } | undefined;
    const typedOutput = output as { system?: string[] } | undefined;

    // Inject initial context on the first LLM call of each session
    if (typedInput?.sessionID && !hasSessionContext(typedInput.sessionID)) {
      markSessionContext(typedInput.sessionID);
      if (initContext) {
        typedOutput?.system?.unshift(initContext);
      }
    }

    // Inject recall instruction (one-shot per trigger)
    if (typedInput?.sessionID && pendingRecall.has(typedInput.sessionID)) {
      pendingRecall.delete(typedInput.sessionID);
      typedOutput?.system?.push(
        '\n[memoir] The user may have relevant context in Memoir. Run memoir_recall to list available memories across default and onboard namespaces, then memoir_get with the matching namespace to fetch exact values.'
      );
    }
  } catch (e) {
    debugLog('system.transform: failed:', errorMessage(e));
  }
}

export function clearSessionContext(): void {
  pruneStaleSessions();
  sessionsWithContext.clear();
}
