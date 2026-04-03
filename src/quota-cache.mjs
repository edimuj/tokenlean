import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_STALE_MS = 5 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 12_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function defaultCacheDir() {
  return join(homedir(), '.tokenlean', 'quota-cache');
}

function normaliseProvider(provider) {
  return String(provider || 'unknown').toLowerCase();
}

async function readCacheEntry(cacheFile) {
  try {
    const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isFinite(raw.fetchedAt)) return null;
    if (!('quota' in raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function writeCacheEntry(cacheFile, quota, fetchedAt) {
  const payload = JSON.stringify({ fetchedAt, quota });
  await writeFile(cacheFile, payload);
}

function isFresh(entry, ttlMs, nowMs) {
  if (!entry) return false;
  return nowMs - entry.fetchedAt <= ttlMs;
}

function isUsableStale(entry, maxStaleMs, nowMs) {
  if (!entry) return false;
  return nowMs - entry.fetchedAt <= maxStaleMs;
}

async function clearStaleLock(lockFile, nowMs, lockStaleMs) {
  try {
    const info = await stat(lockFile);
    if (nowMs - info.mtimeMs > lockStaleMs) {
      await rm(lockFile, { force: true });
    }
  } catch {
    // Best-effort stale-lock cleanup.
  }
}

async function acquireLock(lockFile, options = {}) {
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS;
  const lockPollMs = Number.isFinite(options.lockPollMs) ? options.lockPollMs : DEFAULT_LOCK_POLL_MS;
  const deadline = Date.now() + lockTimeoutMs;

  while (Date.now() <= deadline) {
    try {
      await writeFile(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;
      await clearStaleLock(lockFile, Date.now(), lockStaleMs);
      await sleep(lockPollMs);
    }
  }

  return false;
}

async function releaseLock(lockFile) {
  await rm(lockFile, { force: true });
}

export async function getCachedQuota(provider, fetcher, options = {}) {
  if (typeof fetcher !== 'function') {
    throw new TypeError('fetcher must be a function');
  }

  const providerName = normaliseProvider(provider);
  const cacheDir = options.cacheDir || defaultCacheDir();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_CACHE_TTL_MS;
  const maxStaleMs = Number.isFinite(options.maxStaleMs) ? options.maxStaleMs : DEFAULT_MAX_STALE_MS;
  const cacheFile = join(cacheDir, `${providerName}.json`);
  const lockFile = join(cacheDir, `${providerName}.lock`);

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });

  const cached = await readCacheEntry(cacheFile);
  if (isFresh(cached, ttlMs, Date.now())) {
    return cached.quota;
  }

  const hasLock = await acquireLock(lockFile, options);
  if (!hasLock) {
    const fallback = await readCacheEntry(cacheFile);
    if (isFresh(fallback, ttlMs, Date.now()) || isUsableStale(fallback, maxStaleMs, Date.now())) {
      return fallback.quota;
    }
    return null;
  }

  try {
    const refreshed = await readCacheEntry(cacheFile);
    if (isFresh(refreshed, ttlMs, Date.now())) {
      return refreshed.quota;
    }

    let fetched = null;
    try {
      fetched = await fetcher();
    } catch {
      fetched = null;
    }

    if (fetched !== null && fetched !== undefined) {
      await writeCacheEntry(cacheFile, fetched, Date.now());
      return fetched;
    }

    const fallback = await readCacheEntry(cacheFile);
    if (isUsableStale(fallback, maxStaleMs, Date.now())) {
      return fallback.quota;
    }
    return null;
  } finally {
    await releaseLock(lockFile);
  }
}

