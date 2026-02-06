#!/usr/bin/env node

/**
 * tl-errors - Map error types and throw points
 *
 * Find error class definitions, throw statements, catch blocks, and
 * promise rejections across your codebase. Helps understand error
 * handling patterns before modifying code.
 *
 * Usage: tl-errors [path] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-errors',
    desc: 'Map error types and throw points',
    when: 'before-modify',
    example: 'tl-errors src/'
  }));
  process.exit(0);
}

import { existsSync } from 'fs';
import { basename, relative, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep, batchRipgrep } from '../src/traverse.mjs';

ensureRipgrep();

const HELP = `
tl-errors - Map error types and throw points

Usage: tl-errors [path] [options]

Options:
  --throws              Only throw statements
  --catches             Only catch blocks
  --classes             Only error class definitions
  --rejects             Only promise rejections
  --group <type|file>   Group by type (default) or file
${COMMON_OPTIONS_HELP}

Examples:
  tl-errors                        # Scan project
  tl-errors src/                   # Scan src/ directory
  tl-errors src/api.mjs            # Single file
  tl-errors --throws               # Only throw statements
  tl-errors --group file           # Group by file
  tl-errors -j                     # JSON output
`;

// ─────────────────────────────────────────────────────────────
// Ripgrep Patterns
// ─────────────────────────────────────────────────────────────

const RG_PATTERNS = [
  'throw\\s+',                              // all throw statements
  'class\\s+\\w+\\s+extends\\s+\\w*Error',  // error class definitions
  'catch\\s*[({]',                           // catch blocks
  'reject\\s*\\(|Promise\\.reject',          // promise rejections
];

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function classifyMatches(rawResults, projectRoot, searchPath) {
  const errorClasses = [];
  const throws = [];
  const catches = [];
  const rejects = [];

  // Process error class definitions
  for (const m of rawResults['class\\s+\\w+\\s+extends\\s+\\w*Error'] || []) {
    const cm = m.content.match(/class\s+(\w+)\s+extends\s+(\w+)/);
    if (cm) {
      errorClasses.push({
        name: cm[1],
        extends: cm[2],
        file: relFile(m.file, projectRoot, searchPath),
        line: m.line,
      });
    }
  }

  // Process throw statements
  for (const m of rawResults['throw\\s+'] || []) {
    const content = m.content.trim();
    const file = relFile(m.file, projectRoot, searchPath);

    // throw new SomeError(...)
    const typedMatch = content.match(/throw\s+new\s+(\w+)\s*\(/);
    if (typedMatch) {
      throws.push({
        type: typedMatch[1],
        file,
        line: m.line,
        typed: true,
      });
      continue;
    }

    // Untyped throw (throw err, throw 'string', throw expression)
    if (/throw\s+/.test(content)) {
      throws.push({
        type: 'Untyped',
        file,
        line: m.line,
        typed: false,
      });
    }
  }

  // Process catch blocks
  for (const m of rawResults['catch\\s*[({]'] || []) {
    const content = m.content.trim();
    const file = relFile(m.file, projectRoot, searchPath);

    // catch (err) or catch (e)
    const varMatch = content.match(/catch\s*\(\s*(\w+)\s*\)/);
    catches.push({
      file,
      line: m.line,
      variable: varMatch ? varMatch[1] : null,
    });
  }

  // Process promise rejections
  for (const m of rawResults['reject\\s*\\(|Promise\\.reject'] || []) {
    const file = relFile(m.file, projectRoot, searchPath);
    rejects.push({
      file,
      line: m.line,
    });
  }

  return { errorClasses, throws, catches, rejects };
}

function relFile(file, projectRoot, searchPath) {
  // batchRipgrep returns paths relative to searchPath
  return relative(projectRoot, resolve(searchPath, file));
}

// ─────────────────────────────────────────────────────────────
// Output — group by type (default)
// ─────────────────────────────────────────────────────────────

function formatByType(data, out) {
  const { errorClasses, throws, catches, rejects } = data;

  // Error Classes
  if (errorClasses.length > 0) {
    out.add(`Error Classes (${errorClasses.length}):`);
    const rows = errorClasses.map(c => [
      `  ${c.name}`, `extends ${c.extends}`, `${c.file}:${c.line}`
    ]);
    out.addLines(formatTable(rows));
    out.blank();
  }

  // Throw Points — group by type, then by file with collapsed lines
  if (throws.length > 0) {
    out.add(`Throw Points (${throws.length}):`);

    // Group by type
    const byType = new Map();
    for (const t of throws) {
      if (!byType.has(t.type)) byType.set(t.type, []);
      byType.get(t.type).push(t);
    }

    for (const [type, items] of byType) {
      out.add(`  ${type} (${items.length}):`);

      // Group by file within type
      const byFile = new Map();
      for (const t of items) {
        if (!byFile.has(t.file)) byFile.set(t.file, []);
        byFile.get(t.file).push(t.line);
      }

      for (const [file, lines] of byFile) {
        out.add(`    ${file}  :${lines.join(', :')}`);
      }
    }
    out.blank();
  }

  // Catch Blocks — group by file with collapsed lines
  if (catches.length > 0) {
    out.add(`Catch Blocks (${catches.length}):`);
    const byFile = new Map();
    for (const c of catches) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push(c.line);
    }
    for (const [file, lines] of byFile) {
      out.add(`  ${file}  :${lines.join(', :')}`);
    }
    out.blank();
  }

  // Promise Rejections
  if (rejects.length > 0) {
    out.add(`Rejections (${rejects.length}):`);
    const byFile = new Map();
    for (const r of rejects) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r.line);
    }
    for (const [file, lines] of byFile) {
      out.add(`  ${file}  :${lines.join(', :')}`);
    }
    out.blank();
  }
}

// ─────────────────────────────────────────────────────────────
// Output — group by file
// ─────────────────────────────────────────────────────────────

function formatByFile(data, out) {
  const { errorClasses, throws, catches, rejects } = data;

  // Collect all items keyed by file
  const byFile = new Map();

  function ensure(file) {
    if (!byFile.has(file)) byFile.set(file, []);
    return byFile.get(file);
  }

  for (const c of errorClasses) {
    ensure(c.file).push({ sort: c.line, text: `  class ${c.name} extends ${c.extends}   :${c.line}` });
  }
  for (const t of throws) {
    const label = t.typed ? `throw new ${t.type}` : 'throw (untyped)';
    ensure(t.file).push({ sort: t.line, text: `  ${label}   :${t.line}` });
  }
  for (const c of catches) {
    const label = c.variable ? `catch (${c.variable})` : 'catch';
    ensure(c.file).push({ sort: c.line, text: `  ${label}   :${c.line}` });
  }
  for (const r of rejects) {
    ensure(r.file).push({ sort: r.line, text: `  reject()   :${r.line}` });
  }

  // Sort files, then items within each file by line number
  const files = [...byFile.keys()].sort();
  for (const file of files) {
    const items = byFile.get(file).sort((a, b) => a.sort - b.sort);
    out.add(file);
    for (const item of items) {
      out.add(item.text);
    }
    out.blank();
  }
}

// ─────────────────────────────────────────────────────────────
// Output — quiet mode
// ─────────────────────────────────────────────────────────────

function formatQuiet(data, out) {
  const { errorClasses, throws, catches, rejects } = data;

  for (const c of errorClasses) {
    out.add(`${c.file}:${c.line}:class:${c.name}`);
  }
  for (const t of throws) {
    out.add(`${t.file}:${t.line}:throw:${t.type}`);
  }
  for (const c of catches) {
    out.add(`${c.file}:${c.line}:catch:${c.variable || ''}`);
  }
  for (const r of rejects) {
    out.add(`${r.file}:${r.line}:reject`);
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let onlyThrows = false;
let onlyCatches = false;
let onlyClasses = false;
let onlyRejects = false;
let groupMode = 'type';

const consumedIndices = new Set();

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if (arg === '--throws') {
    onlyThrows = true;
    consumedIndices.add(i);
  } else if (arg === '--catches') {
    onlyCatches = true;
    consumedIndices.add(i);
  } else if (arg === '--classes') {
    onlyClasses = true;
    consumedIndices.add(i);
  } else if (arg === '--rejects') {
    onlyRejects = true;
    consumedIndices.add(i);
  } else if (arg === '--group' && options.remaining[i + 1]) {
    groupMode = options.remaining[i + 1];
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++;
  }
}

const targetPath = options.remaining.find((a, i) => !a.startsWith('-') && !consumedIndices.has(i)) || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const resolvedPath = resolve(targetPath);
const relPath = relative(projectRoot, resolvedPath) || '.';

if (!existsSync(resolvedPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

// Determine which patterns to search for
const hasFilter = onlyThrows || onlyCatches || onlyClasses || onlyRejects;
const patterns = [];
if (!hasFilter || onlyThrows)  patterns.push(RG_PATTERNS[0]);
if (!hasFilter || onlyClasses) patterns.push(RG_PATTERNS[1]);
if (!hasFilter || onlyCatches) patterns.push(RG_PATTERNS[2]);
if (!hasFilter || onlyRejects) patterns.push(RG_PATTERNS[3]);

// Run batchRipgrep with caching
const cacheKey = { op: 'tl-errors', patterns, path: resolvedPath };
const rawResults = withCache(
  cacheKey,
  () => batchRipgrep(patterns, resolvedPath),
  { projectRoot }
);

// Classify matches
const data = classifyMatches(rawResults, projectRoot, resolvedPath);

// Apply filters (zero out categories we don't want)
if (hasFilter) {
  if (!onlyThrows)  data.throws = [];
  if (!onlyCatches) data.catches = [];
  if (!onlyClasses) data.errorClasses = [];
  if (!onlyRejects) data.rejects = [];
}

const totalItems = data.errorClasses.length + data.throws.length +
  data.catches.length + data.rejects.length;

const out = createOutput(options);

// JSON output
const summary = {
  totalThrows: data.throws.length,
  typedThrows: data.throws.filter(t => t.typed).length,
  untypedThrows: data.throws.filter(t => !t.typed).length,
  errorClasses: data.errorClasses.length,
  catches: data.catches.length,
  rejects: data.rejects.length,
};

out.setData('errorClasses', data.errorClasses);
out.setData('throws', data.throws);
out.setData('catches', data.catches);
out.setData('rejects', data.rejects);
out.setData('summary', summary);

if (totalItems === 0) {
  out.header(`\nErrors: ${relPath === '.' ? basename(projectRoot) : relPath}`);
  out.header('  No error patterns found.');
  out.print();
  process.exit(0);
}

if (options.quiet) {
  formatQuiet(data, out);
} else {
  out.header(`\nErrors: ${relPath === '.' ? basename(projectRoot) : relPath}`);

  const parts = [];
  if (summary.errorClasses > 0) parts.push(`${summary.errorClasses} classes`);
  if (summary.totalThrows > 0)  parts.push(`${summary.totalThrows} throws`);
  if (summary.catches > 0)      parts.push(`${summary.catches} catches`);
  if (summary.rejects > 0)      parts.push(`${summary.rejects} rejects`);
  out.header(`  ${parts.join(', ')}`);
  out.blank();

  if (groupMode === 'file') {
    formatByFile(data, out);
  } else {
    formatByType(data, out);
  }
}

out.print();
