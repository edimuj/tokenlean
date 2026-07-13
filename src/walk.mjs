/**
 * Shared source-file discovery + function indexing.
 *
 * Used by tl-dupes and tl-lookup so the file-walk and extraction loop live in
 * one place (not, ironically, duplicated).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { shouldSkip, isCodeFile, detectLanguage, findProjectRoot, getExternalContractFiles } from './project.mjs';
import { extractFunctions } from './dupes.mjs';

const TEST_MARKERS = ['.test.', '.spec.', '__tests__', '__mocks__'];
const MAX_CACHED_FILES = 20_000;

// Persistent MCP processes call lookup/dupes repeatedly. Keep extraction at
// file granularity so an edit reparses only that file instead of synchronously
// rereading every source file in the requested tree.
const functionFileCache = new Map();

function fileVersion(file) {
  const stat = statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function touchCacheEntry(file, entry) {
  // Map insertion order gives us a small, dependency-free LRU.
  functionFileCache.delete(file);
  functionFileCache.set(file, entry);
  while (functionFileCache.size > MAX_CACHED_FILES) {
    functionFileCache.delete(functionFileCache.keys().next().value);
  }
}

function indexFile(file, lang) {
  let version;
  try { version = fileVersion(file); } catch { return { functions: null, cacheHit: false }; }

  const cached = functionFileCache.get(file);
  if (cached?.version === version && cached.lang === lang) {
    touchCacheEntry(file, cached);
    return { functions: cached.functions, cacheHit: true };
  }

  let source;
  try { source = readFileSync(file, 'utf8'); } catch { return { functions: null, cacheHit: false }; }
  const functions = extractFunctions(source, lang);
  touchCacheEntry(file, { version, lang, functions });
  return { functions, cacheHit: false };
}

/** Clear the in-process function index. Primarily useful for tests/embedders. */
export function clearFunctionIndexCache() {
  functionFileCache.clear();
}

function isTestFile(name) {
  const lower = name.toLowerCase();
  return TEST_MARKERS.some(m => lower.includes(m));
}

/**
 * Collect code files under a path (recursively), honoring skip dirs and tests.
 * @returns {{files:string[], isDir:boolean, exists:boolean}}
 */
function collectSourceFiles(targetPath, opts = {}) {
  const { includeTests = false } = opts;
  let stat;
  try { stat = statSync(targetPath); } catch { return { files: [], isDir: false, exists: false }; }

  const files = [];
  if (stat.isDirectory()) {
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!shouldSkip(e.name, true)) walk(full);
        } else if (e.isFile()) {
          if (shouldSkip(e.name, false)) continue;
          if (!includeTests && isTestFile(e.name)) continue;
          if (isCodeFile(full)) files.push(full);
        }
      }
    };
    walk(targetPath);
  } else if (isCodeFile(targetPath)) {
    files.push(targetPath);
  }
  return { files, isDir: stat.isDirectory(), exists: true };
}

/**
 * Build a flat index of all functions under a path.
 *
 * External-contract files (e.g. src/opencode-plugin.js — copied verbatim into
 * another tool's config, so their duplicate helpers are by-design) are excluded
 * by default; pass `includeContracts: true` to index them anyway.
 * @returns {{functions:object[], fileCount:number, projectRoot:string, exists:boolean, cacheHits:number, indexedFiles:number}}
 */
export function buildFunctionIndex(targetPath, opts = {}) {
  const { includeContracts = false } = opts;
  const abs = resolve(targetPath);
  const { files, isDir, exists } = collectSourceFiles(abs, opts);
  const projectRoot = findProjectRoot(isDir ? abs : resolve(abs, '..'));
  const contracts = includeContracts ? null : getExternalContractFiles();

  const functions = [];
  let fileCount = 0;
  let cacheHits = 0;
  let indexedFiles = 0;
  for (const file of files) {
    const rel = relative(projectRoot, file) || file;
    if (contracts && contracts.has(rel)) continue;
    fileCount++;
    const lang = detectLanguage(file);
    const indexed = indexFile(file, lang);
    if (!indexed.functions) continue;
    if (indexed.cacheHit) cacheHits++;
    else indexedFiles++;
    for (const fn of indexed.functions) {
      functions.push({ ...fn, file: rel, lang });
    }
  }
  return { functions, fileCount, projectRoot, exists, cacheHits, indexedFiles };
}
