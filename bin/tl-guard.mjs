#!/usr/bin/env node

/**
 * tl-guard - Pre-commit sanity check
 *
 * Runs 4 checks: secrets, new TODOs, unused exports, circular deps.
 * Reports pass/warn/fail for each.
 *
 * Usage: tl-guard [--no-secrets] [--no-todos] [--no-unused] [--no-circular] [--strict] [-j] [-q]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-guard',
    desc: 'Pre-commit sanity check (secrets, TODOs, unused, circular)',
    when: 'before-commit',
    example: 'tl-guard'
  }));
  process.exit(0);
}

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, getSkipDirs, isCodeFile } from '../src/project.mjs';
import { gitCommand, rgCommand } from '../src/shell.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP = `
tl-guard - Pre-commit sanity check

Runs 4 checks against your project and staged files:
  1. Secrets    — hardcoded secrets in staged files
  2. TODOs      — new TODO/FIXME/HACK/XXX in staged diff
  3. Unused     — unused exports across the project
  4. Circular   — circular import dependencies

Usage: tl-guard [options]

Options:
  --no-secrets          Skip secrets check
  --no-todos            Skip TODO/FIXME check
  --no-unused           Skip unused exports check
  --no-circular         Skip circular deps check
  --strict              Treat warnings as failures (exit 1)
${COMMON_OPTIONS_HELP}

Examples:
  tl-guard                    # Full check
  tl-guard --no-unused        # Skip unused exports
  tl-guard --strict           # Warnings become failures
  tl-guard -j                 # JSON output
  tl-guard -q                 # Quiet mode
`;

// ─────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ─────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const { maxLines, maxTokens, json, quiet, help, remaining } = parseCommonArgs(rawArgs);

if (help) {
  console.log(HELP);
  process.exit(0);
}

const skipChecks = {
  secrets: rawArgs.includes('--no-secrets'),
  todos: rawArgs.includes('--no-todos'),
  unused: rawArgs.includes('--no-unused'),
  circular: rawArgs.includes('--no-circular'),
};
const strict = rawArgs.includes('--strict');

// ─────────────────────────────────────────────────────────────
// Sub-tool Runner (tl-analyze pattern)
// ─────────────────────────────────────────────────────────────

function runSubTool(toolName, args = []) {
  const toolPath = join(__dirname, `tl-${toolName}.mjs`);
  const proc = spawnSync(process.execPath, [toolPath, ...args, '--json'], {
    encoding: 'utf-8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  // tl-secrets exits 1 on high-severity findings but still produces valid JSON
  if (proc.error || (proc.status !== 0 && !proc.stdout)) return null;
  try { return JSON.parse(proc.stdout); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// Check 1: Secrets in staged files
// ─────────────────────────────────────────────────────────────

function checkSecrets() {
  const data = runSubTool('secrets', ['--staged']);
  if (!data) {
    return { status: 'pass', count: 0, details: [], note: 'no staged files or tool unavailable' };
  }

  const findings = data.findings || [];
  if (findings.length === 0) {
    return { status: 'pass', count: 0, details: [] };
  }

  const hasHigh = findings.some(f => f.severity === 'high');
  return {
    status: hasHigh ? 'fail' : 'warn',
    count: findings.length,
    details: findings.map(f => ({
      file: f.file,
      line: f.line,
      type: f.name || f.type,
      severity: f.severity
    }))
  };
}

// ─────────────────────────────────────────────────────────────
// Check 2: New TODOs/FIXMEs in staged diff
// ─────────────────────────────────────────────────────────────

function checkTodos() {
  const diff = gitCommand(['diff', '--cached', '-U0']);
  if (diff === null || diff === '') {
    return { status: 'pass', count: 0, details: [], note: 'no staged changes' };
  }

  const markerRe = /\b(TODO|FIXME|HACK|XXX)\b/i;
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  const todos = [];
  let currentFile = null;
  let hunkLine = 0;
  let addOffset = 0;

  for (const line of diff.split('\n')) {
    // Track current file from diff headers
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    // Track line numbers from hunk headers
    const hunkMatch = line.match(hunkRe);
    if (hunkMatch) {
      hunkLine = parseInt(hunkMatch[1], 10);
      addOffset = 0;
      continue;
    }

    // Only look at added lines
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      const match = content.match(markerRe);
      if (match && currentFile) {
        todos.push({
          file: currentFile,
          line: hunkLine + addOffset,
          marker: match[1].toUpperCase(),
          text: content.trim().slice(0, 80)
        });
      }
      addOffset++;
    } else if (line.startsWith('-')) {
      // removed lines don't advance the new-file line counter
    } else if (!line.startsWith('\\')) {
      // context line (shouldn't appear with -U0, but be safe)
      addOffset++;
    }
  }

  return {
    status: todos.length > 0 ? 'warn' : 'pass',
    count: todos.length,
    details: todos
  };
}

// ─────────────────────────────────────────────────────────────
// Check 3: Unused exports
// ─────────────────────────────────────────────────────────────

function checkUnused() {
  const data = runSubTool('unused', ['.']);
  if (!data) {
    return { status: 'pass', count: 0, details: [], note: 'tool unavailable' };
  }

  const unused = data.unusedExports || [];
  if (unused.length === 0) {
    return { status: 'pass', count: 0, details: [] };
  }

  return {
    status: 'warn',
    count: unused.length,
    details: unused.map(u => ({
      file: u.file,
      name: u.name,
      line: u.line
    }))
  };
}

// ─────────────────────────────────────────────────────────────
// Check 4: Circular dependencies
// ─────────────────────────────────────────────────────────────

const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.tsx', '/index.mjs'];

function buildImportGraph(projectRoot) {
  const skipGlobs = [...getSkipDirs()].map(d => `!${d}`);
  const output = rgCommand([
    '-n', '--no-heading',
    ...skipGlobs.flatMap(g => ['--glob', g]),
    '-e', "from\\s+['\"]\\./|from\\s+['\"]\\.\\./",
    '-e', "require\\s*\\(\\s*['\"]\\./|require\\s*\\(\\s*['\"]\\.\\./",
    projectRoot
  ]);

  if (!output) return new Map();

  const graph = new Map(); // file -> Set<file>
  const importSpecRe = /(?:from|require\s*\()\s*['"](\.[^'"]+)['"]/g;

  for (const line of output.split('\n')) {
    if (!line) continue;
    // Format: filepath:linenum:content
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const rest = line.slice(colonIdx + 1);
    const colonIdx2 = rest.indexOf(':');
    if (colonIdx2 === -1) continue;

    const filePath = line.slice(0, colonIdx);
    const content = rest.slice(colonIdx2 + 1);

    if (!isCodeFile(filePath)) continue;

    const fileDir = dirname(filePath);
    let match;
    importSpecRe.lastIndex = 0;
    while ((match = importSpecRe.exec(content)) !== null) {
      const spec = match[1];
      const resolved = resolveImport(fileDir, spec, projectRoot);
      if (resolved) {
        const relFrom = relative(projectRoot, filePath);
        const relTo = relative(projectRoot, resolved);
        if (!graph.has(relFrom)) graph.set(relFrom, new Set());
        graph.get(relFrom).add(relTo);
      }
    }
  }

  return graph;
}

function resolveImport(fromDir, spec, projectRoot) {
  const base = resolve(fromDir, spec);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function detectCycles(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  const cycles = [];

  for (const node of graph.keys()) {
    color.set(node, WHITE);
  }
  // Also mark nodes that only appear as targets
  for (const deps of graph.values()) {
    for (const dep of deps) {
      if (!color.has(dep)) color.set(dep, WHITE);
    }
  }

  function dfs(u) {
    color.set(u, GRAY);
    const neighbors = graph.get(u) || new Set();
    for (const v of neighbors) {
      if (color.get(v) === GRAY) {
        // Found cycle — reconstruct
        const cycle = [v, u];
        let cur = u;
        while (cur !== v && parent.has(cur)) {
          cur = parent.get(cur);
          if (cur === v) break;
          cycle.push(cur);
        }
        cycle.reverse();
        cycles.push(cycle);
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  // Deduplicate: normalize cycles by rotating to start with smallest element
  const seen = new Set();
  const unique = [];
  for (const cycle of cycles) {
    const minIdx = cycle.indexOf(cycle.reduce((a, b) => a < b ? a : b));
    const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
    const key = normalized.join(' -> ');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(normalized);
    }
  }

  return unique;
}

function checkCircular(projectRoot) {
  const graph = buildImportGraph(projectRoot);
  if (graph.size === 0) {
    return { status: 'pass', count: 0, details: [] };
  }

  const cycles = detectCycles(graph);
  if (cycles.length === 0) {
    return { status: 'pass', count: 0, details: [] };
  }

  return {
    status: 'warn',
    count: cycles.length,
    details: cycles.map(c => ({
      cycle: [...c, c[0]].join(' -> ')
    }))
  };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const projectRoot = findProjectRoot();

// Get staged file count for display
const stagedRaw = gitCommand(['diff', '--cached', '--name-only']);
const stagedFiles = stagedRaw ? stagedRaw.split('\n').filter(Boolean) : [];

// Run enabled checks
const checks = {};

if (!skipChecks.secrets) {
  checks.secrets = checkSecrets();
}

if (!skipChecks.todos) {
  checks.todos = checkTodos();
}

if (!skipChecks.unused) {
  checks.unused = checkUnused();
}

if (!skipChecks.circular) {
  checks.circular = checkCircular(projectRoot);
}

// Compute summary
let passed = 0, warnings = 0, failed = 0;
for (const result of Object.values(checks)) {
  if (result.status === 'pass') passed++;
  else if (result.status === 'warn') warnings++;
  else if (result.status === 'fail') failed++;
}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────

const out = createOutput({ maxLines, maxTokens, json, quiet });

const STATUS_ICON = { pass: '\u2713', warn: '\u26A0', fail: '\u2717' };
const CHECK_LABELS = {
  secrets: 'Secrets',
  todos: 'TODOs',
  unused: 'Unused',
  circular: 'Circular',
};
const CHECK_PASS_MSG = {
  secrets: `No secrets in staged files (${stagedFiles.length} files)`,
  todos: 'No TODO/FIXME introduced',
  unused: 'No unused exports detected',
  circular: 'No circular dependencies',
};

out.header('tl-guard \u2014 Pre-commit sanity check');
out.blank();

for (const [name, result] of Object.entries(checks)) {
  const icon = STATUS_ICON[result.status];
  const label = CHECK_LABELS[name].padEnd(12);

  if (result.status === 'pass') {
    const msg = result.note || CHECK_PASS_MSG[name];
    out.add(`  ${icon} ${label} ${msg}`);
  } else {
    // Fail or warn — show count and details
    const verb = result.status === 'fail' ? 'found' : 'detected';
    out.add(`  ${icon} ${label} ${result.count} ${name === 'circular' ? 'cycle(s)' : 'issue(s)'} ${verb}`);

    // Show details indented
    for (const d of result.details) {
      if (name === 'secrets') {
        out.add(`                     ${d.file}:${d.line} [${d.severity}] ${d.type}`);
      } else if (name === 'todos') {
        out.add(`                     ${d.file}:${d.line} ${d.marker}: ${d.text}`);
      } else if (name === 'unused') {
        out.add(`                     ${d.file}: ${d.name}`);
      } else if (name === 'circular') {
        out.add(`                     ${d.cycle}`);
      }
    }
  }
}

out.blank();
out.stats(`${passed} passed, ${warnings} warning(s), ${failed} failed`);

// JSON data
out.setData('checks', checks);
out.setData('stagedFiles', stagedFiles.length);
out.setData('summary', { passed, warnings, failed });

// Quiet mode override
if (quiet && !json) {
  const lines = [];
  for (const [name, result] of Object.entries(checks)) {
    const icon = STATUS_ICON[result.status];
    const suffix = result.count > 0 ? `:${result.count}` : '';
    lines.push(`${icon} ${name}${suffix}`);
  }
  console.log(lines.join('\n'));
} else {
  out.print();
}

// Exit code
const hasFailed = failed > 0 || (strict && warnings > 0);
process.exit(hasFailed ? 1 : 0);
