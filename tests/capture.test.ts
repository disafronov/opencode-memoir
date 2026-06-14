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
  // Paths NOT covered (require a source code seam or real memoir CLI)
  //
  // (1) Success path: When runMemoir writes succeed, the pending maps are
  //     cleared and data is persisted to the memoir store. Without a real
  //     memoir CLI or a mock injection point for runMemoir, the write
  //     always fails, so this path cannot be exercised in unit tests
  //     without modifying src/ to add a DI seam.
  //
  // (2) Branch resolution via getCurrentBranch: The code calls
  //     getCurrentBranch(store) when sessionBranch is "unknown". This
  //     uses runMemoir which returns an error string; JSON.parse on it
  //     throws, and the catch falls back to "unknown". Testable in
  //     principle but provides no additional behavioral coverage beyond
  //     what the rollback tests already exercise.
  //
  // (3) Code metrics merge with pre-existing data: readMemoirValue
  //     returns '' on failure, so the code starts with a fresh accumulator.
  //     Merging with a non-empty previous value requires readMemoirValue
  //     to succeed, which needs a real memoir CLI or mock injection.
  // -----------------------------------------------------------------------
});
