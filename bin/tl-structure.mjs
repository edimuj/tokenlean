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

import { existsSync } from 'fs';
import { basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { traverseDirectory } from '../src/traverse.mjs';
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

function printTree(node, out, prefix = '', isRoot = false) {
  if (isRoot) {
    // Print children directly for root
    const children = node.children || [];
    children.forEach((child, index) => {
      printNode(child, out, '', index === children.length - 1);
    });
    return;
  }
  printNode(node, out, prefix, true);
}

function printNode(entry, out, prefix, isLast) {
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
      printNode(child, out, newPrefix, index === children.length - 1);
    });
  } else if (entry.binary) {
    out.add(`${prefix}${connector}${marker}${entry.name} (binary)`);
  } else {
    out.add(`${prefix}${connector}${marker}${entry.name} (~${formatTokens(entry.tokens)})`);
  }
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

// Tree output
printTree(tree, out, '', true);

out.print();
