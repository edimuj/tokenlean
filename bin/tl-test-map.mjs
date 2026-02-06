#!/usr/bin/env node

/**
 * tl-test-map - Map source files to their tests
 *
 * Given a source file, finds all test files that cover it via three strategies:
 * colocated tests, project-wide naming, and import-based discovery.
 * Optionally shows coverage data and tested/untested exports.
 *
 * Usage: tl-test-map <file> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-test-map',
    desc: 'Map source files to their test files',
    when: 'before-modify',
    example: 'tl-test-map src/cache.mjs'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, categorizeFile } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep } from '../src/traverse.mjs';
import { rgCommand } from '../src/shell.mjs';

ensureRipgrep();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP = `
tl-test-map - Map source files to their tests

Usage: tl-test-map <file> [options]

Options:
  --exports             Show tested/untested exports
  --uncovered           Show uncovered line ranges
  --no-coverage         Skip coverage lookup
${COMMON_OPTIONS_HELP}

Examples:
  tl-test-map src/cache.mjs              # Find tests for file
  tl-test-map src/output.mjs --exports   # Show tested/untested exports
  tl-test-map src/cache.mjs --uncovered  # Show uncovered lines
  tl-test-map src/cache.mjs --no-coverage # Skip coverage
  tl-test-map src/cache.mjs -j           # JSON output
  tl-test-map src/cache.mjs -q           # Quiet (test file paths only)
`;

// ─────────────────────────────────────────────────────────────
// Test Discovery Layer 1: Colocated tests
// ─────────────────────────────────────────────────────────────

function findColocatedTests(filePath) {
  const dir = dirname(filePath);
  const name = basename(filePath, extname(filePath));
  const found = [];

  const suffixes = ['.test.', '.spec.'];
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs'];

  for (const suffix of suffixes) {
    for (const ext of exts) {
      // Same directory
      const p = join(dir, `${name}${suffix}${ext}`);
      if (existsSync(p)) found.push(resolve(p));

      // __tests__ subdirectory
      const p2 = join(dir, '__tests__', `${name}${suffix}${ext}`);
      if (existsSync(p2)) found.push(resolve(p2));
    }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Test Discovery Layer 2: Project-wide naming
// ─────────────────────────────────────────────────────────────

function findProjectWideTests(name, projectRoot) {
  const testDirs = ['test', 'tests', 'spec', '__tests__', 'e2e'];
  const found = [];

  for (const dir of testDirs) {
    const dirPath = join(projectRoot, dir);
    if (!existsSync(dirPath)) continue;

    const result = rgCommand(['--files', '--glob', `*${name}*`, dirPath]);
    if (!result) continue;

    for (const line of result.split('\n')) {
      if (!line.trim()) continue;
      found.push(resolve(line.trim()));
    }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Test Discovery Layer 3: Import-based
// ─────────────────────────────────────────────────────────────

function isTestFile(absPath, projectRoot) {
  const base = basename(absPath);
  // Must have .test. or .spec. in the filename
  if (/\.(test|spec)\./.test(base)) return true;

  // Or be inside a recognized test directory
  const rel = relative(projectRoot, absPath);
  const parts = rel.split('/');
  const testDirNames = new Set(['test', 'tests', 'spec', '__tests__', 'e2e']);
  return parts.some(p => testDirNames.has(p));
}

function findImportBasedTests(filePath, projectRoot) {
  const name = basename(filePath, extname(filePath));
  const relPath = relative(projectRoot, filePath);

  // Build import patterns: the file could be imported by name or relative path
  // Search for files that reference this module name
  const cacheKey = { op: 'test-map-import-search', module: name, file: relPath };

  const result = withCache(
    cacheKey,
    () => {
      const rgResult = rgCommand(
        ['-l', '--glob', '*.{js,mjs,ts,tsx,jsx}', '-e', name, projectRoot],
        { maxBuffer: 5 * 1024 * 1024 }
      );
      return rgResult || '';
    },
    { projectRoot }
  );

  const found = [];

  for (const line of result.split('\n')) {
    if (!line.trim()) continue;
    const absPath = resolve(line.trim());

    // Only include actual test files (strict check)
    if (!isTestFile(absPath, projectRoot)) continue;

    // Skip the source file itself
    if (absPath === resolve(filePath)) continue;

    // Verify it actually imports this module
    try {
      const content = readFileSync(absPath, 'utf-8');
      const importPattern = new RegExp(
        `(?:from|require)\\s*\\(?\\s*['"][^'"]*\\/?${name}(?:\\.m?[jt]sx?)?['"]`
      );
      if (importPattern.test(content)) {
        found.push(absPath);
      }
    } catch { /* skip unreadable */ }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Test Enrichment
// ─────────────────────────────────────────────────────────────

function countTestCases(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    const tokens = estimateTokens(content);

    // Count test cases across languages
    const casePatterns = [
      /\bit\s*\(/g,           // JS/TS: it('...')
      /\btest\s*\(/g,         // JS/TS: test('...')
      /\bdef\s+test_/g,       // Python: def test_xxx
      /\bfunc\s+Test[A-Z]/g,  // Go: func TestXxx
    ];

    let cases = 0;
    for (const pattern of casePatterns) {
      const matches = content.match(pattern);
      if (matches) cases += matches.length;
    }

    // Count suites (describe blocks)
    const suitePatterns = [
      /\bdescribe\s*\(/g,     // JS/TS
      /\bclass\s+Test\w+/g,   // Python unittest
    ];

    let suites = 0;
    for (const pattern of suitePatterns) {
      const matches = content.match(pattern);
      if (matches) suites += matches.length;
    }

    return { cases, suites, lines, tokens };
  } catch {
    return { cases: 0, suites: 0, lines: 0, tokens: 0 };
  }
}

// ─────────────────────────────────────────────────────────────
// Coverage via tl-coverage subprocess
// ─────────────────────────────────────────────────────────────

function getCoverageForFile(relPath, projectRoot) {
  try {
    const toolPath = join(__dirname, 'tl-coverage.mjs');
    const proc = spawnSync(process.execPath, [toolPath, relPath, '--json'], {
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15000,
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (proc.error || proc.status !== 0) return null;

    const data = JSON.parse(proc.stdout);
    if (!data.files || data.files.length === 0) return null;

    const file = data.files[0];
    return {
      lines: file.lines,
      functions: file.functions,
      branches: file.branches,
      uncoveredLines: file.uncoveredLines || []
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Export Analysis
// ─────────────────────────────────────────────────────────────

function extractExportedNames(content) {
  const names = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('export ')) continue;
    if (trimmed.startsWith('export default ')) continue;
    if (trimmed.startsWith('export * ')) continue;

    // export { a, b } from '...' — skip re-exports
    if (/^export\s+\{[^}]+\}\s+from\s+['"]/.test(trimmed)) continue;

    // export function name / export async function name
    const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) { names.push(funcMatch[1]); continue; }

    // export class name
    const classMatch = trimmed.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) { names.push(classMatch[1]); continue; }

    // export const/let/var name
    const constMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
    if (constMatch) { names.push(constMatch[1]); continue; }

    // export interface/type/enum name
    const typeMatch = trimmed.match(/^export\s+(?:interface|type|enum|const\s+enum)\s+(\w+)/);
    if (typeMatch) { names.push(typeMatch[1]); continue; }
  }

  return names;
}

function findTestedExports(filePath, testFiles) {
  let sourceContent;
  try {
    sourceContent = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const exportNames = extractExportedNames(sourceContent);
  if (exportNames.length === 0) return null;

  // Read all test file contents
  let combinedTestContent = '';
  for (const tf of testFiles) {
    try {
      combinedTestContent += readFileSync(tf, 'utf-8') + '\n';
    } catch { /* skip */ }
  }

  const tested = [];
  const untested = [];

  for (const name of exportNames) {
    // Word-boundary match in test content
    const pattern = new RegExp(`\\b${name}\\b`);
    if (pattern.test(combinedTestContent)) {
      tested.push(name);
    } else {
      untested.push(name);
    }
  }

  return {
    total: exportNames.length,
    tested,
    untested,
    testedPct: exportNames.length > 0 ? Math.round((tested.length / exportNames.length) * 100) : 0
  };
}

// ─────────────────────────────────────────────────────────────
// Line Range Formatter
// ─────────────────────────────────────────────────────────────

function formatLineRanges(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';

  const sorted = [...lines].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);

  return ranges.join(', ');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
let showExports = false;
let showUncovered = false;
let skipCoverage = false;
const remaining = [];

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if (arg === '--exports') {
    showExports = true;
  } else if (arg === '--uncovered') {
    showUncovered = true;
  } else if (arg === '--no-coverage') {
    skipCoverage = true;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const targetFile = remaining[0];

if (options.help || !targetFile) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const fullPath = resolve(targetFile);
if (!existsSync(fullPath)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, fullPath);
const name = basename(fullPath, extname(fullPath));

// ── Discover tests (3 layers, deduplicated) ──

const colocated = findColocatedTests(fullPath);
const projectWide = findProjectWideTests(name, projectRoot);
const importBased = findImportBasedTests(fullPath, projectRoot);

// Tag each with discovery method, deduplicate by absolute path
const seen = new Map(); // absPath → discovery method

for (const p of colocated) {
  if (!seen.has(p)) seen.set(p, 'colocated');
}
for (const p of projectWide) {
  if (!seen.has(p)) seen.set(p, 'project-wide');
}
for (const p of importBased) {
  if (!seen.has(p)) seen.set(p, 'import');
}

// Enrich each test file
const testEntries = [];
let totalCases = 0;

for (const [absPath, discovery] of seen) {
  const testRelPath = relative(projectRoot, absPath);
  const info = countTestCases(absPath);
  totalCases += info.cases;
  testEntries.push({
    path: testRelPath,
    absPath,
    cases: info.cases,
    suites: info.suites,
    lines: info.lines,
    tokens: info.tokens,
    discovery
  });
}

// ── Coverage ──

let coverage = null;
if (!skipCoverage && testEntries.length > 0) {
  coverage = getCoverageForFile(relPath, projectRoot);
}

// ── Exports analysis ──

const testAbsPaths = testEntries.map(t => t.absPath);
const exportsData = (showExports || options.json) && testEntries.length > 0
  ? findTestedExports(fullPath, testAbsPaths)
  : null;

// ── Output ──

const out = createOutput(options);

// JSON data
out.setData('file', relPath);
out.setData('tests', testEntries.map(t => ({
  path: t.path,
  cases: t.cases,
  suites: t.suites,
  lines: t.lines,
  tokens: t.tokens,
  discovery: t.discovery
})));
out.setData('totalTests', testEntries.length);
out.setData('totalCases', totalCases);

if (coverage) {
  const linePct = coverage.lines.found > 0
    ? Math.round((coverage.lines.hit / coverage.lines.found) * 100) : 0;
  const funcPct = coverage.functions.found > 0
    ? Math.round((coverage.functions.hit / coverage.functions.found) * 100) : 0;
  const branchPct = coverage.branches.found > 0
    ? Math.round((coverage.branches.hit / coverage.branches.found) * 100) : 0;

  out.setData('coverage', {
    lines: { hit: coverage.lines.hit, found: coverage.lines.found, pct: linePct },
    functions: { hit: coverage.functions.hit, found: coverage.functions.found, pct: funcPct },
    branches: { hit: coverage.branches.hit, found: coverage.branches.found, pct: branchPct },
    uncoveredLines: formatLineRanges(coverage.uncoveredLines)
  });
} else {
  out.setData('coverage', null);
}

if (exportsData) {
  out.setData('exports', exportsData);
} else {
  out.setData('exports', null);
}

// ── Text output ──

out.header(`Test map: ${relPath}`);
out.blank();

if (testEntries.length === 0) {
  out.add('No tests found.');
  out.blank();

  // Suggest expected test path
  const ext = extname(fullPath);
  const suggestedName = `${name}.test${ext}`;
  const suggestedPaths = [
    join(dirname(relPath), suggestedName),
    join('test', suggestedName),
    join('tests', suggestedName)
  ];
  out.add('Expected test locations:');
  for (const p of suggestedPaths) {
    out.add(`  ${p}`);
  }
} else {
  // Tests table
  const testLabel = testEntries.length === 1 ? '1 file' : `${testEntries.length} files`;
  const caseLabel = totalCases === 1 ? '1 case' : `${totalCases} cases`;
  out.add(`Tests (${testLabel}, ${caseLabel}):`);

  const rows = testEntries.map(t => [
    `  ${t.path}`,
    `${t.cases} cases`,
    `${t.suites} suites`,
    `(${t.discovery})`
  ]);
  formatTable(rows, { indent: '' }).forEach(line => out.add(line));
  out.blank();

  // Coverage section
  if (coverage) {
    const linePct = coverage.lines.found > 0
      ? Math.round((coverage.lines.hit / coverage.lines.found) * 100) : 0;
    const funcPct = coverage.functions.found > 0
      ? Math.round((coverage.functions.hit / coverage.functions.found) * 100) : 0;

    out.add(`Coverage: ${linePct}% lines (${coverage.lines.hit}/${coverage.lines.found}), ${funcPct}% functions (${coverage.functions.hit}/${coverage.functions.found})`);

    if (showUncovered && coverage.uncoveredLines.length > 0) {
      const ranges = formatLineRanges(coverage.uncoveredLines);
      out.add(`  uncovered: ${ranges}`);
    }

    out.blank();
  }

  // Exports section (text mode only with --exports)
  if (showExports && exportsData) {
    out.add(`Exports: ${exportsData.tested.length}/${exportsData.total} tested`);
    if (exportsData.tested.length > 0) {
      out.add(`  tested:   ${exportsData.tested.join(', ')}`);
    }
    if (exportsData.untested.length > 0) {
      out.add(`  untested: ${exportsData.untested.join(', ')}`);
    }
    out.blank();
  }
}

out.print();
