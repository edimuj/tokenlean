#!/usr/bin/env node

/**
 * tl-impact - Analyze the blast radius of changing a file
 *
 * Shows which files import/depend on the target file, helping you
 * understand the impact of changes before you make them.
 *
 * Usage: tl-impact <file> [--depth N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-impact',
    desc: 'Blast radius - what depends on this file',
    when: 'before-modify',
    example: 'tl-impact src/utils.ts'
  }));
  process.exit(0);
}

import { existsSync, readFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, categorizeFile } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep, listFilesWithRipgrep } from '../src/traverse.mjs';

ensureRipgrep();

const HELP = `
tl-impact - Analyze the blast radius of changing a file

Usage: tl-impact <file> [options]

Options:
  --depth N, -d N       Include transitive importers up to N levels (default: 1)
${COMMON_OPTIONS_HELP}

Examples:
  tl-impact src/utils/api.ts         # Direct importers only
  tl-impact src/utils/api.ts -d 2    # Include files that import the importers
  tl-impact src/utils/api.ts -j      # JSON output

Output shows:
  • Which files import the target
  • Token cost of each importer
  • Line number of the import
  • Categorized by source/test/story/mock
`;

// ─────────────────────────────────────────────────────────────
// Import Detection — single-pass reverse import map
// ─────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs']);
const RESOLVE_SUFFIXES = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '/index.js', '/index.ts', '/index.tsx', '/index.mjs'];

/**
 * Resolve an import specifier to an absolute path.
 * Returns null if the specifier is a bare module (npm package) or unresolvable.
 */
function resolveImportSpecifier(spec, importerDir) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;

  const base = resolve(importerDir, spec);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a reverse import map for the entire project in a single pass.
 * Returns { [targetAbsPath]: [ { importer, line, importType, statement }, ... ] }
 */
function buildReverseImportMap(projectRoot) {
  const files = listFilesWithRipgrep(projectRoot);
  if (!files) return Object.create(null);

  // Filter to code files only
  const codeFiles = [];
  for (const relPath of files) {
    const ext = extname(relPath).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      codeFiles.push(join(projectRoot, relPath));
    }
  }

  const reverseMap = Object.create(null);

  for (const filePath of codeFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const importerDir = dirname(filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const importMatches = [
        ...line.matchAll(/from\s+['"]([^'"]+)['"]/g),
        ...line.matchAll(/import\s+['"]([^'"]+)['"]/g),
        ...line.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...line.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];

      for (const match of importMatches) {
        const resolved = resolveImportSpecifier(match[1], importerDir);
        if (!resolved) continue;

        let importType = 'import';
        if (line.includes('require(')) importType = 'require';
        if (line.includes('import(')) importType = 'dynamic import';
        if (line.match(/import\s+type/)) importType = 'type import';

        if (!reverseMap[resolved]) reverseMap[resolved] = [];
        reverseMap[resolved].push({
          importer: filePath,
          line: i + 1,
          importType,
          statement: line.trim().substring(0, 80)
        });
      }
    }
  }

  return reverseMap;
}

/**
 * Look up direct importers from the reverse map.
 * Deduplicates by importer path (first match wins), skips self-imports.
 */
function findDirectImporters(filePath, reverseMap) {
  const importers = new Map();
  const entries = reverseMap[filePath];
  if (!entries) return importers;

  for (const entry of entries) {
    if (entry.importer === filePath) continue;
    if (importers.has(entry.importer)) continue;
    importers.set(entry.importer, {
      line: entry.line,
      importType: entry.importType,
      statement: entry.statement
    });
  }

  return importers;
}

function findTransitiveImporters(directImporters, targetPath, reverseMap, maxDepth = 2) {
  const allImporters = new Map(directImporters);
  const processed = new Set([targetPath]);
  let currentLevel = [...directImporters.keys()];

  for (let depth = 1; depth < maxDepth && currentLevel.length > 0; depth++) {
    const nextLevel = [];

    for (const filePath of currentLevel) {
      if (processed.has(filePath)) continue;
      processed.add(filePath);

      const importers = findDirectImporters(filePath, reverseMap);

      for (const [path, info] of importers) {
        if (!allImporters.has(path) && !processed.has(path)) {
          allImporters.set(path, { ...info, depth, via: basename(filePath) });
          nextLevel.push(path);
        }
      }
    }

    currentLevel = nextLevel;
  }

  return allImporters;
}


// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────

function buildResults(importers, projectRoot) {
  const categories = { source: [], test: [], story: [], mock: [] };

  for (const [path, info] of importers) {
    let category = categorizeFile(path, projectRoot);
    if (!categories[category]) category = 'source';
    const tokens = estimateTokens(readFileSync(path, 'utf-8'));
    categories[category].push({
      path,
      relPath: relative(projectRoot, path),
      tokens,
      ...info
    });
  }

  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => {
      if ((a.depth || 0) !== (b.depth || 0)) return (a.depth || 0) - (b.depth || 0);
      return a.path.localeCompare(b.path);
    });
  }

  return categories;
}

function printCategory(out, title, files, emoji) {
  if (files.length === 0) return { totalFiles: 0, totalTokens: 0 };

  out.add(`${emoji} ${title} (${files.length}):`);

  let totalTokens = 0;
  for (const file of files) {
    totalTokens += file.tokens;
    let line = `   ${file.relPath} (~${formatTokens(file.tokens)}) L${file.line}`;
    if (file.depth && file.depth > 0) {
      line += ` [via ${file.via}]`;
    }
    out.add(line);
  }
  out.blank();

  return { totalFiles: files.length, totalTokens };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let maxDepth = 1;
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--depth' || arg === '-d') && options.remaining[i + 1]) {
    maxDepth = parseInt(options.remaining[i + 1], 10);
    i++;
  }
}

const filePath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const resolvedPath = resolve(filePath);

if (!existsSync(resolvedPath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, resolvedPath);
const targetTokens = estimateTokens(readFileSync(resolvedPath, 'utf-8'));

const out = createOutput(options);

out.header(`\n🎯 Impact analysis: ${relPath}`);
out.header(`   Target file: ~${formatTokens(targetTokens)} tokens`);

if (maxDepth > 1) {
  out.header(`   Analyzing ${maxDepth} levels of dependencies...`);
}
out.blank();

const reverseMap = withCache(
  { op: 'reverse-import-map' },
  () => buildReverseImportMap(projectRoot),
  { projectRoot }
);

const directImporters = findDirectImporters(resolvedPath, reverseMap);
let importers = directImporters;
if (maxDepth > 1) {
  importers = findTransitiveImporters(directImporters, resolvedPath, reverseMap, maxDepth);
}

// Set JSON data
out.setData('target', relPath);
out.setData('targetTokens', targetTokens);
out.setData('maxDepth', maxDepth);

if (importers.size === 0) {
  out.add('✨ No importers found - this file has no dependents!');
  out.blank();
  out.add('This could mean:');
  out.add('  • It\'s an entry point (main, index)');
  out.add('  • It\'s a standalone script');
  out.add('  • It\'s unused and can be safely deleted');
  out.blank();

  out.setData('importers', []);
  out.setData('totalFiles', 0);
  out.setData('totalTokens', 0);

  out.print();
  process.exit(0);
}

const categories = buildResults(importers, projectRoot);

// Set JSON data
out.setData('importers', categories);

let totalFiles = 0;
let totalTokens = 0;

const s = printCategory(out, 'Source files', categories.source, '📦');
totalFiles += s.totalFiles; totalTokens += s.totalTokens;

const t = printCategory(out, 'Test files', categories.test, '🧪');
totalFiles += t.totalFiles; totalTokens += t.totalTokens;

const st = printCategory(out, 'Stories', categories.story, '📖');
totalFiles += st.totalFiles; totalTokens += st.totalTokens;

const m = printCategory(out, 'Mocks/Fixtures', categories.mock, '🎭');
totalFiles += m.totalFiles; totalTokens += m.totalTokens;

out.setData('totalFiles', totalFiles);
out.setData('totalTokens', totalTokens);

out.stats('─'.repeat(50));
out.stats(`📊 Total impact: ${totalFiles} files, ~${formatTokens(totalTokens)} tokens`);
out.stats(`   Changing ${basename(resolvedPath)} may affect all listed files.`);
out.blank();

out.print();
