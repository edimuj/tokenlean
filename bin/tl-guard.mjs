#!/usr/bin/env node

/**
 * tl-guard - Pre-commit sanity check
 *
 * Runs 4 checks: secrets, new TODOs, unused exports, circular deps.
 * Reports pass/warn/fail for each.
 *
 * Usage: tl-guard [--no-secrets] [--no-todos] [--no-unused] [--no-circular] [--strict] [--full] [-j] [-q]
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

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

Runs 5 checks against your project and staged files:
  1. Secrets    — hardcoded secrets in staged files
  2. TODOs      — new TODO/FIXME/HACK/XXX in staged diff
  3. Unused     — unused exports across the project
  4. Circular   — circular import dependencies
  5. CtrlBytes  — raw control bytes (NUL etc.) in tracked text files

Usage: tl-guard [options]

Options:
  --no-secrets          Skip secrets check
  --no-todos            Skip TODO/FIXME check
  --no-unused           Skip unused exports check
  --no-circular         Skip circular deps check
  --no-ctrlbytes        Skip raw control byte check
  --strict              Treat warnings as failures (exit 1)
  --fix                 Auto-fix: remove console.log statements from staged files
  --detail-limit N      Max detail rows per check (default: 20)
  --full                Show all detail rows
${COMMON_OPTIONS_HELP}

Examples:
  tl-guard                    # Full check
  tl-guard --no-unused        # Skip unused exports
  tl-guard --strict           # Warnings become failures
  tl-guard -j                 # JSON output
  tl-guard -q                 # Quiet mode

Suppressing intentional unused exports (library public API):
  The Unused check shells out to "tl unused". Mark intentional public-API
  exports so they stop being flagged (both here and in tl unused):
  - Inline:  add "// tl-keep" on the export line or directly above it
  - Config:  .tokenleanrc.json — nest the keys under "unused":
               { "unused": {
                   "publicApiGlobs": ["sdk/src/**"],
                   "ignoreExports": ["PROVIDER_CATALOG", "src/api.mjs:foo"]
               } }
  See: tl unused --help
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
  ctrlbytes: rawArgs.includes('--no-ctrlbytes'),
};
const strict = rawArgs.includes('--strict');
const fix = rawArgs.includes('--fix');
const fullDetails = rawArgs.includes('--full');
const detailLimitArgIndex = rawArgs.findIndex(arg => arg === '--detail-limit');
const parsedDetailLimit = detailLimitArgIndex >= 0
  ? Number.parseInt(rawArgs[detailLimitArgIndex + 1], 10)
  : NaN;
const DEFAULT_DETAIL_LIMIT = 20;
const detailLimit = fullDetails
  ? Infinity
  : Number.isFinite(parsedDetailLimit) && parsedDetailLimit >= 0
    ? parsedDetailLimit
    : DEFAULT_DETAIL_LIMIT;

function limitDetails(result) {
  if (!Array.isArray(result.details) || result.details.length <= detailLimit) {
    return result;
  }

  return {
    ...result,
    details: result.details.slice(0, detailLimit),
    omittedDetails: result.details.length - detailLimit
  };
}

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
  const suppressed = (data.suppressedExports || []).length;
  if (unused.length === 0) {
    const note = suppressed > 0
      ? `No unused exports detected (${suppressed} suppressed as public API)`
      : undefined;
    return { status: 'pass', count: 0, details: [], note };
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

const RESOLVE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '/index.js', '/index.ts', '/index.tsx', '/index.mjs'];

function buildImportGraph(projectRoot) {
  const skipGlobs = [...getSkipDirs()].map(d => `!${d}`);
  const output = rgCommand([
    '-n', '--no-heading',
    ...skipGlobs.flatMap(g => ['--glob', g]),
    '-e', "from\\s+['\"]\\./|from\\s+['\"]\\.\\./",
    '-e', "import\\s+['\"]\\./|import\\s+['\"]\\.\\./",
    '-e', "import\\s*\\(",
    '-e', "require\\s*\\(\\s*['\"]\\./|require\\s*\\(\\s*['\"]\\.\\./",
    projectRoot
  ]);

  if (!output) return new Map();

  const graph = new Map(); // file -> Set<file>
  const importSpecRe = /(?:from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]|import\s*\(([^)]*)\)|require\s*\(\s*['"](\.[^'"]+)['"]\s*\))/g;

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
      const dynamicSpec = match[3]?.match(/['"](\.[^'"]+)['"]/);
      const spec = match[1] || match[2] || dynamicSpec?.[1] || match[4];
      if (!spec) continue;
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

  // Iterative DFS — avoids stack overflow on deep graphs
  for (const startNode of graph.keys()) {
    if (color.get(startNode) !== WHITE) continue;

    // Stack holds [node, neighborIterator]
    const stack = [];
    color.set(startNode, GRAY);
    stack.push([startNode, (graph.get(startNode) || new Set())[Symbol.iterator]()]);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [u, iter] = frame;
      const next = iter.next();

      if (next.done) {
        color.set(u, BLACK);
        stack.pop();
        continue;
      }

      const v = next.value;
      const vColor = color.get(v) ?? WHITE;

      if (vColor === GRAY) {
        // Back-edge u→v: reconstruct cycle by walking parent chain from u back to v
        const cycle = [u];
        let cur = u;
        while (cur !== v && parent.has(cur)) {
          cur = parent.get(cur);
          cycle.push(cur);
        }
        // cycle is [u, ..., v] — reverse so it reads v → ... → u (forward order)
        cycle.reverse();
        cycles.push(cycle);
      } else if (vColor === WHITE) {
        parent.set(v, u);
        color.set(v, GRAY);
        stack.push([v, (graph.get(v) || new Set())[Symbol.iterator]()]);
      }
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
// Check 5: Raw control bytes (NUL etc.) in tracked text files
// ─────────────────────────────────────────────────────────────
//
// A single raw NUL (0x00) makes ripgrep treat the whole file as binary, so
// Grep silently returns "no matches" and agents conclude the code is missing.
// plain `grep` can't find NULs (it treats them as line separators), so we read
// bytes directly. Source should use the escape sequence ("\0", "\x1b") instead.

// Bad = C0 controls except the common whitespace ones (\t \n \v \f \r).
function isControlByte(b) {
  return (b >= 0x00 && b <= 0x08) || (b >= 0x0e && b <= 0x1f);
}

function byteName(b) {
  if (b === 0x00) return 'NUL';
  if (b === 0x1b) return 'ESC';
  return `0x${b.toString(16).padStart(2, '0')}`;
}

// Extensions git/agents treat as binary assets — skip without reading.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff', '.svgz',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.zst',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.wasm', '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.db', '.sqlite', '.sqlite3', '.class', '.o', '.a', '.node', '.pyc',
  '.heic', '.psd', '.ai', '.sketch', '.keystore', '.jks'
]);

const MAX_SCAN_BYTES = 5 * 1024 * 1024; // skip files larger than this

function checkControlBytes(projectRoot) {
  const tracked = gitCommand(['ls-files'], { cwd: projectRoot });
  if (tracked === null) {
    return { status: 'pass', count: 0, details: [], note: 'not a git repo or no tracked files' };
  }
  const files = tracked.split('\n').filter(Boolean);
  if (files.length === 0) {
    return { status: 'pass', count: 0, details: [] };
  }

  const findings = [];
  for (const rel of files) {
    if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) continue;

    const absPath = join(projectRoot, rel);
    let buf;
    try {
      buf = readFileSync(absPath);
    } catch {
      continue; // deleted/staged-removed or unreadable
    }
    if (buf.length === 0 || buf.length > MAX_SCAN_BYTES) continue;

    // Single pass: earliest offending byte + total count (for the binary ratio).
    let firstOffset = -1;
    let controlCount = 0;
    for (let i = 0; i < buf.length; i++) {
      if (isControlByte(buf[i])) {
        controlCount++;
        if (firstOffset === -1) firstOffset = i;
      }
    }
    if (firstOffset === -1) continue;

    // Skip genuine binaries with no recognised extension. A real/compressed
    // binary has *many* control bytes (~10%+ of its content); a text file with a
    // stray byte has just one or two. Require both a high ratio AND an absolute
    // floor so a short source file with a single NUL is never mistaken for binary.
    if (controlCount >= 5 && controlCount / buf.length > 0.02) continue;

    const firstByte = buf[firstOffset];
    findings.push({ file: rel, offset: firstOffset, byte: firstByte, name: byteName(firstByte) });
  }

  if (findings.length === 0) {
    return { status: 'pass', count: 0, details: [] };
  }
  return { status: 'warn', count: findings.length, details: findings };
}

// ─────────────────────────────────────────────────────────────
// Auto-fix: remove console.log from staged files
// ─────────────────────────────────────────────────────────────

function autoFix(projectRoot, stagedFiles) {
  let fixedCount = 0;
  const fixedFiles = [];

  for (const relFile of stagedFiles) {
    const absPath = join(projectRoot, relFile);
    if (!isCodeFile(relFile) || !existsSync(absPath)) continue;

    let content;
    try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }

    // Remove console.log statements (full lines) — only log, not warn/info/error/debug
    // Only remove standalone console.log calls, not ones inside expressions
    const lines = content.split('\n');
    const filtered = [];
    let removed = 0;

    for (const line of lines) {
      if (/^\s*console\.log\s*\(/.test(line) && !line.includes('eslint-disable')) {
        removed++;
      } else {
        filtered.push(line);
      }
    }

    if (removed > 0) {
      writeFileSync(absPath, filtered.join('\n'), 'utf-8');
      // Re-stage the file
      gitCommand(['add', absPath], { cwd: projectRoot });
      fixedCount += removed;
      fixedFiles.push({ file: relFile, removed });
    }
  }

  return { fixedCount, fixedFiles };
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
  checks.secrets = limitDetails(checkSecrets());
}

if (!skipChecks.todos) {
  checks.todos = limitDetails(checkTodos());
}

if (!skipChecks.unused) {
  checks.unused = limitDetails(checkUnused());
}

if (!skipChecks.circular) {
  checks.circular = limitDetails(checkCircular(projectRoot));
}

if (!skipChecks.ctrlbytes) {
  checks.ctrlbytes = limitDetails(checkControlBytes(projectRoot));
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
  ctrlbytes: 'CtrlBytes',
};
const CHECK_PASS_MSG = {
  secrets: `No secrets in staged files (${stagedFiles.length} files)`,
  todos: 'No TODO/FIXME introduced',
  unused: 'No unused exports detected',
  circular: 'No circular dependencies',
  ctrlbytes: 'No raw control bytes in tracked files',
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
    const noun = name === 'circular' ? 'cycle(s)' : name === 'ctrlbytes' ? 'file(s)' : 'issue(s)';
    out.add(`  ${icon} ${label} ${result.count} ${noun} ${verb}`);

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
      } else if (name === 'ctrlbytes') {
        out.add(`                     ${d.file} (first ${d.name} at byte ${d.offset})`);
      }
    }
    if (result.omittedDetails > 0) {
      out.add(`                     ... ${result.omittedDetails} more; rerun with --full for all details`);
    }
    if (name === 'ctrlbytes') {
      out.add(`                     fix: replace the literal byte with an escape sequence (e.g. "\\0", "\\x1b")`);
    }
  }
}

// Auto-fix if requested
let fixResult = null;
if (fix) {
  fixResult = autoFix(projectRoot, stagedFiles);
  if (fixResult.fixedCount > 0) {
    out.blank();
    out.add(`  >> Fixed: removed ${fixResult.fixedCount} console statement(s) from ${fixResult.fixedFiles.length} file(s)`);
    for (const f of fixResult.fixedFiles) {
      out.add(`     ${f.file}: ${f.removed} removed`);
    }
  }
}

out.blank();
out.stats(`${passed} passed, ${warnings} warning(s), ${failed} failed`);

// JSON data
out.setData('checks', checks);
out.setData('stagedFiles', stagedFiles.length);
out.setData('summary', { passed, warnings, failed });
if (fixResult) out.setData('fixed', fixResult);

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
