#!/usr/bin/env node

/**
 * tl-example - Find diverse, representative usage examples
 *
 * Unlike grep/search which returns every match, tl-example picks
 * 3-5 diverse examples from different files with surrounding context.
 * Smart selection, not exhaustive listing.
 *
 * Usage: tl-example <pattern> [dir] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-example',
    desc: 'Find diverse usage examples of a symbol/pattern',
    when: 'before-read',
    example: 'tl-example useAuth'
  }));
  process.exit(0);
}

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, relative, dirname, basename, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP,
  shellEscape
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { listFiles, isRipgrepAvailable } from '../src/traverse.mjs';

const HELP = `
tl-example - Find diverse, representative usage examples

Usage: tl-example <pattern> [dir] [options]

Unlike search which returns every match, tl-example picks
diverse examples from different files with surrounding context.
Smart selection, not exhaustive listing.

Options:
  --count N, -n N       Number of examples to show (default: 5)
  --context N, -C N     Lines of context around match (default: 4)
  --glob <pattern>      File glob filter (e.g. "*.tsx")
  --type <type>         File type filter (e.g. "ts", "py")
  --def                 Prefer definitions over usages
  --usage               Prefer usages over definitions (default)
${COMMON_OPTIONS_HELP}

Examples:
  tl-example useAuth                  # Find usage examples
  tl-example "createUser" -n 3        # Show 3 examples
  tl-example "useState" src/          # Search in specific dir
  tl-example "Router" -C 8            # More context lines
  tl-example "fetchData" --type ts    # Only TypeScript files
  tl-example "handleSubmit" --def     # Find definitions
`;

// ─────────────────────────────────────────────────────────────
// File Type Matching
// ─────────────────────────────────────────────────────────────

const TYPE_MAP = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  ruby: ['.rb'],
  php: ['.php'],
  css: ['.css', '.scss', '.sass', '.less'],
  html: ['.html', '.htm'],
  json: ['.json'],
  yaml: ['.yml', '.yaml'],
  md: ['.md'],
};

function matchesType(fileName, type) {
  const exts = TYPE_MAP[type];
  if (!exts) return false;
  return exts.some(ext => fileName.endsWith(ext));
}

function matchesGlob(fileName, glob) {
  // Simple glob: *.tsx, *.{ts,tsx}, etc.
  if (glob.startsWith('*.')) {
    const ext = glob.slice(1); // .tsx
    if (ext.startsWith('.{') && ext.endsWith('}')) {
      const exts = ext.slice(2, -1).split(',').map(e => '.' + e.trim());
      return exts.some(e => fileName.endsWith(e));
    }
    return fileName.endsWith(ext);
  }
  return fileName.includes(glob);
}

// ─────────────────────────────────────────────────────────────
// Search (ripgrep with Node.js fallback)
// ─────────────────────────────────────────────────────────────

function searchWithRg(pattern, dir, options = {}) {
  const { glob, type } = options;

  let cmd = `rg -n --no-heading --max-count 5 --max-columns 300`;
  if (glob) cmd += ` --glob "${shellEscape(glob)}"`;
  if (type) cmd += ` --type ${type}`;
  cmd += ` --glob "!node_modules" --glob "!.git" --glob "!dist" --glob "!build"`;
  cmd += ` --glob "!coverage" --glob "!*.min.*" --glob "!*.map" --glob "!*.lock"`;
  cmd += ` "${shellEscape(pattern)}" "${shellEscape(dir)}"`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return null; // null signals fallback needed (vs [] = no matches)
  }
}

function searchWithNode(pattern, dir, options = {}) {
  const { glob, type } = options;
  const files = listFiles(dir);
  const regex = new RegExp(pattern);
  const results = [];
  const MAX_MATCHES = 200;  // Enough to select diverse examples from
  const MAX_PER_FILE = 5;

  for (const file of files) {
    if (file.binary) continue;
    if (type && !matchesType(file.name, type)) continue;
    if (glob && !matchesGlob(file.name, glob)) continue;

    // Skip large files (> 500KB)
    if (file.size && file.size > 512000) continue;

    try {
      const content = readFileSync(file.path, 'utf-8');
      const lines = content.split('\n');
      let fileMatches = 0;

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${file.path}:${i + 1}:${lines[i]}`);
          fileMatches++;
          if (fileMatches >= MAX_PER_FILE) break;
        }
      }
    } catch { /* skip unreadable */ }

    if (results.length >= MAX_MATCHES) break;
  }

  return results;
}

function search(pattern, dir, options) {
  // Try ripgrep first
  if (isRipgrepAvailable()) {
    const results = searchWithRg(pattern, dir, options);
    if (results !== null) return results;
  }

  // Fallback to Node.js search
  return searchWithNode(pattern, dir, options);
}

// ─────────────────────────────────────────────────────────────
// Match Parsing
// ─────────────────────────────────────────────────────────────

function parseMatches(lines, dir) {
  const matches = [];

  for (const line of lines) {
    // Format: file:line:content
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;

    const [, filePath, lineNo, content] = m;
    const relPath = relative(dir, filePath);

    matches.push({
      file: filePath,
      relPath,
      dir: dirname(relPath),
      line: parseInt(lineNo, 10),
      content: content.trim(),
      basename: basename(filePath)
    });
  }

  return matches;
}

// ─────────────────────────────────────────────────────────────
// Usage Classification
// ─────────────────────────────────────────────────────────────

function classifyMatch(match) {
  const c = match.content;

  // Definitions
  if (/^\s*(export\s+)?(function|class|const|let|var|type|interface|enum)\s/.test(c)) return 'definition';
  if (/^\s*(export\s+)?default\s+(function|class)/.test(c)) return 'definition';
  if (/^\s*def\s/.test(c)) return 'definition';  // Python
  if (/^\s*func\s/.test(c)) return 'definition';  // Go

  // Imports
  if (/^\s*(import|from|require)\s/.test(c)) return 'import';

  // Test files
  if (/\.(test|spec|e2e)\.[^.]+$/.test(match.basename)) return 'test';

  // Type annotations
  if (/^\s*(type|interface)\s/.test(c)) return 'type';

  return 'usage';
}

// ─────────────────────────────────────────────────────────────
// Smart Selection
// ─────────────────────────────────────────────────────────────

function selectDiverse(matches, count, preferDef) {
  if (matches.length <= count) return matches;

  // Classify all matches
  for (const m of matches) {
    m.kind = classifyMatch(m);
  }

  // Score each match for diversity
  const selected = [];
  const usedFiles = new Set();
  const usedDirs = new Set();
  const usedKinds = new Set();

  // Sort by priority: prefer what the user asked for
  // Imports are always lowest — they're the least informative
  const priorityOrder = preferDef
    ? ['definition', 'usage', 'test', 'type', 'import']
    : ['usage', 'definition', 'test', 'type', 'import'];

  // Build candidate pool sorted by priority
  const candidates = [...matches].sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a.kind);
    const bIdx = priorityOrder.indexOf(b.kind);
    return aIdx - bIdx;
  });

  // Round 1: Pick one from each unique directory (diversity)
  for (const m of candidates) {
    if (selected.length >= count) break;
    if (!usedDirs.has(m.dir)) {
      selected.push(m);
      usedFiles.add(m.file);
      usedDirs.add(m.dir);
      usedKinds.add(m.kind);
    }
  }

  // Round 2: Pick from new files (still unseen)
  for (const m of candidates) {
    if (selected.length >= count) break;
    if (!usedFiles.has(m.file)) {
      selected.push(m);
      usedFiles.add(m.file);
      usedDirs.add(m.dir);
      usedKinds.add(m.kind);
    }
  }

  // Round 3: Pick by new usage kind
  for (const m of candidates) {
    if (selected.length >= count) break;
    if (!usedKinds.has(m.kind) && !selected.includes(m)) {
      selected.push(m);
      usedKinds.add(m.kind);
    }
  }

  // Round 4: Fill remaining from unseen matches
  for (const m of candidates) {
    if (selected.length >= count) break;
    if (!selected.includes(m)) {
      selected.push(m);
    }
  }

  return selected.slice(0, count);
}

// ─────────────────────────────────────────────────────────────
// Context Extraction
// ─────────────────────────────────────────────────────────────

function getContext(filePath, matchLine, contextLines) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const start = Math.max(0, matchLine - 1 - contextLines);
    const end = Math.min(lines.length, matchLine + contextLines);

    const result = [];
    for (let i = start; i < end; i++) {
      const lineNo = i + 1;
      const marker = lineNo === matchLine ? '>' : ' ';
      const lineContent = lines[i];
      // Truncate long lines
      const display = lineContent.length > 120 ? lineContent.slice(0, 117) + '...' : lineContent;
      result.push({ lineNo, marker, content: display });
    }

    return result;
  } catch {
    return [{ lineNo: matchLine, marker: '>', content: '(could not read file)' }];
  }
}

// ─────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────

function displayExamples(out, pattern, selected, totalMatches, totalFiles, contextLines, dir) {
  // Stats line
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  out.header(`${pattern} — ${selected.length} examples from ${totalMatches} matches across ${totalFiles} ${fileWord}`);

  for (const match of selected) {
    out.blank();

    // File header with kind tag
    const kindTag = match.kind && match.kind !== 'usage' ? ` [${match.kind}]` : '';
    out.add(`─── ${match.relPath}:${match.line}${kindTag} ───`);

    // Context lines
    const ctx = getContext(match.file, match.line, contextLines);
    const maxLineNo = Math.max(...ctx.map(c => c.lineNo));
    const pad = String(maxLineNo).length;

    for (const line of ctx) {
      const num = String(line.lineNo).padStart(pad);
      out.add(`${line.marker} ${num} │ ${line.content}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  let count = 5;
  let contextLines = 4;
  let glob = null;
  let type = null;
  let preferDef = false;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--count' || arg === '-n') {
      count = parseInt(args[++i], 10) || 5;
    } else if (arg === '--context' || arg === '-C') {
      contextLines = parseInt(args[++i], 10) || 4;
    } else if (arg === '--glob') {
      glob = args[++i];
    } else if (arg === '--type') {
      type = args[++i];
    } else if (arg === '--def') {
      preferDef = true;
    } else if (arg === '--usage') {
      preferDef = false;
    } else {
      filteredArgs.push(arg);
    }
  }

  const opts = parseCommonArgs(filteredArgs);

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  if (opts.remaining.length === 0) {
    console.log(HELP.trim());
    process.exit(0);
  }

  const pattern = opts.remaining[0];
  const dir = resolve(opts.remaining[1] || findProjectRoot() || '.');

  // Search
  const rawMatches = search(pattern, dir, { glob, type });

  if (rawMatches.length === 0) {
    console.error(`No matches found for "${pattern}"`);
    process.exit(1);
  }

  // Parse
  const matches = parseMatches(rawMatches, dir);
  const totalFiles = new Set(matches.map(m => m.file)).size;

  // Select diverse examples
  const selected = selectDiverse(matches, count, preferDef);

  // Sort selected by file path for readable output
  selected.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.line - b.line);

  // Output
  const out = createOutput(opts);

  if (opts.json) {
    out.setData('pattern', pattern);
    out.setData('totalMatches', matches.length);
    out.setData('totalFiles', totalFiles);
    out.setData('examples', selected.map(m => ({
      file: m.relPath,
      line: m.line,
      kind: m.kind,
      content: m.content,
      context: getContext(m.file, m.line, contextLines).map(c => ({
        lineNo: c.lineNo,
        isMatch: c.marker === '>',
        content: c.content
      }))
    })));
  }

  displayExamples(out, pattern, selected, matches.length, totalFiles, contextLines, dir);
  out.print();
}

main();
