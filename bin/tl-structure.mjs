#!/usr/bin/env node

/**
 * tl-structure - Smart project overview with context estimates
 *
 * Shows directory structure with token estimates, highlighting
 * important directories and files for quick orientation.
 *
 * Optimized: Uses stat-based sizing (no file reads) for 10x faster performance
 *
 * Usage: tl-structure [path] [--depth N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-structure',
    desc: 'Project overview with token estimates',
    when: 'before-read',
    example: 'tl-structure'
  }));
  process.exit(0);
}

import { existsSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { traverseDirectory } from '../src/traverse.mjs';
import { getConfig } from '../src/config.mjs';
import { rgCommand } from '../src/shell.mjs';

const HELP = `
tl-structure - Smart project overview with context estimates

Usage: tl-structure [path] [options]

Options:
  --depth N, -d N    Maximum depth to show (default: 3)
  --entry-points     Highlight entry points (main, bin, exports from package.json)
  --exports, -e      Show top exports inline per file (JS/TS)
${COMMON_OPTIONS_HELP}

Configure defaults in .tokenleanrc.json:
  "structure": { "depth": 3, "important": ["src", "lib"] }

Examples:
  tl-structure                   # Current directory
  tl-structure src/ -d 2         # Just src, 2 levels deep
  tl-structure -j                # JSON output
  tl-structure -q                # Quiet (no headers)
`;

function printTree(node, out, prefix = '', isRoot = false, exportsByFile = null) {
  if (isRoot) {
    // Print children directly for root
    const children = node.children || [];
    children.forEach((child, index) => {
      printNode(child, out, '', index === children.length - 1, exportsByFile);
    });
    return;
  }
  printNode(node, out, prefix, true, exportsByFile);
}

function printNode(entry, out, prefix, isLast, exportsByFile = null) {
  const connector = isLast ? '└── ' : '├── ';
  const marker = entry.important ? '*' : ' ';
  const newPrefix = prefix + (isLast ? '    ' : '│   ');

  if (entry.type === 'dir') {
    const sizeInfo = entry.fileCount > 0
      ? ` (${entry.fileCount} files, ~${formatTokens(entry.totalTokens)})`
      : ' (empty)';
    out.add(`${prefix}${connector}${marker}${entry.name}/${sizeInfo}`);

    // Print children
    const children = entry.children || [];
    children.forEach((child, index) => {
      printNode(child, out, newPrefix, index === children.length - 1, exportsByFile);
    });
  } else if (entry.binary) {
    out.add(`${prefix}${connector}${marker}${entry.name} (binary)`);
  } else {
    let line = `${prefix}${connector}${marker}${entry.name} (~${formatTokens(entry.tokens)})`;

    // Append inline exports if available
    if (exportsByFile && entry.path) {
      const exports = exportsByFile.get(resolve(entry.path));
      if (exports && exports.length > 0) {
        const MAX_SHOW = 3;
        const shown = exports.slice(0, MAX_SHOW).join(', ');
        const overflow = exports.length > MAX_SHOW ? `, +${exports.length - MAX_SHOW}` : '';
        line += ` [${shown}${overflow}]`;
      }
    }

    out.add(line);
  }
}

// ─────────────────────────────────────────────────────────────
// Entry Point Detection
// ─────────────────────────────────────────────────────────────

function detectEntryPoints(projectDir) {
  const entries = [];
  const pkgPath = join(projectDir, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      if (pkg.main) entries.push({ path: pkg.main, type: 'main' });
      if (pkg.module) entries.push({ path: pkg.module, type: 'module' });

      if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
          entries.push({ path: pkg.bin, type: 'bin' });
        } else {
          for (const [name, path] of Object.entries(pkg.bin)) {
            entries.push({ path, type: `bin:${name}` });
          }
        }
      }

      if (pkg.exports) {
        if (typeof pkg.exports === 'string') {
          entries.push({ path: pkg.exports, type: 'exports' });
        } else {
          for (const [key, value] of Object.entries(pkg.exports)) {
            const resolved = typeof value === 'string' ? value :
              (value.import || value.require || value.default || null);
            if (resolved) entries.push({ path: resolved, type: `exports:${key}` });
          }
        }
      }

      // Scripts that hint at entry points
      if (pkg.scripts?.start) {
        const startMatch = pkg.scripts.start.match(/node\s+(\S+\.m?[jt]sx?)/);
        if (startMatch) entries.push({ path: startMatch[1], type: 'scripts:start' });
      }
    } catch { /* ignore parse errors */ }
  }

  // Common entry patterns (only if no package.json entries found)
  if (entries.length === 0) {
    const commonEntries = [
      'index.js', 'index.ts', 'index.mjs', 'main.js', 'main.ts',
      'app.js', 'app.ts', 'server.js', 'server.ts',
      'src/index.js', 'src/index.ts', 'src/index.mjs',
      'src/main.js', 'src/main.ts', 'src/main.tsx',
      'src/app.js', 'src/app.ts', 'src/app.tsx',
      'src/App.tsx', 'src/App.jsx'
    ];
    for (const entry of commonEntries) {
      if (existsSync(join(projectDir, entry))) {
        entries.push({ path: entry, type: 'conventional' });
      }
    }
  }

  return entries;
}

// ─────────────────────────────────────────────────────────────
// Export Extraction (JS/TS only)
// ─────────────────────────────────────────────────────────────

function batchExtractExports(rootDir) {
  const output = rgCommand([
    '--no-heading',
    '-n',
    '--glob', '*.{js,mjs,cjs,jsx,ts,tsx,mts}',
    '^export\\s+(default\\s+)?(function|const|let|var|class|type|interface|enum|async\\s+function)\\s+',
    rootDir
  ], { maxBuffer: 10 * 1024 * 1024 });

  if (!output) return new Map();

  const exportsByFile = new Map();

  for (const line of output.split('\n')) {
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const secondColon = line.indexOf(':', colonIdx + 1);
    if (secondColon === -1) continue;

    const filePath = line.substring(0, colonIdx);
    const content = line.substring(secondColon + 1).trim();

    const name = extractExportName(content);
    if (!name) continue;

    if (!exportsByFile.has(filePath)) {
      exportsByFile.set(filePath, []);
    }
    exportsByFile.get(filePath).push(name);
  }

  return exportsByFile;
}

function extractExportName(line) {
  const m = line.match(
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+|type\s+|interface\s+|enum\s+)(\w+)/
  );
  return m ? m[1] : null;
}

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Get config defaults
const structureConfig = getConfig('structure') || {};

let targetPath = '.';
let maxDepth = structureConfig.depth || 3;
let showEntryPoints = false;
let showExports = false;

// Parse tool-specific options
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--depth' || arg === '-d') && options.remaining[i + 1]) {
    maxDepth = parseInt(options.remaining[i + 1], 10);
    i++;
  } else if (arg === '--entry-points') {
    showEntryPoints = true;
  } else if (arg === '--exports' || arg === '-e') {
    showExports = true;
  } else if (!arg.startsWith('-')) {
    targetPath = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const out = createOutput(options);

// Single-pass traversal (fast!)
const tree = traverseDirectory(targetPath, { maxDepth });

// Set JSON data
out.setData('path', targetPath);
out.setData('totalFiles', tree.fileCount);
out.setData('totalTokens', tree.totalTokens);
out.setData('depth', maxDepth);
out.setData('tree', tree.children);

// Headers
const rootName = targetPath === '.' ? basename(process.cwd()) : targetPath;
out.header(rootName);
out.header(`Total: ${tree.fileCount} files, ~${formatTokens(tree.totalTokens)} tokens`);
out.header(`(* = important for understanding project)`);
out.blank();

// Export extraction
const exportsByFile = showExports ? batchExtractExports(resolve(targetPath)) : null;

if (showExports && exportsByFile) {
  const exportsData = {};
  for (const [filePath, names] of exportsByFile) {
    exportsData[filePath] = names;
  }
  out.setData('exports', exportsData);
}

// Tree output
printTree(tree, out, '', true, exportsByFile);

// Entry points
if (showEntryPoints) {
  const absTarget = resolve(targetPath);
  const entryPoints = detectEntryPoints(absTarget);
  if (entryPoints.length > 0) {
    out.blank();
    out.add('Entry points:');
    for (const ep of entryPoints) {
      out.add(`  ${ep.path} (${ep.type})`);
    }
    out.setData('entryPoints', entryPoints);
  }
}

out.print();
