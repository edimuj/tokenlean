#!/usr/bin/env node

/**
 * tl-analyze - Composite file profile (symbols + deps + impact + complexity + related)
 *
 * One command to understand a file: its API surface, dependencies, blast radius,
 * complexity hotspots, and related test files — in ~100 tokens.
 *
 * Usage: tl-analyze <file> [--no-symbols] [--no-deps] [--no-impact] [--no-complexity] [--no-related] [--full]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-analyze',
    desc: 'Composite file profile (symbols + deps + impact + complexity + related)',
    when: 'before-read',
    example: 'tl-analyze src/auth.ts'
  }));
  process.exit(0);
}

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP = `
tl-analyze - Composite file profile

Chains: symbols + deps + impact + complexity + related into a single compact view.

Usage: tl-analyze <file> [options]

Options:
  --no-symbols          Skip signatures section
  --no-deps             Skip dependencies section
  --no-impact           Skip impact/blast radius section
  --no-complexity       Skip complexity section
  --no-related          Skip related files section
  --full                Show more detail per section
${COMMON_OPTIONS_HELP}

Examples:
  tl-analyze src/auth.ts              # Full profile
  tl-analyze src/auth.ts --no-impact  # Skip blast radius
  tl-analyze src/auth.ts --full       # More detail
  tl-analyze src/auth.ts -j           # JSON output
  tl-analyze src/auth.ts -q           # Quiet mode
`;

// ─────────────────────────────────────────────────────────────
// Sub-tool Runner
// ─────────────────────────────────────────────────────────────

function runSubTool(toolName, filePath) {
  try {
    const toolPath = join(__dirname, `tl-${toolName}.mjs`);
    const proc = spawnSync(process.execPath, [toolPath, filePath, '--json'], {
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (proc.error || proc.status !== 0) return null;
    return JSON.parse(proc.stdout);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Section Extractors — distill highlights from JSON
// ─────────────────────────────────────────────────────────────

function extractSymbols(data, full) {
  if (!data || !data.symbols) return null;

  const symbols = data.symbols;
  const signatures = [];

  // Collect exported functions/classes
  if (symbols.exports) {
    for (const exp of symbols.exports) {
      if (exp.startsWith('export {') || exp.startsWith('export *')) continue;
      signatures.push(exp);
    }
  }

  // Add class methods
  if (symbols.classes) {
    for (const cls of symbols.classes) {
      signatures.push(cls.signature);
      if (cls.methods) {
        for (const m of cls.methods) {
          signatures.push('  ' + m);
        }
      }
    }
  }

  // Non-exported functions
  if (symbols.functions) {
    for (const f of symbols.functions) {
      if (!f.startsWith('export')) signatures.push(f);
    }
  }

  const limit = full ? 20 : 8;
  const display = signatures.slice(0, limit);
  const remaining = signatures.length - display.length;

  return {
    exportCount: data.symbols.exports?.length || 0,
    symbolCount: data.symbolCount || 0,
    signatures: display,
    remaining
  };
}

function extractDeps(data, full) {
  if (!data || !data.imports) return null;

  const imports = data.imports;
  const result = { total: data.totalImports || 0, npm: [], local: [], builtin: [] };

  const npmLimit = full ? 10 : 5;
  const localLimit = full ? 10 : 5;

  if (imports.npm) {
    result.npm = imports.npm.slice(0, npmLimit).map(i => i.spec.split('/').slice(0, i.spec.startsWith('@') ? 2 : 1).join('/'));
    result.npm = [...new Set(result.npm)];
  }
  if (imports.local) {
    result.local = imports.local.slice(0, localLimit).map(i => i.spec);
  }
  if (imports.builtin) {
    result.builtin = imports.builtin.map(i => i.spec.replace(/^node:/, ''));
    result.builtin = [...new Set(result.builtin)];
  }

  return result;
}

function extractImpact(data, full) {
  if (!data) return null;

  const totalFiles = data.totalFiles || 0;
  if (totalFiles === 0) return { totalFiles: 0, importers: [], testCount: 0 };

  const importers = data.importers || {};
  const sourceFiles = importers.source || [];
  const testFiles = importers.test || [];

  const limit = full ? 8 : 3;
  const topImporters = sourceFiles.slice(0, limit).map(f => f.relPath);
  const remaining = sourceFiles.length - topImporters.length;

  return {
    totalFiles,
    importers: topImporters,
    remaining,
    testCount: testFiles.length
  };
}

function extractComplexity(data, full) {
  if (!data || !data.functions) return null;

  const functions = data.functions;
  const threshold = 10;
  const complex = functions.filter(f => f.cyclomatic >= threshold);
  const underThreshold = functions.length - complex.length;

  // Sort by cyclomatic desc
  complex.sort((a, b) => b.cyclomatic - a.cyclomatic);

  const limit = full ? 10 : 5;
  const display = complex.slice(0, limit);

  return {
    totalFunctions: functions.length,
    complexFunctions: display.map(f => ({
      name: f.name,
      cyclomatic: f.cyclomatic,
      cognitive: f.cognitive
    })),
    underThreshold
  };
}

function extractRelated(data, full) {
  if (!data) return null;

  const limit = full ? 10 : 5;
  const tests = (data.tests || []).slice(0, limit).map(f => f.path);
  const importers = (data.importers || []).slice(0, limit).map(f => f.path);

  return {
    tests,
    importers,
    totalImporters: data.totalImporters || 0,
    siblings: (data.siblings || []).slice(0, 3).map(f => f.path)
  };
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function formatSymbolsSection(out, symbols) {
  if (!symbols) return;
  out.add('  Signatures');
  for (const sig of symbols.signatures) {
    out.add('    ' + sig);
  }
  if (symbols.remaining > 0) {
    out.add(`    ... +${symbols.remaining} more`);
  }
  out.blank();
}

function formatDepsSection(out, deps) {
  if (!deps) return;
  out.add(`  Dependencies (${deps.total})`);
  if (deps.npm.length > 0) {
    out.add('    npm: ' + deps.npm.join(', '));
  }
  if (deps.local.length > 0) {
    out.add('    local: ' + deps.local.join(', '));
  }
  if (deps.builtin.length > 0) {
    out.add('    builtin: ' + deps.builtin.join(', '));
  }
  out.blank();
}

function formatImpactSection(out, impact) {
  if (!impact) return;
  if (impact.totalFiles === 0) {
    out.add('  Impact: no importers found');
    out.blank();
    return;
  }
  const testNote = impact.testCount > 0 ? ` (${impact.testCount} tests)` : '';
  out.add(`  Impact (${impact.totalFiles} importers)${testNote}`);
  const display = impact.importers.join(', ');
  if (impact.remaining > 0) {
    out.add(`    ${display}, +${impact.remaining} more`);
  } else {
    out.add(`    ${display}`);
  }
  out.blank();
}

function formatComplexitySection(out, complexity) {
  if (!complexity) return;
  if (complexity.complexFunctions.length === 0) {
    out.add(`  Complexity: ${complexity.totalFunctions} functions, all under threshold`);
    out.blank();
    return;
  }
  out.add('  Complexity');
  for (const f of complexity.complexFunctions) {
    out.add(`    \u26a0\ufe0f  ${f.name}: cyclomatic ${f.cyclomatic}, cognitive ${f.cognitive}`);
  }
  if (complexity.underThreshold > 0) {
    out.add(`    \u2705 ${complexity.underThreshold} functions under threshold`);
  }
  out.blank();
}

function formatRelatedSection(out, related) {
  if (!related) return;
  const parts = [];
  if (related.tests.length > 0) {
    parts.push(...related.tests);
  }
  if (parts.length === 0 && related.importers.length === 0) {
    out.add('  Related: no test files found');
    out.blank();
    return;
  }
  out.add('  Related');
  if (related.tests.length > 0) {
    out.add('    tests: ' + related.tests.join(', '));
  }
  if (related.importers.length > 0) {
    const extra = related.totalImporters > related.importers.length
      ? `, +${related.totalImporters - related.importers.length} more`
      : '';
    out.add('    importers: ' + related.importers.join(', ') + extra);
  }
  out.blank();
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
const skipSymbols = options.remaining.includes('--no-symbols');
const skipDeps = options.remaining.includes('--no-deps');
const skipImpact = options.remaining.includes('--no-impact');
const skipComplexity = options.remaining.includes('--no-complexity');
const skipRelated = options.remaining.includes('--no-related');
const full = options.remaining.includes('--full');

const filePath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const resolvedPath = resolve(filePath);

if (!existsSync(resolvedPath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, resolvedPath);
const content = readFileSync(resolvedPath, 'utf-8');
const tokens = estimateTokens(content);
const out = createOutput(options);

// Run sub-tools and extract highlights
const symbolsData = !skipSymbols ? runSubTool('symbols', filePath) : null;
const depsData = !skipDeps ? runSubTool('deps', filePath) : null;
const impactData = !skipImpact ? runSubTool('impact', filePath) : null;
const complexityData = !skipComplexity ? runSubTool('complexity', filePath) : null;
const relatedData = !skipRelated ? runSubTool('related', filePath) : null;

const symbols = extractSymbols(symbolsData, full);
const deps = extractDeps(depsData, full);
const impact = extractImpact(impactData, full);
const complexity = extractComplexity(complexityData, full);
const related = extractRelated(relatedData, full);

// Export count from symbols
const exportCount = symbols ? symbols.exportCount : '';
const exportStr = exportCount ? `, ${exportCount} exports` : '';

// Set JSON data
out.setData('file', relPath);
out.setData('tokens', tokens);
if (symbols) out.setData('symbols', symbolsData?.symbols || {});
if (deps) out.setData('deps', depsData?.imports || {});
if (impact) out.setData('impact', impactData?.importers || {});
if (complexity) out.setData('complexity', complexityData?.functions || []);
if (related) out.setData('related', {
  tests: relatedData?.tests || [],
  importers: relatedData?.importers || [],
  siblings: relatedData?.siblings || []
});

// Build text output
out.header(`\n\ud83d\udccb ${relPath} (~${formatTokens(tokens)} tokens${exportStr})`);
out.blank();

if (symbols) formatSymbolsSection(out, symbols);
if (deps) formatDepsSection(out, deps);
if (impact) formatImpactSection(out, impact);
if (complexity) formatComplexitySection(out, complexity);
if (related) formatRelatedSection(out, related);

out.print();
