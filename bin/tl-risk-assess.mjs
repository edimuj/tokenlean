#!/usr/bin/env node

/**
 * tl-risk-assess - Quick heuristic risk score for a file
 *
 * Combines blast radius (tl-impact), complexity (tl-complexity),
 * and test coverage (tl-test-map) into a single risk score 1-10.
 *
 * Usage: tl-risk-assess <file>
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-risk-assess',
    desc: 'Quick risk score combining blast radius + complexity + tests',
    when: 'before-modify',
    example: 'tl-risk-assess src/output.mjs'
  }));
  process.exit(0);
}

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP = `
tl-risk-assess - Quick heuristic risk score for a file

Usage: tl-risk-assess <file> [options]

Options:
${COMMON_OPTIONS_HELP}

Scores 1-10 based on:
  Blast radius   - how many files import this one
  Complexity     - max cyclomatic complexity
  Test coverage  - whether tests exist for this file

Examples:
  tl-risk-assess src/output.mjs          # Risk score for a file
  tl-risk-assess src/output.mjs -j       # JSON output
  tl-risk-assess src/output.mjs -q       # Score only
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
// Risk Scoring
// ─────────────────────────────────────────────────────────────

function scoreBlastRadius(impactData) {
  if (!impactData || !impactData.importers) return { score: 1, count: 0, label: 'NONE' };

  let count = 0;
  for (const category of Object.values(impactData.importers)) {
    count += category.length;
  }

  // Source importers only (exclude tests)
  const sourceCount = (impactData.importers.source || []).length;

  if (sourceCount === 0) return { score: 1, count, label: 'NONE' };
  if (sourceCount <= 2) return { score: 2, count: sourceCount, label: 'LOW' };
  if (sourceCount <= 5) return { score: 4, count: sourceCount, label: 'MODERATE' };
  if (sourceCount <= 15) return { score: 7, count: sourceCount, label: 'HIGH' };
  return { score: 9, count: sourceCount, label: 'CRITICAL' };
}

function scoreComplexity(complexityData) {
  if (!complexityData || !complexityData.functions || complexityData.functions.length === 0) {
    return { score: 1, maxCyclo: 0, label: 'NONE' };
  }

  const maxCyclo = Math.max(...complexityData.functions.map(f => f.cyclomatic));

  if (maxCyclo <= 5) return { score: 1, maxCyclo, label: 'LOW' };
  if (maxCyclo <= 10) return { score: 3, maxCyclo, label: 'MODERATE' };
  if (maxCyclo <= 20) return { score: 5, maxCyclo, label: 'HIGH' };
  if (maxCyclo <= 40) return { score: 7, maxCyclo, label: 'VERY HIGH' };
  return { score: 9, maxCyclo, label: 'EXTREME' };
}

function scoreTestCoverage(testMapData) {
  if (!testMapData) return { score: 8, tests: 0, label: 'NONE' };

  const testCount = testMapData.totalTests || 0;
  const caseCount = testMapData.totalCases || 0;

  if (testCount === 0) return { score: 8, tests: 0, cases: 0, label: 'NONE' };
  if (caseCount >= 10) return { score: 1, tests: testCount, cases: caseCount, label: 'GOOD' };
  if (caseCount >= 3) return { score: 3, tests: testCount, cases: caseCount, label: 'MODERATE' };
  return { score: 5, tests: testCount, cases: caseCount, label: 'MINIMAL' };
}

function calculateOverallRisk(blast, complexity, tests) {
  // Weighted average: blast 40%, complexity 30%, tests 30%
  const raw = blast.score * 0.4 + complexity.score * 0.3 + tests.score * 0.3;
  return Math.max(1, Math.min(10, Math.round(raw)));
}

function getSuggestion(blast, complexity, tests) {
  const suggestions = [];
  if (tests.label === 'NONE') suggestions.push('Add tests before modifying');
  if (tests.label === 'MINIMAL') suggestions.push('Improve test coverage');
  if (complexity.label === 'VERY HIGH' || complexity.label === 'EXTREME') suggestions.push('Consider refactoring complex functions');
  if (blast.label === 'CRITICAL') suggestions.push('Changes here affect many files - review impact carefully');
  if (suggestions.length === 0) suggestions.push('Low risk - proceed with normal caution');
  return suggestions[0];
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

const filePath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, filePath) || filePath;

// Run sub-tools in sequence (they're fast enough)
const impactData = runSubTool('impact', filePath);
const complexityData = runSubTool('complexity', filePath);
const testMapData = runSubTool('test-map', filePath);

const blast = scoreBlastRadius(impactData);
const complexity = scoreComplexity(complexityData);
const tests = scoreTestCoverage(testMapData);
const overall = calculateOverallRisk(blast, complexity, tests);
const suggestion = getSuggestion(blast, complexity, tests);

const out = createOutput(options);

if (!options.quiet) {
  out.add(`${relPath}: risk ${overall}/10`);
  out.add(`  Blast: ${blast.label} (${blast.count} importers)`);
  out.add(`  Complexity: ${complexity.label} (max cyclo ${complexity.maxCyclo})`);
  const testDetail = tests.tests > 0 ? `${tests.tests} files, ${tests.cases} cases` : 'no tests';
  out.add(`  Tests: ${tests.label} (${testDetail})`);
  out.add(`  >> ${suggestion}`);
} else {
  out.add(`${relPath}: ${overall}/10`);
}

out.setData('file', relPath);
out.setData('risk', overall);
out.setData('blast', blast);
out.setData('complexity', complexity);
out.setData('tests', tests);
out.setData('suggestion', suggestion);

out.print();
