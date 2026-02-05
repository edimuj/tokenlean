#!/usr/bin/env node

/**
 * tl-style - Detect coding conventions from actual code
 *
 * Analyzes source files to extract the dominant coding style.
 * Gives agents a compact style guide so they write matching code.
 *
 * Usage: tl-style [dir] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-style',
    desc: 'Detect coding conventions from actual code',
    when: 'before-modify',
    example: 'tl-style src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import { join, extname, basename, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { listFiles } from '../src/traverse.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-style - Detect coding conventions from actual code

Usage: tl-style [dir] [options]

Analyzes source files and reports the dominant coding style.
Gives agents a compact style guide so they write matching code.

Options:
  --full                Show percentages for all stats
  --sample N            Max files to analyze (default: 50)
${COMMON_OPTIONS_HELP}

Examples:
  tl-style                        # Analyze current project
  tl-style src/                   # Analyze specific directory
  tl-style --full                 # Show detailed percentages
  tl-style -j                     # JSON output
`;

// ─────────────────────────────────────────────────────────────
// Language Detection & File Filtering
// ─────────────────────────────────────────────────────────────

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const PY_EXTS = new Set(['.py', '.pyi']);
const GO_EXTS = new Set(['.go']);

function detectLanguage(files) {
  const counts = { js: 0, ts: 0, py: 0, go: 0, other: 0 };
  for (const f of files) {
    const ext = extname(f.name).toLowerCase();
    if (TS_EXTS.has(ext)) counts.ts++;
    else if (JS_EXTS.has(ext)) counts.js++;
    else if (PY_EXTS.has(ext)) counts.py++;
    else if (GO_EXTS.has(ext)) counts.go++;
    else counts.other++;
  }

  // Combined JS/TS if both exist
  const jsTs = counts.js + counts.ts;
  if (jsTs >= counts.py && jsTs >= counts.go) {
    if (counts.ts > 0) return 'typescript';
    if (counts.js > 0) return 'javascript';
  }
  if (counts.py >= jsTs && counts.py >= counts.go) return 'python';
  if (counts.go >= jsTs && counts.go >= counts.py) return 'go';
  return 'javascript'; // fallback
}

function isSourceFile(name, lang) {
  const ext = extname(name).toLowerCase();
  if (lang === 'typescript' || lang === 'javascript') {
    return JS_EXTS.has(ext) || TS_EXTS.has(ext);
  }
  if (lang === 'python') return PY_EXTS.has(ext);
  if (lang === 'go') return GO_EXTS.has(ext);
  return false;
}

// ─────────────────────────────────────────────────────────────
// File Sampling
// ─────────────────────────────────────────────────────────────

function sampleFiles(allFiles, lang, maxSample) {
  const source = allFiles.filter(f => isSourceFile(f.name, lang) && !f.binary);

  if (source.length <= maxSample) return source;

  // Sample diversely from different directories
  const byDir = {};
  for (const f of source) {
    const dir = f.relativePath ? f.relativePath.replace(/\/[^/]+$/, '') : '.';
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push(f);
  }

  const dirs = Object.keys(byDir);
  const perDir = Math.max(1, Math.floor(maxSample / dirs.length));
  const sampled = [];

  for (const dir of dirs) {
    const files = byDir[dir];
    // Pick evenly spaced files from each directory
    const step = Math.max(1, Math.floor(files.length / perDir));
    for (let i = 0; i < files.length && sampled.length < maxSample; i += step) {
      sampled.push(files[i]);
    }
  }

  return sampled.slice(0, maxSample);
}

// ─────────────────────────────────────────────────────────────
// Stats Accumulator
// ─────────────────────────────────────────────────────────────

function createStats() {
  return {
    formatting: {
      singleQuotes: 0, doubleQuotes: 0,
      withSemi: 0, withoutSemi: 0,
      tabIndent: 0, spaceIndent: 0,
      indentSizes: {},         // { 2: count, 4: count }
      trailingCommaYes: 0, trailingCommaNo: 0,
      bracketSameLine: 0, bracketNextLine: 0,
      lineLengths: []
    },
    imports: {
      esm: 0, cjs: 0,
      namedImport: 0, defaultImport: 0,
      typeImport: 0
    },
    naming: {
      files: { kebab: 0, camel: 0, pascal: 0, snake: 0, flat: 0 },
      functions: { camel: 0, pascal: 0, snake: 0 },
      constants: { upperSnake: 0, camel: 0, pascal: 0 }
    },
    patterns: {
      constDecl: 0, letDecl: 0, varDecl: 0,
      arrowFn: 0, fnDecl: 0, fnExpr: 0,
      asyncAwait: 0, thenChain: 0,
      namedExport: 0, defaultExport: 0,
      lineComment: 0, blockComment: 0,
      jsdoc: 0
    },
    // Python-specific
    python: {
      singleQuotes: 0, doubleQuotes: 0,
      fStrings: 0,
      typeHints: 0, noTypeHints: 0,
      docstringDouble: 0, docstringSingle: 0
    }
  };
}

// ─────────────────────────────────────────────────────────────
// JS/TS Analysis
// ─────────────────────────────────────────────────────────────

function analyzeJsTs(content, stats, fileName) {
  const lines = content.split('\n');
  let inBlockComment = false;
  let prevNonEmpty = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    const stripped = trimmed.trimStart();

    // Track line lengths (non-empty lines only)
    if (stripped.length > 0) {
      stats.formatting.lineLengths.push(trimmed.length);
    }

    // Block comment tracking
    if (inBlockComment) {
      if (stripped.includes('*/')) inBlockComment = false;
      continue;
    }
    if (stripped.startsWith('/*')) {
      if (stripped.startsWith('/**')) stats.patterns.jsdoc++;
      else stats.patterns.blockComment++;
      if (!stripped.includes('*/')) inBlockComment = true;
      continue;
    }
    if (stripped.startsWith('//')) {
      stats.patterns.lineComment++;
      continue;
    }
    if (stripped === '') continue;

    // --- Indentation ---
    if (trimmed !== stripped) {  // has leading whitespace
      const leading = trimmed.match(/^(\s+)/);
      if (leading) {
        const ws = leading[1];
        if (ws[0] === '\t') {
          stats.formatting.tabIndent++;
        } else {
          stats.formatting.spaceIndent++;
          const size = ws.length;
          // Only record plausible indent levels
          if (size <= 16) {
            stats.formatting.indentSizes[size] = (stats.formatting.indentSizes[size] || 0) + 1;
          }
        }
      }
    }

    // --- Quotes (from imports — most reliable signal) ---
    if (/^\s*(import\s|.*\sfrom\s)/.test(stripped)) {
      if (/from\s+'/.test(stripped) || /^import\s+'/.test(stripped)) stats.formatting.singleQuotes++;
      else if (/from\s+"/.test(stripped) || /^import\s+"/.test(stripped)) stats.formatting.doubleQuotes++;
    }
    if (/require\(/.test(stripped)) {
      if (/require\('/.test(stripped)) stats.formatting.singleQuotes++;
      else if (/require\("/.test(stripped)) stats.formatting.doubleQuotes++;
    }

    // --- Semicolons (on statement-like lines) ---
    if (/^\s*(import|export|const|let|var|return|throw|type|interface)\s/.test(stripped) ||
        /^\s*\w+(\.\w+)*\(/.test(stripped)) {
      if (trimmed.endsWith(';')) stats.formatting.withSemi++;
      else if (!trimmed.endsWith('{') && !trimmed.endsWith(',') && !trimmed.endsWith('(')) {
        stats.formatting.withoutSemi++;
      }
    }

    // --- Trailing commas (before closing bracket) ---
    if (/^[}\]]/.test(stripped) && prevNonEmpty) {
      if (prevNonEmpty.endsWith(',')) stats.formatting.trailingCommaYes++;
      else if (!prevNonEmpty.endsWith('{') && !prevNonEmpty.endsWith('[')) {
        stats.formatting.trailingCommaNo++;
      }
    }

    // --- Opening bracket position ---
    // function foo() {   ← same line
    // function foo()     ← next line if followed by {
    if (/\)\s*\{$/.test(trimmed) || /\belse\s*\{$/.test(trimmed) || /=>\s*\{$/.test(trimmed)) {
      stats.formatting.bracketSameLine++;
    }

    // --- Imports ---
    if (/^\s*import\s/.test(stripped)) {
      stats.imports.esm++;
      if (/import\s+type\s/.test(stripped)) stats.imports.typeImport++;
      else if (/import\s*\{/.test(stripped)) stats.imports.namedImport++;
      else if (/import\s+\w/.test(stripped) && !/import\s*\*/.test(stripped)) stats.imports.defaultImport++;
    }
    if (/\brequire\(/.test(stripped)) stats.imports.cjs++;

    // --- Variable declarations ---
    if (/^\s*const\s/.test(stripped) || /^\s*export\s+const\s/.test(stripped)) stats.patterns.constDecl++;
    if (/^\s*let\s/.test(stripped) || /^\s*export\s+let\s/.test(stripped)) stats.patterns.letDecl++;
    if (/^\s*var\s/.test(stripped)) stats.patterns.varDecl++;

    // --- Function style ---
    if (/^\s*(export\s+)?(async\s+)?function\s+\w/.test(stripped)) stats.patterns.fnDecl++;
    if (/=\s*(async\s+)?\(.*\)\s*=>/.test(stripped) || /=\s*(async\s+)?\w+\s*=>/.test(stripped)) {
      stats.patterns.arrowFn++;
    }

    // --- Async style ---
    if (/\bawait\s/.test(stripped)) stats.patterns.asyncAwait++;
    if (/\.then\(/.test(stripped)) stats.patterns.thenChain++;

    // --- Export style ---
    if (/^\s*export\s+(default|=)/.test(stripped)) stats.patterns.defaultExport++;
    else if (/^\s*export\s+(const|function|class|type|interface|enum|async)/.test(stripped)) {
      stats.patterns.namedExport++;
    }

    // --- Function naming ---
    let fnMatch = stripped.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$]\w*)/);
    if (fnMatch) classifyFunctionName(fnMatch[1], stats);
    fnMatch = stripped.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s+)?(?:\(|[a-zA-Z_$]\w*\s*=>)/);
    if (fnMatch) classifyFunctionName(fnMatch[1], stats);

    // --- Constant naming (UPPER_SNAKE detection) ---
    const constMatch = stripped.match(/^\s*(?:export\s+)?const\s+([A-Z][A-Z_\d]+)\s*=/);
    if (constMatch) stats.naming.constants.upperSnake++;

    prevNonEmpty = stripped;
  }

  // --- File naming ---
  const stem = basename(fileName).replace(/\.[^.]+$/, '');
  classifyFileName(stem, stats);
}

// ─────────────────────────────────────────────────────────────
// Python Analysis
// ─────────────────────────────────────────────────────────────

function analyzePython(content, stats, fileName) {
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const stripped = trimmed.trimStart();
    if (stripped === '' || stripped.startsWith('#')) continue;

    if (stripped.length > 0) {
      stats.formatting.lineLengths.push(trimmed.length);
    }

    // Indentation
    if (trimmed !== stripped) {
      const leading = trimmed.match(/^(\s+)/);
      if (leading) {
        const ws = leading[1];
        if (ws[0] === '\t') stats.formatting.tabIndent++;
        else {
          stats.formatting.spaceIndent++;
          const size = ws.length;
          if (size <= 16) {
            stats.formatting.indentSizes[size] = (stats.formatting.indentSizes[size] || 0) + 1;
          }
        }
      }
    }

    // Quotes (from imports)
    if (/^\s*(from|import)\s/.test(stripped)) {
      if (/'/.test(stripped)) stats.python.singleQuotes++;
      else if (/"/.test(stripped)) stats.python.doubleQuotes++;
    }

    // General string quotes
    if (/^\s*\w+\s*=\s*'/.test(stripped)) stats.python.singleQuotes++;
    else if (/^\s*\w+\s*=\s*"/.test(stripped)) stats.python.doubleQuotes++;

    // f-strings
    if (/\bf['"]/.test(stripped)) stats.python.fStrings++;

    // Type hints
    if (/:\s*(str|int|float|bool|list|dict|Optional|Union|Any|Tuple)\b/.test(stripped) ||
        /\)\s*->\s*\w/.test(stripped)) {
      stats.python.typeHints++;
    }

    // Docstrings
    if (/^\s*"""/.test(stripped)) stats.python.docstringDouble++;
    else if (/^\s*'''/.test(stripped)) stats.python.docstringSingle++;

    // Function naming
    const fnMatch = stripped.match(/^\s*def\s+([a-zA-Z_]\w*)/);
    if (fnMatch && !fnMatch[1].startsWith('_')) {
      classifyFunctionName(fnMatch[1], stats);
    }
  }

  const stem = basename(fileName).replace(/\.[^.]+$/, '');
  classifyFileName(stem, stats);
}

// ─────────────────────────────────────────────────────────────
// Naming Classification
// ─────────────────────────────────────────────────────────────

function classifyFunctionName(name, stats) {
  if (/^[A-Z][A-Z_\d]+$/.test(name)) return; // UPPER_SNAKE constant, skip
  if (/^[A-Z]/.test(name)) stats.naming.functions.pascal++;
  else if (/_/.test(name)) stats.naming.functions.snake++;
  else stats.naming.functions.camel++;
}

function classifyFileName(stem, stats) {
  if (stem.startsWith('_') || stem === 'index') return; // skip
  if (/^[A-Z][a-z]/.test(stem) && !/[-_]/.test(stem)) stats.naming.files.pascal++;
  else if (/-/.test(stem)) stats.naming.files.kebab++;
  else if (/_/.test(stem)) stats.naming.files.snake++;
  else if (/^[a-z]/.test(stem) && /[A-Z]/.test(stem)) stats.naming.files.camel++;
  else stats.naming.files.flat++;
}

// ─────────────────────────────────────────────────────────────
// Config File Detection
// ─────────────────────────────────────────────────────────────

const CONFIG_FILES = [
  { name: '.prettierrc', type: 'json' },
  { name: '.prettierrc.json', type: 'json' },
  { name: 'prettier.config.js', type: 'exists' },
  { name: 'prettier.config.mjs', type: 'exists' },
  { name: '.eslintrc', type: 'json' },
  { name: '.eslintrc.json', type: 'json' },
  { name: 'eslint.config.js', type: 'exists' },
  { name: 'eslint.config.mjs', type: 'exists' },
  { name: '.editorconfig', type: 'ini' },
  { name: 'tsconfig.json', type: 'json' },
  { name: 'biome.json', type: 'json' },
  { name: 'biome.jsonc', type: 'exists' },
  { name: '.stylelintrc.json', type: 'json' },
  { name: 'deno.json', type: 'json' },
];

function findConfigs(dir) {
  const found = [];

  for (const cfg of CONFIG_FILES) {
    const path = join(dir, cfg.name);
    if (!existsSync(path)) continue;

    const entry = { name: cfg.name, settings: {} };

    if (cfg.type === 'json') {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        entry.settings = extractKeySettings(cfg.name, parsed);
      } catch { /* ignore parse errors */ }
    } else if (cfg.type === 'ini' && cfg.name === '.editorconfig') {
      try {
        const raw = readFileSync(path, 'utf-8');
        entry.settings = parseEditorConfig(raw);
      } catch { /* ignore */ }
    }

    found.push(entry);
  }

  return found;
}

function extractKeySettings(name, obj) {
  const settings = {};

  if (name.includes('prettier')) {
    const keys = ['semi', 'singleQuote', 'tabWidth', 'useTabs', 'trailingComma',
      'printWidth', 'arrowParens', 'bracketSpacing', 'endOfLine'];
    for (const k of keys) {
      if (obj[k] !== undefined) settings[k] = obj[k];
    }
  } else if (name.includes('eslint')) {
    if (obj.extends) settings.extends = Array.isArray(obj.extends) ? obj.extends : [obj.extends];
    if (obj.parser) settings.parser = obj.parser;
  } else if (name === 'tsconfig.json') {
    const co = obj.compilerOptions || {};
    const keys = ['strict', 'target', 'module', 'jsx', 'baseUrl', 'paths'];
    for (const k of keys) {
      if (co[k] !== undefined) settings[k] = co[k];
    }
  } else if (name.includes('biome')) {
    if (obj.formatter) settings.formatter = obj.formatter;
    if (obj.linter?.enabled !== undefined) settings.linter = obj.linter.enabled;
  }

  return settings;
}

function parseEditorConfig(raw) {
  const settings = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(indent_style|indent_size|end_of_line|trim_trailing_whitespace|insert_final_newline)\s*=\s*(.+)/);
    if (m) settings[m[1].trim()] = m[2].trim();
  }
  return settings;
}

// ─────────────────────────────────────────────────────────────
// Results Formatting
// ─────────────────────────────────────────────────────────────

function pct(a, b) {
  const total = a + b;
  if (total === 0) return null;
  return Math.round((a / total) * 100);
}

function dominant(a, aLabel, b, bLabel, threshold = 60) {
  const total = a + b;
  if (total === 0) return null;
  const p = Math.round((a / total) * 100);
  if (p >= threshold) return { label: aLabel, pct: p };
  if (p <= 100 - threshold) return { label: bLabel, pct: 100 - p };
  return { label: 'mixed', pct: Math.max(p, 100 - p) };
}

function dominantMulti(counts, threshold = 50) {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  if (total === 0) return null;

  const sorted = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) return null;
  const [label, count] = sorted[0];
  const p = Math.round((count / total) * 100);
  return { label, pct: p, runner: sorted[1] ? { label: sorted[1][0], pct: Math.round((sorted[1][1] / total) * 100) } : null };
}

function detectIndentSize(sizes) {
  // Find the GCD of the most common indent levels
  const entries = Object.entries(sizes)
    .map(([s, c]) => [parseInt(s), c])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  // Check if 2-space or 4-space dominates
  const two = (sizes['2'] || 0) + (sizes['4'] || 0) + (sizes['6'] || 0) + (sizes['8'] || 0);
  const four = (sizes['4'] || 0) + (sizes['8'] || 0) + (sizes['12'] || 0);

  // If most indent levels are divisible by 4, it's 4-space
  if (four > 0 && (sizes['2'] || 0) === 0 && (sizes['6'] || 0) === 0) return 4;
  // If 2-based levels dominate, it's 2-space
  if (two > four) return 2;
  if (four > 0) return 4;
  return entries[0][0]; // fallback to most common
}

function lineStats(lengths) {
  if (lengths.length === 0) return null;
  const sorted = [...lengths].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const max = sorted[sorted.length - 1];
  return { p50, p95, max };
}

function fmtStat(result, full) {
  if (!result) return null;
  if (full) return `${result.label} (${result.pct}%)`;
  return result.label;
}

// ─────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────

function displayResults(out, stats, lang, filesAnalyzed, configs, full) {
  const f = stats.formatting;
  const im = stats.imports;
  const n = stats.naming;
  const p = stats.patterns;

  const langLabel = lang === 'typescript' ? 'TypeScript' :
    lang === 'javascript' ? 'JavaScript' :
    lang === 'python' ? 'Python' : lang;

  out.header(`${langLabel} conventions (${filesAnalyzed} files analyzed)`);
  out.blank();

  // --- Formatting ---
  out.add('Formatting:');
  const isPython = lang === 'python';

  const quoteResult = isPython
    ? dominant(stats.python.singleQuotes, 'single', stats.python.doubleQuotes, 'double')
    : dominant(f.singleQuotes, 'single', f.doubleQuotes, 'double');
  if (quoteResult) out.add(`  quotes:           ${fmtStat(quoteResult, full)}`);

  if (!isPython) {
    const semiResult = dominant(f.withSemi, 'yes', f.withoutSemi, 'no');
    if (semiResult) out.add(`  semicolons:       ${fmtStat(semiResult, full)}`);
  }

  const indentResult = dominant(f.tabIndent, 'tabs', f.spaceIndent, 'spaces');
  if (indentResult) {
    let indentStr = fmtStat(indentResult, full);
    if (indentResult.label === 'spaces') {
      const size = detectIndentSize(f.indentSizes);
      if (size) indentStr = `${size} spaces` + (full ? ` (${indentResult.pct}%)` : '');
    }
    out.add(`  indent:           ${indentStr}`);
  }

  if (!isPython) {
    const tcResult = dominant(f.trailingCommaYes, 'yes', f.trailingCommaNo, 'no');
    if (tcResult) out.add(`  trailing commas:  ${fmtStat(tcResult, full)}`);

    const brResult = dominant(f.bracketSameLine, 'same line', f.bracketNextLine, 'next line');
    if (brResult) out.add(`  bracket style:    ${fmtStat(brResult, full)}`);
  }

  const ls = lineStats(f.lineLengths);
  if (ls) out.add(`  line length:      ~${ls.p50} median, ${ls.p95} p95`);

  // --- Imports ---
  if (!isPython && (im.esm > 0 || im.cjs > 0)) {
    out.blank();
    out.add('Imports:');
    const modResult = dominant(im.esm, 'ESM (import/export)', im.cjs, 'CJS (require)');
    if (modResult) out.add(`  module system:    ${fmtStat(modResult, full)}`);

    const impResult = dominant(im.namedImport, 'named', im.defaultImport, 'default');
    if (impResult) out.add(`  import style:     ${impResult.label} preferred` + (full ? ` (${impResult.pct}%)` : ''));

    if (im.typeImport > 0) out.add(`  type imports:     ${im.typeImport} found`);
  }

  // --- Naming ---
  const fnNaming = dominantMulti(n.functions);
  const fileNaming = dominantMulti(n.files);
  if (fnNaming || fileNaming) {
    out.blank();
    out.add('Naming:');
    if (fileNaming) {
      let s = `  files:            ${fileNaming.label}`;
      if (full) s += ` (${fileNaming.pct}%)`;
      if (fileNaming.runner && fileNaming.runner.pct > 15) {
        s += `, also ${fileNaming.runner.label}`;
        if (full) s += ` (${fileNaming.runner.pct}%)`;
      }
      out.add(s);
    }
    if (fnNaming) {
      let s = `  functions:        ${fnNaming.label}`;
      if (full) s += ` (${fnNaming.pct}%)`;
      out.add(s);
    }
    if (n.constants.upperSnake > 0) {
      out.add(`  constants:        UPPER_SNAKE (${n.constants.upperSnake} found)`);
    }
  }

  // --- Patterns ---
  if (!isPython) {
    out.blank();
    out.add('Patterns:');

    const totalDecl = p.constDecl + p.letDecl + p.varDecl;
    if (totalDecl > 0) {
      const parts = [];
      if (p.constDecl > 0) parts.push(`const ${full ? `(${Math.round(p.constDecl / totalDecl * 100)}%)` : ''}`);
      if (p.letDecl > 0) parts.push(`let ${full ? `(${Math.round(p.letDecl / totalDecl * 100)}%)` : ''}`);
      if (p.varDecl > 0) parts.push(`var ${full ? `(${Math.round(p.varDecl / totalDecl * 100)}%)` : ''}`);
      out.add(`  variables:        ${parts.join(' / ').replace(/\s+/g, ' ')}`);
    }

    const fnResult = dominant(p.arrowFn, 'arrow', p.fnDecl, 'declaration');
    if (fnResult) out.add(`  functions:        ${fmtStat(fnResult, full)}`);

    const asyncResult = dominant(p.asyncAwait, 'async/await', p.thenChain, '.then()');
    if (asyncResult) out.add(`  async:            ${fmtStat(asyncResult, full)}`);

    const expResult = dominant(p.namedExport, 'named', p.defaultExport, 'default');
    if (expResult) out.add(`  exports:          ${fmtStat(expResult, full)}`);

    const totalComment = p.lineComment + p.blockComment + p.jsdoc;
    if (totalComment > 0) {
      const parts = [];
      if (p.lineComment > 0) parts.push(`// (${p.lineComment})`);
      if (p.jsdoc > 0) parts.push(`/** JSDoc (${p.jsdoc})`);
      if (p.blockComment > 0) parts.push(`/* block (${p.blockComment})`);
      out.add(`  comments:         ${parts.join(', ')}`);
    }
  }

  // --- Python-specific ---
  if (isPython) {
    const py = stats.python;
    out.blank();
    out.add('Python:');
    if (py.fStrings > 0) out.add(`  f-strings:        ${py.fStrings} found`);
    const thResult = dominant(py.typeHints, 'yes', py.noTypeHints, 'no');
    if (thResult) out.add(`  type hints:       ${fmtStat(thResult, full)}`);
    const dsResult = dominant(py.docstringDouble, '"""triple double"""', py.docstringSingle, "'''triple single'''");
    if (dsResult) out.add(`  docstrings:       ${fmtStat(dsResult, full)}`);
  }

  // --- Config files ---
  if (configs.length > 0) {
    out.blank();
    out.add('Config files:');
    for (const cfg of configs) {
      const keys = Object.entries(cfg.settings);
      if (keys.length > 0) {
        const summary = keys
          .map(([k, v]) => {
            if (typeof v === 'object' && !Array.isArray(v)) return `${k}: {...}`;
            if (Array.isArray(v)) return `${k}: [${v.length > 2 ? v.slice(0, 2).join(', ') + ', ...' : v.join(', ')}]`;
            return `${k}: ${v}`;
          })
          .join(', ');
        out.add(`  ${cfg.name} — ${summary}`);
      } else {
        out.add(`  ${cfg.name}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  let full = false;
  let maxSample = 50;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--full') full = true;
    else if (arg === '--sample') maxSample = parseInt(args[++i], 10) || 50;
    else filteredArgs.push(arg);
  }

  const opts = parseCommonArgs(filteredArgs);

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  const dir = resolve(opts.remaining[0] || findProjectRoot() || '.');

  if (!existsSync(dir)) {
    console.error(`Error: directory not found: ${dir}`);
    process.exit(1);
  }

  // Get all files
  const allFiles = listFiles(dir);
  if (allFiles.length === 0) {
    console.error('Error: no source files found');
    process.exit(1);
  }

  // Detect language and sample files
  const lang = detectLanguage(allFiles);
  const sampled = sampleFiles(allFiles, lang, maxSample);

  if (sampled.length === 0) {
    console.error(`Error: no ${lang} source files found`);
    process.exit(1);
  }

  // Analyze
  const stats = createStats();

  for (const file of sampled) {
    try {
      const content = readFileSync(file.path, 'utf-8');
      if (lang === 'python') {
        analyzePython(content, stats, file.name);
      } else {
        analyzeJsTs(content, stats, file.name);
      }
    } catch { /* skip unreadable files */ }
  }

  // Find config files
  const projectRoot = findProjectRoot() || dir;
  const configs = findConfigs(projectRoot);

  // Output
  const out = createOutput(opts);

  if (opts.json) {
    out.setData('language', lang);
    out.setData('filesAnalyzed', sampled.length);
    out.setData('formatting', {
      quotes: dominant(
        lang === 'python' ? stats.python.singleQuotes : stats.formatting.singleQuotes,
        'single',
        lang === 'python' ? stats.python.doubleQuotes : stats.formatting.doubleQuotes,
        'double'
      ),
      semicolons: lang !== 'python' ? dominant(stats.formatting.withSemi, 'yes', stats.formatting.withoutSemi, 'no') : undefined,
      indent: dominant(stats.formatting.tabIndent, 'tabs', stats.formatting.spaceIndent, 'spaces'),
      indentSize: detectIndentSize(stats.formatting.indentSizes),
      trailingCommas: dominant(stats.formatting.trailingCommaYes, 'yes', stats.formatting.trailingCommaNo, 'no'),
      lineLength: lineStats(stats.formatting.lineLengths)
    });
    out.setData('imports', stats.imports);
    out.setData('naming', {
      files: dominantMulti(stats.naming.files),
      functions: dominantMulti(stats.naming.functions)
    });
    out.setData('patterns', stats.patterns);
    out.setData('configFiles', configs);
  }

  displayResults(out, stats, lang, sampled.length, configs, full);
  out.print();
}

main();
