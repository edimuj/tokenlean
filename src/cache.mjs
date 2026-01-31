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

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { loadConfig } from './config.mjs';

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

/**
 * Check if directory is a git repository
 */
function isGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git state (HEAD commit + dirty files)
 * Returns null if not in a git repo
 */
export function getGitState(projectRoot) {
  if (!isGitRepo(projectRoot)) {
    return null;
  }

  try {
    // Get HEAD commit
    const head = execSync('git rev-parse HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8'
    }).trim();

    // Get list of modified/untracked files (sorted for consistency)
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf-8'
    });

    const dirtyFiles = status
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.slice(3)) // Remove status prefix
      .sort();

    return {
      head,
      dirtyFiles
    };
  } catch {
    return null;
  }
}

/**
 * Check if git state matches stored state
 */
function gitStateMatches(stored, current) {
  if (!stored || !current) return false;
  if (stored.head !== current.head) return false;
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
    mkdirSync(cacheDir, { recursive: true });
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

/**
 * Get total size of cache directory in bytes
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
 * Remove oldest cache entries until under maxSize
 */
function enforceMaxSize(projectRoot) {
  const config = getCacheConfig();
  const cacheDir = getCacheDir(projectRoot);

  const entries = getCacheEntries(cacheDir);
  let totalSize = entries.reduce((sum, e) => sum + e.size, 0);

  if (totalSize <= config.maxSize) return;

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
}

// ─────────────────────────────────────────────────────────────
// Low-Level Cache API
// ─────────────────────────────────────────────────────────────

/**
 * Read from cache if valid
 * Returns cached data or null if cache miss/invalid
 */
export function getCached(key, projectRoot) {
  const config = getCacheConfig();
  if (!config.enabled) return null;

  const filePath = getCacheFilePath(key, projectRoot);
  if (!existsSync(filePath)) return null;

  try {
    const cached = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Git-based invalidation
    const currentGitState = getGitState(projectRoot);
    if (currentGitState) {
      // If we have git state, use it for validation
      if (!gitStateMatches(cached.gitState, currentGitState)) {
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
    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(filePath, JSON.stringify(cacheEntry));

    // Enforce size limit
    enforceMaxSize(projectRoot);
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
  const { projectRoot = process.cwd() } = options;

  // Check cache first
  const cached = getCached(key, projectRoot);
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
  } else {
    // Clear all caches
    if (existsSync(config.location)) {
      try {
        rmSync(config.location, { recursive: true });
      } catch { /* ignore errors */ }
    }
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
