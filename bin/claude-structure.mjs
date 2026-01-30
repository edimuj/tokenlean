#!/usr/bin/env node

/**
 * Claude Structure - Smart project overview with context estimates
 *
 * Shows directory structure with token estimates, highlighting
 * important directories and files for quick orientation.
 *
 * Usage: claude-structure [path] [--depth N]
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'android', 'ios', 'dist', 'build',
  '.expo', '.next', 'coverage', '__pycache__', '.cache', '.turbo'
]);

const IMPORTANT_FILES = new Set([
  'package.json', 'tsconfig.json', 'CLAUDE.md', 'README.md',
  'app.json', '.env.example', 'index.ts', 'index.tsx'
]);

const IMPORTANT_DIRS = new Set([
  'src', 'app', 'components', 'lib', 'utils', 'hooks', 'store',
  'api', 'services', 'types', '.claude', 'scripts', 'tests'
]);

function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

function formatTokens(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function getDirStats(dirPath) {
  let totalTokens = 0;
  let fileCount = 0;

  function walk(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && !IMPORTANT_DIRS.has(entry.name)) continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            totalTokens += estimateTokens(content);
            fileCount++;
          } catch (e) { /* skip binary */ }
        }
      }
    } catch (e) { /* permission error */ }
  }

  walk(dirPath);
  return { totalTokens, fileCount };
}

function printTree(dirPath, prefix = '', depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return;

  const entries = readdirSync(dirPath, { withFileTypes: true });

  // Sort: directories first, then by importance, then alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    const aImportant = IMPORTANT_DIRS.has(a.name) || IMPORTANT_FILES.has(a.name);
    const bImportant = IMPORTANT_DIRS.has(b.name) || IMPORTANT_FILES.has(b.name);
    if (aImportant !== bImportant) return aImportant ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const filtered = entries.filter(e => {
    if (e.name.startsWith('.') && e.name !== '.claude') return false;
    if (SKIP_DIRS.has(e.name)) return false;
    return true;
  });

  filtered.forEach((entry, index) => {
    const isLast = index === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = join(dirPath, entry.name);

    const isImportant = IMPORTANT_DIRS.has(entry.name) || IMPORTANT_FILES.has(entry.name);
    const marker = isImportant ? '*' : ' ';

    if (entry.isDirectory()) {
      const stats = getDirStats(fullPath);
      const sizeInfo = stats.fileCount > 0
        ? ` (${stats.fileCount} files, ~${formatTokens(stats.totalTokens)})`
        : ' (empty)';

      console.log(`${prefix}${connector}${marker}${entry.name}/${sizeInfo}`);

      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      printTree(fullPath, newPrefix, depth + 1, maxDepth);
    } else {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const tokens = estimateTokens(content);
        const lines = content.split('\n').length;
        console.log(`${prefix}${connector}${marker}${entry.name} (~${formatTokens(tokens)}, ${lines}L)`);
      } catch (e) {
        console.log(`${prefix}${connector}${marker}${entry.name} (binary)`);
      }
    }
  });
}

// Main
const args = process.argv.slice(2);
let targetPath = '.';
let maxDepth = 3;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--depth' && args[i + 1]) {
    maxDepth = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith('-')) {
    targetPath = args[i];
  }
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const rootStats = getDirStats(targetPath);
console.log(`\n📁 ${targetPath === '.' ? basename(process.cwd()) : targetPath}`);
console.log(`   Total: ${rootStats.fileCount} files, ~${formatTokens(rootStats.totalTokens)} tokens`);
console.log(`   (* = important for understanding project)\n`);

printTree(targetPath, '', 0, maxDepth);
console.log();
