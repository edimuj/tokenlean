#!/usr/bin/env node

/**
 * tl-todo - Extract TODOs, FIXMEs, and other markers from codebase
 *
 * Quickly find all task markers in your code. Helps prioritize work
 * and find forgotten tasks without reading entire files.
 *
 * Usage: tl-todo [path]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-todo',
    desc: 'Find TODOs, FIXMEs in codebase',
    when: 'search',
    example: 'tl-todo --priority'
  }));
  process.exit(0);
}

import { existsSync, readFileSync } from 'fs';
import { basename, dirname, relative, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip, SKIP_DIRS } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep } from '../src/traverse.mjs';
import { rgCommand } from '../src/shell.mjs';

ensureRipgrep();

const HELP = `
tl-todo - Extract TODOs, FIXMEs, and other markers from codebase

Usage: tl-todo [path] [options]

Options:
  --type T, -t T        Filter by type (todo, fixme, hack, xxx, note)
  --author A            Filter by author (e.g., "@john")
  --priority, -p        Sort by priority (FIXME > TODO > HACK > NOTE)
  --context N, -c N     Show N lines of context (default: 0)
${COMMON_OPTIONS_HELP}

Examples:
  tl-todo                          # All markers in project
  tl-todo src/                     # Only in src/
  tl-todo -t fixme                 # Only FIXMEs
  tl-todo -p                       # Sort by priority
  tl-todo -c 2                     # Show 2 lines of context

Markers detected:
  🔴 FIXME  - Bugs or critical issues
  🟡 TODO   - Tasks to complete
  🟠 HACK   - Temporary workarounds
  ⚪ XXX    - Warnings/concerns
  🔵 NOTE   - Important information
`;

// Marker types with priority (lower = higher priority)
const MARKERS = {
  FIXME: { emoji: '🔴', priority: 1 },
  FIX: { emoji: '🔴', priority: 1 },
  BUG: { emoji: '🔴', priority: 1 },
  TODO: { emoji: '🟡', priority: 2 },
  HACK: { emoji: '🟠', priority: 3 },
  WORKAROUND: { emoji: '🟠', priority: 3 },
  XXX: { emoji: '⚪', priority: 4 },
  WARN: { emoji: '⚪', priority: 4 },
  NOTE: { emoji: '🔵', priority: 5 },
  INFO: { emoji: '🔵', priority: 5 },
};

// ─────────────────────────────────────────────────────────────
// Todo Extraction
// ─────────────────────────────────────────────────────────────

function findTodos(searchPath, projectRoot) {
  const todos = [];
  const markerPattern = Object.keys(MARKERS).join('|');

  // Comment prefixes to detect actual comment lines
  // Must be preceded by comment syntax or be in a comment context
  const commentPrefixes = [
    '//',           // C-style line comments
    '#',            // Shell, Python, Ruby
    '--',           // SQL, Lua, Haskell
    '\\*',          // Inside /* */ blocks
    '<!--',         // HTML comments
    '\\{#',         // Jinja/Django templates (escaped brace)
  ];

  try {
    // Build exclude patterns for ripgrep
    const excludeArgs = [...SKIP_DIRS].flatMap(d => ['--glob', `!${d}`]);

    // Search for markers that look like they're in comments
    // Pattern: comment prefix followed by optional whitespace, then marker with colon/parens
    // Require : or ( after marker to avoid false positives like "Todo Extraction"
    const commentPattern = `(${commentPrefixes.join('|')})\\s*(${markerPattern})[:(]`;

    const cacheKey = { op: 'rg-todo-markers', pattern: commentPattern, path: searchPath };
    const output = withCache(
      cacheKey,
      () => rgCommand(['-n', '--no-heading', '-i', ...excludeArgs, '-e', commentPattern, searchPath], { maxBuffer: 50 * 1024 * 1024 }) || '',
      { projectRoot }
    );

    if (!output.trim()) {
      return todos;
    }

    const lines = output.trim().split('\n');

    for (const line of lines) {
      // Format: file:line:content
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [, file, lineNum, content] = match;

      // Skip if file should be skipped
      if (shouldSkip(basename(file), false)) continue;

      // Extract marker type and message
      const markerMatch = content.match(new RegExp(`(${markerPattern})[:\\s(]+(.*)`, 'i'));
      if (!markerMatch) continue;

      const type = markerMatch[1].toUpperCase();
      let message = markerMatch[2].trim();

      // Clean up common comment endings
      message = message.replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').replace(/\)\s*$/, '').trim();

      // Skip if message is too short or looks like code/section header
      if (message.length < 3) continue;
      if (/^[{(\[;,=]/.test(message)) continue;
      if (/^─+$/.test(message)) continue; // Section dividers

      // Extract author if present: TODO(@author): message or TODO(author): message
      // Only match if explicitly has @ or parens around author name
      let author = null;
      const authorMatch = message.match(/^[@(](\w+)\)?[:\s]+(.+)$/);
      if (authorMatch && authorMatch[1].length < 15 && authorMatch[2].length > 5) {
        author = authorMatch[1];
        message = authorMatch[2];
      }

      const relFile = relative(projectRoot, resolve(searchPath, file));

      todos.push({
        file: relFile,
        line: parseInt(lineNum, 10),
        type: MARKERS[type] ? type : 'TODO',
        message: message.substring(0, 200),
        author,
        priority: MARKERS[type]?.priority || 2
      });
    }
  } catch (e) {
    // ripgrep error
  }

  return todos;
}

function getContext(file, lineNum, contextLines, projectRoot) {
  if (contextLines <= 0) return null;

  try {
    const fullPath = resolve(projectRoot, file);
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    const start = Math.max(0, lineNum - 1 - contextLines);
    const end = Math.min(lines.length, lineNum + contextLines);

    return lines.slice(start, end).map((l, i) => ({
      num: start + i + 1,
      content: l.substring(0, 120),
      isTodo: start + i + 1 === lineNum
    }));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────

function formatTodos(todos, out, contextLines, projectRoot) {
  // Group by file
  const byFile = new Map();
  for (const todo of todos) {
    if (!byFile.has(todo.file)) {
      byFile.set(todo.file, []);
    }
    byFile.get(todo.file).push(todo);
  }

  for (const [file, fileTodos] of byFile) {
    out.add(`📄 ${file}`);

    for (const todo of fileTodos) {
      const marker = MARKERS[todo.type] || MARKERS.TODO;
      let line = `   ${marker.emoji} L${todo.line}: ${todo.message}`;
      if (todo.author) {
        line += ` (@${todo.author})`;
      }
      out.add(line);

      // Add context if requested
      if (contextLines > 0) {
        const context = getContext(file, todo.line, contextLines, projectRoot);
        if (context) {
          for (const ctx of context) {
            const prefix = ctx.isTodo ? ' → ' : '   ';
            out.add(`      ${ctx.num.toString().padStart(4)}${prefix}${ctx.content}`);
          }
        }
      }
    }
    out.blank();
  }
}

function formatSummary(todos, out) {
  const counts = {};
  for (const marker of Object.keys(MARKERS)) {
    counts[marker] = 0;
  }

  for (const todo of todos) {
    counts[todo.type] = (counts[todo.type] || 0) + 1;
  }

  const parts = [];
  for (const [type, count] of Object.entries(counts)) {
    if (count > 0) {
      parts.push(`${MARKERS[type].emoji} ${count} ${type}`);
    }
  }

  return parts.join('  ');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let filterType = null;
let filterAuthor = null;
let sortByPriority = false;
let contextLines = 0;

const consumedIndices = new Set();

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--type' || arg === '-t') && options.remaining[i + 1]) {
    filterType = options.remaining[i + 1].toUpperCase();
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++;
  } else if (arg === '--author' && options.remaining[i + 1]) {
    filterAuthor = options.remaining[i + 1].replace(/^@/, '');
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++;
  } else if (arg === '--priority' || arg === '-p') {
    sortByPriority = true;
    consumedIndices.add(i);
  } else if ((arg === '--context' || arg === '-c') && options.remaining[i + 1]) {
    contextLines = parseInt(options.remaining[i + 1], 10);
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

const out = createOutput(options);

out.header(`\n📋 TODOs: ${relPath === '.' ? basename(projectRoot) : relPath}`);

let todos = findTodos(resolvedPath, projectRoot);

// Apply filters
if (filterType) {
  todos = todos.filter(t => t.type === filterType);
}
if (filterAuthor) {
  todos = todos.filter(t => t.author && t.author.toLowerCase() === filterAuthor.toLowerCase());
}

// Sort
if (sortByPriority) {
  todos.sort((a, b) => a.priority - b.priority || a.file.localeCompare(b.file));
} else {
  todos.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (todos.length === 0) {
  out.header('   No markers found! ✨');
  out.print();
  process.exit(0);
}

out.header(`   ${todos.length} markers found`);
out.blank();

formatTodos(todos, out, contextLines, projectRoot);

out.stats('─'.repeat(50));
out.stats(`📊 ${formatSummary(todos, out)}`);
out.blank();

// JSON data
out.setData('path', relPath);
out.setData('count', todos.length);
out.setData('todos', todos);

out.print();
