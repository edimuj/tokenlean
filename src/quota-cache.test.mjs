import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCachedQuota } from './quota-cache.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tl-quota-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getCachedQuota', () => {
  it('caches successful fetches within ttl', async () => {
    const cacheDir = makeTempDir();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { burst: { utilization: 12, resetsAt: '2026-04-03T12:00:00.000Z' } };
    };

    const first = await getCachedQuota('claude', fetcher, { cacheDir, ttlMs: 60_000 });
    const second = await getCachedQuota('claude', fetcher, { cacheDir, ttlMs: 60_000 });

    assert.equal(calls, 1);
    assert.deepEqual(second, first);
  });

  it('refreshes cache after ttl expiry', async () => {
    const cacheDir = makeTempDir();
    let calls = 0;
    const fetcher = async () => ({ value: ++calls });

    const first = await getCachedQuota('codex', fetcher, { cacheDir, ttlMs: 5 });
    await sleep(15);
    const second = await getCachedQuota('codex', fetcher, { cacheDir, ttlMs: 5 });

    assert.equal(calls, 2);
    assert.notEqual(first.value, second.value);
  });

  it('returns stale value when refresh fails', async () => {
    const cacheDir = makeTempDir();
    const seed = async () => ({ value: 42 });
    await getCachedQuota('claude', seed, { cacheDir, ttlMs: 5, maxStaleMs: 5_000 });
    await sleep(15);

    const failingFetcher = async () => null;
    const result = await getCachedQuota('claude', failingFetcher, { cacheDir, ttlMs: 5, maxStaleMs: 5_000 });
    assert.deepEqual(result, { value: 42 });
  });

  it('deduplicates concurrent refreshes with lock', async () => {
    const cacheDir = makeTempDir();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await sleep(120);
      return { value: 99 };
    };

    const [a, b, c] = await Promise.all([
      getCachedQuota('claude', fetcher, { cacheDir, ttlMs: 60_000 }),
      getCachedQuota('claude', fetcher, { cacheDir, ttlMs: 60_000 }),
      getCachedQuota('claude', fetcher, { cacheDir, ttlMs: 60_000 }),
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(a, { value: 99 });
    assert.deepEqual(b, { value: 99 });
    assert.deepEqual(c, { value: 99 });
  });
});

