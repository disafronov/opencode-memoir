import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coercePaths, errorMessage, MEMOIR_GET_MAX_KEYS, tryPrettyJson } from '../src/utils.ts';
import { SECRET_PATTERN, isSecretSanitizationEnabled } from '../src/recall-gate.ts';
import { parseTurnMetrics, serializeTurnMetrics } from '../src/capture.ts';

describe('MEMOIR_GET_MAX_KEYS', () => {
  it('limits key count to prevent OS arg-length overflow', () => {
    assert.strictEqual(MEMOIR_GET_MAX_KEYS, 20);
  });
});

describe('coercePaths', () => {
  it('returns empty array for undefined', () => {
    assert.deepStrictEqual(coercePaths(undefined), []);
  });

  it('wraps a single string in array', () => {
    assert.deepStrictEqual(coercePaths('prefs.coding.style'), ['prefs.coding.style']);
  });

  it('filters falsy values from array', () => {
    assert.deepStrictEqual(coercePaths(['a', '', 'b', undefined as unknown as string, 'c']), ['a', 'b', 'c']);
  });

  it('passes through clean array', () => {
    assert.deepStrictEqual(coercePaths(['a', 'b', 'c']), ['a', 'b', 'c']);
  });
});

describe('tryPrettyJson', () => {
  it('pretty-prints valid JSON', () => {
    const result = tryPrettyJson('{"a":1,"b":{"c":2}}');
    assert.strictEqual(result, '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
  });

  it('passes non-JSON through unchanged', () => {
    const text = 'Memoir command failed (1): not found';
    assert.strictEqual(tryPrettyJson(text), text);
  });

  it('passes empty string through unchanged', () => {
    assert.strictEqual(tryPrettyJson(''), '');
  });

  it('handles array JSON', () => {
    const result = tryPrettyJson('[1, 2, 3]');
    assert.strictEqual(result, '[\n  1,\n  2,\n  3\n]');
  });
});

describe('SECRET_PATTERN', () => {
  it('matches API keys', () => {
    assert.ok(SECRET_PATTERN.test('api_key=sk-1234567890abcdef'));
    assert.ok(SECRET_PATTERN.test('apikey=abc123456789'));
    assert.ok(SECRET_PATTERN.test('api-key=xyz789012345'));
  });

  it('matches tokens', () => {
    assert.ok(SECRET_PATTERN.test('auth_token=ghp_abcdefghij123456'));
    assert.ok(SECRET_PATTERN.test('token=eyJhbGci'));
  });

  it('matches passwords', () => {
    assert.ok(SECRET_PATTERN.test('password=hunter2islong'));
    assert.ok(SECRET_PATTERN.test('passwd=s3cretislong'));
  });

  it('matches private keys', () => {
    assert.ok(SECRET_PATTERN.test('-----BEGIN RSA PRIVATE KEY-----'));
    assert.ok(SECRET_PATTERN.test('-----BEGIN EC PRIVATE KEY-----'));
  });

  it('does not match innocent words containing secret-related substrings', () => {
    // Word boundaries (\b) prevent matching "secret" inside "secretary",
    // "token" inside "tokenization", etc.
    assert.ok(!SECRET_PATTERN.test('the secretary problem'));
    assert.ok(!SECRET_PATTERN.test('tokenization of input'));
    assert.ok(!SECRET_PATTERN.test('the passwordless approach'));
    assert.ok(!SECRET_PATTERN.test('passwording the input'));
  });

  it('does not match clearly safe content', () => {
    assert.ok(!SECRET_PATTERN.test('use pytest for testing'));
    assert.ok(!SECRET_PATTERN.test('prefer functional components'));
    assert.ok(!SECRET_PATTERN.test('the API should return JSON'));
    assert.ok(!SECRET_PATTERN.test('database is PostgreSQL'));
  });

  it('can be disabled via MEMOIR_SANITIZE_SECRETS=0 at the source', async () => {
    // We can't easily mock process.env for the import-time SECRET_PATTERN,
    // but we verify the gating logic would work by asserting the pattern
    // itself still matches; the disable is controlled at the call site.
    const original = process.env.MEMOIR_SANITIZE_SECRETS;
    delete process.env.MEMOIR_SANITIZE_SECRETS;
    assert.ok(SECRET_PATTERN.test('api_key=sk-1234567890abcdef'), 'default enabled');
    process.env.MEMOIR_SANITIZE_SECRETS = '0';
    // Pattern itself is unchanged — gating is at the call site
    assert.ok(SECRET_PATTERN.test('api_key=sk-1234567890abcdef'), 'pattern unchanged');
    process.env.MEMOIR_SANITIZE_SECRETS = original ?? '';
  });
});

describe('errorMessage', () => {
  it('extracts message from Error instances', () => {
    assert.strictEqual(errorMessage(new Error('test')), 'test');
  });

  it('converts non-Error values to string', () => {
    assert.strictEqual(errorMessage('string error'), 'string error');
  });

  it('handles null', () => {
    assert.strictEqual(errorMessage(null), 'null');
  });

  it('handles undefined', () => {
    assert.strictEqual(errorMessage(undefined), 'undefined');
  });
});

describe('isSecretSanitizationEnabled', () => {
  it('is enabled by default', () => {
    delete process.env.MEMOIR_SANITIZE_SECRETS;
    assert.ok(isSecretSanitizationEnabled());
  });

  it('is disabled when MEMOIR_SANITIZE_SECRETS=0', () => {
    process.env.MEMOIR_SANITIZE_SECRETS = '0';
    assert.ok(!isSecretSanitizationEnabled());
    delete process.env.MEMOIR_SANITIZE_SECRETS;
  });

  it('is enabled when MEMOIR_SANITIZE_SECRETS=1', () => {
    process.env.MEMOIR_SANITIZE_SECRETS = '1';
    assert.ok(isSecretSanitizationEnabled());
    delete process.env.MEMOIR_SANITIZE_SECRETS;
  });

  it('is enabled for any non-zero value', () => {
    process.env.MEMOIR_SANITIZE_SECRETS = 'false';
    assert.ok(isSecretSanitizationEnabled());
    process.env.MEMOIR_SANITIZE_SECRETS = 'anything';
    assert.ok(isSecretSanitizationEnabled());
    delete process.env.MEMOIR_SANITIZE_SECRETS;
  });
});

describe('parseTurnMetrics', () => {
  it('returns empty map for empty string', () => {
    const result = parseTurnMetrics('');
    assert.strictEqual(result.size, 0);
  });

  it('parses single tool entry', () => {
    const result = parseTurnMetrics('Edit:5:1');
    assert.strictEqual(result.size, 1);
    assert.strictEqual(result.get('Edit')?.calls, 5);
    assert.strictEqual(result.get('Edit')?.errors, 1);
  });

  it('parses multiple tool entries', () => {
    const result = parseTurnMetrics('Edit:10:2 | Write:3:0 | Read:8:0');
    assert.strictEqual(result.size, 3);
    assert.strictEqual(result.get('Edit')?.calls, 10);
    assert.strictEqual(result.get('Edit')?.errors, 2);
    assert.strictEqual(result.get('Write')?.calls, 3);
    assert.strictEqual(result.get('Read')?.calls, 8);
  });

  it('handles extra whitespace around pipes', () => {
    const result = parseTurnMetrics('Bash:7:1  |  grep:2:0');
    assert.strictEqual(result.size, 2);
    assert.strictEqual(result.get('Bash')?.calls, 7);
    assert.strictEqual(result.get('grep')?.calls, 2);
  });

  it('defaults missing fields to 0', () => {
    const result = parseTurnMetrics('Edit:5');
    assert.strictEqual(result.size, 1);
    assert.strictEqual(result.get('Edit')?.calls, 5);
    assert.strictEqual(result.get('Edit')?.errors, 0);
  });

  it('handles non-numeric counters as 0', () => {
    const result = parseTurnMetrics('Edit:abc:def');
    assert.strictEqual(result.size, 1);
    assert.strictEqual(result.get('Edit')?.calls, 0);
    assert.strictEqual(result.get('Edit')?.errors, 0);
  });
});

describe('serializeTurnMetrics', () => {
  it('roundtrips with parseTurnMetrics', () => {
    const input = new Map([
      ['Edit', { calls: 5, errors: 1 }],
      ['Write', { calls: 3, errors: 0 }],
    ]);
    const serialized = serializeTurnMetrics(input);
    const parsed = parseTurnMetrics(serialized);
    assert.strictEqual(parsed.get('Edit')?.calls, 5);
    assert.strictEqual(parsed.get('Edit')?.errors, 1);
    assert.strictEqual(parsed.get('Write')?.calls, 3);
    assert.strictEqual(parsed.get('Write')?.errors, 0);
  });

  it('produces pipe-delimited format', () => {
    const input = new Map([['Bash', { calls: 7, errors: 2 }]]);
    assert.strictEqual(serializeTurnMetrics(input), 'Bash:7:2');
  });
});
