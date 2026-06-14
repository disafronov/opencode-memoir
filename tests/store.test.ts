import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStorePath, reorderResolver } from '../src/store.ts';

describe('deriveStorePath', () => {
  afterEach(() => {
    delete process.env.MEMOIR_STORE;
  });

  it('uses MEMOIR_STORE env var when set', () => {
    process.env.MEMOIR_STORE = '/tmp/test-memoir-store';
    assert.strictEqual(deriveStorePath('/some/project'), '/tmp/test-memoir-store');
  });

  it('uses homedir slug from cwd when no env', () => {
    const result = deriveStorePath('/home/user/my-project');
    assert.match(result, /^\/.*\.memoir/);
    assert.ok(result.includes('my-project'));
  });

  it('replaces slashes and dots with hyphens in slug', () => {
    const result = deriveStorePath('/home/user/dev/my.app');
    assert.match(result, /my-app$/);
  });

  it('handles cwd at root', () => {
    const result = deriveStorePath('/');
    assert.match(result, /^\/.*\.memoir\/-$/);
  });

  it('handles cwd with hyphens and underscores', () => {
    const result = deriveStorePath('/home/user/my_project-v2');
    assert.ok(result.includes('my_project-v2'));
  });
});

describe('reorderResolver', () => {
  it('returns a new array with winner first', () => {
    assert.deepStrictEqual(reorderResolver(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    const inputRef = input;
    reorderResolver(input, 'b');
    assert.deepStrictEqual(input, inputRef);
  });

  it('returns copy when winner is already first', () => {
    const input = ['a', 'b', 'c'];
    const result = reorderResolver(input, 'a');
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
    assert.notStrictEqual(result, input); // is a copy, not same reference
  });

  it('returns copy when winner is not found', () => {
    const input = ['a', 'b', 'c'];
    const result = reorderResolver(input, 'd');
    assert.deepStrictEqual(result, ['a', 'b', 'c']);
    assert.notStrictEqual(result, input); // is a copy
  });

  it('handles single-element array', () => {
    assert.deepStrictEqual(reorderResolver(['a'], 'a'), ['a']);
  });
});
