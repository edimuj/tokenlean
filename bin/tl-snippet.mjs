#!/usr/bin/env node

/**
 * tl-snippet - Extract a function/class body by name
 *
 * Returns just the code you need instead of reading entire files.
 * Like tl-symbols but gives you the implementation, not just signatures.
 *
 * Usage: tl-snippet <name> <file> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-snippet',
    desc: 'Extract function/class body by name',
    when: 'before-read',
    example: 'tl-snippet handleSubmit src/form.ts'
  }));
  process.exit(0);
}

import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { rgCommand } from '../src/shell.mjs';

const HELP = `
tl-snippet - Extract a function/class body by name

Usage: tl-snippet <name> [file] [options]

Extracts the full implementation of a function, class, method, or type.
Much more token-efficient than reading entire files.

Options:
  --context N, -c N     Include N lines of context above/below (default: 0)
  --all                 Show all matches, not just the first
${COMMON_OPTIONS_HELP}

Supports qualified names:
  tl-snippet save                     # Find 'save' in project
  tl-snippet SaveManager.save         # Method 'save' in SaveManager class
  tl-snippet src/utils.ts:parseArgs   # Function in specific file

Examples:
  tl-snippet handleSubmit src/form.ts     # Extract handleSubmit from file
  tl-snippet useAuth                      # Find and extract useAuth hook
  tl-snippet Router.get src/server.ts     # Extract class method
  tl-snippet parseConfig -c 3            # Include 3 lines of context
`;

// ─────────────────────────────────────────────────────────────
// Definition Finding (via ripgrep)
// ─────────────────────────────────────────────────────────────

function findDefinitions(name, searchPath) {
  const patterns = [
    `function ${name}\\s*[(<]`,                 // function name( or name<T>(
    `(const|let|var)\\s+${name}\\s*=`,          // const name =
    `${name}\\s*:\\s*\\(`,                       // name: ( (object method shorthand)
    `(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*(?::\\s*\\w[^{]*)?\\{`, // name() { (class method)
    `(?:export\\s+)?(?:abstract\\s+)?class\\s+${name}`,  // class Name
    `(?:export\\s+)?interface\\s+${name}`,       // interface Name
    `(?:export\\s+)?type\\s+${name}\\s*[=<]`,    // type Name =
    `(?:export\\s+)?enum\\s+${name}`,            // enum Name
    `(?:pub(?:\\([^)]*\\))?\\s+)?fn\\s+${name}\\s*[(<]`,  // Rust: fn name( / pub fn name(
    `def\\s+${name}\\s*[(<]`,                    // Ruby/Python: def name(
    `(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${name}`,  // Rust: struct Name
    `(?:pub(?:\\([^)]*\\))?\\s+)?trait\\s+${name}`,   // Rust: trait Name
    `impl(?:\\s+\\w+\\s+for)?\\s+${name}`,       // Rust: impl Name / impl Trait for Name
    `(?:public|private|protected)?\\s*(?:static\\s+)?(?:class|interface)\\s+${name}`, // Java/C#/Kotlin
    `func\\s+${name}\\s*[(<]`,                   // Go/Swift: func name(
  ];

  const pattern = `(${patterns.join('|')})`;
  const defs = [];

  const result = rgCommand(['-n', '-H', '--glob', '*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,rb,java,kt,swift,c,cpp,h,hpp,cs,php,scala,ex,exs,lua,zig,nim}', '--no-heading', '-e', pattern, searchPath]);

  if (result) {
    for (const line of result.split('\n')) {
      if (!line) continue;
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [, file, lineNum, content] = match;
      if (file.includes('node_modules')) continue;

      // Skip imports/requires
      const trimmed = content.trim();
      if (trimmed.startsWith('import ') || trimmed.includes('require(')) continue;
      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      defs.push({
        file,
        line: parseInt(lineNum, 10),
        content: trimmed
      });
    }
  }

  return defs;
}

// ─────────────────────────────────────────────────────────────
// Body Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Count net braces in a line, ignoring those inside strings, template
 * literals, regex, and comments.
 */
function countBraces(line) {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    // Skip escaped characters
    if (prev === '\\') continue;

    if (inLineComment) break; // Rest of line is comment

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && line[i + 1] === '/') { inLineComment = true; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '`') { inTemplate = true; continue; }
      if (ch === '{') open++;
      if (ch === '}') close++;
    } else if (inSingle && ch === "'") {
      inSingle = false;
    } else if (inDouble && ch === '"') {
      inDouble = false;
    } else if (inTemplate && ch === '`') {
      inTemplate = false;
    }
  }

  return { open, close };
}

function extractBody(filePath, startLine, contextLines = 0) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const defIdx = startLine - 1; // 0-based

  // Check if this line has an opening brace within 5 lines
  let foundOpen = false;
  let isSingleLine = false;

  for (let i = defIdx; i < Math.min(defIdx + 5, lines.length); i++) {
    const { open } = countBraces(lines[i]);
    if (open > 0) {
      foundOpen = true;
      break;
    }
    // Single-line definition (type alias, const, etc.)
    if (lines[i].includes(';') && !foundOpen) {
      isSingleLine = true;
      break;
    }
  }

  // For single-line definitions, find the ending semicolon
  if (isSingleLine || !foundOpen) {
    let endIdx = defIdx;
    let parenCount = 0;
    let angleCount = 0;
    for (let i = defIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '(') parenCount++;
        if (ch === ')') parenCount--;
        if (ch === '<') angleCount++;
        if (ch === '>') angleCount--;
      }
      if (lines[i].includes(';') && parenCount <= 0 && angleCount <= 0) {
        endIdx = i;
        break;
      }
      if (i - defIdx > 30) { endIdx = i; break; }
    }

    const ctxStart = Math.max(0, defIdx - contextLines);
    const ctxEnd = Math.min(lines.length - 1, endIdx + contextLines);
    return {
      lines: lines.slice(ctxStart, ctxEnd + 1),
      startLine: ctxStart + 1,
      endLine: ctxEnd + 1
    };
  }

  // Track braces (string-aware) to find the end of the body
  let braceCount = 0;
  let opened = false;

  for (let i = defIdx; i < lines.length; i++) {
    const { open, close } = countBraces(lines[i]);
    braceCount += open - close;
    if (open > 0) opened = true;

    if (opened && braceCount <= 0) {
      const ctxStart = Math.max(0, defIdx - contextLines);
      const ctxEnd = Math.min(lines.length - 1, i + contextLines);
      return {
        lines: lines.slice(ctxStart, ctxEnd + 1),
        startLine: ctxStart + 1,
        endLine: ctxEnd + 1
      };
    }

    // Safety: don't scan more than 500 lines
    if (i - defIdx > 500) break;
  }

  // Fallback: return from def line to what we have
  const ctxStart = Math.max(0, defIdx - contextLines);
  const ctxEnd = Math.min(lines.length - 1, defIdx + 30);
  return {
    lines: lines.slice(ctxStart, ctxEnd + 1),
    startLine: ctxStart + 1,
    endLine: ctxEnd + 1
  };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

// Parse tool-specific options
let contextLines = 0;
let showAll = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--context' || arg === '-c') && options.remaining[i + 1]) {
    contextLines = Math.max(0, parseInt(options.remaining[++i], 10) || 0);
  } else if (arg === '--all') {
    showAll = true;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const rawName = remaining[0];
let targetFile = remaining[1] || null;

if (!rawName) {
  console.log(HELP);
  process.exit(1);
}

// Parse qualified names: file:method or Class.method syntax
let name = rawName;
let className = null;

// Handle file:method syntax (e.g., src/utils.ts:parseArgs)
const colonIdx = rawName.lastIndexOf(':');
if (colonIdx > 0) {
  const possibleFile = rawName.substring(0, colonIdx);
  const possibleMethod = rawName.substring(colonIdx + 1);
  if (possibleFile && possibleMethod) {
    if (!targetFile) targetFile = possibleFile;
    name = possibleMethod;
  }
}

// Handle Class.method syntax (e.g., SaveManager.save)
const KNOWN_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'json', 'md', 'css', 'html', 'vue', 'svelte']);
if (name === rawName && rawName.includes('.')) {
  const dotIdx = rawName.lastIndexOf('.');
  const possibleOwner = rawName.substring(0, dotIdx);
  const possibleMethod = rawName.substring(dotIdx + 1);
  if (possibleOwner && possibleMethod && !KNOWN_EXTS.has(possibleMethod.toLowerCase())) {
    className = possibleOwner;
    name = possibleMethod;
  }
}

const projectRoot = findProjectRoot();
const out = createOutput(options);
const displayName = className ? `${className}.${name}` : name;

// Find definitions
const searchPath = targetFile || projectRoot;
let defs = findDefinitions(name, searchPath);

if (defs.length === 0 && targetFile) {
  // Try searching the whole project if file-specific search failed
  defs = findDefinitions(name, projectRoot);
}

// Filter by className if specified
if (className && defs.length > 0) {
  const filtered = defs.filter(def => {
    const fileName = basename(def.file, extname(def.file));
    if (fileName === className || fileName.toLowerCase() === className.toLowerCase()) {
      return true;
    }
    try {
      const content = readFileSync(def.file, 'utf-8');
      return content.includes(`class ${className}`) ||
             content.includes(`interface ${className}`) ||
             content.includes(`const ${className}`);
    } catch { return false; }
  });
  if (filtered.length > 0) defs = filtered;
}

// Deduplicate by file:line
const seen = new Set();
defs = defs.filter(d => {
  const key = `${d.file}:${d.line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

if (defs.length === 0) {
  out.add(`No definition found for "${displayName}"`);

  // Show available symbols so the agent doesn't need a separate tl-symbols call
  if (targetFile) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const symbolsTool = join(__dirname, 'tl-symbols.mjs');
    const result = spawnSync(process.execPath, [symbolsTool, targetFile], {
      encoding: 'utf-8',
      timeout: 5000
    });
    if (result.stdout && result.status === 0) {
      out.blank();
      out.add('Available symbols:');
      out.add(result.stdout.trimEnd());
    }
  }

  out.print();
  process.exit(1);
}

// Extract and display
const maxResults = showAll ? defs.length : 1;
const results = [];

for (let i = 0; i < Math.min(maxResults, defs.length); i++) {
  const def = defs[i];
  const body = extractBody(def.file, def.line, contextLines);
  if (!body) continue;

  const relPath = relative(projectRoot, def.file);
  const bodyText = body.lines.join('\n');
  const tokens = estimateTokens(bodyText);
  const lineCount = body.endLine - body.startLine + 1;

  results.push({
    file: relPath,
    startLine: body.startLine,
    endLine: body.endLine,
    lineCount,
    tokens,
    body: bodyText
  });

  if (!options.quiet) {
    out.add(`── ${relPath}:${body.startLine}-${body.endLine} (${lineCount} lines, ~${formatTokens(tokens)})`);
  }

  // Add line numbers to output
  const startNum = body.startLine;
  for (let j = 0; j < body.lines.length; j++) {
    const lineNum = startNum + j;
    const prefix = String(lineNum).padStart(4);
    out.add(`${prefix}│ ${body.lines[j]}`);
  }

  if (i < Math.min(maxResults, defs.length) - 1) {
    out.blank();
  }
}

if (!showAll && defs.length > 1) {
  out.blank();
  out.add(`Found ${defs.length} definitions. Use --all to show all.`);
  for (const def of defs.slice(1, 5)) {
    const rel = relative(projectRoot, def.file);
    out.add(`  ${rel}:${def.line}`);
  }
  if (defs.length > 5) {
    out.add(`  ... and ${defs.length - 5} more`);
  }
}

// JSON data
out.setData('name', displayName);
out.setData('results', results);
out.setData('totalDefinitions', defs.length);

out.print();
