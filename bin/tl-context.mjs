#!/usr/bin/env node

/**
 * tl-context - Estimate context token usage for files/directories
 *
 * Helps understand what contributes to context usage.
 *
 * Optimized: Uses stat-based sizing (no file reads) for 10x faster performance
 *
 * Usage: tl-context [path] [--top N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-context',
    desc: 'Estimate token usage for files/directories',
    when: 'before-read',
    example: 'tl-context src/'
  }));
  process.exit(0);
}

import { statSync, existsSync } from 'fs';
import { relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTokens,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { listFiles, estimateTokensFromSize } from '../src/traverse.mjs';

const HELP = `
tl-context - Estimate context token usage for files/directories

Usage: tl-context [path] [options]

Options:
  --top N, -n N       Show top N files (default: 20, use --all for all)
  --all               Show all files
${COMMON_OPTIONS_HELP}

Examples:
  tl-context src/              # Estimate tokens for src directory
  tl-context src/ --top 10     # Show top 10 largest files
  tl-context src/ --all        # Show all files
  tl-context package.json      # Single file estimate
  tl-context -j                # JSON output for scripting
`;

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let topN = 20;
let targetPath = '.';

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--top' || arg === '-n') && options.remaining[i + 1]) {
    topN = parseInt(options.remaining[i + 1], 10);
    i++;
  } else if (arg === '--all') {
    topN = null;
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

const projectRoot = findProjectRoot();
const out = createOutput(options);

const stat = statSync(targetPath);
if (stat.isFile()) {
  // Single file - use stat for size
  const tokens = estimateTokensFromSize(stat.size);

  out.setData('file', targetPath);
  out.setData('tokens', tokens);
  out.setData('size', stat.size);

  out.header(`${targetPath}: ~${formatTokens(tokens)} tokens (${stat.size} bytes)`);
  out.print();
} else {
  // Directory - use fast traversal
  const files = listFiles(targetPath);

  // Sort by tokens descending
  files.sort((a, b) => (b.tokens || 0) - (a.tokens || 0));

  // Filter out binary files for stats
  const validFiles = files.filter(f => !f.binary);
  const total = validFiles.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const totalSize = validFiles.reduce((sum, r) => sum + (r.size || 0), 0);

  // Set JSON data
  out.setData('path', targetPath);
  out.setData('totalTokens', total);
  out.setData('totalSize', totalSize);
  out.setData('fileCount', validFiles.length);

  // Header
  out.header(`Context Estimate: ${targetPath}`);
  out.header(`Total: ~${formatTokens(total)} tokens across ${validFiles.length} files`);
  out.blank();

  // File list
  const displayResults = topN ? validFiles.slice(0, topN) : validFiles;

  if (displayResults.length > 0) {
    if (topN) {
      out.header(`Top ${Math.min(topN, validFiles.length)} largest files:`);
    }
    out.blank();

    // Format as table
    const rows = displayResults.map(r => {
      const relPath = r.relativePath || relative(targetPath, r.path);
      const truncPath = relPath.length > 60 ? '...' + relPath.slice(-57) : relPath;
      return [formatTokens(r.tokens || 0), truncPath];
    });

    const tableLines = formatTable(rows, { indent: '  ', separator: '   ' });
    out.add('  Tokens   Path');
    out.add('  ' + '-'.repeat(70));
    out.addLines(tableLines);
  }

  // Group by directory
  const byDir = {};
  for (const r of validFiles) {
    const rel = r.relativePath || relative(targetPath, r.path);
    const dir = rel.includes('/') ? rel.split('/')[0] : '.';
    byDir[dir] = (byDir[dir] || 0) + (r.tokens || 0);
  }

  const sortedDirs = Object.entries(byDir).sort((a, b) => b[1] - a[1]);

  out.blank();
  out.header('By top-level directory:');
  out.blank();

  const dirRows = sortedDirs.slice(0, 10).map(([dir, tokens]) => {
    const pct = ((tokens / total) * 100).toFixed(1) + '%';
    return [formatTokens(tokens), pct, dir + '/'];
  });

  out.addLines(formatTable(dirRows, { indent: '  ', separator: '  ' }));

  out.setData('byDirectory', Object.fromEntries(sortedDirs));
  out.setData('files', validFiles.slice(0, 100).map(r => ({
    path: r.relativePath || relative(targetPath, r.path),
    tokens: r.tokens || 0,
    size: r.size || 0
  })));

  out.print();
}
