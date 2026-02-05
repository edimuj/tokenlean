/**
 * Fast file system traversal for tokenlean CLI tools
 *
 * Optimized for performance:
 * - Uses fs.stat for file sizes (no content reading)
 * - Single-pass traversal (no redundant walks)
 * - Optional ripgrep for blazing fast file discovery
 * - Parallel async operations where beneficial
 *
 * Token estimation: ~4 chars per token (same as reading content)
 */

import { readdirSync, statSync, lstatSync, existsSync, realpathSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { execSync } from 'child_process';
import { getSkipDirs, getSkipExtensions, getImportantDirs, getImportantFiles, shouldSkip } from './project.mjs';

// ─────────────────────────────────────────────────────────────
// Token Estimation from File Size
// ─────────────────────────────────────────────────────────────

/**
 * Estimate tokens from file size (bytes)
 * ~4 bytes per token on average for code files
 */
export function estimateTokensFromSize(bytes) {
  return Math.ceil(bytes / 4);
}

// ─────────────────────────────────────────────────────────────
// Fast File Discovery with Ripgrep
// ─────────────────────────────────────────────────────────────

/**
 * Check if ripgrep is available
 */
let _rgAvailable = null;
export function isRipgrepAvailable() {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    execSync('rg --version', { stdio: 'ignore' });
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/**
 * Get all files using ripgrep (much faster than fs.readdir recursion)
 * Returns array of relative paths
 */
export function listFilesWithRipgrep(dir, options = {}) {
  const { maxDepth } = options;

  try {
    let cmd = `rg --files --hidden`;

    // Add depth limit if specified
    if (maxDepth !== undefined) {
      cmd += ` --max-depth ${maxDepth}`;
    }

    // Add ignore patterns for common skip dirs
    const skipDirs = getSkipDirs();
    for (const skip of skipDirs) {
      cmd += ` --glob "!${skip}"`;
    }

    // Add ignore patterns for skip extensions
    const skipExts = getSkipExtensions();
    for (const ext of skipExts) {
      cmd += ` --glob "!*${ext}"`;
    }

    const output = execSync(cmd, {
      cwd: dir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
      stdio: ['pipe', 'pipe', 'ignore'] // Ignore stderr
    });

    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null; // Fall back to manual traversal
  }
}

// ─────────────────────────────────────────────────────────────
// Single-Pass Directory Traversal
// ─────────────────────────────────────────────────────────────

/**
 * File info returned by traversal
 * @typedef {Object} FileInfo
 * @property {string} path - Full path
 * @property {string} name - File name
 * @property {number} size - Size in bytes
 * @property {number} tokens - Estimated tokens
 * @property {boolean} important - Is important file
 */

/**
 * Directory info returned by traversal
 * @typedef {Object} DirInfo
 * @property {string} path - Full path
 * @property {string} name - Directory name
 * @property {number} totalSize - Total size of all files
 * @property {number} totalTokens - Total estimated tokens
 * @property {number} fileCount - Number of files
 * @property {boolean} important - Is important directory
 * @property {Array<DirInfo|FileInfo>} children - Child entries
 */

/**
 * Traverse a directory tree in a single pass
 * Collects all stats without redundant walks
 *
 * @param {string} rootDir - Directory to traverse
 * @param {Object} options - Options
 * @param {number} [options.maxDepth=Infinity] - Maximum depth
 * @param {boolean} [options.includeFiles=true] - Include file info
 * @param {boolean} [options.includeStats=true] - Include size/token stats
 * @returns {DirInfo} Root directory info with all children
 */
export function traverseDirectory(rootDir, options = {}) {
  const {
    maxDepth = Infinity,
    includeFiles = true,
    includeStats = true
  } = options;

  const skipDirs = getSkipDirs();
  const skipExts = getSkipExtensions();
  const importantDirs = getImportantDirs();
  const importantFiles = getImportantFiles();

  const visitedDirs = new Set();

  function traverse(dirPath, depth) {
    const name = basename(dirPath);
    const isImportant = importantDirs.has(name);

    const result = {
      path: dirPath,
      name,
      type: 'dir',
      important: isImportant,
      totalSize: 0,
      totalTokens: 0,
      fileCount: 0,
      children: []
    };

    if (depth > maxDepth) {
      return result;
    }

    // Guard against symlink loops by tracking real paths
    try {
      const realPath = realpathSync(dirPath);
      if (visitedDirs.has(realPath)) return result;
      visitedDirs.add(realPath);
    } catch {
      return result; // Broken symlink
    }

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return result; // Permission denied
    }

    // Sort: directories first, important items first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      const aImp = importantDirs.has(a.name) || importantFiles.has(a.name);
      const bImp = importantDirs.has(b.name) || importantFiles.has(b.name);
      if (aImp !== bImp) return aImp ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      // Skip hidden (except .claude)
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;

      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue; // Skip symlinked dirs

        const childDir = traverse(fullPath, depth + 1);
        result.children.push(childDir);
        result.totalSize += childDir.totalSize;
        result.totalTokens += childDir.totalTokens;
        result.fileCount += childDir.fileCount;
      } else {
        // Check skip extensions
        const ext = extname(entry.name).toLowerCase();
        if (skipExts.has(ext)) continue;
        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) continue;

        if (includeStats) {
          try {
            const stat = statSync(fullPath);
            const size = stat.size;
            const tokens = estimateTokensFromSize(size);

            result.totalSize += size;
            result.totalTokens += tokens;
            result.fileCount++;

            if (includeFiles) {
              result.children.push({
                path: fullPath,
                name: entry.name,
                type: 'file',
                important: importantFiles.has(entry.name),
                size,
                tokens
              });
            }
          } catch {
            // Can't stat file (permissions, etc.)
            if (includeFiles) {
              result.children.push({
                path: fullPath,
                name: entry.name,
                type: 'file',
                important: importantFiles.has(entry.name),
                binary: true
              });
            }
          }
        } else if (includeFiles) {
          result.fileCount++;
          result.children.push({
            path: fullPath,
            name: entry.name,
            type: 'file',
            important: importantFiles.has(entry.name)
          });
        }
      }
    }

    return result;
  }

  return traverse(rootDir, 0);
}

// ─────────────────────────────────────────────────────────────
// Flat File List (for tools that just need files)
// ─────────────────────────────────────────────────────────────

/**
 * Get flat list of all files with stats
 * Uses ripgrep if available, falls back to manual traversal
 *
 * @param {string} dir - Directory to scan
 * @param {Object} options - Options
 * @returns {Array<FileInfo>} Array of file info
 */
export function listFiles(dir, options = {}) {
  const { useRipgrep = true } = options;

  // Try ripgrep first (much faster)
  if (useRipgrep && isRipgrepAvailable()) {
    const files = listFilesWithRipgrep(dir, options);
    if (files) {
      const importantFiles = getImportantFiles();
      return files.map(relPath => {
        const fullPath = join(dir, relPath);
        const name = basename(relPath);
        try {
          const stat = statSync(fullPath);
          return {
            path: fullPath,
            relativePath: relPath,
            name,
            size: stat.size,
            tokens: estimateTokensFromSize(stat.size),
            important: importantFiles.has(name)
          };
        } catch {
          return {
            path: fullPath,
            relativePath: relPath,
            name,
            binary: true,
            important: importantFiles.has(name)
          };
        }
      });
    }
  }

  // Fallback: manual traversal
  const result = [];
  const tree = traverseDirectory(dir, { ...options, includeFiles: true });

  function flatten(node, basePath = '') {
    if (node.type === 'file') {
      result.push({
        ...node,
        relativePath: relative(dir, node.path)
      });
    } else if (node.children) {
      for (const child of node.children) {
        flatten(child);
      }
    }
  }

  flatten(tree);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Summary Stats (fastest - just counts)
// ─────────────────────────────────────────────────────────────

/**
 * Get quick summary stats for a directory
 * Optimized for speed - minimal file operations
 *
 * @param {string} dir - Directory to scan
 * @returns {{ fileCount: number, totalSize: number, totalTokens: number }}
 */
export function getDirectoryStats(dir) {
  // Use ripgrep to get file list quickly
  if (isRipgrepAvailable()) {
    const files = listFilesWithRipgrep(dir);
    if (files) {
      let totalSize = 0;
      let fileCount = 0;

      for (const relPath of files) {
        try {
          const stat = statSync(join(dir, relPath));
          totalSize += stat.size;
          fileCount++;
        } catch {
          // Skip unreadable files
        }
      }

      return {
        fileCount,
        totalSize,
        totalTokens: estimateTokensFromSize(totalSize)
      };
    }
  }

  // Fallback
  const tree = traverseDirectory(dir, { includeFiles: false });
  return {
    fileCount: tree.fileCount,
    totalSize: tree.totalSize,
    totalTokens: tree.totalTokens
  };
}
