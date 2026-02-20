#!/usr/bin/env node

/**
 * tl-complexity - Code complexity metrics
 *
 * Calculates cyclomatic and cognitive complexity for functions in your codebase.
 * Helps identify functions that may need refactoring.
 *
 * Usage: tl-complexity [file-or-dir] [--threshold N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-complexity',
    desc: 'Code complexity metrics for functions',
    when: 'before-modify',
    example: 'tl-complexity src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, findCodeFiles } from '../src/project.mjs';

const HELP = `
tl-complexity - Code complexity metrics

Usage: tl-complexity [file-or-dir] [options]

Options:
  --threshold N, -t N   Only show functions with complexity >= N (default: 0)
  --sort <field>        Sort by: cyclomatic, cognitive, name, loc (default: cyclomatic)
  --top N               Show only top N most complex functions
  --summary             Show only file-level summary, not individual functions
${COMMON_OPTIONS_HELP}

Examples:
  tl-complexity src/                    # All functions
  tl-complexity src/utils.ts            # Single file
  tl-complexity src/ --threshold 10     # Only complex functions
  tl-complexity src/ --top 20           # Top 20 most complex
  tl-complexity src/ --summary          # File-level only

Metrics:
  Cyclomatic: Number of independent paths through code
             (if, for, while, case, catch, &&, ||, ?:)
  Cognitive:  How hard code is to understand
             (nesting increases weight of decisions)

Thresholds (suggestions):
  1-10:  Simple, low risk
  11-20: Moderate, some risk
  21-50: Complex, high risk
  50+:   Very complex, refactor recommended
`;

// ─────────────────────────────────────────────────────────────
// Function Extraction
// ─────────────────────────────────────────────────────────────

function extractFunctions(content, filePath) {
  const functions = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Match function declarations
    const funcPatterns = [
      // function name() or async function name()
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
      // const name = function() or const name = async function()
      /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
      // const name = () => or const name = async () =>
      /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/,
      // const name = async () => (without params parens sometimes)
      /^(?:export\s+)?const\s+(\w+)\s*=\s*async\s+\w+\s*=>/,
      // Class method: name() { or async name() { or public name() {
      /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
    ];

    let funcName = null;
    let funcStart = i;

    for (const pattern of funcPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        funcName = match[1];
        // Skip constructor, get, set for class methods
        if (['constructor', 'get', 'set', 'if', 'for', 'while', 'switch', 'catch'].includes(funcName)) {
          funcName = null;
        }
        break;
      }
    }

    if (funcName) {
      // Find the function body
      const funcBody = extractFunctionBody(lines, i);
      if (funcBody) {
        functions.push({
          name: funcName,
          startLine: i + 1,
          endLine: i + funcBody.lines.length,
          body: funcBody.content,
          loc: funcBody.lines.length
        });
        i += funcBody.lines.length;
        continue;
      }
    }

    i++;
  }

  return functions;
}

function extractFunctionBody(lines, startLine) {
  let braceDepth = 0;
  let arrowWithoutBrace = false;
  let started = false;
  const bodyLines = [];

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    bodyLines.push(line);

    // Check for arrow function without braces
    if (i === startLine && line.includes('=>') && !line.includes('{')) {
      // Single expression arrow function - ends at semicolon or next statement
      if (line.trim().endsWith(';') || line.trim().endsWith(',')) {
        return { lines: bodyLines, content: bodyLines.join('\n') };
      }
      arrowWithoutBrace = true;
    }

    // Count braces
    for (const char of line) {
      if (char === '{') {
        braceDepth++;
        started = true;
      } else if (char === '}') {
        braceDepth--;
      }
    }

    // Handle arrow functions without braces (multi-line)
    if (arrowWithoutBrace && !started) {
      if (line.trim().endsWith(';') || line.trim().endsWith(',') ||
          (i + 1 < lines.length && /^[\s]*(?:const|let|var|function|class|export|import|return|\}|\/\/)/.test(lines[i + 1]))) {
        return { lines: bodyLines, content: bodyLines.join('\n') };
      }
      continue;
    }

    // End of function body
    if (started && braceDepth === 0) {
      return { lines: bodyLines, content: bodyLines.join('\n') };
    }

    // Safety limit
    if (bodyLines.length > 1000) {
      return { lines: bodyLines, content: bodyLines.join('\n') };
    }
  }

  return bodyLines.length > 0 ? { lines: bodyLines, content: bodyLines.join('\n') } : null;
}

// ─────────────────────────────────────────────────────────────
// Complexity Calculation
// ─────────────────────────────────────────────────────────────

function calculateCyclomaticComplexity(code) {
  // Start with 1 (base path)
  let complexity = 1;

  // Remove strings and comments to avoid false positives
  const cleaned = removeStringsAndComments(code);

  // Decision points that add to cyclomatic complexity
  const patterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bdo\s*\{/g,
    /\bcase\s+[^:]+:/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]/g,           // Ternary operator (? but not ?. or ??)
    /\&\&/g,                // Logical AND
    /\|\|/g,                // Logical OR
    /\?\?/g,                // Nullish coalescing
  ];

  for (const pattern of patterns) {
    const matches = cleaned.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

function calculateCognitiveComplexity(code) {
  let complexity = 0;
  let nestingLevel = 0;

  const lines = code.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }

    // Track nesting level
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check for control flow before adjusting nesting
    // These add 1 + nesting level
    if (/\bif\s*\(/.test(trimmed) && !/\belse\s+if/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\belse\s+if\s*\(/.test(trimmed)) {
      complexity += 1; // else if doesn't add nesting penalty
    }
    if (/\belse\s*\{/.test(trimmed)) {
      complexity += 1; // else adds 1
    }
    if (/\bfor\s*\(/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\bwhile\s*\(/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\bdo\s*\{/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\bswitch\s*\(/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\bcatch\s*\(/.test(trimmed)) {
      complexity += 1 + nestingLevel;
    }
    if (/\btry\s*\{/.test(trimmed)) {
      // try doesn't add complexity, just nesting
    }

    // Logical operators add 1 each (no nesting penalty)
    const andMatches = trimmed.match(/\&\&/g);
    const orMatches = trimmed.match(/\|\|/g);
    const nullishMatches = trimmed.match(/\?\?/g);
    const ternaryMatches = trimmed.match(/\?[^:?]/g);

    if (andMatches) complexity += andMatches.length;
    if (orMatches) complexity += orMatches.length;
    if (nullishMatches) complexity += nullishMatches.length;
    if (ternaryMatches) complexity += ternaryMatches.length;

    // Update nesting after processing line
    // Only count structural nesting (if/for/while/etc), not object literals
    if (/\b(if|for|while|do|switch|try|catch|else)\b/.test(trimmed) && openBraces > 0) {
      nestingLevel += openBraces;
    } else {
      nestingLevel += openBraces;
    }
    nestingLevel -= closeBraces;
    nestingLevel = Math.max(0, nestingLevel);
  }

  return complexity;
}

function removeStringsAndComments(code) {
  // Remove single-line comments
  let result = code.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove template literals (simplified)
  result = result.replace(/`[^`]*`/g, '""');
  // Remove strings
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");

  return result;
}

// ─────────────────────────────────────────────────────────────
// Complexity Rating
// ─────────────────────────────────────────────────────────────

function getRating(cyclomatic) {
  if (cyclomatic <= 10) return { label: 'simple', icon: 'ok' };
  if (cyclomatic <= 20) return { label: 'moderate', icon: '~' };
  if (cyclomatic <= 50) return { label: 'complex', icon: '! ' };
  return { label: 'very complex', icon: 'X' };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let threshold = 0;
let sortBy = 'cyclomatic';
let topN = Infinity;
let summaryOnly = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--threshold' || arg === '-t') {
    threshold = parseInt(options.remaining[++i], 10) || 0;
  } else if (arg === '--sort') {
    sortBy = options.remaining[++i];
  } else if (arg === '--top') {
    topN = parseInt(options.remaining[++i], 10) || 20;
  } else if (arg === '--summary') {
    summaryOnly = true;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const targetPath = remaining[0] || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Find files
let files = [];
const stat = statSync(targetPath);
if (stat.isFile()) {
  files = [targetPath];
} else {
  files = findCodeFiles(targetPath);
}

if (files.length === 0) {
  console.error('No code files found');
  process.exit(1);
}

// Analyze all functions
const allFunctions = [];
const fileSummaries = [];

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const relPath = relative(projectRoot, file);
  const functions = extractFunctions(content, file);

  let fileComplexity = 0;
  let fileCognitive = 0;

  for (const func of functions) {
    const cyclomatic = calculateCyclomaticComplexity(func.body);
    const cognitive = calculateCognitiveComplexity(func.body);

    fileComplexity += cyclomatic;
    fileCognitive += cognitive;

    if (cyclomatic >= threshold) {
      allFunctions.push({
        file: relPath,
        name: func.name,
        line: func.startLine,
        loc: func.loc,
        cyclomatic,
        cognitive,
        rating: getRating(cyclomatic)
      });
    }
  }

  if (functions.length > 0) {
    fileSummaries.push({
      file: relPath,
      functions: functions.length,
      totalCyclomatic: fileComplexity,
      totalCognitive: fileCognitive,
      avgCyclomatic: Math.round(fileComplexity / functions.length * 10) / 10
    });
  }
}

// Sort functions
allFunctions.sort((a, b) => {
  if (sortBy === 'cognitive') return b.cognitive - a.cognitive;
  if (sortBy === 'name') return a.name.localeCompare(b.name);
  if (sortBy === 'loc') return b.loc - a.loc;
  return b.cyclomatic - a.cyclomatic; // default: cyclomatic
});

// Apply top N limit
const displayFunctions = allFunctions.slice(0, topN);

// Set JSON data
out.setData('functions', allFunctions);
out.setData('fileSummaries', fileSummaries);
out.setData('totalFunctions', allFunctions.length);

// Output
if (summaryOnly) {
  out.header(`Complexity Summary (${fileSummaries.length} files)`);
  out.blank();

  // Sort files by total complexity
  fileSummaries.sort((a, b) => b.totalCyclomatic - a.totalCyclomatic);

  const rows = fileSummaries.map(f => [
    f.file,
    `${f.functions} fn`,
    `avg ${f.avgCyclomatic}`,
    `total ${f.totalCyclomatic}`
  ]);

  formatTable(rows).forEach(line => out.add(line));
} else {
  out.header(`Function Complexity (${displayFunctions.length}${allFunctions.length > topN ? ` of ${allFunctions.length}` : ''} functions)`);
  out.blank();

  if (displayFunctions.length === 0) {
    out.add(`No functions found with complexity >= ${threshold}`);
  } else {
    // Group by file
    const byFile = new Map();
    for (const func of displayFunctions) {
      if (!byFile.has(func.file)) byFile.set(func.file, []);
      byFile.get(func.file).push(func);
    }

    for (const [file, funcs] of byFile) {
      out.add(`${file}`);
      for (const func of funcs) {
        const rating = func.rating;
        out.add(`  ${rating.icon} ${func.name} (L${func.line}): cyclo=${func.cyclomatic} cog=${func.cognitive} loc=${func.loc}`);
      }
      out.blank();
    }
  }
}

// Summary stats
if (!options.quiet && allFunctions.length > 0) {
  const totalCyclo = allFunctions.reduce((sum, f) => sum + f.cyclomatic, 0);
  const avgCyclo = Math.round(totalCyclo / allFunctions.length * 10) / 10;
  const maxCyclo = Math.max(...allFunctions.map(f => f.cyclomatic));

  const complex = allFunctions.filter(f => f.cyclomatic > 10).length;
  const veryComplex = allFunctions.filter(f => f.cyclomatic > 20).length;

  out.add('---');
  out.add(`Avg complexity: ${avgCyclo} | Max: ${maxCyclo} | Complex (>10): ${complex} | Very complex (>20): ${veryComplex}`);
}

out.print();
