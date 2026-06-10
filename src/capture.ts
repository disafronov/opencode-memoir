import { deriveStorePath, ensureStore, getCurrentBranch, readMemoirValue, runMemoir } from './store.js';
import { debugLog } from './debug.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'ApplyPatch', 'MultiFileEdit']);

export interface EditRecord {
  tool: string;
  filePath: string;
  snippet: string;
  timestamp: number;
}

export interface ToolMetrics {
  calls: number;
  errors: number;
}

/**
 * Maximum entries retained in metrics.code.<branch>.
 * Mirrors MEMOIR_METRICS_CODE_MAX from plugins/claude-code/hooks/stop.sh.
 */
export const METRICS_CODE_MAX = 1000;

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

const pendingEditsBySession = new Map<string, EditRecord[]>();
const toolMetricsBySession = new Map<string, Map<string, ToolMetrics>>();
const cachedBranchBySession = new Map<string, string>();

export function getCachedBranch(sessionID: string): string {
  return cachedBranchBySession.get(sessionID) ?? 'unknown';
}

export function setCachedBranch(sessionID: string, branch: string): void {
  cachedBranchBySession.set(sessionID, branch);
}

/** Record an edit for a specific session. */
export function recordEdit(sessionID: string, edit: EditRecord): void {
  let edits = pendingEditsBySession.get(sessionID);
  if (!edits) { edits = []; pendingEditsBySession.set(sessionID, edits); }
  edits.push(edit);
}

/** Accumulate tool metrics for a specific session (adds to previous values). */
export function recordToolMetrics(sessionID: string, tool: string, metrics: ToolMetrics): void {
  let sessionMetrics = toolMetricsBySession.get(sessionID);
  if (!sessionMetrics) { sessionMetrics = new Map(); toolMetricsBySession.set(sessionID, sessionMetrics); }
  const prev = sessionMetrics.get(tool) ?? { calls: 0, errors: 0 };
  sessionMetrics.set(tool, {
    calls: prev.calls + metrics.calls,
    errors: prev.errors + metrics.errors,
  });
}

/** Peek at a session's pending edits (test helper, read-only). */
export function getPendingEdits(sessionID: string): readonly EditRecord[] {
  return pendingEditsBySession.get(sessionID) ?? [];
}

/** Peek at a session's tool metrics (test helper, read-only). */
export function getToolMetrics(sessionID: string): ReadonlyMap<string, ToolMetrics> {
  return toolMetricsBySession.get(sessionID) ?? new Map();
}

/** Clear all state for a session (test helper). */
export function clearSession(sessionID: string): void {
  pendingEditsBySession.delete(sessionID);
  toolMetricsBySession.delete(sessionID);
  cachedBranchBySession.delete(sessionID);
}

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

export function parseTurnMetrics(text: string): Map<string, ToolMetrics> {
  const result = new Map<string, ToolMetrics>();
  if (!text) return result;
  const parts = text.split('|');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [tool, callsStr, errorsStr] = trimmed.split(':');
    if (!tool) continue;
    result.set(tool, {
      calls: parseInt(callsStr, 10) || 0,
      errors: parseInt(errorsStr, 10) || 0,
    });
  }
  return result;
}

export function serializeTurnMetrics(map: Map<string, ToolMetrics>): string {
  return [...map.entries()]
    .map(([tool, m]) => `${tool}:${m.calls}:${m.errors}`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Per-store mutex
// ---------------------------------------------------------------------------

const flushQueues = new Map<string, Promise<void>>();

async function acquireFlushLock(store: string): Promise<() => void> {
  const prev = flushQueues.get(store) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  flushQueues.set(store, next);
  await prev;
  return () => {
    release();
    if (flushQueues.get(store) === next) flushQueues.delete(store);
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// flushCapture — flushes one session, or all if no sessionID
// ---------------------------------------------------------------------------

export async function flushCapture(store?: string, branch?: string, sessionID?: string): Promise<void> {
  // Determine which sessions to flush
  const targets: string[] = sessionID
    ? [sessionID]
    : [...pendingEditsBySession.keys()]; // dispose: flush all sessions
  if (targets.length === 0) return;

  try {
    store = store ?? deriveStorePath();
    if (!store) return;
    await ensureStore(store);

    // Acquire store-level mutex before touching per-session state.
    // Prevents C1 (cross-session interleave) and C2-RACE (data arriving
    // between snapshot and drain).
    const releaseLock = await acquireFlushLock(store);
    try {
      // Atomic swap: grab current data and replace with empty containers.
      // Any recordEdit/recordToolMetrics call during the subsequent I/O
      // goes into the fresh empty containers and is safe.
      interface SessionData { edits: EditRecord[]; metrics: Map<string, ToolMetrics>; sessionBranch: string; }
      const perSession: SessionData[] = [];
      const swappedSids = new Map<string, number>(); // sid → index in perSession for rollback
      for (const sid of targets) {
        const idx = perSession.length;
        const edits = pendingEditsBySession.get(sid) ?? [];
        pendingEditsBySession.set(sid, []);
        const metrics = toolMetricsBySession.get(sid) ?? new Map();
        toolMetricsBySession.set(sid, new Map());
        const sb = branch ?? cachedBranchBySession.get(sid);
        perSession.push({ edits, metrics, sessionBranch: sb ?? 'unknown' });
        swappedSids.set(sid, idx);
      }

      // Skip if nothing to flush
      if (!perSession.some(p => p.edits.length > 0 || p.metrics.size > 0)) return;

      // Wrap I/O in inner try — if it fails, restore swapped data before
      // propagating the error so the next flush retries it.
      try {
        // Resolve 'unknown' branches (read-only I/O, safe inside lock —
        // the lock serializes per-store CLI access)
        for (const p of perSession) {
          if (p.sessionBranch === 'unknown' || !p.sessionBranch) {
            p.sessionBranch = await getCurrentBranch(store);
          }
        }

        // For each session, read-merge-write sequentially.
        for (const p of perSession) {
          const { edits, metrics, sessionBranch: branchKey } = p;
          if (edits.length === 0 && metrics.size === 0) continue;

          const [prevCodeRaw, prevTurnRaw] = await Promise.all([
            edits.length > 0 ? readMemoirValue(store, `metrics.code.${branchKey}`) : Promise.resolve(''),
            metrics.size > 0 ? readMemoirValue(store, `metrics.turn.${branchKey}`) : Promise.resolve(''),
          ]);

          let codeWrite: Promise<string> | undefined;
          if (edits.length > 0) {
            const files = [...new Set(edits.map(e => e.filePath))];
            const entry = {
              timestamp: Date.now() / 1000,
              summary: `Changed ${edits.length} block(s) across ${files.length} file(s): ${files.join(', ')}`,
              files,
            };

            let acc: { schema_version: number; entries: Array<Record<string, unknown>> } = {
              schema_version: 2, entries: [],
            };
            if (prevCodeRaw) {
              try {
                const parsed = JSON.parse(prevCodeRaw);
                if (parsed?.entries && Array.isArray(parsed.entries)) {
                  acc = parsed;
                  if (acc.schema_version < 2) acc.schema_version = 2;
                }
              } catch (e) {
                debugLog('flushCapture: failed to parse existing code metrics, starting fresh:', e instanceof Error ? e.message : String(e));
              }
            }
            acc.entries.push(entry as unknown as Record<string, unknown>);
            if (acc.entries.length > METRICS_CODE_MAX) acc.entries = acc.entries.slice(-METRICS_CODE_MAX);
            codeWrite = runMemoir(['-s', store, 'remember', '--replace', JSON.stringify(acc), '-p', `metrics.code.${branchKey}`], { cwd: store });
          }

          let turnWrite: Promise<string> | undefined;
          if (metrics.size > 0) {
            const existing = parseTurnMetrics(prevTurnRaw);
            for (const [tool, current] of metrics) {
              const prev = existing.get(tool) ?? { calls: 0, errors: 0 };
              existing.set(tool, { calls: prev.calls + current.calls, errors: prev.errors + current.errors });
            }
            turnWrite = runMemoir(['-s', store, 'remember', '--replace', serializeTurnMetrics(existing), '-p', `metrics.turn.${branchKey}`], { cwd: store });
          }

          // Check writes for this session's pair
          const results = await Promise.all([codeWrite, turnWrite].filter(Boolean));
          for (const result of results) {
            if (typeof result === 'string' && result.startsWith('Memoir command failed')) {
              throw new Error(`Memoir write failed: ${result}`);
            }
          }
        }
      } catch (e) {
        // Restore swapped data into pending maps so the next flush retries it.
        // Entries accumulated during I/O by concurrent recordEdit/recordToolMetrics
        // are preserved: we prepend the original entries, so ordering is maintained.
        for (const [sid, idx] of swappedSids) {
          const p = perSession[idx];
          const currentEdits = pendingEditsBySession.get(sid) ?? [];
          pendingEditsBySession.set(sid, [...p.edits, ...currentEdits]);

          const merged = toolMetricsBySession.get(sid) ?? new Map();
          for (const [tool, m] of p.metrics) {
            const prev = merged.get(tool) ?? { calls: 0, errors: 0 };
            merged.set(tool, { calls: prev.calls + m.calls, errors: prev.errors + m.errors });
          }
          toolMetricsBySession.set(sid, merged);
        }
        // Re-throw so the outer catch logs it
        throw e;
      }
    } finally {
      releaseLock();
    }
  } catch (e) {
    debugLog('flushCapture: failed:', e instanceof Error ? e.message : String(e));
  }
}
