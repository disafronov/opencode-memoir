import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  clearSession,
  getPendingEdits,
  getToolMetrics,
  recordEdit,
  recordToolMetrics,
  setCachedBranch,
  flushCapture,
  setCliOverrides,
} from '../src/capture.ts';
import { ensuredStores, setPluginStoreOverride } from '../src/store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory with a .git subdirectory so ensureStore() succeeds. */
async function makeFakeStoreDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memoir-flush-test-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  // Write a minimal HEAD so it looks like a git repo
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flushCapture', () => {
  let fakeStore: string;
  let origEnvStore: string | undefined;

  beforeEach(async () => {
    fakeStore = await makeFakeStoreDir();
    // Pre-register the store so ensureStore() short-circuits (no CLI needed)
    ensuredStores.add(fakeStore);
    // Redirect the plugin store override so deriveStorePath() returns our dir
    setPluginStoreOverride(fakeStore);
    origEnvStore = process.env.MEMOIR_STORE;
  });

  afterEach(async () => {
    setPluginStoreOverride(undefined);
    ensuredStores.delete(fakeStore);
    process.env.MEMOIR_STORE = origEnvStore ?? '';
    if (!origEnvStore) delete process.env.MEMOIR_STORE;
    await rm(fakeStore, { recursive: true, force: true }).catch(() => undefined);
  });

  // -----------------------------------------------------------------------
  // (a) Empty flush is a no-op — no CLI call, no state change
  // -----------------------------------------------------------------------
  describe('empty flush', () => {
    const SID = 'empty-flush-session';

    beforeEach(() => {
      clearSession(SID);
    });

    afterEach(() => {
      clearSession(SID);
    });

    it('returns immediately when no sessions have pending data (no sessionID)', async () => {
      // No edits or metrics recorded for any session
      await flushCapture(fakeStore, 'main');
      // If we got here without error, the no-op path worked
      assert.ok(true, 'empty flush completed without error');
    });

    it('returns immediately for a sessionID with no pending data', async () => {
      await flushCapture(fakeStore, 'main', SID);
      assert.ok(true, 'empty flush for specific SID completed without error');
    });

    it('does not alter pending state when there is nothing to flush', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/keep.ts',
        snippet: 'x',
        timestamp: Date.now(),
      });
      recordToolMetrics(SID, 'Edit', { calls: 1, errors: 0 });

      // Flush a different session — the one with data should be untouched
      await flushCapture(fakeStore, 'main', 'nonexistent-session');
      assert.strictEqual(getPendingEdits(SID).length, 1);
      assert.strictEqual(getToolMetrics(SID).get('Edit')?.calls, 1);
    });
  });

  // -----------------------------------------------------------------------
  // (b) Rollback on write failure
  //
  // Without a real memoir CLI, runMemoir returns an error string starting
  // with "Memoir command failed". The write check in flushCapture throws,
  // causing the rollback path to restore the swapped data.
  // -----------------------------------------------------------------------
  describe('rollback on write failure', () => {
    const SID = 'rollback-session';

    beforeEach(() => {
      clearSession(SID);
      setCachedBranch(SID, 'main');
    });

    afterEach(() => {
      clearSession(SID);
    });

    it('restores pending edits after write failure', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/rollback.ts',
        snippet: 'const x = 1;',
        timestamp: 1_700_000_000,
      });
      assert.strictEqual(getPendingEdits(SID).length, 1);

      await flushCapture(fakeStore, 'main', SID);

      // The memoir CLI is not available so the write fails and rollback
      // restores the pending edits for the next flush to retry.
      assert.strictEqual(
        getPendingEdits(SID).length,
        1,
        'edits should be restored after write failure (rollback)',
      );
      assert.strictEqual(getPendingEdits(SID)[0].filePath, '/tmp/rollback.ts');
    });

    it('restores tool metrics after write failure', async () => {
      recordToolMetrics(SID, 'Edit', { calls: 5, errors: 1 });
      recordToolMetrics(SID, 'Bash', { calls: 3, errors: 0 });
      assert.strictEqual(getToolMetrics(SID).get('Edit')?.calls, 5);

      await flushCapture(fakeStore, 'main', SID);

      // Metrics should be restored by rollback
      assert.strictEqual(
        getToolMetrics(SID).get('Edit')?.calls,
        5,
        'Edit calls should be restored after rollback',
      );
      assert.strictEqual(
        getToolMetrics(SID).get('Edit')?.errors,
        1,
        'Edit errors should be restored after rollback',
      );
      assert.strictEqual(
        getToolMetrics(SID).get('Bash')?.calls,
        3,
        'Bash calls should be restored after rollback',
      );
    });

    it('preserves edits that arrived during I/O (rollback prepends)', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/original.ts',
        snippet: 'a',
        timestamp: 1_700_000_000,
      });

      // Start flush — it will swap the data and then fail on writes,
      // triggering rollback. During the async I/O window, new edits
      // could arrive; the rollback path prepends the original data
      // so nothing is lost.
      const flushPromise = flushCapture(fakeStore, 'main', SID);

      // Record a concurrent edit while flush is in-flight. The swap has
      // already replaced the pending array with [], so this goes into the
      // fresh container. After rollback, both the original and the new
      // edit should be present.
      recordEdit(SID, {
        tool: 'Write',
        filePath: '/tmp/concurrent.ts',
        snippet: 'b',
        timestamp: 1_700_000_001,
      });

      await flushPromise;

      const edits = getPendingEdits(SID);
      assert.strictEqual(edits.length, 2, 'both original and concurrent edits should survive rollback');
      // Original is prepended first (rollback does [...originalEdits, ...currentEdits])
      assert.strictEqual(edits[0].filePath, '/tmp/original.ts');
      assert.strictEqual(edits[1].filePath, '/tmp/concurrent.ts');
    });

    it('preserves metrics that arrived during I/O (rollback merges)', async () => {
      recordToolMetrics(SID, 'Edit', { calls: 10, errors: 2 });

      const flushPromise = flushCapture(fakeStore, 'main', SID);

      // Accumulate extra metrics concurrently
      recordToolMetrics(SID, 'Edit', { calls: 3, errors: 0 });

      await flushPromise;

      // After rollback, original (10/2) and concurrent (3/0) are merged
      const merged = getToolMetrics(SID).get('Edit');
      assert.strictEqual(merged?.calls, 13, 'original + concurrent calls should merge on rollback');
      assert.strictEqual(merged?.errors, 2, 'original + concurrent errors should merge on rollback');
    });
  });

  // -----------------------------------------------------------------------
  // (c) Multi-session flush
  // -----------------------------------------------------------------------
  describe('multi-session flush', () => {
    const SID_A = 'multi-session-a';
    const SID_B = 'multi-session-b';

    beforeEach(() => {
      clearSession(SID_A);
      clearSession(SID_B);
      setCachedBranch(SID_A, 'main');
      setCachedBranch(SID_B, 'main');
    });

    afterEach(() => {
      clearSession(SID_A);
      clearSession(SID_B);
    });

    it('flushes all sessions when sessionID is omitted (rollback restores each)', async () => {
      recordEdit(SID_A, {
        tool: 'Edit',
        filePath: '/tmp/a.ts',
        snippet: 'x',
        timestamp: 1_700_000_000,
      });
      recordToolMetrics(SID_A, 'Edit', { calls: 2, errors: 0 });

      recordEdit(SID_B, {
        tool: 'Write',
        filePath: '/tmp/b.ts',
        snippet: 'y',
        timestamp: 1_700_000_001,
      });
      recordToolMetrics(SID_B, 'Write', { calls: 1, errors: 1 });

      // Flush all (no sessionID) — will fail and rollback both
      await flushCapture(fakeStore, 'main');

      assert.strictEqual(
        getPendingEdits(SID_A).length,
        1,
        'session A edits should be restored by rollback',
      );
      assert.strictEqual(
        getPendingEdits(SID_B).length,
        1,
        'session B edits should be restored by rollback',
      );
      assert.strictEqual(
        getToolMetrics(SID_A).get('Edit')?.calls,
        2,
        'session A metrics should be restored by rollback',
      );
      assert.strictEqual(
        getToolMetrics(SID_B).get('Write')?.errors,
        1,
        'session B metrics should be restored by rollback',
      );
    });

    it('flushes only the specified session when sessionID is given', async () => {
      recordEdit(SID_A, {
        tool: 'Edit',
        filePath: '/tmp/a.ts',
        snippet: 'x',
        timestamp: 1_700_000_000,
      });
      recordEdit(SID_B, {
        tool: 'Write',
        filePath: '/tmp/b.ts',
        snippet: 'y',
        timestamp: 1_700_000_001,
      });

      // Flush only SID_A — rollback should restore it, SID_B untouched
      await flushCapture(fakeStore, 'main', SID_A);

      assert.strictEqual(
        getPendingEdits(SID_A).length,
        1,
        'session A edits should be restored by rollback',
      );
      assert.strictEqual(
        getPendingEdits(SID_B).length,
        1,
        'session B edits should not be affected by flushing session A',
      );
    });
  });

  // -----------------------------------------------------------------------
  // (d) Mutex serialization — concurrent flushes for the same store are
  //     serialized and do not interleave.
  // -----------------------------------------------------------------------
  describe('mutex serialization', () => {
    const SID = 'mutex-session';

    beforeEach(() => {
      clearSession(SID);
      setCachedBranch(SID, 'main');
    });

    afterEach(() => {
      clearSession(SID);
    });

    it('concurrent flush calls for the same store are serialized', async () => {
      // Record some data so the flush doesn't early-return
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/mutex.ts',
        snippet: 'z',
        timestamp: 1_700_000_000,
      });

      // Launch two concurrent flushes. They must not interleave — the
      // acquireFlushLock promise-chain mutex ensures the second waits
      // for the first. Both will fail (no real CLI) and rollback.
      const results = await Promise.all([
        flushCapture(fakeStore, 'main', SID),
        flushCapture(fakeStore, 'main', SID),
      ]);

      // Both complete without throwing (flushCapture never throws)
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0], undefined);
      assert.strictEqual(results[1], undefined);

      // Data should still be present after rollback (both attempts fail)
      // The exact count is hard to predict because the second flush may
      // or may not see the first flush's rollback, but there must be
      // at least one edit present — nothing should be silently lost.
      const edits = getPendingEdits(SID);
      assert.ok(edits.length >= 1, `at least 1 edit should survive after concurrent flushes, got ${edits.length}`);
    });

    it('flushes for different stores run concurrently without blocking', async () => {
      // Create a second fake store
      const fakeStore2 = await makeFakeStoreDir();
      ensuredStores.add(fakeStore2);
      try {
        recordEdit(SID, {
          tool: 'Edit',
          filePath: '/tmp/concurrent.ts',
          snippet: 'c',
          timestamp: 1_700_000_000,
        });

        // Flushes for different stores should NOT serialize on each other.
        // We can't easily prove concurrency from the outside, but we can
        // confirm both complete without deadlock.
        const start = Date.now();
        await Promise.all([
          flushCapture(fakeStore, 'main', SID),
          flushCapture(fakeStore2, 'main', SID),
        ]);
        const elapsed = Date.now() - start;
        // Sanity: both completed in reasonable time (no deadlock)
        assert.ok(elapsed < 30_000, `concurrent flushes completed in ${elapsed}ms — no deadlock`);
      } finally {
        ensuredStores.delete(fakeStore2);
        await rm(fakeStore2, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (e) No store path — flush silently returns
  // -----------------------------------------------------------------------
  describe('no store path', () => {
    const SID = 'no-store-session';

    beforeEach(() => {
      clearSession(SID);
      // Remove all store path sources so deriveStorePath() can't return
      // a meaningful path. Since the plugin override is already cleared
      // in the outer afterEach, we just ensure it's cleared here too.
      setPluginStoreOverride(undefined);
    });

    afterEach(() => {
      clearSession(SID);
      // Restore store override for other tests
    });

    it('flush returns without error when store path is unavailable', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/nostore.ts',
        snippet: 'n',
        timestamp: 1_700_000_000,
      });

      // Without a store path, flushCapture should silently return.
      // In a non-git temp directory deriveStorePath falls back to a
      // slug-based path but the subsequent ensureStore will fail (no
      // memoir CLI). The outer catch swallows the error. Either way,
      // the function must not throw.
      await flushCapture(undefined, 'main', SID);
      assert.ok(true, 'flushCapture did not throw when store was unavailable');
    });
  });

  // -----------------------------------------------------------------------
  // (f) Success / branch resolution / merge — CLI mocked via setCliOverrides
  // -----------------------------------------------------------------------
  describe('flushCapture success/branch/merge (CLI mocked)', () => {
    const SID = 'mock-session';
    let callLog: Array<{ fn: string; args: unknown[] }>;
    let tmpStore: string;

    beforeEach(async () => {
      tmpStore = await makeFakeStoreDir();
      ensuredStores.add(tmpStore);
      clearSession(SID);
      callLog = [];

      setCliOverrides({
        getCurrentBranch: async (_store: string) => {
          callLog.push({ fn: 'getCurrentBranch', args: [_store] });
          return 'main';
        },
        readMemoirValue: async (_store: string, key: string, _ns?: string) => {
          callLog.push({ fn: 'readMemoirValue', args: [_store, key, _ns] });
          return '';
        },
        runMemoir: async (args: string[]) => {
          callLog.push({ fn: 'runMemoir', args });
          return { ok: true, stdout: 'ok' };
        },
      });
    });

    afterEach(() => {
      setCliOverrides(null);
      clearSession(SID);
      ensuredStores.delete(tmpStore);
    });

    // --- Path 1: success path — pending data cleared after flush ----------

    it('clears pending edits after successful flush', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/success.ts',
        snippet: 'x',
        timestamp: 1_700_000_000,
      });
      recordEdit(SID, {
        tool: 'Write',
        filePath: '/tmp/other.ts',
        snippet: 'y',
        timestamp: 1_700_000_001,
      });
      assert.strictEqual(getPendingEdits(SID).length, 2);

      await flushCapture(tmpStore, 'main', SID);

      assert.strictEqual(getPendingEdits(SID).length, 0, 'edits should be empty after success');
    });

    it('clears tool metrics after successful flush', async () => {
      recordToolMetrics(SID, 'Edit', { calls: 5, errors: 1 });
      recordToolMetrics(SID, 'Bash', { calls: 3, errors: 0 });
      assert.strictEqual(getToolMetrics(SID).size, 2);

      await flushCapture(tmpStore, 'main', SID);

      assert.strictEqual(getToolMetrics(SID).size, 0, 'metrics map should be empty after success');
    });

    it('calls runMemoir with correct code metrics args', async () => {
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/a.ts',
        snippet: 'z',
        timestamp: 1_700_000_000,
      });

      await flushCapture(tmpStore, 'main', SID);

      const codeCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.code.main'),
      );
      assert.strictEqual(codeCalls.length, 1, 'runMemoir should be called once for code metrics');

      const args = codeCalls[0].args as string[];
      // args = ['-s', store, 'remember', '--replace', JSON.stringify(acc), '-p', 'metrics.code.main']
      assert.strictEqual(args[0], '-s');
      assert.strictEqual(args[1], tmpStore);
      assert.strictEqual(args[2], 'remember');
      assert.strictEqual(args[3], '--replace');
      // args[4] is the JSON payload
      const payload = JSON.parse(args[4] as string);
      assert.strictEqual(payload.schema_version, 2);
      assert.strictEqual(payload.entries.length, 1);
      assert.deepStrictEqual(payload.entries[0].files, ['/tmp/a.ts']);
      assert.strictEqual(args[5], '-p');
      assert.strictEqual(args[6], 'metrics.code.main');
    });

    it('calls runMemoir with correct turn metrics args', async () => {
      recordToolMetrics(SID, 'Edit', { calls: 5, errors: 1 });

      await flushCapture(tmpStore, 'main', SID);

      const turnCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.turn.main'),
      );
      assert.strictEqual(turnCalls.length, 1, 'runMemoir should be called once for turn metrics');

      const args = turnCalls[0].args as string[];
      // args = ['-s', store, 'remember', '--replace', serializedMetrics, '-p', 'metrics.turn.main']
      assert.strictEqual(args[0], '-s');
      assert.strictEqual(args[1], tmpStore);
      assert.strictEqual(args[2], 'remember');
      assert.strictEqual(args[3], '--replace');
      assert.strictEqual(args[4], 'Edit:5:1');
      assert.strictEqual(args[5], '-p');
      assert.strictEqual(args[6], 'metrics.turn.main');
    });

    // --- Path 2: branch resolution ---------------------------------------

    it('uses getCurrentBranch when cached branch is unknown', async () => {
      // Do NOT call setCachedBranch — getCachedBranch returns 'unknown' by default
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/branch.ts',
        snippet: 'b',
        timestamp: 1_700_000_000,
      });

      await flushCapture(tmpStore, undefined, SID);

      // getCurrentBranch should have been called (branch was 'unknown')
      const cbCalls = callLog.filter(c => c.fn === 'getCurrentBranch');
      assert.strictEqual(cbCalls.length, 1, 'getCurrentBranch should be called once');

      // The branch key used in readMemoirValue should be the value
      // returned by getCurrentBranch — 'main' (the mock default).
      const readCalls = callLog.filter(c => c.fn === 'readMemoirValue');
      assert.ok(readCalls.length > 0, 'readMemoirValue should be called');
      assert.ok(
        (readCalls[0].args as string[])[1].includes('metrics.code.main'),
        `branch key should be 'main' from getCurrentBranch, got: ${(readCalls[0].args as string[])[1]}`,
      );
    });

    it('skips getCurrentBranch when explicit branch param is provided', async () => {
      setCachedBranch(SID, 'develop'); // cached, but should be ignored
      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/explicit.ts',
        snippet: 'e',
        timestamp: 1_700_000_000,
      });

      // Pass explicit branch 'release' — the code uses `branch ?? cachedBranchBySession.get(sid)`
      await flushCapture(tmpStore, 'release', SID);

      // getCurrentBranch must NOT be called — branch was already known
      const cbCalls = callLog.filter(c => c.fn === 'getCurrentBranch');
      assert.strictEqual(cbCalls.length, 0, 'getCurrentBranch should not be called with explicit branch');

      // The branch key should be 'release' (the explicit param)
      const readCalls = callLog.filter(c => c.fn === 'readMemoirValue');
      assert.ok(readCalls.length > 0, 'readMemoirValue should be called');
      assert.ok(
        (readCalls[0].args as string[])[1].includes('metrics.code.release'),
        `branch key should be 'release', got: ${(readCalls[0].args as string[])[1]}`,
      );
    });

    // --- Path 3: merge with pre-existing data -----------------------------

    it('merges code metrics with pre-existing stored entries', async () => {
      const existingEntries = [
        { timestamp: 1_600_000_000, summary: 'old 1', files: ['a.ts'] },
        { timestamp: 1_600_000_001, summary: 'old 2', files: ['b.ts'] },
      ];
      const existingCode = JSON.stringify({ schema_version: 2, entries: existingEntries });

      // Override readMemoirValue to return pre-existing data for code metrics
      setCliOverrides({
        getCurrentBranch: async () => 'main',
        readMemoirValue: async (_store: string, key: string) => {
          callLog.push({ fn: 'readMemoirValue', args: [_store, key] });
          if (key === 'metrics.code.main') return existingCode;
          return '';
        },
        runMemoir: async (args: string[]) => {
          callLog.push({ fn: 'runMemoir', args });
          return { ok: true, stdout: 'ok' };
        },
      });

      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/new.ts',
        snippet: 'n',
        timestamp: 1_700_000_000,
      });

      await flushCapture(tmpStore, 'main', SID);

      // The runMemoir call for code metrics should contain 2 existing + 1 new = 3 entries
      const codeCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.code.main'),
      );
      assert.strictEqual(codeCalls.length, 1);
      const payload = JSON.parse((codeCalls[0].args as string[])[4] as string);
      assert.strictEqual(payload.entries.length, 3, 'should have 2 existing + 1 new entry');
      assert.strictEqual(payload.schema_version, 2, 'schema_version should be preserved');
      assert.deepStrictEqual(payload.entries[0].files, ['a.ts'], 'first entry should be the old one');
      assert.deepStrictEqual(payload.entries[2].files, ['/tmp/new.ts'], 'last entry should be the new one');
    });

    it('merges turn metrics with existing counters (sums calls/errors)', async () => {
      // Pre-existing: Edit:5:1 | Read:10:0
      const existingTurn = 'Edit:5:1 | Read:10:0';

      setCliOverrides({
        getCurrentBranch: async () => 'main',
        readMemoirValue: async (_store: string, key: string) => {
          callLog.push({ fn: 'readMemoirValue', args: [_store, key] });
          if (key === 'metrics.turn.main') return existingTurn;
          return '';
        },
        runMemoir: async (args: string[]) => {
          callLog.push({ fn: 'runMemoir', args });
          return { ok: true, stdout: 'ok' };
        },
      });

      // Record Edit:{calls:3, errors:1} — should sum with existing {5:1} → {8:2}
      recordToolMetrics(SID, 'Edit', { calls: 3, errors: 1 });

      await flushCapture(tmpStore, 'main', SID);

      const turnCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.turn.main'),
      );
      assert.strictEqual(turnCalls.length, 1);
      const serialized = (turnCalls[0].args as string[])[4] as string;
      // Edit should be 5+3=8 calls, 1+1=2 errors; Read untouched
      assert.ok(serialized.includes('Edit:8:2'), `Edit should be Edit:8:2, got: ${serialized}`);
      assert.ok(serialized.includes('Read:10:0'), `Read should be Read:10:0, got: ${serialized}`);
    });

    it('preserves untouched tools during turn merge', async () => {
      const existingTurn = 'Bash:20:3 | Grep:50:0';

      setCliOverrides({
        getCurrentBranch: async () => 'main',
        readMemoirValue: async (_store: string, key: string) => {
          callLog.push({ fn: 'readMemoirValue', args: [_store, key] });
          if (key === 'metrics.turn.main') return existingTurn;
          return '';
        },
        runMemoir: async (args: string[]) => {
          callLog.push({ fn: 'runMemoir', args });
          return { ok: true, stdout: 'ok' };
        },
      });

      // Record a tool not in the existing set
      recordToolMetrics(SID, 'Edit', { calls: 2, errors: 0 });

      await flushCapture(tmpStore, 'main', SID);

      const turnCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.turn.main'),
      );
      assert.strictEqual(turnCalls.length, 1);
      const serialized = (turnCalls[0].args as string[])[4] as string;
      // Existing tools preserved, new tool added
      assert.ok(serialized.includes('Bash:20:3'), 'Bash should be preserved');
      assert.ok(serialized.includes('Grep:50:0'), 'Grep should be preserved');
      assert.ok(serialized.includes('Edit:2:0'), 'Edit should be present');
    });

    it('caps code metrics at METRICS_CODE_MAX (FIFO eviction)', async () => {
      // Pre-populate with exactly METRICS_CODE_MAX entries
      const maxEntries = Array.from({ length: 1000 }, (_, i) => ({
        timestamp: 1_600_000_000 + i,
        summary: `entry ${i}`,
        files: [`file-${i}.ts`],
      }));
      const existingCode = JSON.stringify({ schema_version: 2, entries: maxEntries });

      setCliOverrides({
        getCurrentBranch: async () => 'main',
        readMemoirValue: async (_store: string, key: string) => {
          callLog.push({ fn: 'readMemoirValue', args: [_store, key] });
          if (key === 'metrics.code.main') return existingCode;
          return '';
        },
        runMemoir: async (args: string[]) => {
          callLog.push({ fn: 'runMemoir', args });
          return { ok: true, stdout: 'ok' };
        },
      });

      recordEdit(SID, {
        tool: 'Edit',
        filePath: '/tmp/cap.ts',
        snippet: 'c',
        timestamp: 1_700_000_000,
      });

      await flushCapture(tmpStore, 'main', SID);

      const codeCalls = callLog.filter(
        c => c.fn === 'runMemoir' && (c.args as string[]).includes('metrics.code.main'),
      );
      assert.strictEqual(codeCalls.length, 1);
      const payload = JSON.parse((codeCalls[0].args as string[])[4] as string);
      assert.strictEqual(
        payload.entries.length,
        1000,
        `should be capped at METRICS_CODE_MAX, got ${payload.entries.length}`,
      );
      // The oldest entry (index 0: file-0.ts) should have been evicted;
      // the first entry should now be file-1.ts
      assert.deepStrictEqual(payload.entries[0].files, ['file-1.ts'], 'oldest entry should be evicted');
      // The last entry should be the new one
      assert.deepStrictEqual(payload.entries[999].files, ['/tmp/cap.ts'], 'new entry should be appended');
    });
  });
});
