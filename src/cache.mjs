/**
 * Shared caching system for tokenlean CLI tools
 *
 * Provides disk-based caching with git-based invalidation for expensive
 * ripgrep operations. Falls back to TTL-based invalidation when not in a git repo.
 *
 * Cache storage: ~/.tokenlean/cache/<project-hash>/<key-hash>.json
 *
 * Usage:
 *   // High-level API (preferred)
 *   const result = withCache(
 *     { op: 'rg-search', pattern: 'useState', glob: '*.tsx' },
 *     () => execSync('rg ...'),
 *     { projectRoot }
 *   );
 *
 *   // Low-level API
 *   let data = getCached(key, projectRoot);
 *   if (!data) {
 *     data = computeExpensiveResult();
 *     setCached(key, data, projectRoot);
 *   }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, readlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { gitCommand } from './shell.mjs';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const DEFAULT_CACHE_DIR = join(homedir(), '.tokenlean', 'cache');
const DEFAULT_TTL = 300; // 5 minutes fallback for non-git repos
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100MB

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/**
 * Get cache configuration from config system
 */
export function getCacheConfig() {
  const { config } = loadConfig();
  const cacheConfig = config.cache || {};

  return {
    enabled: cacheConfig.enabled !== false && process.env.TOKENLEAN_CACHE !== '0',
    ttl: cacheConfig.ttl ?? DEFAULT_TTL,
    maxSize: parseSize(cacheConfig.maxSize) ?? DEFAULT_MAX_SIZE,
    location: cacheConfig.location ?? DEFAULT_CACHE_DIR
  };
}

/**
 * Parse size string like '100MB' to bytes
 */
function parseSize(size) {
  if (typeof size === 'number') return size;
  if (typeof size !== 'string') return null;

  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return null;

  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  const multipliers = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024
  };

  return Math.floor(num * multipliers[unit]);
}

// ─────────────────────────────────────────────────────────────
// Hashing Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Create a short hash from any value
 */
function hash(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Get hash of project root path for cache directory
 */
function getProjectHash(projectRoot) {
  return hash(projectRoot);
}

/**
 * Get cache key hash from operation key object
 */
function getCacheKeyHash(key) {
  return hash(key);
}

// ─────────────────────────────────────────────────────────────
// Git State Detection
// ─────────────────────────────────────────────────────────────

function resolveGitDir(dir) {
  let current = resolve(dir);
  while (true) {
    const marker = join(current, '.git');
    if (existsSync(marker)) {
      try {
        if (lstatSync(marker).isDirectory()) return marker;
        const content = readFileSync(marker, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/i);
        if (!match) throw new Error(`Invalid gitdir marker: ${marker}`);
        return resolve(current, match[1]);
      } catch (err) {
        throw new Error(`Cannot resolve git directory from ${marker}: ${err.message}`);
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveCommonGitDir(gitDir) {
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return resolve(gitDir, common);
  } catch {
    return gitDir;
  }
}

/**
 * Resolve the HEAD commit SHA by reading git's internal files directly.
 * Returns null if not a git repo or cannot determine HEAD.
 * Cost: 1–2 synchronous file reads (no git spawn).
 */
function readHeadSnapshot(dir) {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return null;

  try {
    const headContent = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (headContent.startsWith('ref: ')) {
      // Symbolic ref — follow to the actual ref file
      const refPath = headContent.slice(5); // e.g. "refs/heads/main"
      const commonDir = resolveCommonGitDir(gitDir);
      for (const baseDir of new Set([gitDir, commonDir])) {
        const refFile = join(baseDir, refPath);
        if (existsSync(refFile)) {
          return readFileSync(refFile, 'utf8').trim();
        }
      }
      // Try packed-refs fallback
      const packedRefs = join(commonDir, 'packed-refs');
      if (existsSync(packedRefs)) {
        const packed = readFileSync(packedRefs, 'utf8');
        for (const line of packed.split('\n')) {
          if (line.endsWith(` ${refPath}`)) {
            return line.slice(0, 40);
          }
        }
      }
      return null;
    }
    // Detached HEAD — content is the SHA directly
    return headContent.length >= 40 ? headContent : null;
  } catch {
    return null;
  }
}

function parsePorcelainStatus(raw) {
  const records = raw.split('\0');
  const entries = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = status.includes('R') || status.includes('C');
    const originalPath = renamed ? (records[++i] || null) : null;
    entries.push({ status, path, originalPath });
  }

  return entries.sort((a, b) =>
    a.path.localeCompare(b.path) || a.status.localeCompare(b.status)
  );
}

function updateFingerprint(hash, label, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(`${label}:${data.length}:`);
  hash.update(data);
  hash.update('\0');
}

function fingerprintWorktree(projectRoot, entries) {
  const digest = createHash('sha256');
  updateFingerprint(digest, 'version', 'worktree-v1');

  for (const entry of entries) {
    updateFingerprint(digest, 'status', entry.status);
    updateFingerprint(digest, 'path', entry.path);
    if (entry.originalPath) updateFingerprint(digest, 'originalPath', entry.originalPath);

    const fullPath = resolve(projectRoot, entry.path);
    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        updateFingerprint(digest, 'symlink', readlinkSync(fullPath));
      } else if (stat.isFile()) {
        // Hash actual dirty/untracked content. Filename-only status snapshots let
        // a second edit to an already-dirty file reuse stale source analysis.
        updateFingerprint(digest, 'content', readFileSync(fullPath));
      } else if (stat.isDirectory()) {
        // Usually a dirty submodule. Its HEAD captures the source state without
        // recursively hashing a potentially large nested worktree.
        const submoduleHead = gitCommand(['rev-parse', 'HEAD'], { cwd: fullPath });
        updateFingerprint(digest, 'directory', submoduleHead || `${stat.size}:${stat.mtimeMs}`);
      } else {
        updateFingerprint(digest, 'other', `${stat.mode}:${stat.size}:${stat.mtimeMs}`);
      }
    } catch (err) {
      // Deletions are part of the state too; the status/path plus this marker is
      // stable until that deleted path changes state again.
      updateFingerprint(digest, 'missing', err.code || err.message);
    }
  }

  return digest.digest('hex');
}

/**
 * Check if directory is a git repository
 */
function isGitRepo(dir) {
  return gitCommand(['rev-parse', '--git-dir'], { cwd: dir }) !== null;
}

/**
 * Get current git state (HEAD commit + dirty file content fingerprint)
 * Returns null if not in a git repo.
 */
export function getGitState(projectRoot) {
  try {
    const gitDir = resolveGitDir(projectRoot);
    if (!gitDir) return null;
    const headSnapshot = readHeadSnapshot(projectRoot);
    if (headSnapshot === null && !isGitRepo(projectRoot)) {
      return { head: null, dirtyFiles: [], worktreeFingerprint: null, invalid: true };
    }

    // Unborn repositories have no HEAD commit but still need content-based cache
    // invalidation for their untracked source files.
    const head = headSnapshot ?? gitCommand(['rev-parse', 'HEAD'], { cwd: projectRoot }) ?? 'UNBORN';
    const status = gitCommand(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: projectRoot, trim: false }
    );
    if (status === null) {
      return { head, dirtyFiles: [], worktreeFingerprint: null, invalid: true };
    }

    const entries = parsePorcelainStatus(status);
    const dirtyFiles = entries.flatMap(entry =>
      entry.originalPath ? [entry.path, entry.originalPath] : [entry.path]
    ).sort();

    return {
      head,
      dirtyFiles,
      worktreeFingerprint: fingerprintWorktree(projectRoot, entries)
    };
  } catch {
    // A repository marker was present, so this is a state-evaluation failure,
    // not a non-git directory. Callers must bypass the cache rather than fall
    // back to TTL and risk serving stale source-derived data.
    return { head: null, dirtyFiles: [], worktreeFingerprint: null, invalid: true };
  }
}

/**
 * Check if git state matches stored state
 */
function gitStateMatches(stored, current) {
  if (!stored || !current) return false;
  if (stored.invalid || current.invalid) return false;
  if (stored.head !== current.head) return false;
  if (!stored.worktreeFingerprint || !current.worktreeFingerprint) return false;
  if (stored.worktreeFingerprint !== current.worktreeFingerprint) return false;
  if (stored.dirtyFiles.length !== current.dirtyFiles.length) return false;

  for (let i = 0; i < stored.dirtyFiles.length; i++) {
    if (stored.dirtyFiles[i] !== current.dirtyFiles[i]) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Cache Directory Management
// ─────────────────────────────────────────────────────────────

/**
 * Get or create cache directory for a project
 */
export function getCacheDir(projectRoot) {
  const config = getCacheConfig();
  const projectHash = getProjectHash(projectRoot);
  const cacheDir = join(config.location, projectHash);

  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  }

  return cacheDir;
}

/**
 * Get cache file path for a key
 */
function getCacheFilePath(key, projectRoot) {
  const cacheDir = getCacheDir(projectRoot);
  const keyHash = getCacheKeyHash(key);
  return join(cacheDir, `${keyHash}.json`);
}

// ─────────────────────────────────────────────────────────────
// Cache Size Management
// ─────────────────────────────────────────────────────────────

// In-process size index: cacheDir → total bytes written in this process.
// Acts as a fast "is the cache definitely under the limit?" gate.
// On a miss (cold start) we fall back to a full stat sweep to populate it.
const _cacheSizeIndex = new Map();

/**
 * Get total size of cache directory in bytes, populating the size index.
 */
function getCacheDirSize(cacheDir) {
  if (!existsSync(cacheDir)) return 0;

  let total = 0;
  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      try {
        const stat = statSync(join(cacheDir, file));
        if (stat.isFile()) {
          total += stat.size;
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory read error */ }

  return total;
}

/**
 * Get all cache entries with metadata
 */
function getCacheEntries(cacheDir) {
  if (!existsSync(cacheDir)) return [];

  const entries = [];
  try {
    const files = readdirSync(cacheDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = join(cacheDir, file);
        const stat = statSync(filePath);
        entries.push({
          path: filePath,
          size: stat.size,
          mtime: stat.mtime.getTime()
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory read error */ }

  return entries;
}

/**
 * Remove oldest cache entries until under maxSize.
 * Uses an in-process size counter to skip the full stat sweep when the cache
 * is comfortably under the limit — making the common case O(1) instead of O(N).
 */
function enforceMaxSize(projectRoot, writtenBytes) {
  const config = getCacheConfig();
  const cacheDir = getCacheDir(projectRoot);

  // Update the incremental counter with the bytes just written.
  const prev = _cacheSizeIndex.get(cacheDir);
  if (prev === undefined) {
    // Cold start: seed from disk so the counter is accurate.
    _cacheSizeIndex.set(cacheDir, getCacheDirSize(cacheDir));
  } else {
    _cacheSizeIndex.set(cacheDir, prev + writtenBytes);
  }

  // Fast path: counter says we're under the limit — skip the full sweep.
  if (_cacheSizeIndex.get(cacheDir) <= config.maxSize) return;

  // Slow path: do a precise stat sweep and evict oldest entries.
  const entries = getCacheEntries(cacheDir);
  let totalSize = entries.reduce((sum, e) => sum + e.size, 0);

  if (totalSize <= config.maxSize) {
    // Counter was stale (e.g. another process deleted files); resync and bail.
    _cacheSizeIndex.set(cacheDir, totalSize);
    return;
  }

  // Sort by modification time (oldest first)
  entries.sort((a, b) => a.mtime - b.mtime);

  // Remove oldest entries until under limit
  for (const entry of entries) {
    if (totalSize <= config.maxSize) break;

    try {
      unlinkSync(entry.path);
      totalSize -= entry.size;
    } catch { /* skip if can't delete */ }
  }

  // Resync counter after eviction
  _cacheSizeIndex.set(cacheDir, totalSize);
}

// ─────────────────────────────────────────────────────────────
// Low-Level Cache API
// ─────────────────────────────────────────────────────────────

/**
 * Read from cache if valid
 * Returns cached data or null if cache miss/invalid
 */
export function getCached(key, projectRoot, options = {}) {
  const { headOnly = false } = options;
  const config = getCacheConfig();
  if (!config.enabled) return null;

  const filePath = getCacheFilePath(key, projectRoot);
  if (!existsSync(filePath)) return null;

  try {
    const cached = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Git-based invalidation
    const currentGitState = getGitState(projectRoot);
    if (currentGitState) {
      if (currentGitState.invalid) return null;
      if (headOnly) {
        // Only compare HEAD commit — ignore dirty files
        if (!cached.gitState || cached.gitState.head !== currentGitState.head) {
          return null;
        }
      } else if (!gitStateMatches(cached.gitState, currentGitState)) {
        return null;
      }
    } else {
      // Fall back to TTL-based invalidation
      const age = (Date.now() - cached.timestamp) / 1000;
      if (age > config.ttl) {
        return null;
      }
    }

    return cached.data;
  } catch {
    return null;
  }
}

/**
 * Write to cache with git state
 */
export function setCached(key, data, projectRoot) {
  const config = getCacheConfig();
  if (!config.enabled) return;

  const filePath = getCacheFilePath(key, projectRoot);
  const gitState = getGitState(projectRoot);

  const cacheEntry = {
    data,
    gitState,
    timestamp: Date.now(),
    key: typeof key === 'string' ? key : JSON.stringify(key)
  };

  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

    const serialized = JSON.stringify(cacheEntry);
    writeFileSync(filePath, serialized);

    // Enforce size limit — pass the bytes just written for O(1) common path
    enforceMaxSize(projectRoot, Buffer.byteLength(serialized));
  } catch {
    // Silently fail - caching is best-effort
  }
}

// ─────────────────────────────────────────────────────────────
// High-Level Cache API
// ─────────────────────────────────────────────────────────────

/**
 * Execute function with caching
 * Preferred API for caching expensive operations
 *
 * @param {Object|string} key - Cache key (operation + args)
 * @param {Function} fn - Function to execute if cache miss
 * @param {Object} options - Options including projectRoot
 * @returns {*} Cached or computed result
 */
export function withCache(key, fn, options = {}) {
  const { projectRoot = process.cwd(), headOnly } = options;

  // Check cache first
  const cached = getCached(key, projectRoot, { headOnly });
  if (cached !== null) {
    return cached;
  }

  // Execute function and cache result
  const result = fn();
  setCached(key, result, projectRoot);

  return result;
}

// ─────────────────────────────────────────────────────────────
// Cache Management Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Clear cache for a project or all projects
 * @param {string|null} projectRoot - Project to clear, or null for all
 */
export function clearCache(projectRoot = null) {
  const config = getCacheConfig();

  if (projectRoot) {
    // Clear single project cache
    const cacheDir = getCacheDir(projectRoot);
    if (existsSync(cacheDir)) {
      try {
        rmSync(cacheDir, { recursive: true });
      } catch { /* ignore errors */ }
    }
    _cacheSizeIndex.delete(cacheDir);
  } else {
    // Clear all caches
    if (existsSync(config.location)) {
      try {
        rmSync(config.location, { recursive: true });
      } catch { /* ignore errors */ }
    }
    _cacheSizeIndex.clear();
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(projectRoot = null) {
  const config = getCacheConfig();

  if (projectRoot) {
    // Stats for single project
    const cacheDir = getCacheDir(projectRoot);
    const entries = getCacheEntries(cacheDir);
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0);

    return {
      enabled: config.enabled,
      location: cacheDir,
      entries: entries.length,
      size: totalSize,
      sizeFormatted: formatSize(totalSize),
      maxSize: config.maxSize,
      maxSizeFormatted: formatSize(config.maxSize)
    };
  }

  // Stats for all projects
  if (!existsSync(config.location)) {
    return {
      enabled: config.enabled,
      location: config.location,
      projects: 0,
      totalEntries: 0,
      totalSize: 0,
      totalSizeFormatted: '0 B',
      maxSize: config.maxSize,
      maxSizeFormatted: formatSize(config.maxSize)
    };
  }

  let totalEntries = 0;
  let totalSize = 0;
  let projects = 0;

  try {
    const projectDirs = readdirSync(config.location);
    for (const dir of projectDirs) {
      const projectDir = join(config.location, dir);
      try {
        if (statSync(projectDir).isDirectory()) {
          projects++;
          const entries = getCacheEntries(projectDir);
          totalEntries += entries.length;
          totalSize += entries.reduce((sum, e) => sum + e.size, 0);
        }
      } catch { /* skip */ }
    }
  } catch { /* location doesn't exist yet */ }

  return {
    enabled: config.enabled,
    location: config.location,
    projects,
    totalEntries,
    totalSize,
    totalSizeFormatted: formatSize(totalSize),
    maxSize: config.maxSize,
    maxSizeFormatted: formatSize(config.maxSize)
  };
}

/**
 * Format bytes to human readable
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
