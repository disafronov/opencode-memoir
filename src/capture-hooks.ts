import { EDIT_TOOLS, flushCapture, getCachedBranch, recordEdit, recordToolMetrics, setCachedBranch } from './capture.js';
import { autoMatchMemoirBranch } from './store.js';
import { pendingRecall, shouldTriggerRecall } from './recall-gate.js';
import { errorMessage } from './utils.js';
import { debugLog } from './debug.js';

export async function handleShellEnv(storeRoot: string, _input: unknown, output: { env: Record<string, string> }): Promise<void> {
  try {
    output.env.MEMOIR_STORE = storeRoot;
  } catch (e) {
    debugLog('shell.env: failed:', errorMessage(e));
  }
}

export async function handleToolExecuteAfter(input: unknown, output: unknown): Promise<void> {
  try {
    const typedInput = input as { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> } | undefined;
    const typedOutput = output as { metadata?: { error?: string }; output?: string } | undefined;
    // Per-session state key
    const sid = typedInput?.sessionID ?? 'default';

    // Accumulate per-tool metrics (cf. collect-metrics.sh).
    // Skipped when MEMOIR_NO_CAPTURE or MEMOIR_NO_METRICS is set.
    if (process.env.MEMOIR_NO_CAPTURE !== '1' && process.env.MEMOIR_NO_METRICS !== '1') {
      const calls = 1;
      const errors = (typedOutput?.metadata?.error || typedOutput?.output?.startsWith('Error:')) ? 1 : 0;
      recordToolMetrics(sid, typedInput?.tool ?? '', { calls, errors });
    }

    // Track file edits (cf. collect-edits.sh).
    // Skipped when MEMOIR_NO_CAPTURE or MEMOIR_NO_CODE_SUMMARY is set.
    if (process.env.MEMOIR_NO_CAPTURE !== '1' && process.env.MEMOIR_NO_CODE_SUMMARY !== '1' && EDIT_TOOLS.has(typedInput?.tool ?? '')) {
      const args = typedInput?.args ?? {};
      const filePath =
        typeof args.filePath === 'string' ? args.filePath
        : typeof args.path === 'string' ? args.path
        : '';
      if (filePath) {
        recordEdit(sid, { tool: typedInput?.tool ?? '', filePath, snippet: '', timestamp: Date.now() });
      }
    }
  } catch (e) {
    debugLog('tool.execute.after: failed:', errorMessage(e));
  }
}

export async function handleChatMessage(storeRoot: string, input: unknown, output: unknown): Promise<void> {
  try {
    const typedInput = input as { sessionID?: string } | undefined;
    const typedOutput = output as { parts?: Array<{ type: string; text: string }> } | undefined;
    const sid = typedInput?.sessionID ?? 'default';

    // C4: run recall gate BEFORE any await — otherwise system.transform
    // could fire before pendingRecall is set.
    const text = (typedOutput?.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join(' ');
    if (shouldTriggerRecall(text)) {
      pendingRecall.add(sid);
    }

    // Snapshot previous branch BEFORE switching — edits from the last turn
    // belong to the OLD branch. (C2 fix: prevents misattribution when the
    // user switches git branch between turns.)
    const _cachedBranch = getCachedBranch(sid);
    const prevBranch = _cachedBranch === 'unknown' ? undefined : _cachedBranch;
    setCachedBranch(sid, await autoMatchMemoirBranch(storeRoot));

    // Skip capture flush when MEMOIR_NO_CAPTURE is set.
    // Flush under the PREVIOUS branch (the one edits were made on).
    if (process.env.MEMOIR_NO_CAPTURE !== '1') {
      await flushCapture(storeRoot, prevBranch, sid);
    }
  } catch (e) {
    debugLog('chat.message: failed:', errorMessage(e));
  }
}

export async function flushAllCapture(storeRoot: string): Promise<void> {
  await flushCapture(storeRoot);
}
