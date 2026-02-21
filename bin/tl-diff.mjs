#!/usr/bin/env node

/**
 * tl-diff - Token-efficient git diff summary
 *
 * Summarizes git changes without outputting full diff content.
 * Great for understanding what changed before diving into details.
 *
 * Usage: tl-diff [ref] [--staged] [--stat-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-diff',
    desc: 'Summarize git changes with token estimates',
    when: 'search',
    example: 'tl-diff --staged'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import {
  createOutput,
  parseCommonArgs,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { gitCommand } from '../src/shell.mjs';

const HELP = `
tl-diff - Token-efficient git diff summary

Usage: tl-diff [ref] [options]

Options:
  --staged             Show staged changes only
  --stat-only          Show just the summary (no file list)
  --breaking           Detect breaking changes (removed/renamed exports)
${COMMON_OPTIONS_HELP}

Examples:
  tl-diff                     # Working directory changes
  tl-diff --staged            # Staged changes
  tl-diff HEAD~3              # Last 3 commits
  tl-diff main                # Changes vs main branch
  tl-diff -j                  # JSON output
`;

function run(args) {
  return gitCommand(args) || '';
}

function parseDiffStat(stat) {
  const lines = stat.trim().split('\n');
  const files = [];

  for (const line of lines) {
    // Match: " src/file.ts | 42 +++---"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*(\+*)(-*)/);
    if (match) {
      files.push({
        path: match[1].trim(),
        changes: parseInt(match[2]),
        additions: match[3].length,
        deletions: match[4].length
      });
    }
  }

  return files;
}

function categorizeChanges(files) {
  const categories = {
    components: [],
    hooks: [],
    store: [],
    types: [],
    tests: [],
    config: [],
    manuscripts: [],
    other: []
  };

  for (const file of files) {
    const path = file.path.toLowerCase();

    if (path.includes('.test.') || path.includes('.spec.') || path.includes('__tests__')) {
      categories.tests.push(file);
    } else if (path.includes('/components/') || path.endsWith('.tsx')) {
      categories.components.push(file);
    } else if (path.includes('/hooks/') || path.includes('use')) {
      categories.hooks.push(file);
    } else if (path.includes('/store/') || path.includes('slice') || path.includes('reducer')) {
      categories.store.push(file);
    } else if (path.includes('/types/') || path.endsWith('.d.ts')) {
      categories.types.push(file);
    } else if (path.includes('manuscripts') || path.endsWith('.json')) {
      categories.manuscripts.push(file);
    } else if (path.includes('config') || path.includes('package.json') || path.includes('tsconfig')) {
      categories.config.push(file);
    } else {
      categories.other.push(file);
    }
  }

  return categories;
}

// ─────────────────────────────────────────────────────────────
// Breaking Change Detection
// ─────────────────────────────────────────────────────────────

const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs']);

function extractExportNames(content) {
  const exports = new Map(); // name -> signature (first 80 chars)
  if (!content) return exports;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('export ')) continue;

    // export function foo(...)
    let m = trimmed.match(/export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
    if (m) { exports.set(m[1], trimmed.slice(0, 80)); continue; }

    // export class Foo
    m = trimmed.match(/export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (m) { exports.set(m[1], trimmed.slice(0, 80)); continue; }

    // export const foo
    m = trimmed.match(/export\s+const\s+(\w+)/);
    if (m) { exports.set(m[1], trimmed.slice(0, 80)); continue; }

    // export type/interface
    m = trimmed.match(/export\s+(?:type|interface)\s+(\w+)/);
    if (m) { exports.set(m[1], trimmed.slice(0, 80)); continue; }

    // export enum
    m = trimmed.match(/export\s+(?:const\s+)?enum\s+(\w+)/);
    if (m) { exports.set(m[1], trimmed.slice(0, 80)); continue; }

    // export { foo, bar }
    m = trimmed.match(/export\s+\{([^}]+)\}/);
    if (m) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0].trim();
        if (clean) exports.set(clean, `export { ${clean} }`);
      }
    }

    // export default
    m = trimmed.match(/export\s+default\s+(?:class|function)?\s*(\w+)?/);
    if (m && m[1]) { exports.set('default', trimmed.slice(0, 80)); }
  }

  return exports;
}

function detectBreakingChanges(files, ref, staged) {
  const breakingChanges = [];
  const baseRef = staged ? 'HEAD' : (ref || 'HEAD');

  for (const file of files) {
    const ext = '.' + file.path.split('.').pop();
    if (!CODE_EXTS.has(ext)) continue;

    // Get old file content from git
    const oldContent = gitCommand(['show', `${baseRef}:${file.path}`]);
    if (oldContent === null) continue; // new file, no breaking changes possible

    // Get current file content
    let newContent = null;
    if (existsSync(file.path)) {
      try { newContent = readFileSync(file.path, 'utf-8'); } catch { /* skip */ }
    }
    if (newContent === null) continue; // deleted file — all exports removed, but that's obvious

    const oldExports = extractExportNames(oldContent);
    const newExports = extractExportNames(newContent);

    const removed = [];
    const changed = [];

    for (const [name, oldSig] of oldExports) {
      if (!newExports.has(name)) {
        removed.push(name);
      } else {
        const newSig = newExports.get(name);
        // Check for parameter signature changes
        const oldParams = oldSig.match(/\(([^)]*)\)/);
        const newParams = newSig.match(/\(([^)]*)\)/);
        if (oldParams && newParams && oldParams[1] !== newParams[1]) {
          changed.push(name);
        }
      }
    }

    if (removed.length > 0 || changed.length > 0) {
      breakingChanges.push({ file: file.path, removed, changed });
    }
  }

  return breakingChanges;
}

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let ref = '';
let staged = false;
let statOnly = false;

let breaking = false;
for (const arg of options.remaining) {
  if (arg === '--staged') {
    staged = true;
  } else if (arg === '--stat-only') {
    statOnly = true;
  } else if (arg === '--breaking') {
    breaking = true;
  } else if (!arg.startsWith('-')) {
    ref = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

// Build git diff args
const diffArgs = ['diff'];
if (staged) {
  diffArgs.push('--cached');
} else if (ref) {
  diffArgs.push(ref);
}
diffArgs.push('--stat=200');

const stat = run(diffArgs);

const out = createOutput(options);

if (!stat.trim()) {
  out.header('No changes detected');
  out.print();
  process.exit(0);
}

const files = parseDiffStat(stat);
const categories = categorizeChanges(files);

const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);
const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

// Set JSON data
out.setData('files', files);
out.setData('categories', categories);
out.setData('totalFiles', files.length);
out.setData('totalChanges', totalChanges);
out.setData('estimatedTokens', totalChanges * 4);

// Summary header
out.header('Diff Summary');
out.header(`${files.length} files changed, ~${formatTokens(totalChanges * 4)} tokens of changes`);
out.header(`+${totalAdditions} additions, -${totalDeletions} deletions`);
out.blank();

if (!statOnly) {
  const order = ['components', 'hooks', 'store', 'types', 'manuscripts', 'tests', 'config', 'other'];
  const labels = {
    components: 'Components',
    hooks: 'Hooks',
    store: 'Store',
    types: 'Types',
    manuscripts: 'Manuscripts',
    tests: 'Tests',
    config: 'Config',
    other: 'Other'
  };

  for (const cat of order) {
    const catFiles = categories[cat];
    if (catFiles.length === 0) continue;

    out.add(`${labels[cat]} (${catFiles.length})`);

    // Sort by changes descending
    catFiles.sort((a, b) => b.changes - a.changes);

    for (const f of catFiles.slice(0, 10)) {
      const bar = '+'.repeat(Math.min(f.additions, 20)) + '-'.repeat(Math.min(f.deletions, 20));
      out.add(`  ${f.path}`);
      out.add(`    ${f.changes} changes ${bar}`);
    }

    if (catFiles.length > 10) {
      out.add(`  ... and ${catFiles.length - 10} more`);
    }

    out.blank();
  }

  out.header('Tip: Use --stat-only for just the summary, or check specific files with:');
  out.header('   git diff [ref] -- path/to/file.ts');
}

// Breaking change detection
if (breaking) {
  const breakingChanges = detectBreakingChanges(files, ref, staged);
  if (breakingChanges.length > 0) {
    out.blank();
    out.add(`BREAKING CHANGES (${breakingChanges.length}):`);
    for (const bc of breakingChanges) {
      out.add(`  ${bc.file}:`);
      for (const removed of bc.removed) {
        out.add(`    - ${removed} (removed)`);
      }
      for (const changed of bc.changed) {
        out.add(`    ~ ${changed} (signature changed)`);
      }
    }
    out.setData('breakingChanges', breakingChanges);
  } else {
    out.blank();
    out.add('No breaking changes detected');
  }
}

out.print();
