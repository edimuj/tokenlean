import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, DEFAULT_CONFIG, clearConfigCache, loadConfig } from './config.mjs';

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const result = deepMerge({ a: 1, b: 2 }, { c: 3 });
    assert.deepStrictEqual(result, { a: 1, b: 2, c: 3 });
  });

  it('overrides existing keys', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 99 });
    assert.deepStrictEqual(result, { a: 1, b: 99 });
  });

  it('deep merges nested objects', () => {
    const target = { output: { maxLines: 100, format: 'text' } };
    const source = { output: { maxLines: 50 } };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { output: { maxLines: 50, format: 'text' } });
  });

  it('replaces arrays instead of merging', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result, { items: [4, 5] });
  });

  it('handles null in source (overwrites target)', () => {
    const target = { output: { maxLines: 100 } };
    const source = { output: null };
    const result = deepMerge(target, source);
    assert.strictEqual(result.output, null);
  });

  it('handles null in target (source overwrites)', () => {
    const target = { output: null };
    const source = { output: { maxLines: 50 } };
    const result = deepMerge(target, source);
    assert.deepStrictEqual(result.output, { maxLines: 50 });
  });

  it('does not mutate target or source', () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    const targetCopy = JSON.parse(JSON.stringify(target));
    const sourceCopy = JSON.parse(JSON.stringify(source));
    deepMerge(target, source);
    assert.deepStrictEqual(target, targetCopy);
    assert.deepStrictEqual(source, sourceCopy);
  });

  it('handles empty source', () => {
    const target = { a: 1 };
    const result = deepMerge(target, {});
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('handles empty target', () => {
    const result = deepMerge({}, { a: 1 });
    assert.deepStrictEqual(result, { a: 1 });
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has expected top-level keys', () => {
    const expectedKeys = [
      'output', 'skipDirs', 'skipExtensions', 'importantDirs',
      'importantFiles', 'searchPatterns', 'hotspots', 'structure',
      'symbols', 'impact', 'cache'
    ];
    for (const key of expectedKeys) {
      assert.ok(key in DEFAULT_CONFIG, `missing key: ${key}`);
    }
  });

  it('output has correct types', () => {
    assert.strictEqual(DEFAULT_CONFIG.output.maxLines, null);
    assert.strictEqual(DEFAULT_CONFIG.output.maxTokens, null);
    assert.strictEqual(DEFAULT_CONFIG.output.format, 'text');
  });

  it('array fields are arrays', () => {
    assert.ok(Array.isArray(DEFAULT_CONFIG.skipDirs));
    assert.ok(Array.isArray(DEFAULT_CONFIG.skipExtensions));
    assert.ok(Array.isArray(DEFAULT_CONFIG.importantDirs));
    assert.ok(Array.isArray(DEFAULT_CONFIG.importantFiles));
  });
});

describe('clearConfigCache', () => {
  afterEach(() => clearConfigCache());

  it('is callable without error', () => {
    assert.doesNotThrow(() => clearConfigCache());
  });

  it('can be called multiple times', () => {
    clearConfigCache();
    clearConfigCache();
    assert.ok(true);
  });
});

describe('per-project config cache', () => {
  afterEach(() => clearConfigCache());

  it('does not leak the first MCP cwd config into a second project', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-config-projects-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 11 } }));
    writeFileSync(join(second, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 22 } }));

    try {
      assert.strictEqual(loadConfig({ startDir: first }).config.output.maxLines, 11);
      assert.strictEqual(loadConfig({ startDir: second }).config.output.maxLines, 22);
      assert.strictEqual(loadConfig({ startDir: first }).config.output.maxLines, 11);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates a cached config after a same-process edit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-config-edit-'));
    const configPath = join(root, '.tokenleanrc.json');
    try {
      writeFileSync(configPath, JSON.stringify({ output: { maxLines: 11 } }));
      assert.strictEqual(loadConfig({ startDir: root }).config.output.maxLines, 11);
      // Same-length rewrite exercises content invalidation, not just size.
      writeFileSync(configPath, JSON.stringify({ output: { maxLines: 33 } }));
      assert.strictEqual(loadConfig({ startDir: root }).config.output.maxLines, 33);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a newly-created nearer project config', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-config-nearer-'));
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 10 } }));
    try {
      assert.strictEqual(loadConfig({ startDir: nested }).config.output.maxLines, 10);
      writeFileSync(join(nested, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 20 } }));
      assert.strictEqual(loadConfig({ startDir: nested }).config.output.maxLines, 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
