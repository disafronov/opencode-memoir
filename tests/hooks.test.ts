import { describe, it, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';

import { MemoirOpenCode } from '../src/index.ts';
import {
  clearSession, EDIT_TOOLS, getPendingEdits, getToolMetrics, recordEdit, recordToolMetrics,
} from '../src/capture.ts';
import { pendingRecall } from '../src/recall-gate.ts';

// ---------------------------------------------------------------------------
// Minimal mocks for plugin input/output types
// ---------------------------------------------------------------------------

function mockPluginInput(): Record<string, unknown> {
  return {
    client: {} as Record<string, never>,
    project: {} as Record<string, never>,
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: { register: () => { /* noop */ } },
    serverUrl: new URL('http://localhost:3000'),
    $: {} as Record<string, never>,
  };
}

type HookMap = Record<string, (...args: unknown[]) => unknown>;

// ---------------------------------------------------------------------------
// Setup: instantiate the plugin once, get hooks back
// ---------------------------------------------------------------------------

let hooks: HookMap;

before(async () => {
  hooks = (await MemoirOpenCode(mockPluginInput() as never, {})) as unknown as HookMap;
});

// All tool.execute.after and chat.message tests use this session ID.
const SID = 'test-session';

describe('config hook', () => {
  it('registers memoir:* commands', async () => {
    const config: { command?: Record<string, unknown> } = {};
    await hooks.config(config);
    assert.ok(config.command);
    assert.ok(config.command!['memoir:status']);
    assert.ok(config.command!['memoir:ui']);
    assert.ok(config.command!['memoir:remember']);
    assert.ok(config.command!['memoir:recall']);
    assert.ok(config.command!['memoir:onboard']);
    assert.ok(config.command!['memoir:unmerged']);
  });
});

describe('shell.env hook', () => {
  it('injects MEMOIR_STORE into env', async () => {
    const output: { env: Record<string, string> } = { env: {} };
    await hooks['shell.env']({} as never, output);
    assert.ok(output.env.MEMOIR_STORE);
    assert.match(output.env.MEMOIR_STORE, /\.memoir\//);
  });
});

describe('tool.execute.after hook', () => {
  beforeEach(() => {
    clearSession(SID);
    delete process.env.MEMOIR_NO_CAPTURE;
    delete process.env.MEMOIR_NO_METRICS;
    delete process.env.MEMOIR_NO_CODE_SUMMARY;
  });

  it('accumulates tool call metrics', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'success' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).get('Edit')?.calls, 1);
    assert.strictEqual(getToolMetrics(SID).get('Edit')?.errors, 0);
  });

  it('tracks error count when metadata.error is set', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Bash', sessionID: SID, callID: 'c1', args: {} } as never,
      { metadata: { error: 'exit code 1' }, output: '' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).get('Bash')?.calls, 1);
    assert.strictEqual(getToolMetrics(SID).get('Bash')?.errors, 1);
  });

  it('tracks error count when output starts with Error:', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Write', sessionID: SID, callID: 'c1', args: {} } as never,
      { metadata: {}, output: 'Error: permission denied' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).get('Write')?.calls, 1);
    assert.strictEqual(getToolMetrics(SID).get('Write')?.errors, 1);
  });

  it('accumulates multiple calls for the same tool', async () => {
    for (let i = 0; i < 5; i++) {
      await hooks['tool.execute.after'](
        { tool: 'Read', sessionID: SID, callID: `c${i}`, args: {} } as never,
        { metadata: {}, output: 'ok' } as never,
      );
    }
    assert.strictEqual(getToolMetrics(SID).get('Read')?.calls, 5);
  });

  it('skips metrics when MEMOIR_NO_METRICS=1', async () => {
    process.env.MEMOIR_NO_METRICS = '1';
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).size, 0);
    // Edits are tracked separately (different guard)
    assert.strictEqual(getPendingEdits(SID).length, 1);
  });

  it('skips metrics when MEMOIR_NO_CAPTURE=1', async () => {
    process.env.MEMOIR_NO_CAPTURE = '1';
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).size, 0);
    assert.strictEqual(getPendingEdits(SID).length, 0);
  });

  it('tracks edits for known edit tools (Edit, Write, MultiEdit, NotebookEdit, apply_patch, ApplyPatch, MultiFileEdit)', async () => {
    const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'ApplyPatch', 'MultiFileEdit'];
    for (const tool of editTools) {
      await hooks['tool.execute.after'](
        { tool, sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
        { metadata: {}, output: 'ok' } as never,
      );
    }
    assert.strictEqual(getPendingEdits(SID).length, editTools.length);
  });

  it('tracks edits with filePath from args.filePath or args.path', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    await hooks['tool.execute.after'](
      { tool: 'Write', sessionID: SID, callID: 'c2', args: { path: '/tmp/b.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getPendingEdits(SID).length, 2);
    assert.strictEqual(getPendingEdits(SID)[0].filePath, '/tmp/a.ts');
    assert.strictEqual(getPendingEdits(SID)[1].filePath, '/tmp/b.ts');
  });

  it('does not track non-edit tools', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Read', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    await hooks['tool.execute.after'](
      { tool: 'Bash', sessionID: SID, callID: 'c2', args: {} } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getPendingEdits(SID).length, 0);
  });

  it('skips edits when MEMOIR_NO_CODE_SUMMARY=1', async () => {
    process.env.MEMOIR_NO_CODE_SUMMARY = '1';
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: { filePath: '/tmp/a.ts' } } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).get('Edit')?.calls, 1);
    assert.strictEqual(getPendingEdits(SID).length, 0);
  });

  it('does not crash on missing filePath args', async () => {
    await hooks['tool.execute.after'](
      { tool: 'Edit', sessionID: SID, callID: 'c1', args: {} } as never,
      { metadata: {}, output: 'ok' } as never,
    );
    assert.strictEqual(getToolMetrics(SID).get('Edit')?.calls, 1);
    assert.strictEqual(getPendingEdits(SID).length, 0);
  });

  it('does not throw on any input', async () => {
    await hooks['tool.execute.after'](null as never, null as never);
    assert.ok(true);
  });
});

describe('chat.message hook', () => {
  beforeEach(() => {
    clearSession(SID);
    pendingRecall.clear();
    delete process.env.MEMOIR_NO_CAPTURE;
  });

  it('triggers recall gate for code-related messages', async () => {
    await hooks['chat.message'](
      { sessionID: SID } as never,
      { parts: [{ type: 'text', text: 'Can you implement the caching layer for the payment module?' }] } as never,
    );
    assert.ok(pendingRecall.has(SID));
  });

  it('does not trigger recall for acknowledgements', async () => {
    await hooks['chat.message'](
      { sessionID: SID } as never,
      { parts: [{ type: 'text', text: 'ok' }] } as never,
    );
    assert.ok(!pendingRecall.has(SID));
  });

  it('does not crash on empty parts', async () => {
    await hooks['chat.message'](
      { sessionID: SID } as never,
      { parts: [] } as never,
    );
    assert.ok(!pendingRecall.has(SID));
  });

  it('does not throw on any input', async () => {
    await hooks['chat.message'](null as never, null as never);
    assert.ok(true);
  });
});

describe('system.transform hook', () => {
  beforeEach(() => {
    pendingRecall.clear();
  });

  it('injects recall instruction when recall is pending', async () => {
    pendingRecall.add('s1');
    const output: { system: string[] } = { system: [] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 's1' } as never,
      output as never,
    );
    assert.ok(output.system.length > 0);
    assert.match(output.system[0], /memoir/);
    assert.ok(!pendingRecall.has('s1'), 'recall consumed');
  });

  it('does not inject recall instruction when no recall is pending', async () => {
    const output: { system: string[] } = { system: [] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 's99' } as never,
      output as never,
    );
    assert.strictEqual(output.system.length, 0);
  });

  it('does not throw on missing sessionID', async () => {
    await hooks['experimental.chat.system.transform'](
      {} as never,
      { system: [] } as never,
    );
    assert.ok(true);
  });
});

describe('dispose hook', () => {
  it('cleans up sessionsWithContext (does not throw)', async () => {
    await hooks.dispose();
    assert.ok(true);
  });
});
