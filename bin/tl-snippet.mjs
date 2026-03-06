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
import {
  findJsTsDefinitions,
  getJsTsSuggestionCandidates,
  isJsTsFile
} from '../src/semantic-js.mjs';
import { rgCommand } from '../src/shell.mjs';

const HELP = `
tl-snippet - Extract a function/class body by name

Usage: tl-snippet <name[,name2,...]> [file] [options]

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

Multiple names (comma-separated):
  tl-snippet getCached,setCached src/cache.mjs

Examples:
  tl-snippet handleSubmit src/form.ts     # Extract handleSubmit from file
  tl-snippet useAuth                      # Find and extract useAuth hook
  tl-snippet getCached,setCached,withCache src/cache.mjs  # Multiple at once
  tl-snippet Router.get src/server.ts     # Extract class method
  tl-snippet parseConfig -c 3            # Include 3 lines of context
`;

// ─────────────────────────────────────────────────────────────
// Definition Finding (via ripgrep)
// ─────────────────────────────────────────────────────────────

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findDefinitions(name, searchPath) {
  const escapedName = escapeRegExp(name);
  const patterns = [
    `function ${escapedName}\\s*[(<]`,                 // function name( or name<T>(
    `(const|let|var)\\s+${escapedName}\\s*=`,          // const name =
    `${escapedName}\\s*:\\s*\\(`,                       // name: ( (object method shorthand)
    `(?:async\\s+)?${escapedName}\\s*\\([^)]*\\)\\s*(?::\\s*\\w[^{]*)?\\{`, // name() { (class method, single-line)
    `(?:(?:public|private|protected|static|abstract|override|readonly)\\s+)*(?:async\\s+)?${escapedName}\\s*\\(`, // name( (class method, multi-line params)
    `(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapedName}`,  // class Name
    `(?:export\\s+)?interface\\s+${escapedName}`,       // interface Name
    `(?:export\\s+)?type\\s+${escapedName}\\s*[=<]`,    // type Name =
    `(?:export\\s+)?enum\\s+${escapedName}`,            // enum Name
    `(?:pub(?:\\([^)]*\\))?\\s+)?fn\\s+${escapedName}\\s*[(<]`,  // Rust: fn name( / pub fn name(
    `def\\s+${escapedName}\\s*($|[(<])`,                 // Ruby/Python: def name / def name(
    `(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${escapedName}`,  // Rust: struct Name
    `(?:pub(?:\\([^)]*\\))?\\s+)?trait\\s+${escapedName}`,   // Rust: trait Name
    `impl(?:\\s+\\w+\\s+for)?\\s+${escapedName}`,       // Rust: impl Name / impl Trait for Name
    `(?:public|private|protected)?\\s*(?:static\\s+)?(?:class|interface)\\s+${escapedName}`, // Java/C#/Kotlin
    `func\\s+${escapedName}\\s*[(<]`,                   // Go/Swift: func name(
    `func\\s*\\([^)]*\\)\\s*${escapedName}\\s*\\(`,      // Go: func (recv) name(
    `type\\s+${escapedName}\\s+(?:struct|interface)`,     // Go: type Name struct/interface
    `function\\s+\\w+\\.${escapedName}\\s*\\(`,           // Lua: function M.name(
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
      // Skip call sites: this.name(, obj.name(, foo?.name(, await this.name(
      // But not Lua-style definitions: function M.name(
      if (new RegExp(`[.?]\\s*${escapedName}\\s*\\(`).test(trimmed) && !trimmed.startsWith('function ')) continue;
      // Skip variable assignments that just call the function: const x = name(
      if (new RegExp(`(?:const|let|var)\\s+\\w+\\s*=\\s*(?:await\\s+)?${escapedName}\\s*\\(`).test(trimmed)) continue;

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

function getFileLines(filePath, fileLinesCache = null) {
  if (fileLinesCache && fileLinesCache.has(filePath)) {
    return fileLinesCache.get(filePath);
  }

  let lines = null;
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    lines = null;
  }

  if (fileLinesCache) fileLinesCache.set(filePath, lines);
  return lines;
}

/**
 * Indentation-based body extraction for Python.
 * Finds the end of a block by tracking indent level.
 */
function extractPythonBody(filePath, startLine, contextLines = 0, fileLinesCache = null) {
  const lines = getFileLines(filePath, fileLinesCache);
  if (!lines) return null;
  const defIdx = startLine - 1;
  if (defIdx < 0 || defIdx >= lines.length) return null;

  // Get indent of the definition line
  const defLine = lines[defIdx];
  if (typeof defLine !== 'string') return null;
  const defIndent = defLine.match(/^(\s*)/)[1].length;

  // For multi-line signatures (e.g., def foo(\n    arg1,\n    arg2\n):)
  // scan forward to find the colon that ends the signature
  let bodyStartIdx = defIdx;
  if (defLine.includes('(') && !defLine.trimEnd().endsWith(':')) {
    for (let i = defIdx; i < Math.min(defIdx + 20, lines.length); i++) {
      if (lines[i].trimEnd().endsWith(':')) {
        bodyStartIdx = i;
        break;
      }
    }
  }

  // Scan forward from the line after the signature
  let endIdx = bodyStartIdx;
  for (let i = bodyStartIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank lines and comments are part of the block
    if (trimmed === '' || trimmed.startsWith('#')) {
      // But trailing blanks at end shouldn't extend the block —
      // we'll trim them after finding the real end
      continue;
    }

    const lineIndent = line.match(/^(\s*)/)[1].length;

    // Line at same or lesser indent = block ended
    if (lineIndent <= defIndent) {
      break;
    }

    endIdx = i;

    // Safety: don't scan more than 500 lines
    if (i - defIdx > 500) break;
  }

  const ctxStart = Math.max(0, defIdx - contextLines);
  const ctxEnd = Math.min(lines.length - 1, endIdx + contextLines);
  return {
    lines: lines.slice(ctxStart, ctxEnd + 1),
    startLine: ctxStart + 1,
    endLine: ctxEnd + 1
  };
}

const END_KW_EXTS = new Set(['.rb', '.ex', '.exs', '.lua']);

// Block-opening keywords per language family
const RUBY_OPEN_RE = /\b(def|do|if|unless|case|for|while|until|begin|class|module)\b/g;
const ELIXIR_OPEN_RE = /\bdo\b/g; // In Elixir, only `do` opens blocks
const LUA_OPEN_RE = /\b(function|if|for|while)\b/g; // repeat...until has no end
const BLOCK_CLOSE_RE = /\bend\b/g;

/**
 * End-keyword body extraction for Ruby, Elixir, Lua.
 * Tracks nested block-open/close keywords to find the matching `end`.
 */
function extractEndKeywordBody(filePath, startLine, contextLines = 0, fileLinesCache = null) {
  const lines = getFileLines(filePath, fileLinesCache);
  if (!lines) return null;
  const defIdx = startLine - 1;
  if (defIdx < 0 || defIdx >= lines.length) return null;

  const ext = extname(filePath);
  const openRe = ext === '.rb' ? RUBY_OPEN_RE
    : (ext === '.ex' || ext === '.exs') ? ELIXIR_OPEN_RE
    : LUA_OPEN_RE;

  let depth = 0;
  for (let i = defIdx; i < lines.length; i++) {
    const stripped = stripStringsAndComments(lines[i], filePath);

    const opens = [...stripped.matchAll(openRe)].length;
    const closes = [...stripped.matchAll(BLOCK_CLOSE_RE)].length;
    depth += opens - closes;

    if (i > defIdx && depth <= 0) {
      const ctxStart = Math.max(0, defIdx - contextLines);
      const ctxEnd = Math.min(lines.length - 1, i + contextLines);
      return {
        lines: lines.slice(ctxStart, ctxEnd + 1),
        startLine: ctxStart + 1,
        endLine: ctxEnd + 1
      };
    }

    // Safety
    if (i - defIdx > 500) break;
  }

  // Fallback
  const ctxStart = Math.max(0, defIdx - contextLines);
  const ctxEnd = Math.min(lines.length - 1, defIdx + 30);
  return {
    lines: lines.slice(ctxStart, ctxEnd + 1),
    startLine: ctxStart + 1,
    endLine: ctxEnd + 1
  };
}

/**
 * Strip string literals and comments from a line so keyword counting
 * isn't fooled by `end` inside strings or comments.
 */
function stripStringsAndComments(line, filePath) {
  const isLua = filePath.endsWith('.lua');
  let result = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if (prev === '\\') { result += ' '; continue; }

    if (!inSingle && !inDouble) {
      // Line comments: # (Ruby/Elixir) or -- (Lua)
      if (ch === '#' && !isLua) break;
      if (ch === '-' && line[i + 1] === '-' && isLua) break;
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      result += ch;
    } else if (inSingle && ch === "'") {
      inSingle = false;
    } else if (inDouble && ch === '"') {
      inDouble = false;
    }
  }

  return result;
}

function extractBody(filePath, startLine, contextLines = 0, fileLinesCache = null) {
  // Python: use indentation-based extraction
  if (filePath.endsWith('.py')) {
    return extractPythonBody(filePath, startLine, contextLines, fileLinesCache);
  }

  // Ruby, Elixir, Lua: use end-keyword extraction
  if (END_KW_EXTS.has(extname(filePath))) {
    return extractEndKeywordBody(filePath, startLine, contextLines, fileLinesCache);
  }

  const lines = getFileLines(filePath, fileLinesCache);
  if (!lines) return null;
  const defIdx = startLine - 1; // 0-based
  if (defIdx < 0 || defIdx >= lines.length) return null;

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

function extractExactBody(filePath, def, contextLines = 0, fileLinesCache = null) {
  const lines = getFileLines(filePath, fileLinesCache);
  if (!lines) return null;

  const startLine = Number.isInteger(def.line) ? def.line : null;
  const endLine = Number.isInteger(def.endLine) ? def.endLine : startLine;
  if (!startLine || !endLine) return null;

  const startIdx = Math.max(0, startLine - 1 - contextLines);
  const endIdx = Math.min(lines.length - 1, endLine - 1 + contextLines);

  return {
    lines: lines.slice(startIdx, endIdx + 1),
    startLine: startIdx + 1,
    endLine: endIdx + 1
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

// Parse qualified name: file:method or Class.method syntax
function parseQualifiedName(raw) {
  let name = raw;
  let cls = null;
  let file = targetFile;

  // Handle file:method syntax (e.g., src/utils.ts:parseArgs)
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx > 0) {
    const possibleFile = raw.substring(0, colonIdx);
    const possibleMethod = raw.substring(colonIdx + 1);
    if (possibleFile && possibleMethod) {
      if (!file) file = possibleFile;
      name = possibleMethod;
    }
  }

  // Handle Class.method syntax (e.g., SaveManager.save)
  const KNOWN_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'json', 'md', 'css', 'html', 'vue', 'svelte']);
  if (name === raw && raw.includes('.')) {
    const dotIdx = raw.lastIndexOf('.');
    const possibleOwner = raw.substring(0, dotIdx);
    const possibleMethod = raw.substring(dotIdx + 1);
    if (possibleOwner && possibleMethod && !KNOWN_EXTS.has(possibleMethod.toLowerCase())) {
      cls = possibleOwner;
      name = possibleMethod;
    }
  }

  return { name, className: cls, targetFile: file };
}

// Find the enclosing class/impl/module for a method at a given line
function findEnclosingClass(filePath, lineNum, fileLinesCache = null) {
  const lines = getFileLines(filePath, fileLinesCache);
  if (!lines) return null;
  const defIdx = lineNum - 1; // 0-based
  if (defIdx < 0 || defIdx >= lines.length) return null;

  const ext = extname(filePath);

  // Python: indentation-based
  if (ext === '.py') {
    const defLine = lines[defIdx];
    const defIndent = defLine.match(/^(\s*)/)[1].length;
    for (let i = defIdx - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent < defIndent) {
        const classMatch = trimmed.match(/^class\s+(\w+)/);
        if (classMatch) return classMatch[1];
        return null; // hit a non-class scope (function, module-level) — no enclosing class
      }
    }
    return null;
  }

  // Ruby: end-keyword based
  if (ext === '.rb') {
    let depth = 0;
    for (let i = defIdx - 1; i >= 0; i--) {
      const stripped = stripStringsAndComments(lines[i], filePath);
      const opens = [...stripped.matchAll(RUBY_OPEN_RE)].length;
      const closes = [...stripped.matchAll(BLOCK_CLOSE_RE)].length;
      depth += closes - opens; // reversed: scanning backwards
      if (depth < 0) {
        const trimmed = lines[i].trim();
        const classMatch = trimmed.match(/^(?:class|module)\s+(\w+)/);
        if (classMatch) return classMatch[1];
        return null;
      }
    }
    return null;
  }

  // Elixir
  if (ext === '.ex' || ext === '.exs') {
    let depth = 0;
    for (let i = defIdx - 1; i >= 0; i--) {
      const stripped = stripStringsAndComments(lines[i], filePath);
      const opens = [...stripped.matchAll(ELIXIR_OPEN_RE)].length;
      const closes = [...stripped.matchAll(BLOCK_CLOSE_RE)].length;
      depth += closes - opens;
      if (depth < 0) {
        const trimmed = lines[i].trim();
        const modMatch = trimmed.match(/^defmodule\s+([\w.]+)/);
        if (modMatch) return modMatch[1];
        return null;
      }
    }
    return null;
  }

  // Brace-delimited languages (Rust, Java, TS, Go, C#, etc.)
  let braceDepth = 0;
  for (let i = defIdx - 1; i >= 0; i--) {
    const { open, close } = countBraces(lines[i]);
    braceDepth += close - open; // reversed: scanning backwards
    if (braceDepth < 0) {
      // We've exited a block — check this line for class/impl/struct/interface
      const trimmed = lines[i].trim();
      const implMatch = trimmed.match(/impl(?:<[^{]*?>)?\s+(?:\w+\s+for\s+)?(\w+)/);
      if (implMatch) return implMatch[1];
      const classMatch = trimmed.match(/(?:class|struct|interface|trait|enum|protocol|record|union)\s+(\w+)/);
      if (classMatch) return classMatch[1];
      // Go: type Name struct
      const goMatch = trimmed.match(/type\s+(\w+)\s+(?:struct|interface)/);
      if (goMatch) return goMatch[1];
      // Module/namespace
      const modMatch = trimmed.match(/(?:module|namespace)\s+(\w+)/);
      if (modMatch) return modMatch[1];
      return null; // found a block but not a class-like construct
    }
  }
  return null;
}

function extractSuggestionName(sig) {
  if (!sig || typeof sig !== 'string') return null;
  const cleaned = sig
    .replace(/^export\s+(default\s+)?/, '')
    .replace(/^(?:async\s+)?function\s+/, '')
    .replace(/^(?:const|let|var)\s+/, '')
    .replace(/^(?:class|interface|type|enum)\s+/, '')
    .replace(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|trait|mod|type|const|static)\s+/, '')
    .replace(/^def\s+(?:self\.)?/, '')
    .replace(/^func\s+(?:\([^)]*\)\s*)?/, '')
    .trim();

  const match = cleaned.match(/^([A-Za-z_$][\w$]*[!?=]?)/);
  return match ? match[1] : null;
}

function collectSymbolCandidates(symbols) {
  if (!symbols || typeof symbols !== 'object') return [];
  const seen = new Set();
  const candidates = [];

  function add(name) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    candidates.push(name);
  }

  for (const fn of symbols.functions || []) {
    add(extractSuggestionName(typeof fn === 'string' ? fn : fn.signature || String(fn)));
  }
  for (const cls of symbols.classes || []) {
    add(extractSuggestionName(typeof cls === 'string' ? cls : cls.signature || String(cls)));
  }
  for (const t of symbols.types || []) {
    add(extractSuggestionName(typeof t === 'string' ? t : t.signature || String(t)));
  }
  for (const c of symbols.constants || []) {
    add(extractSuggestionName(typeof c === 'string' ? c : c.signature || String(c)));
  }
  for (const m of symbols.modules || []) {
    add(extractSuggestionName(typeof m === 'string' ? m : m.signature || String(m)));
  }

  return candidates;
}

function rankSymbolSuggestions(candidates, query, limit = 12) {
  const q = (query || '').toLowerCase();
  const scored = candidates.map((name, idx) => {
    const n = name.toLowerCase();
    let score = 0;
    if (n === q) score = 100;
    else if (q && n.startsWith(q)) score = 80;
    else if (q && n.includes(q)) score = 60;
    else if (q && (n.replace(/[!?=]/g, '') === q.replace(/[!?=]/g, ''))) score = 50;
    return { name, score, idx };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const best = scored.filter(s => s.score > 0);
  if (best.length > 0) {
    return best.slice(0, limit).map(s => s.name);
  }

  return scored.slice(0, limit).map(s => s.name);
}

function getCompactSymbolSuggestions(filePath, query) {
  if (isJsTsFile(filePath)) {
    const candidates = getJsTsSuggestionCandidates(filePath);
    if (candidates.length > 0) {
      const suggestions = rankSymbolSuggestions(candidates, query, 12);
      return { suggestions, total: candidates.length };
    }
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const symbolsTool = join(__dirname, 'tl-symbols.mjs');
  const result = spawnSync(process.execPath, [symbolsTool, filePath, '-j'], {
    encoding: 'utf-8',
    timeout: 5000
  });
  if (result.status !== 0 || !result.stdout) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    const candidates = collectSymbolCandidates(parsed.symbols);
    const suggestions = rankSymbolSuggestions(candidates, query, 12);
    return { suggestions, total: candidates.length };
  } catch {
    return null;
  }
}

// Split comma-separated names (but not if name contains file:method with commas in path)
const nameList = rawName.includes(',') ? rawName.split(',').filter(Boolean) : [rawName];

const projectRoot = findProjectRoot();
const out = createOutput(options);
const allResults = [];
const fileLinesCache = new Map();
let hadErrors = false;

for (let ni = 0; ni < nameList.length; ni++) {
  const parsed = parseQualifiedName(nameList[ni].trim());
  const { name, className } = parsed;
  const file = parsed.targetFile;
  const displayName = className ? `${className}.${name}` : name;

  if (ni > 0) out.blank();

  if (file && !getFileLines(file, fileLinesCache)) {
    out.add(`Target file not found or unreadable: ${file}`);
    hadErrors = true;
    continue;
  }

  // Find definitions
  const searchPath = file || projectRoot;
  const semanticDefs = findJsTsDefinitions(name, searchPath, { className });
  let defs = semanticDefs.length > 0 ? semanticDefs : findDefinitions(name, searchPath);

  // Filter by className if specified — scope-aware check
  if (className && defs.length > 0 && semanticDefs.length === 0) {
    const filtered = defs.filter(def => {
      const enclosing = findEnclosingClass(def.file, def.line, fileLinesCache);
      return enclosing === className;
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

    // Show compact symbol suggestions only for single-name mode
    if (nameList.length === 1 && file) {
      const suggestionResult = getCompactSymbolSuggestions(file, name);
      if (suggestionResult?.suggestions?.length > 0) {
        out.blank();
        out.add('Closest symbols:');
        for (const s of suggestionResult.suggestions) {
          out.add(`  ${s}`);
        }
        const remaining = suggestionResult.total - suggestionResult.suggestions.length;
        if (remaining > 0) {
          out.add(`  ... and ${remaining} more (use tl-symbols ${file} for full list)`);
        }
      }
    }
    continue;
  }

  // Extract and display
  const maxResults = showAll ? defs.length : 1;

  for (let i = 0; i < Math.min(maxResults, defs.length); i++) {
    const def = defs[i];
    const body = semanticDefs.length > 0
      ? extractExactBody(def.file, def, contextLines, fileLinesCache)
      : extractBody(def.file, def.line, contextLines, fileLinesCache);
    if (!body) continue;

    const relPath = relative(projectRoot, def.file);
    const bodyText = body.lines.join('\n');
    const tokens = estimateTokens(bodyText);
    const lineCount = body.endLine - body.startLine + 1;

    allResults.push({
      name: displayName,
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
}

// JSON data
out.setData('names', nameList.length === 1 ? nameList[0] : nameList);
out.setData('results', allResults);
out.setData('totalDefinitions', allResults.length);

out.print();
if (hadErrors) process.exit(1);
