import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  getCacheConfig,
  getGitState,
  getCacheDir,
  getCached,
  setCached,
  withCache,
  clearCache,
  getCacheStats
} from './cache.mjs';

// ─────────────────────────────────────────────────────────────
// Fixture: temp git repo for cache tests
// ─────────────────────────────────────────────────────────────
let tmpDir;

before(() => {
  tmpDir = join(tmpdir(), `tl-cache-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  // Init a git repo so git-based invalidation works
  execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
  writeFileSync(join(tmpDir, 'test.txt'), 'hello\n');
  execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
});

afterEach(() => {
  // Clear cache between tests to avoid cross-contamination
  clearCache(tmpDir);
});

after(() => {
  clearCache(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// getCacheConfig
// ─────────────────────────────────────────────────────────────

describe('getCacheConfig', () => {
  it('returns config object with required fields', () => {
    const config = getCacheConfig();
    assert.ok('enabled' in config);
    assert.ok('ttl' in config);
    assert.ok('maxSize' in config);
    assert.ok('location' in config);
  });

  it('enabled is a boolean', () => {
    const config = getCacheConfig();
    assert.equal(typeof config.enabled, 'boolean');
  });

  it('ttl is a positive number', () => {
    const config = getCacheConfig();
    assert.ok(config.ttl > 0);
  });

  it('maxSize is a positive number', () => {
    const config = getCacheConfig();
    assert.ok(config.maxSize > 0);
  });

  it('location is a string path', () => {
    const config = getCacheConfig();
    assert.equal(typeof config.location, 'string');
    assert.ok(config.location.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────
// getGitState
// ─────────────────────────────────────────────────────────────

describe('getGitState', () => {
  it('returns head and dirtyFiles for a git repo', () => {
    const state = getGitState(tmpDir);
    assert.ok(state !== null);
    assert.ok(state.head, 'should have head commit');
    assert.match(state.head, /^[0-9a-f]{40}$/, 'head should be 40-char hex');
    assert.ok(Array.isArray(state.dirtyFiles));
  });

  it('returns null for non-git directories', () => {
    const nonGitDir = join(tmpdir(), `tl-non-git-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });
    try {
      const state = getGitState(nonGitDir);
      assert.equal(state, null);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('tracks dirty files', () => {
    // Create an untracked file
    writeFileSync(join(tmpDir, 'dirty.txt'), 'dirty\n');
    const state = getGitState(tmpDir);
    assert.ok(state.dirtyFiles.length > 0, 'should detect dirty files');
    // Clean up
    rmSync(join(tmpDir, 'dirty.txt'));
  });
});

// ─────────────────────────────────────────────────────────────
// getCacheDir
// ─────────────────────────────────────────────────────────────

describe('getCacheDir', () => {
  it('returns a directory path', () => {
    const dir = getCacheDir(tmpDir);
    assert.ok(typeof dir === 'string');
    assert.ok(dir.length > 0);
  });

  it('creates the directory if it does not exist', () => {
    clearCache(tmpDir);
    const dir = getCacheDir(tmpDir);
    assert.ok(existsSync(dir), 'cache dir should be created');
  });

  it('returns consistent path for same project', () => {
    const dir1 = getCacheDir(tmpDir);
    const dir2 = getCacheDir(tmpDir);
    assert.equal(dir1, dir2);
  });
});

// ─────────────────────────────────────────────────────────────
// setCached / getCached roundtrip
// ─────────────────────────────────────────────────────────────

describe('setCached / getCached', () => {
  it('roundtrips simple data', () => {
    const key = { op: 'test', id: 'roundtrip-1' };
    const data = { result: [1, 2, 3], meta: 'hello' };

    setCached(key, data, tmpDir);
    const retrieved = getCached(key, tmpDir);

    assert.deepEqual(retrieved, data);
  });

  it('roundtrips string data', () => {
    const key = 'simple-string-key';
    setCached(key, 'hello world', tmpDir);
    assert.equal(getCached(key, tmpDir), 'hello world');
  });

  it('roundtrips array data', () => {
    const key = 'array-key';
    const data = ['a', 'b', 'c'];
    setCached(key, data, tmpDir);
    assert.deepEqual(getCached(key, tmpDir), data);
  });

  it('returns null for non-existent key', () => {
    const result = getCached({ op: 'nonexistent' }, tmpDir);
    assert.equal(result, null);
  });

  it('invalidates when git state changes', () => {
    const key = { op: 'test', id: 'git-invalidation' };
    setCached(key, 'old', tmpDir);
    assert.equal(getCached(key, tmpDir), 'old');

    // Make a new commit to change HEAD
    writeFileSync(join(tmpDir, 'new-file.txt'), 'content\n');
    execSync('git add . && git commit -m "change"', { cwd: tmpDir, stdio: 'ignore' });

    // Cache should be invalidated
    assert.equal(getCached(key, tmpDir), null, 'should be invalidated after new commit');
  });
});

// ─────────────────────────────────────────────────────────────
// withCache
// ─────────────────────────────────────────────────────────────

describe('withCache', () => {
  it('caches function result', () => {
    let callCount = 0;
    const key = { op: 'withCache-test-1' };

    const result1 = withCache(key, () => { callCount++; return 42; }, { projectRoot: tmpDir });
    assert.equal(result1, 42);
    assert.equal(callCount, 1);

    const result2 = withCache(key, () => { callCount++; return 99; }, { projectRoot: tmpDir });
    assert.equal(result2, 42, 'should return cached value');
    assert.equal(callCount, 1, 'function should not be called again');
  });

  it('calls function on cache miss', () => {
    let called = false;
    const result = withCache(
      { op: 'miss-test' },
      () => { called = true; return 'computed'; },
      { projectRoot: tmpDir }
    );
    assert.equal(called, true);
    assert.equal(result, 'computed');
  });
});

// ─────────────────────────────────────────────────────────────
// clearCache
// ─────────────────────────────────────────────────────────────

describe('clearCache', () => {
  it('removes cache for specific project', () => {
    setCached('clear-test', 'data', tmpDir);
    assert.ok(getCached('clear-test', tmpDir) !== null);

    clearCache(tmpDir);
    assert.equal(getCached('clear-test', tmpDir), null);
  });
});

// ─────────────────────────────────────────────────────────────
// getCacheStats
// ─────────────────────────────────────────────────────────────

describe('getCacheStats', () => {
  it('returns stats for a project', () => {
    setCached('stats-test-1', 'data1', tmpDir);
    setCached('stats-test-2', 'data2', tmpDir);

    const stats = getCacheStats(tmpDir);
    assert.ok('enabled' in stats);
    assert.ok('location' in stats);
    assert.ok('entries' in stats);
    assert.ok('size' in stats);
    assert.ok('sizeFormatted' in stats);
    assert.ok('maxSize' in stats);
    assert.ok(stats.entries >= 2, 'should have at least 2 entries');
    assert.ok(stats.size > 0, 'should have positive size');
  });

  it('returns global stats when projectRoot is null', () => {
    const stats = getCacheStats(null);
    assert.ok('enabled' in stats);
    assert.ok('location' in stats);
    assert.ok('totalEntries' in stats || 'projects' in stats);
  });

  it('sizeFormatted is human-readable', () => {
    setCached('format-test', 'x'.repeat(100), tmpDir);
    const stats = getCacheStats(tmpDir);
    assert.ok(typeof stats.sizeFormatted === 'string');
    assert.ok(stats.sizeFormatted.length > 0);
  });
});
