#!/usr/bin/env node

/**
 * tl-coverage - Quick test coverage info for files
 *
 * Reads coverage data from common formats (lcov, istanbul, c8) and shows
 * coverage percentages for files. No need to read full coverage reports.
 *
 * Usage: tl-coverage [file-or-dir] [--below N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-coverage',
    desc: 'Quick test coverage info for files',
    when: 'before-modify',
    example: 'tl-coverage src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-coverage - Quick test coverage info for files

Usage: tl-coverage [file-or-dir] [options]

Options:
  --below N             Only show files with coverage below N% (default: show all)
  --above N             Only show files with coverage above N%
  --sort <field>        Sort by: coverage, lines, name (default: coverage)
  --uncovered           Show uncovered line numbers for each file
${COMMON_OPTIONS_HELP}

Examples:
  tl-coverage                      # All files coverage
  tl-coverage src/                 # Coverage for src/ files
  tl-coverage src/api.ts           # Single file coverage
  tl-coverage --below 80           # Files under 80% coverage
  tl-coverage src/ --uncovered     # Show uncovered lines

Coverage data sources (auto-detected):
  - coverage/lcov.info (lcov format)
  - coverage/coverage-final.json (istanbul/nyc)
  - coverage/coverage-summary.json (jest)
  - .nyc_output/*.json (nyc raw)
`;

// ─────────────────────────────────────────────────────────────
// Coverage Data Detection
// ─────────────────────────────────────────────────────────────

function findCoverageData(projectRoot) {
  const coverageDir = join(projectRoot, 'coverage');

  // Try different coverage formats in order of preference
  const sources = [
    { path: join(coverageDir, 'lcov.info'), type: 'lcov' },
    { path: join(coverageDir, 'coverage-final.json'), type: 'istanbul' },
    { path: join(coverageDir, 'coverage-summary.json'), type: 'summary' },
    { path: join(projectRoot, '.nyc_output'), type: 'nyc' }
  ];

  for (const source of sources) {
    if (existsSync(source.path)) {
      return source;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Coverage Parsers
// ─────────────────────────────────────────────────────────────

function parseLcov(content, projectRoot) {
  const coverage = new Map();
  let currentFile = null;
  let currentData = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('SF:')) {
      // Source file
      currentFile = trimmed.slice(3);
      // Make path relative
      if (currentFile.startsWith(projectRoot)) {
        currentFile = relative(projectRoot, currentFile);
      }
      currentData = {
        lines: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 },
        uncoveredLines: []
      };
    } else if (trimmed.startsWith('DA:')) {
      // Line data: DA:lineNum,hitCount
      const [lineNum, hitCount] = trimmed.slice(3).split(',').map(Number);
      if (currentData) {
        currentData.lines.found++;
        if (hitCount > 0) {
          currentData.lines.hit++;
        } else {
          currentData.uncoveredLines.push(lineNum);
        }
      }
    } else if (trimmed.startsWith('FNF:')) {
      if (currentData) currentData.functions.found = parseInt(trimmed.slice(4), 10);
    } else if (trimmed.startsWith('FNH:')) {
      if (currentData) currentData.functions.hit = parseInt(trimmed.slice(4), 10);
    } else if (trimmed.startsWith('BRF:')) {
      if (currentData) currentData.branches.found = parseInt(trimmed.slice(4), 10);
    } else if (trimmed.startsWith('BRH:')) {
      if (currentData) currentData.branches.hit = parseInt(trimmed.slice(4), 10);
    } else if (trimmed === 'end_of_record') {
      if (currentFile && currentData) {
        coverage.set(currentFile, currentData);
      }
      currentFile = null;
      currentData = null;
    }
  }

  return coverage;
}

function parseIstanbul(content, projectRoot) {
  const coverage = new Map();
  const data = JSON.parse(content);

  for (const [filePath, fileData] of Object.entries(data)) {
    let relPath = filePath;
    if (filePath.startsWith(projectRoot)) {
      relPath = relative(projectRoot, filePath);
    }

    const statementMap = fileData.statementMap || {};
    const s = fileData.s || {};
    const fnMap = fileData.fnMap || {};
    const f = fileData.f || {};
    const branchMap = fileData.branchMap || {};
    const b = fileData.b || {};

    // Calculate line coverage from statements
    const lineHits = new Map();
    for (const [stmtId, count] of Object.entries(s)) {
      const stmt = statementMap[stmtId];
      if (stmt && stmt.start) {
        const line = stmt.start.line;
        lineHits.set(line, (lineHits.get(line) || 0) + count);
      }
    }

    const uncoveredLines = [];
    for (const [line, count] of lineHits) {
      if (count === 0) {
        uncoveredLines.push(line);
      }
    }

    coverage.set(relPath, {
      lines: {
        found: Object.keys(s).length,
        hit: Object.values(s).filter(c => c > 0).length
      },
      functions: {
        found: Object.keys(f).length,
        hit: Object.values(f).filter(c => c > 0).length
      },
      branches: {
        found: Object.values(b).flat().length,
        hit: Object.values(b).flat().filter(c => c > 0).length
      },
      uncoveredLines: uncoveredLines.sort((a, b) => a - b)
    });
  }

  return coverage;
}

function parseSummary(content, projectRoot) {
  const coverage = new Map();
  const data = JSON.parse(content);

  for (const [filePath, fileData] of Object.entries(data)) {
    if (filePath === 'total') continue;

    let relPath = filePath;
    if (filePath.startsWith(projectRoot)) {
      relPath = relative(projectRoot, filePath);
    }

    coverage.set(relPath, {
      lines: {
        found: fileData.lines?.total || 0,
        hit: fileData.lines?.covered || 0
      },
      functions: {
        found: fileData.functions?.total || 0,
        hit: fileData.functions?.covered || 0
      },
      branches: {
        found: fileData.branches?.total || 0,
        hit: fileData.branches?.covered || 0
      },
      uncoveredLines: []  // Summary doesn't have line details
    });
  }

  return coverage;
}

function loadCoverage(source, projectRoot) {
  if (source.type === 'lcov') {
    const content = readFileSync(source.path, 'utf-8');
    return parseLcov(content, projectRoot);
  }

  if (source.type === 'istanbul') {
    const content = readFileSync(source.path, 'utf-8');
    return parseIstanbul(content, projectRoot);
  }

  if (source.type === 'summary') {
    const content = readFileSync(source.path, 'utf-8');
    return parseSummary(content, projectRoot);
  }

  if (source.type === 'nyc') {
    // Load all JSON files in .nyc_output
    const combined = new Map();
    const files = readdirSync(source.path).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const content = readFileSync(join(source.path, file), 'utf-8');
      const fileCoverage = parseIstanbul(content, projectRoot);
      for (const [path, data] of fileCoverage) {
        combined.set(path, data);
      }
    }

    return combined;
  }

  return new Map();
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function calcPercentage(hit, found) {
  if (found === 0) return 100;
  return Math.round((hit / found) * 100);
}

function formatPercentage(pct) {
  if (pct >= 80) return `${pct}%`;
  if (pct >= 50) return `${pct}%`;
  return `${pct}%`;
}

function formatLineRanges(lines) {
  if (lines.length === 0) return '';

  const ranges = [];
  let start = lines[0];
  let end = lines[0];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === end + 1) {
      end = lines[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = lines[i];
      end = lines[i];
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

// Parse custom options
let belowThreshold = null;
let aboveThreshold = null;
let sortBy = 'coverage';
let showUncovered = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--below') {
    belowThreshold = parseInt(options.remaining[++i], 10);
  } else if (arg === '--above') {
    aboveThreshold = parseInt(options.remaining[++i], 10);
  } else if (arg === '--sort') {
    sortBy = options.remaining[++i];
  } else if (arg === '--uncovered') {
    showUncovered = true;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const targetPath = remaining[0];

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Find coverage data
const coverageSource = findCoverageData(projectRoot);
if (!coverageSource) {
  console.error('No coverage data found. Run your tests with coverage first.');
  console.error('Looked for: coverage/lcov.info, coverage/coverage-final.json, .nyc_output/');
  process.exit(1);
}

// Load coverage
const coverage = loadCoverage(coverageSource, projectRoot);

if (coverage.size === 0) {
  console.error('Coverage data is empty');
  process.exit(1);
}

// Filter by target path if specified
let filteredCoverage = [...coverage.entries()];

if (targetPath) {
  const targetStat = existsSync(targetPath) ? statSync(targetPath) : null;

  if (targetStat?.isFile()) {
    // Single file
    const relPath = relative(projectRoot, targetPath);
    filteredCoverage = filteredCoverage.filter(([path]) => path === relPath);
  } else {
    // Directory or pattern
    const prefix = targetPath.replace(/\/$/, '');
    filteredCoverage = filteredCoverage.filter(([path]) => path.startsWith(prefix));
  }
}

// Apply thresholds
if (belowThreshold !== null) {
  filteredCoverage = filteredCoverage.filter(([, data]) => {
    const pct = calcPercentage(data.lines.hit, data.lines.found);
    return pct < belowThreshold;
  });
}

if (aboveThreshold !== null) {
  filteredCoverage = filteredCoverage.filter(([, data]) => {
    const pct = calcPercentage(data.lines.hit, data.lines.found);
    return pct >= aboveThreshold;
  });
}

// Sort
filteredCoverage.sort((a, b) => {
  if (sortBy === 'name') {
    return a[0].localeCompare(b[0]);
  }
  if (sortBy === 'lines') {
    return b[1].lines.found - a[1].lines.found;
  }
  // Default: coverage (ascending - lowest first)
  const pctA = calcPercentage(a[1].lines.hit, a[1].lines.found);
  const pctB = calcPercentage(b[1].lines.hit, b[1].lines.found);
  return pctA - pctB;
});

// Calculate totals
let totalLines = 0;
let totalHit = 0;
for (const [, data] of filteredCoverage) {
  totalLines += data.lines.found;
  totalHit += data.lines.hit;
}

// Set JSON data
out.setData('source', basename(coverageSource.path));
out.setData('files', filteredCoverage.map(([path, data]) => ({
  path,
  coverage: calcPercentage(data.lines.hit, data.lines.found),
  lines: data.lines,
  functions: data.functions,
  branches: data.branches,
  uncoveredLines: data.uncoveredLines
})));
out.setData('totalCoverage', calcPercentage(totalHit, totalLines));

// Output
out.header(`📊 Coverage from ${basename(coverageSource.path)}`);
out.blank();

if (filteredCoverage.length === 0) {
  out.add('No files match the criteria');
} else {
  const rows = [];

  for (const [path, data] of filteredCoverage) {
    const linePct = calcPercentage(data.lines.hit, data.lines.found);
    const funcPct = calcPercentage(data.functions.hit, data.functions.found);
    const branchPct = calcPercentage(data.branches.hit, data.branches.found);

    const indicator = linePct >= 80 ? '✓' : linePct >= 50 ? '◐' : '✗';

    rows.push([
      `${indicator} ${path}`,
      `${linePct}%`,
      `(${data.lines.hit}/${data.lines.found})`
    ]);

    if (showUncovered && data.uncoveredLines.length > 0) {
      const lineRanges = formatLineRanges(data.uncoveredLines);
      rows.push(['', '', `  uncovered: ${lineRanges}`]);
    }
  }

  formatTable(rows).forEach(line => out.add(line));
}

// Summary
if (!options.quiet && filteredCoverage.length > 0) {
  out.blank();
  const totalPct = calcPercentage(totalHit, totalLines);
  out.add(`Total: ${totalPct}% coverage (${totalHit}/${totalLines} lines) across ${filteredCoverage.length} file(s)`);
}

out.print();
