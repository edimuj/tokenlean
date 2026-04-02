#!/usr/bin/env node

/**
 * tl-symbols - Extract function/class/type signatures without bodies
 *
 * Shows the API surface of a file in minimal tokens - signatures only,
 * no implementation details. Perfect for understanding what a file
 * provides without reading the whole thing.
 *
 * Usage: tl-symbols <file> [--exports-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-symbols',
    desc: 'Function/class signatures without bodies',
    when: 'before-read',
    example: 'tl-symbols src/utils.ts'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { extractGenericSymbols } from '../src/generic-lang.mjs';
import { shouldSkip } from '../src/project.mjs';
import { getJsTsSemanticFacts } from '../src/semantic-js.mjs';
import { extractJsSymbols, filterExportsOnlySymbols } from '../src/symbols-js.mjs';
import { extractPythonSymbols } from '../src/symbols-python.mjs';
import { extractGoSymbols } from '../src/symbols-go.mjs';
import { extractRustSymbols } from '../src/symbols-rust.mjs';
import { extractRubySymbols } from '../src/symbols-ruby.mjs';
import {
  formatSymbols,
  countSymbols,
  extractSymbolNames,
  applySymbolFilter,
  tryFastFunctionFilterNames
} from '../src/symbols-format.mjs';

const HELP = `
tl-symbols - Extract function/class/type signatures without bodies

Usage: tl-symbols <file|dir...> [options]

Options:
  --exports-only, -e    Show only exported symbols
  --filter <type>       Show only: function, class, type, constant, export
${COMMON_OPTIONS_HELP}

Multi-file mode:
  Multiple files or a directory produce compact one-line-per-file output.
  Format: path: name1(), name2(), ClassName(3m), +N

Examples:
  tl-symbols src/api.ts              # All symbols (detailed)
  tl-symbols src/api.ts src/db.ts    # Multiple files (compact)
  tl-symbols src/                    # All files in directory
  tl-symbols src/ -e                 # Exports only, all files
  tl-symbols src/api.ts -e           # Exports only
  tl-symbols src/api.ts -j           # JSON output


Supported languages:
  JavaScript/TypeScript (.js, .ts, .jsx, .tsx, .mjs)
  Python (.py)
  Go (.go)
  Rust (.rs)
  Ruby (.rb)
  Other languages: generic regex-based extraction (best-effort)
`;

// ─────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────

const LANG_EXTENSIONS = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb']
};

function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

// All extensions tl-symbols can handle (dedicated + generic fallback)
const ALL_SUPPORTED_EXTS = new Set([
  ...LANG_EXTENSIONS.js, ...LANG_EXTENSIONS.python, ...LANG_EXTENSIONS.go,
  ...LANG_EXTENSIONS.rust, ...LANG_EXTENSIONS.ruby,
  '.kt', '.kts', '.swift', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs', '.scala', '.zig', '.lua', '.r', '.R', '.ex', '.exs', '.erl', '.hrl',
  '.hs', '.ml', '.mli', '.php', '.dart', '.v', '.sv',
]);

// ─────────────────────────────────────────────────────────────
// File Collection & Symbol Extraction
// ─────────────────────────────────────────────────────────────

function collectFiles(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        collectFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ALL_SUPPORTED_EXTS.has(ext) && !shouldSkip(entry.name, false)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function extractSymbolsForFile(filePath, exportsOnly) {
  const lang = detectLanguage(filePath);
  let symbols;

  if (lang === 'js') {
    const facts = getJsTsSemanticFacts(filePath);
    if (facts?.symbols) {
      symbols = facts.symbols;
    }
  }

  if (!symbols) {
    const content = readFileSync(filePath, 'utf-8');
    switch (lang) {
      case 'js': symbols = extractJsSymbols(content, exportsOnly); break;
      case 'python': symbols = extractPythonSymbols(content); break;
      case 'go': symbols = extractGoSymbols(content); break;
      case 'rust': symbols = extractRustSymbols(content); break;
      case 'ruby': symbols = extractRubySymbols(content); break;
      default: symbols = extractGenericSymbols(content); break;
    }
  }

  return { symbols, lang };
}

// ─────────────────────────────────────────────────────────────
// Multi-File Mode
// ─────────────────────────────────────────────────────────────

function runMultiFileMode(files, baseDir, exportsOnly, filterType, options) {
  if (files.length === 0) {
    console.error(`No code files found`);
    process.exit(1);
  }

  const out = createOutput(options);
  let totalSymbols = 0;
  let totalFiles = 0;
  const jsonFiles = [];
  const MAX_INLINE = 8;

  for (const file of files) {
    try {
      const lang = detectLanguage(file);
      let names = tryFastFunctionFilterNames(file, lang, exportsOnly, filterType, readFileSync);
      if (!names) {
        const { symbols } = extractSymbolsForFile(file, exportsOnly);
        applySymbolFilter(symbols, filterType);
        names = extractSymbolNames(symbols, lang, exportsOnly || filterType === 'export');
      }
      if (names.length === 0) continue;

      totalFiles++;
      totalSymbols += names.length;
      const relPath = baseDir ? relative(baseDir, file) : basename(file);

      let line;
      if (names.length <= MAX_INLINE) {
        line = `${relPath}: ${names.join(', ')}`;
      } else {
        line = `${relPath}: ${names.slice(0, MAX_INLINE).join(', ')}, +${names.length - MAX_INLINE}`;
      }
      out.add(line);

      if (options.json) {
        jsonFiles.push({ file: relPath, language: lang || 'generic', symbols: names });
      }
    } catch {
      // Skip files that can't be read/parsed
    }
  }

  if (options.json) {
    out.setData('files', jsonFiles);
    out.setData('totalFiles', totalFiles);
    out.setData('totalSymbols', totalSymbols);
  } else {
    out.blank();
    out.add(`${totalFiles} files, ${totalSymbols} symbols`);
  }

  out.print();
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const exportsOnly = options.remaining.includes('--exports-only') || options.remaining.includes('-e');

let filterType = null;
for (let i = 0; i < options.remaining.length; i++) {
  if (options.remaining[i] === '--filter' && options.remaining[i + 1]) {
    filterType = options.remaining[++i].toLowerCase();
  }
}

const VALID_FILTERS = ['function', 'class', 'type', 'constant', 'export'];
if (filterType && !VALID_FILTERS.includes(filterType)) {
  console.error(`Invalid filter: "${filterType}". Must be one of: ${VALID_FILTERS.join(', ')}`);
  process.exit(1);
}

const paths = options.remaining.filter(a => !a.startsWith('-') && !VALID_FILTERS.includes(a.toLowerCase()));

if (options.help || paths.length === 0) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

for (const p of paths) {
  if (!existsSync(p)) {
    console.error(`Not found: ${p}`);
    process.exit(1);
  }
}

// Multi-path mode: directory or 2+ files -> compact output
if (paths.length > 1 || statSync(paths[0]).isDirectory()) {
  const allFiles = [];
  let baseDir = null;
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      baseDir = baseDir || p;
      allFiles.push(...collectFiles(p));
    } else {
      allFiles.push(p);
    }
  }
  allFiles.sort();
  runMultiFileMode(allFiles, baseDir, exportsOnly, filterType, options);
  process.exit(0);
}

// Single-file mode (detailed)
const filePath = paths[0];
const lang = detectLanguage(filePath);

const content = readFileSync(filePath, 'utf-8');
const fullFileTokens = estimateTokens(content);

let symbols;
let isGeneric = false;
if (lang === 'js') {
  const facts = getJsTsSemanticFacts(filePath, { content });
  symbols = facts?.symbols || null;
  if (symbols && exportsOnly) {
    symbols = filterExportsOnlySymbols(symbols);
  }
}

if (!symbols) {
  switch (lang) {
    case 'js':
      symbols = extractJsSymbols(content, exportsOnly);
      break;
    case 'python':
      symbols = extractPythonSymbols(content);
      break;
    case 'go':
      symbols = extractGoSymbols(content);
      break;
    case 'rust':
      symbols = extractRustSymbols(content);
      break;
    case 'ruby':
      symbols = extractRubySymbols(content);
      break;
    default:
      symbols = extractGenericSymbols(content);
      isGeneric = true;
      break;
  }
}

applySymbolFilter(symbols, filterType);

const symbolCount = countSymbols(symbols);
const out = createOutput(options);

// Set JSON data
out.setData('file', basename(filePath));
out.setData('language', lang || 'generic');
out.setData('symbolCount', symbolCount);
out.setData('fullFileTokens', fullFileTokens);
out.setData('symbols', symbols);
if (isGeneric) out.setData('generic', true);

// Build text output
if (isGeneric) {
  out.header(`\n! Generic extraction (no dedicated ${extname(filePath)} parser)`);
}
const allTag = symbols.all ? `, __all__: ${symbols.all.length} public` : '';
out.header(`\n${basename(filePath)} (${symbolCount} symbols${allTag})`);
out.header(`   Full file: ~${formatTokens(fullFileTokens)} tokens -> Symbols only: ~${formatTokens(Math.ceil(symbolCount * 15))} tokens`);
out.blank();

formatSymbols(symbols, isGeneric ? 'generic' : lang, out);

out.print();
