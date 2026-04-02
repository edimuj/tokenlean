import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gitCommand, rgCommand } from './shell.mjs';

describe('gitCommand', () => {
  it('returns stdout for valid commands', () => {
    const result = gitCommand(['rev-parse', '--git-dir']);
    assert.ok(result !== null, 'should return non-null for a git repo');
    assert.ok(result.includes('.git'), 'should include .git');
  });

  it('returns null for invalid git commands', () => {
    const result = gitCommand(['invalid-subcommand-xyz']);
    assert.equal(result, null);
  });

  it('returns null when cwd is not a git repo', () => {
    const result = gitCommand(['rev-parse', '--git-dir'], { cwd: '/tmp' });
    assert.equal(result, null);
  });

  it('trims stdout whitespace', () => {
    const result = gitCommand(['rev-parse', 'HEAD']);
    assert.ok(result !== null);
    assert.equal(result, result.trim(), 'output should be trimmed');
    assert.match(result, /^[0-9a-f]{40}$/, 'HEAD should be a 40-char hex string');
  });

  it('respects cwd option', () => {
    // Run from the project root should work
    const result = gitCommand(['log', '--oneline', '-1'], { cwd: process.cwd() });
    assert.ok(result !== null);
    assert.ok(result.length > 0);
  });

  it('handles timeout option without crashing', () => {
    // Large timeout should succeed
    const result = gitCommand(['rev-parse', 'HEAD'], { timeout: 5000 });
    assert.ok(result !== null);
  });
});

describe('rgCommand', () => {
  it('returns stdout for matching searches', () => {
    // Search for "export" in this test file — guaranteed to match
    const result = rgCommand(['-c', 'export', 'src/shell.mjs']);
    assert.ok(result !== null, 'should find matches');
    assert.ok(parseInt(result) > 0, 'count should be > 0');
  });

  it('returns empty string for no matches (exit code 1)', () => {
    const result = rgCommand(['-c', 'zzz_nonexistent_pattern_xyz', 'src/shell.mjs']);
    assert.equal(result, '', 'no matches should return empty string');
  });

  it('returns null for errors (exit code >= 2)', () => {
    // Invalid regex should cause rg error
    const result = rgCommand(['-e', '[invalid regex']);
    assert.equal(result, null);
  });

  it('respects cwd option', () => {
    const result = rgCommand(['-c', 'function', 'src/shell.mjs'], { cwd: process.cwd() });
    assert.ok(result !== null);
    assert.ok(parseInt(result) >= 2, 'shell.mjs has at least 2 functions');
  });

  it('handles multi-line output', () => {
    const result = rgCommand(['-n', '--no-heading', 'function', 'src/shell.mjs']);
    assert.ok(result !== null);
    const lines = result.split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, 'should find multiple function lines');
  });
});
