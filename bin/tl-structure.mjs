#!/usr/bin/env node

/**
 * tl-structure - Smart project overview with context estimates
 *
 * Shows directory structure with token estimates, highlighting
 * important directories and files for quick orientation.
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

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import {
  getSkipDirs,
  getImportantFiles,
  getImportantDirs
} from '../src/project.mjs';
import { getConfig } from '../src/config.mjs';

const HELP = `
tl-structure - Smart project overview with context estimates

Usage: tl-structure [path] [options]

Options:
  --depth N, -d N    Maximum depth to show (default: 3)
${COMMON_OPTIONS_HELP}

Configure defaults in .tokenleanrc.json:
  "structure": { "depth": 3, "important": ["src", "lib"] }

Examples:
  tl-structure                   # Current directory
  tl-structure src/ -d 2         # Just src, 2 levels deep
  tl-structure -j                # JSON output
  tl-structure -q                # Quiet (no headers)
`;

function getDirStats(dirPath, skipDirs, importantDirs) {
  let totalTokens = 0;
  let fileCount = 0;

  function walk(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && !importantDirs.has(entry.name)) continue;
        if (skipDirs.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            totalTokens += estimateTokens(content);
            fileCount++;
          } catch { /* skip binary */ }
        }
      }
    } catch { /* permission error */ }
  }

  walk(dirPath);
  return { totalTokens, fileCount };
}

function buildTree(dirPath, depth, maxDepth, skipDirs, importantDirs, importantFiles) {
  const tree = [];
  if (depth > maxDepth) return tree;

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    // Sort: directories first, then by importance, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      const aImportant = importantDirs.has(a.name) || importantFiles.has(a.name);
      const bImportant = importantDirs.has(b.name) || importantFiles.has(b.name);
      if (aImportant !== bImportant) return aImportant ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const filtered = entries.filter(e => {
      if (e.name.startsWith('.') && e.name !== '.claude') return false;
      if (skipDirs.has(e.name)) return false;
      return true;
    });

    for (const entry of filtered) {
      const fullPath = join(dirPath, entry.name);
      const isImportant = importantDirs.has(entry.name) || importantFiles.has(entry.name);

      if (entry.isDirectory()) {
        const stats = getDirStats(fullPath, skipDirs, importantDirs);
        tree.push({
          name: entry.name,
          type: 'dir',
          important: isImportant,
          fileCount: stats.fileCount,
          tokens: stats.totalTokens,
          children: buildTree(fullPath, depth + 1, maxDepth, skipDirs, importantDirs, importantFiles)
        });
      } else {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const tokens = estimateTokens(content);
          const lines = content.split('\n').length;
          tree.push({
            name: entry.name,
            type: 'file',
            important: isImportant,
            tokens,
            lines
          });
        } catch {
          tree.push({
            name: entry.name,
            type: 'file',
            important: isImportant,
            binary: true
          });
        }
      }
    }
  } catch { /* permission error */ }

  return tree;
}

function printTree(tree, out, prefix = '') {
  tree.forEach((entry, index) => {
    const isLast = index === tree.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const marker = entry.important ? '*' : ' ';

    if (entry.type === 'dir') {
      const sizeInfo = entry.fileCount > 0
        ? ` (${entry.fileCount} files, ~${formatTokens(entry.tokens)})`
        : ' (empty)';
      out.add(`${prefix}${connector}${marker}${entry.name}/${sizeInfo}`);

      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      printTree(entry.children, out, newPrefix);
    } else if (entry.binary) {
      out.add(`${prefix}${connector}${marker}${entry.name} (binary)`);
    } else {
      out.add(`${prefix}${connector}${marker}${entry.name} (~${formatTokens(entry.tokens)}, ${entry.lines}L)`);
    }
  });
}

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Get config defaults
const structureConfig = getConfig('structure') || {};

let targetPath = '.';
let maxDepth = structureConfig.depth || 3;

// Parse tool-specific options
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--depth' || arg === '-d') && options.remaining[i + 1]) {
    maxDepth = parseInt(options.remaining[i + 1], 10);
    i++;
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

// Get combined sets (defaults + user config extensions)
const skipDirs = getSkipDirs();
const importantDirs = getImportantDirs();
const importantFiles = getImportantFiles();

const out = createOutput(options);

const rootStats = getDirStats(targetPath, skipDirs, importantDirs);
const tree = buildTree(targetPath, 0, maxDepth, skipDirs, importantDirs, importantFiles);

// Set JSON data
out.setData('path', targetPath);
out.setData('totalFiles', rootStats.fileCount);
out.setData('totalTokens', rootStats.totalTokens);
out.setData('depth', maxDepth);
out.setData('tree', tree);

// Headers
const rootName = targetPath === '.' ? basename(process.cwd()) : targetPath;
out.header(rootName);
out.header(`Total: ${rootStats.fileCount} files, ~${formatTokens(rootStats.totalTokens)} tokens`);
out.header(`(* = important for understanding project)`);
out.blank();

// Tree output
printTree(tree, out);

out.print();
