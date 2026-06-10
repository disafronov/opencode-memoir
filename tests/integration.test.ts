import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureStore, runMemoir, ensuredStores, memoirSpawnSpecs } from '../src/store.ts';

/**
 * Probe whether a working `memoir` CLI is reachable via any spawn spec.
 * Returns true if `memoir --help` (or a fallback launcher) succeeds.
 * Done once at module load so tests can self-skip in environments
 * (most CI) where the binary isn't installed.
 */
async function memoirAvailable(): Promise<boolean> {
  const result = await runMemoir(['--help']);
  return !result.startsWith('Memoir command failed');
}

const hasMemoir = await memoirAvailable();

// Single smoke test: the one path unit tests mock away — that ensureStore
// can actually bootstrap a working store from an empty, NON-git directory
// (the bug that motivated the scratch-git-dir fix). Everything else is
// covered by unit/hook tests; real-CLI coverage here is deliberately minimal.
describe('integration: ensureStore + memoir status (real CLI)', { skip: !hasMemoir ? 'memoir CLI not available' : false }, () => {
  let workDir: string;
  let store: string;

  after(async () => {
    if (store) {
      ensuredStores.delete(store);
      await rm(store, { recursive: true, force: true }).catch(() => undefined);
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('creates a working store in an empty non-git directory', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'memoir-it-work-'));
    store = join(workDir, 'store');

    // workDir is a fresh tmp dir with no .git — this is the scenario that
    // crashed `memoir new` before the scratch-git-dir workaround.
    await ensureStore(store);

    // Store directory must now be a real prolly-tree git repo.
    await assert.doesNotReject(access(join(store, '.git')), '.git should exist in the new store');

    // And memoir must be able to report status against it.
    const status = await runMemoir(['--json', '-s', store, 'status'], { cwd: store });
    assert.ok(!status.startsWith('Memoir command failed'), `status should succeed, got: ${status}`);
    const data = JSON.parse(status);
    assert.ok(data.branch, 'status JSON should report a branch');
  });
});
