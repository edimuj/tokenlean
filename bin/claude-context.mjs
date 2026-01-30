#!/usr/bin/env node

/**
 * Claude Context - Estimate context token usage for files/directories
 *
 * Helps understand what contributes to context usage.
 * Usage: claude-context [path] [--top N]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'android', 'ios', 'dist', 'build',
  '.expo', '.next', 'coverage', '__pycache__', '.cache'
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg',
  '.zip', '.tar', '.gz',
  '.lock', '.log'
]);

// Rough token estimate: ~4 chars per token for code
function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

function formatTokens(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function shouldSkip(name, isDir) {
  if (isDir && SKIP_DIRS.has(name)) return true;
  if (!isDir) {
    const ext = name.substring(name.lastIndexOf('.'));
    if (SKIP_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function analyzeDir(dirPath, results = [], depth = 0) {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    if (shouldSkip(entry.name, entry.isDirectory())) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      analyzeDir(fullPath, results, depth + 1);
    } else {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const tokens = estimateTokens(content);
        results.push({ path: fullPath, tokens, lines: content.split('\n').length });
      } catch (e) {
        // Skip binary or unreadable files
      }
    }
  }

  return results;
}

function printResults(results, rootPath, topN) {
  // Sort by tokens descending
  results.sort((a, b) => b.tokens - a.tokens);

  const total = results.reduce((sum, r) => sum + r.tokens, 0);

  console.log(`\n📊 Context Estimate for: ${rootPath}\n`);
  console.log(`Total: ~${formatTokens(total)} tokens across ${results.length} files\n`);

  if (topN) {
    console.log(`Top ${topN} largest files:\n`);
    results = results.slice(0, topN);
  }

  const maxPathLen = Math.min(60, Math.max(...results.map(r => relative(rootPath, r.path).length)));

  console.log('  Tokens   Lines  Path');
  console.log('  ' + '-'.repeat(maxPathLen + 20));

  for (const r of results) {
    const relPath = relative(rootPath, r.path);
    const truncPath = relPath.length > 60 ? '...' + relPath.slice(-57) : relPath;
    console.log(`  ${formatTokens(r.tokens).padStart(6)}   ${String(r.lines).padStart(5)}  ${truncPath}`);
  }

  console.log();

  // Group by directory
  const byDir = {};
  for (const r of results) {
    const rel = relative(rootPath, r.path);
    const dir = rel.includes('/') ? rel.split('/')[0] : '.';
    byDir[dir] = (byDir[dir] || 0) + r.tokens;
  }

  const sortedDirs = Object.entries(byDir).sort((a, b) => b[1] - a[1]);

  console.log('By top-level directory:\n');
  for (const [dir, tokens] of sortedDirs.slice(0, 10)) {
    const pct = ((tokens / total) * 100).toFixed(1);
    console.log(`  ${formatTokens(tokens).padStart(6)}  ${pct.padStart(5)}%  ${dir}/`);
  }
  console.log();
}

// Main
const args = process.argv.slice(2);
let targetPath = '.';
let topN = 20;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top' && args[i + 1]) {
    topN = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--all') {
    topN = null;
  } else if (!args[i].startsWith('-')) {
    targetPath = args[i];
  }
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const stat = statSync(targetPath);
if (stat.isFile()) {
  const content = readFileSync(targetPath, 'utf-8');
  const tokens = estimateTokens(content);
  console.log(`\n${targetPath}: ~${formatTokens(tokens)} tokens (${content.split('\n').length} lines)\n`);
} else {
  const results = analyzeDir(targetPath);
  printResults(results, targetPath, topN);
}
