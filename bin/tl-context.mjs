#!/usr/bin/env node

/**
 * tl-context - Estimate context token usage for files/directories
 *
 * Helps understand what contributes to context usage.
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

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import {
  findProjectRoot,
  shouldSkip,
  getSkipDirs,
  getImportantDirs
} from '../src/project.mjs';

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

function analyzeDir(dirPath, results = [], skipDirs, importantDirs) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !importantDirs.has(entry.name)) continue;
      if (shouldSkip(entry.name, entry.isDirectory())) continue;

      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        analyzeDir(fullPath, results, skipDirs, importantDirs);
      } else {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const tokens = estimateTokens(content);
          results.push({ path: fullPath, tokens, lines: content.split('\n').length });
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  } catch {
    // Permission error
  }

  return results;
}

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
const skipDirs = getSkipDirs();
const importantDirs = getImportantDirs();
const out = createOutput(options);

const stat = statSync(targetPath);
if (stat.isFile()) {
  // Single file
  const content = readFileSync(targetPath, 'utf-8');
  const tokens = estimateTokens(content);
  const lines = content.split('\n').length;

  out.setData('file', targetPath);
  out.setData('tokens', tokens);
  out.setData('lines', lines);

  out.header(`${targetPath}: ~${formatTokens(tokens)} tokens (${lines} lines)`);
  out.print();
} else {
  // Directory
  const results = analyzeDir(targetPath, [], skipDirs, importantDirs);

  // Sort by tokens descending
  results.sort((a, b) => b.tokens - a.tokens);

  const total = results.reduce((sum, r) => sum + r.tokens, 0);
  const totalLines = results.reduce((sum, r) => sum + r.lines, 0);

  // Set JSON data
  out.setData('path', targetPath);
  out.setData('totalTokens', total);
  out.setData('totalLines', totalLines);
  out.setData('fileCount', results.length);

  // Header
  out.header(`Context Estimate: ${targetPath}`);
  out.header(`Total: ~${formatTokens(total)} tokens across ${results.length} files`);
  out.blank();

  // File list
  const displayResults = topN ? results.slice(0, topN) : results;

  if (displayResults.length > 0) {
    if (topN) {
      out.header(`Top ${Math.min(topN, results.length)} largest files:`);
    }
    out.blank();

    // Format as table
    const rows = displayResults.map(r => {
      const relPath = relative(targetPath, r.path);
      const truncPath = relPath.length > 60 ? '...' + relPath.slice(-57) : relPath;
      return [formatTokens(r.tokens), r.lines, truncPath];
    });

    const tableLines = formatTable(rows, { indent: '  ', separator: '   ' });
    out.add('  Tokens   Lines  Path');
    out.add('  ' + '-'.repeat(70));
    out.addLines(tableLines);
  }

  // Group by directory
  const byDir = {};
  for (const r of results) {
    const rel = relative(targetPath, r.path);
    const dir = rel.includes('/') ? rel.split('/')[0] : '.';
    byDir[dir] = (byDir[dir] || 0) + r.tokens;
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
  out.setData('files', results.slice(0, 100).map(r => ({
    path: relative(targetPath, r.path),
    tokens: r.tokens,
    lines: r.lines
  })));

  out.print();
}
