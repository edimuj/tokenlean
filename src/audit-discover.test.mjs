import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProvider } from './audit-discover.mjs';

describe('normalizeProvider', () => {
  it('normalizes claude-code to claude', () => {
    assert.equal(normalizeProvider('claude-code'), 'claude');
  });

  it('normalizes claudecode to claude', () => {
    assert.equal(normalizeProvider('claudecode'), 'claude');
  });

  it('keeps codex as codex', () => {
    assert.equal(normalizeProvider('codex'), 'codex');
  });

  it('normalizes auto', () => {
    assert.equal(normalizeProvider('auto'), 'auto');
  });

  it('normalizes null/undefined to auto', () => {
    assert.equal(normalizeProvider(null), 'auto');
    assert.equal(normalizeProvider(undefined), 'auto');
  });

  it('throws on unsupported provider', () => {
    assert.throws(() => normalizeProvider('invalid'), /Unsupported provider/);
  });
});
