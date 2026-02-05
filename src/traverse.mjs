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
import { spawnSync } from 'child_process';
import { getSkipDirs, getSkipExtensions, getImportantDirs, getImportantFiles, shouldSkip } from './project.mjs';
import { rgCommand } from './shell.mjs';

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
  _rgAvailable = rgCommand(['--version']) !== null;
  return _rgAvailable;
}

/**
 * Ensure ripgrep is available, exit with a friendly error if not.
 */
export function ensureRipgrep() {
  if (!isRipgrepAvailable()) {
    console.error('Error: ripgrep (rg) is required but not found.');
    console.error('Install: brew install ripgrep  (or see https://github.com/BurntSushi/ripgrep#installation)');
    process.exit(1);
  }
}

/**
 * Get all files using ripgrep (much faster than fs.readdir recursion)
 * Returns array of relative paths
 */
export function listFilesWithRipgrep(dir, options = {}) {
  const { maxDepth } = options;

  const args = ['--files', '--hidden'];

  // Add depth limit if specified
  if (maxDepth !== undefined) {
    args.push('--max-depth', String(maxDepth));
  }

  // Add ignore patterns for common skip dirs
  const skipDirs = getSkipDirs();
  for (const skip of skipDirs) {
    args.push('--glob', `!${skip}`);
  }

  // Add ignore patterns for skip extensions
  const skipExts = getSkipExtensions();
  for (const ext of skipExts) {
    args.push('--glob', `!*${ext}`);
  }

  const output = rgCommand(args, { cwd: dir, maxBuffer: 50 * 1024 * 1024 });
  if (output === null || output === '') return null;

  return output.split('\n').filter(Boolean);
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

// ─────────────────────────────────────────────────────────────
// Batch Ripgrep — single rg process for multiple patterns
// ─────────────────────────────────────────────────────────────

/**
 * Search for multiple patterns in a single rg invocation.
 *
 * Uses `rg --json` with multiple `-e` flags and attributes each match
 * back to its originating pattern via `submatches[].match.text`.
 *
 * @param {string[]} patterns   Regex patterns to search for
 * @param {string}   searchPath Directory (or file) to search
 * @param {Object}   options
 * @param {string}   [options.cwd]           Working directory for rg
 * @param {string[]} [options.globs]         Glob filters (--glob)
 * @param {string[]} [options.types]         Type filters (--type)
 * @param {boolean}  [options.wordBoundary=false] Use -w flag
 * @param {boolean}  [options.filesOnly=false]    Return only file paths (like -l)
 * @param {number}   [options.maxBuffer=10*1024*1024]
 * @returns {Object.<string, Array<{file: string, line?: number, content?: string}>>}
 *   Plain object keyed by pattern → array of matches.
 */
export function batchRipgrep(patterns, searchPath, options = {}) {
  const {
    cwd,
    globs = [],
    types = [],
    wordBoundary = false,
    filesOnly = false,
    maxBuffer = 10 * 1024 * 1024
  } = options;

  // Initialise result with all keys so callers can safely iterate
  const result = Object.create(null);
  for (const p of patterns) result[p] = [];

  if (patterns.length === 0) return result;

  // Build args
  const args = ['--json', '--no-heading'];
  if (wordBoundary) args.push('-w');
  for (const g of globs) { args.push('--glob', g); }
  for (const t of types) { args.push('--type', t); }
  for (const p of patterns) { args.push('-e', p); }
  args.push('--', searchPath);

  const spawnOpts = { encoding: 'utf-8', maxBuffer };
  if (cwd) spawnOpts.cwd = cwd;

  const proc = spawnSync('rg', args, spawnOpts);

  // Exit 1 = no matches, exit 2+ = error
  if (proc.status >= 2 || proc.error) {
    if (proc.stderr) process.stderr.write(proc.stderr);
    return result;
  }

  if (!proc.stdout) return result;

  // Pre-compile patterns for attribution
  let compiled;
  if (wordBoundary) {
    // In word-boundary mode patterns are plain words — exact match is enough
    compiled = null;
  } else {
    compiled = patterns.map(p => {
      try { return new RegExp(p); } catch { return null; }
    });
  }

  // Dedupe sets for filesOnly mode
  const seenFiles = filesOnly ? Object.create(null) : null;
  if (filesOnly) {
    for (const p of patterns) seenFiles[p] = new Set();
  }

  const lines = proc.stdout.split('\n');
  for (const raw of lines) {
    if (!raw) continue;

    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    if (record.type !== 'match') continue;

    const data = record.data;
    const file = data.path ? data.path.text : '';
    const lineNum = data.line_number;
    const lineText = data.lines ? data.lines.text.replace(/\n$/, '') : '';

    // Attribute: which pattern(s) produced this match?
    const matchedPatterns = new Set();

    if (data.submatches && data.submatches.length > 0) {
      for (const sm of data.submatches) {
        const text = sm.match ? sm.match.text : '';
        if (wordBoundary) {
          // Exact word comparison
          for (const p of patterns) {
            if (text === p) matchedPatterns.add(p);
          }
        } else {
          for (let i = 0; i < patterns.length; i++) {
            const re = compiled[i];
            if (re && re.test(text)) {
              matchedPatterns.add(patterns[i]);
            }
          }
        }
      }
    }

    // Fallback: test full line against each pattern
    if (matchedPatterns.size === 0) {
      if (wordBoundary) {
        for (const p of patterns) {
          if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lineText)) {
            matchedPatterns.add(p);
          }
        }
      } else {
        for (let i = 0; i < patterns.length; i++) {
          const re = compiled[i];
          if (re && re.test(lineText)) {
            matchedPatterns.add(patterns[i]);
          }
        }
      }
    }

    for (const p of matchedPatterns) {
      if (filesOnly) {
        if (!seenFiles[p].has(file)) {
          seenFiles[p].add(file);
          result[p].push({ file });
        }
      } else {
        result[p].push({ file, line: lineNum, content: lineText });
      }
    }
  }

  return result;
}
