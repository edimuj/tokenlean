#!/usr/bin/env node

/**
 * tl-run - Smart command runner with token-efficient output
 *
 * Wraps shell commands and produces token-efficient summaries.
 * Auto-detects output type (test/build/lint/generic) and extracts
 * only what matters — turning 300-line test runs into 10-line failure summaries.
 *
 * Usage: tl-run <command> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-run',
    desc: 'Smart command runner with token-efficient output',
    when: 'search',
    example: 'tl-run "npm test"'
  }));
  process.exit(0);
}

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { getConfig } from '../src/config.mjs';
import { stripAnsi, formatElapsed } from '../src/text-util.mjs';

const HELP = `
tl-run - Smart command runner with token-efficient output

Usage: tl-run <command> [options]

Wraps shell commands and produces token-efficient summaries.
Auto-detects output type (test/build/lint/generic) and extracts
only what matters.

Compresses passing runs; on a non-zero exit it shows the raw output
(budgeted so failing/error lines surface from anywhere in the stream,
not just the tail) so the failure is never hidden behind a summary.

Chained commands (cmd1 && cmd2, a || b, x; y) run in ONE shell — so
cd/export/source state carries across — but each segment is detected
and summarized independently instead of mangling the combined output.
Operators and the overall exit code match the shell exactly.

Options:
  --type <type>         Force output type: test, build, lint, generic (default: auto)
                        (forcing a type disables per-segment splitting)
  --raw                 Show full output, no summarization
  --no-split            Treat a chained command as one blob (legacy behavior)
  --timeout <ms>        Command timeout in ms (default: 120000 / 2min)
  --diff                Compare output against previous run of same command
${COMMON_OPTIONS_HELP}

Examples:
  tl-run "npm test"                     # Auto-detect, summarize
  tl-run "cargo build" --type build     # Force type
  tl-run "eslint src/" --raw            # Full output, no summarization
  tl-run "npm test" -j                  # JSON structured output
  tl-run "long-command" --timeout 60000 # Custom timeout
  tl-run "cd src && npm run build && npm test"  # Per-segment summaries
`;

const VALID_TYPES = ['test', 'build', 'lint', 'generic'];
const ANALYSIS_CHAR_LIMIT = 300000;
// On a non-zero exit we stop trusting the per-framework failure parser and show
// raw output instead (see summaryToLines). This is the line budget for that raw
// dump when the caller didn't set an explicit -l/-t — generous on purpose, since
// failure is exactly when the agent needs ground truth and a rerun costs more.
const DEFAULT_FAILURE_BUDGET = 120;
const GENERIC_FAST_PATH_CHAR_LIMIT = 120000;
// Default command timeout. Kept modest because output is buffered (no live
// feedback), so a hung command should surface as a timeout quickly rather than
// tying up an interactive agent. Override with --timeout or run.timeout config.
const DEFAULT_TIMEOUT = 120000;
const MAX_BUFFER = 50 * 1024 * 1024;
// Grace period between SIGTERM and SIGKILL when terminating the process group.
const KILL_GRACE_MS = 2000;
// Grace period after the child process exits to let 'close' flush any buffered
// pipe output. If 'close' never fires (an escaped grandchild holds the pipe),
// we finish anyway once this elapses rather than hang forever. See runCommand.
const CLOSE_GRACE_MS = 1000;

function sampleTextForAnalysis(text, maxChars = ANALYSIS_CHAR_LIMIT) {
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.45);
  const tailChars = maxChars - headChars;
  const omittedChars = text.length - maxChars;
  return `${text.slice(0, headChars)}\n... ${omittedChars} chars omitted for analysis ...\n${text.slice(-tailChars)}`;
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lines++;
  }
  return lines;
}

function headLines(text, maxLines, maxChars = 60000) {
  return text.slice(0, maxChars).split('\n').slice(0, maxLines);
}

function tailLines(text, maxLines, maxChars = 60000) {
  return text.slice(-maxChars).split('\n').slice(-maxLines);
}

// ─────────────────────────────────────────────────────────────
// Command Execution
// ─────────────────────────────────────────────────────────────

// Run a shell command, capturing stdout/stderr. Uses an async, detached spawn
// so that on timeout we can kill the entire process group (SIGTERM then
// SIGKILL) rather than just the shell. spawnSync only signals the direct child,
// leaving grandchildren (e.g. tsc/bun/jest workers) orphaned and, when they
// keep the stdout pipe open, can hang the parent past its own timeout.
function runCommand(command, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(command, {
        shell: true,
        detached: true, // own process group so we can kill the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          TERM: 'dumb'
        }
      });
    } catch (err) {
      resolve({ stdout: '', stderr: err.message, exitCode: 127, elapsed: Date.now() - start, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    // Kill the child's whole process group; fall back to the bare child if the
    // group signal fails (e.g. the leader already exited).
    const killGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    };

    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killGroup('SIGTERM');
          killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
          killTimer.unref();
        }, timeout)
      : null;

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk;
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        exitCode,
        elapsed: Date.now() - start,
        timedOut
      });
    };

    // Map an (code, signal) pair to our exit code, identically for 'exit' and
    // 'close'. Timeout always wins (124).
    const resolveCode = (code, signal) => {
      if (timedOut) return 124; // standard timeout exit code
      if (code === null) return signal ? 1 : 0;
      return code;
    };

    child.on('error', (err) => {
      // Spawn-level failure (e.g. shell missing). No process to wait on.
      stderr = stderr || err.message;
      finish(127);
    });

    // 'close' fires only after the child AND every inherited stdio pipe reaches
    // EOF. A grandchild that escaped the process group (a daemonized/setsid
    // worker — e.g. some test runners' workers) keeps the stdout/stderr pipe
    // open, so 'close' can NEVER fire even though the command itself finished or
    // was killed. That left agents hanging indefinitely past the timeout. So we
    // also resolve on 'exit' (the process is gone) after a short grace for
    // 'close' to flush buffered output; whichever fires first wins.
    child.on('exit', (code, signal) => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => finish(resolveCode(code, signal)), CLOSE_GRACE_MS);
      graceTimer.unref();
    });

    child.on('close', (code, signal) => {
      finish(resolveCode(code, signal));
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Command Chaining (&& / || / ;)
// ─────────────────────────────────────────────────────────────

// Split a command on TOP-LEVEL &&, ||, ; — respecting single/double quotes,
// backslash escapes, backticks, and (...)/$(...) nesting. A single | (pipe)
// stays inside its segment (a pipeline is one logical command). Returns
// { segments, ops } where ops connects segments[i] and segments[i+1], or null
// when the command isn't a chain or contains constructs we won't instrument
// (heredocs, top-level backgrounding &, brace groups, unbalanced quotes/parens).
// Falling back to null is always safe: the caller runs the command unsplit.
function splitTopLevel(command) {
  const parts = [];
  const ops = [];
  let buf = '';
  let sq = false, dq = false, bt = false;
  let parenDepth = 0;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];

    if (escaped) { buf += c; escaped = false; continue; }
    if (c === '\\') {
      if (sq) { buf += c; continue; } // literal inside single quotes
      buf += c; escaped = true; continue;
    }
    if (sq) { buf += c; if (c === "'") sq = false; continue; }
    if (dq) { buf += c; if (c === '"') dq = false; continue; }
    if (c === "'") { sq = true; buf += c; continue; }
    if (c === '"') { dq = true; buf += c; continue; }
    if (c === '`') { bt = !bt; buf += c; continue; }
    if (bt) { buf += c; continue; }

    if (c === '$' && next === '(') { parenDepth++; buf += '$('; i++; continue; }
    if (c === '(') { parenDepth++; buf += c; continue; }
    if (c === ')') { if (parenDepth > 0) parenDepth--; buf += c; continue; }
    if (parenDepth > 0) { buf += c; continue; }

    // Top-level, unquoted territory.
    if (c === '<' && next === '<') return null;            // heredoc / here-string
    if (c === '{' && (next === undefined || /\s/.test(next))) return null; // brace group / fn body
    if (c === '&') {
      if (next === '&') { parts.push(buf); ops.push('&&'); buf = ''; i++; continue; }
      return null;                                         // top-level background
    }
    if (c === '|') {
      if (next === '|') { parts.push(buf); ops.push('||'); buf = ''; i++; continue; }
      buf += c; continue;                                  // pipe — part of the segment
    }
    if (c === ';') { parts.push(buf); ops.push(';'); buf = ''; continue; }
    buf += c;
  }

  if (sq || dq || bt || escaped || parenDepth !== 0) return null; // unbalanced
  parts.push(buf);

  const segments = parts.map((p) => p.trim());
  if (segments.some((s) => s === '')) return null;         // empty segment (e.g. ;;, trailing op)
  if (segments.length < 2) return null;                    // not a chain
  return { segments, ops };
}

// Single-quote a string for safe interpolation into a /bin/sh script.
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build an instrumented script that runs each segment in the SAME shell (so
// cd/export/source persist) while capturing each segment's stdout/stderr into
// its own file and recording its exit code on fd 9. Original operators are kept
// verbatim, so short-circuiting (&&/||) and the overall exit code are identical
// to running the command directly. Segments that short-circuit never emit a
// status line, so the caller knows they were skipped.
function buildSegmentedScript(segments, ops, dir) {
  const statusFile = join(dir, 'status');
  const group = (seg, i) => {
    const outFile = shQuote(join(dir, `${i}.out`));
    const errFile = shQuote(join(dir, `${i}.err`));
    // newline (not ;) terminates the segment so a trailing comment can't eat the
    // bookkeeping; ( exit $st ) makes the group's status == the segment's status.
    return `{ ${seg}\n__tl_st=$?; printf '%s %s\\n' ${i} "$__tl_st" >&9; ( exit $__tl_st ); } >${outFile} 2>${errFile}`;
  };

  let script = `exec 9>${shQuote(statusFile)}\n`;
  script += group(segments[0], 0);
  for (let i = 1; i < segments.length; i++) {
    script += ` ${ops[i - 1]} ${group(segments[i], i)}`;
  }
  // Capture the chain's status BEFORE closing fd 9 / exiting, so the overall
  // exit code matches the shell exactly (exec 9>&- would otherwise reset $?).
  script += `\n__tl_rc=$?\nexec 9>&-\nexit $__tl_rc\n`;
  return { script, statusFile };
}

// Run a chained command segment-by-segment. Returns per-segment results plus the
// overall exit/elapsed/timedOut (taken from the script as a whole).
async function runSegmented(segments, ops, timeout) {
  const dir = mkdtempSync(join(tmpdir(), 'tlrun-'));
  try {
    const { script, statusFile } = buildSegmentedScript(segments, ops, dir);
    const result = await runCommand(script, timeout);

    const ran = new Map();
    try {
      for (const line of readFileSync(statusFile, 'utf-8').split('\n')) {
        const m = line.match(/^(\d+) (-?\d+)$/);
        if (m) ran.set(parseInt(m[1], 10), parseInt(m[2], 10));
      }
    } catch { /* no status file — treat all as skipped */ }

    const segResults = segments.map((cmd, i) => {
      if (!ran.has(i)) return { index: i, cmd, ran: false };
      let stdout = '', stderr = '';
      try { stdout = stripAnsi(readFileSync(join(dir, `${i}.out`), 'utf-8')); } catch { /* none */ }
      try { stderr = stripAnsi(readFileSync(join(dir, `${i}.err`), 'utf-8')); } catch { /* none */ }
      return { index: i, cmd, ran: true, exitCode: ran.get(i), stdout, stderr };
    });

    return { segResults, exitCode: result.exitCode, elapsed: result.elapsed, timedOut: result.timedOut };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ─────────────────────────────────────────────────────────────
// Type Detection
// ─────────────────────────────────────────────────────────────

const CMD_PATTERNS = {
  test: /\b(test|jest|vitest|mocha|pytest|rspec|phpunit|go\s+test|cargo\s+test|npm\s+test|npx\s+jest|npx\s+vitest)\b/i,
  build: /\b(build|compile|tsc|webpack|make|cargo\s+build|go\s+build|gcc|g\+\+|esbuild|rollup|vite\s+build)\b/i,
  lint: /\b(lint|eslint|prettier|pylint|flake8|clippy|golangci|biome|stylelint|tslint)\b/i
};

const OUTPUT_PATTERNS = {
  test: [
    /\d+\s+(passing|passed|failed|failing)/i,
    /test\s+suites?:/i,
    /tests?:\s+\d+/i,
    /test result:/i,
    /\d+\s+tests?\s+(ran|completed|executed)/i,
    /PASS\s+|FAIL\s+/
  ],
  build: [
    /error\s+(TS|C|E)\d+/i,
    /\bcompiled\b/i,
    /BUILD\s+(SUCCESS|FAILED)/i,
    /\berror\[E\d+\]/,
    /webpack\s+compiled/i,
    /built\s+in\s+\d/i
  ],
  lint: [
    /\d+\s+problems?/i,
    /\d+\s+errors?,\s*\d+\s+warnings?/i,
    /\d+\s+warnings?\s+found/i,
    /✖\s+\d+\s+problems?/i
  ]
};

function detectType(command, stdout, stderr) {
  // Tier 1: Command name matching (highest confidence)
  for (const [type, pattern] of Object.entries(CMD_PATTERNS)) {
    if (pattern.test(command)) return type;
  }

  // Tier 2: Output content matching (require 2+ matches, then fallback to 1)
  const combined = sampleTextForAnalysis(stdout + '\n' + stderr, ANALYSIS_CHAR_LIMIT);

  let bestType = null;
  let bestCount = 0;

  for (const [type, patterns] of Object.entries(OUTPUT_PATTERNS)) {
    let matches = 0;
    for (const pattern of patterns) {
      if (pattern.test(combined)) matches++;
    }
    if (matches > bestCount) {
      bestCount = matches;
      bestType = type;
    }
  }

  // Require 2+ matches for confident detection from output alone
  if (bestCount >= 2) return bestType;

  return 'generic';
}

// ─────────────────────────────────────────────────────────────
// Summarizers
// ─────────────────────────────────────────────────────────────

function summarizeTest(stdout, stderr, exitCode) {
  const stdoutLines = stdout.split('\n');
  const stderrLines = stderr.split('\n');
  const combined = stdout + '\n' + stderr;
  const lines = combined.split('\n');
  const result = { summary: '', failures: [], parsed: false };

  function extractCounts(sourceLines) {
    // Extract pass/fail counts from various test runners.
    let passed = 0, failed = 0, skipped = 0, total = 0;
    let goPassed = 0, goFailed = 0;
    let foundCounts = false;

    for (const line of sourceLines) {
      // Jest/Vitest: Tests: 3 failed, 47 passed, 50 total
      let m = line.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+total)?/i);
      if (m && (m[1] || m[2])) {
        failed = parseInt(m[1] || '0', 10);
        passed = parseInt(m[2] || '0', 10);
        skipped = parseInt(m[3] || '0', 10);
        total = parseInt(m[4] || '0', 10) || (passed + failed + skipped);
        foundCounts = true;
        continue;
      }

      // Mocha/generic: N passing, N failing
      m = line.match(/(\d+)\s+passing/i);
      if (m) { passed = parseInt(m[1], 10); foundCounts = true; }
      m = line.match(/(\d+)\s+failing/i);
      if (m) { failed = parseInt(m[1], 10); foundCounts = true; }

      // pytest: "3 passed, 2 failed in 0.12s" or "====== 3 passed ======"
      // Gated behind summary indicators to avoid matching random log lines.
      if (/={3,}|in\s+[\d.]+s/.test(line)) {
        m = line.match(/(\d+)\s+passed/i);
        if (m) { passed = parseInt(m[1], 10); foundCounts = true; }
        m = line.match(/(\d+)\s+failed/i);
        if (m) { failed = parseInt(m[1], 10); foundCounts = true; }
      }

      // Go test: ok/FAIL per package (counted separately, used as fallback)
      if (line.match(/^ok\s+\S+\/\S+/)) { goPassed++; }
      if (line.match(/^FAIL\s+\S+\/\S+/)) { goFailed++; }

      // Rust: test result: ok. N passed; N failed
      m = line.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed/i);
      if (m) {
        passed = parseInt(m[1], 10);
        failed = parseInt(m[2], 10);
        foundCounts = true;
      }

      // node:test — spec reporter ("ℹ pass 12") and TAP reporter ("# pass 12").
      m = line.match(/^\s*(?:ℹ|#)\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/);
      if (m) {
        const n = parseInt(m[2], 10);
        if (m[1] === 'pass') { passed = n; foundCounts = true; }
        else if (m[1] === 'fail') { failed = n; foundCounts = true; }
        else if (m[1] === 'skipped') { skipped = n; }
        else if (m[1] === 'tests') { total = n; }
      }

      // Bun: counts print on their own line as " N pass" / " N fail" / " N skip"
      // (anchored to the whole line so log noise like "1 failure detected" is ignored).
      m = line.match(/^\s*(\d+)\s+pass(?:ed)?\s*$/i);
      if (m) { passed = parseInt(m[1], 10); foundCounts = true; }
      m = line.match(/^\s*(\d+)\s+fail(?:ed)?\s*$/i);
      if (m) { failed = parseInt(m[1], 10); foundCounts = true; }
      m = line.match(/^\s*(\d+)\s+skip(?:ped)?\s*$/i);
      if (m) { skipped = parseInt(m[1], 10); }
    }

    // Go fallback: use per-package counts if no other runner was detected.
    if (!foundCounts && (goPassed > 0 || goFailed > 0)) {
      passed = goPassed;
      failed = goFailed;
      foundCounts = true;
    }

    if (!foundCounts) {
      total = total || (passed + failed + skipped);
    }

    return { passed, failed, skipped, total, foundCounts };
  }

  const stdoutCounts = extractCounts(stdoutLines);
  const stderrCounts = extractCounts(stderrLines);
  const combinedCounts = extractCounts(lines);
  let { passed, failed, skipped, foundCounts } = combinedCounts;

  // stdout/stderr ordering is unavailable after spawnSync separates streams.
  // For successful runs, prefer any zero-failure runner summary over stale
  // failure-looking diagnostics appended from the other stream.
  if (exitCode === 0) {
    if (stdoutCounts.foundCounts && stdoutCounts.failed === 0) {
      ({ passed, failed, skipped, foundCounts } = stdoutCounts);
    } else if (stderrCounts.foundCounts && stderrCounts.failed === 0) {
      ({ passed, failed, skipped, foundCounts } = stderrCounts);
    }
  }

  // Build summary line
  const parts = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  result.parsed = foundCounts;

  if (exitCode !== 0 && failed === 0) {
    // Fail closed: the command exited non-zero but no test failures were
    // parsed — either an unparsed runner, or a non-test step in the command
    // (a coverage/duplication guard, a post-test lint) failed. NEVER lead with
    // a green "N passed"; surface the failure first so the result can't read
    // as a pass at a glance. The parsed counts are kept as trailing context.
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    result.summary = `tests failed: exit ${exitCode}${detail}`;
  } else {
    result.summary = parts.length > 0 ? parts.join(', ') : (exitCode === 0 ? 'all passed' : 'tests failed');
  }

  // Extract failure details whenever the runner reported failures (parsed
  // `failed > 0` from anchored summary lines — reliable), OR when the command
  // exited non-zero but we couldn't parse counts (unknown state). Crucially,
  // `failed > 0` triggers extraction even on exit 0: a pipe (`... | tail`,
  // `| grep`) or a `pipefail`-less shell masks the real exit code, so a run
  // that printed "1 failed" would otherwise yield an empty failures[] and force
  // the agent to re-run with the bare command just to see WHICH test failed.
  // The exit-0 + no-parsed-counts case is still excluded to avoid false
  // positives from console blocks/warnings on genuinely-green runs.
  if (failed > 0 || (exitCode !== 0 && !foundCounts)) {
    let inFailure = false;
    let currentFailure = null;
    let failureCount = 0;

    // Jest/Vitest: when ● blocks exist, use only those (they have assertion
    // details). FAIL suite lines and ✕ indicators are redundant noise.
    const hasJestBullets = lines.some(l => /^\s*●\s+/.test(l) && !/●\s+Console\s*$/i.test(l));

    for (const line of lines) {
      if (failureCount >= 30) break;

      // Detect failure start patterns
      let failStart;
      if (hasJestBullets) {
        failStart = /^\s*●\s+/.test(line) && !/●\s+Console\s*$/i.test(line)
          ? line.match(/^(\s*)?●\s+(.+)/) : null;
      } else {
        failStart =
          line.match(/^(\s*)?(FAIL|✕|✖|✗|×|✘)\s+(.+)/i) ||
          line.match(/^(\s*)?(FAILED):\s*(.+)/i) ||
          line.match(/^\s*\(fail\)\s+(.+)/i) ||
          line.match(/^\s*\d+\)\s+(.+)/);
      }

      if (failStart) {
        let name = (failStart[3] || failStart[2] || failStart[1] || '').trim();
        // node:test prints a "✖ failing tests:" section header — not a test.
        if (/^(failing|passing) tests:?$/i.test(name)) continue;
        // Strip node:test's trailing "(123.45ms)" timing from the name.
        name = name.replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, '');
        if (currentFailure) {
          result.failures.push(currentFailure);
        }
        currentFailure = { name, message: '', location: '' };
        inFailure = true;
        failureCount++;
        continue;
      }

      if (inFailure && currentFailure) {
        const stripped = line.trim();
        // Capture error/assertion messages (any non-empty, non-stack-trace line)
        if (stripped && !stripped.startsWith('at ') && !stripped.startsWith('|')) {
          const msgLines = currentFailure.message ? currentFailure.message.split('\n').length : 0;
          if (msgLines < 5) {
            currentFailure.message += (currentFailure.message ? '\n' : '') + stripped;
          }
        }
        // Capture file:line location from stack traces
        const locMatch = line.match(/at\s+.*?([^\s(]+:\d+)/);
        if (locMatch && !currentFailure.location) {
          currentFailure.location = locMatch[1];
        }
        // End of failure block
        if (stripped === '' && currentFailure.message) {
          inFailure = false;
        }
      }
    }

    if (currentFailure) {
      result.failures.push(currentFailure);
    }

    // node:test reports each failing test twice (inline during the run, then in
    // the "✖ failing tests:" summary). Collapse by name, keeping the richest.
    if (result.failures.length > 1) {
      const byName = new Map();
      for (const f of result.failures) {
        const prev = byName.get(f.name);
        if (!prev || (f.message.length + f.location.length) > (prev.message.length + prev.location.length)) {
          byName.set(f.name, f);
        }
      }
      result.failures = [...byName.values()];
    }
    result.failures = result.failures.slice(0, 10);
  }

  return result;
}

function summarizeBuild(stdout, stderr, exitCode) {
  const combined = stdout + '\n' + stderr;
  const lines = combined.split('\n');
  const result = { summary: '', errors: [], warningCount: 0 };

  const errors = [];
  const warnings = [];

  for (const line of lines) {
    // Error lines with file:line
    if (/\berror\b/i.test(line) && /[^\s]+:\d+/.test(line)) {
      errors.push(line.trim());
    } else if (/\berror\s*(TS|C|E|\[E)\d+/i.test(line)) {
      errors.push(line.trim());
    } else if (/^\s*error\s*:/i.test(line)) {
      // Bare "error:" prefix (e.g., "error: linker command failed")
      errors.push(line.trim());
    } else if (/\bwarning\b/i.test(line)) {
      warnings.push(line.trim());
    }
  }

  result.warningCount = warnings.length;

  if (exitCode === 0) {
    result.summary = 'build succeeded' + (warnings.length > 0 ? ` (${warnings.length} warnings)` : '');
  } else {
    result.summary = `build failed: ${errors.length} errors` + (warnings.length > 0 ? `, ${warnings.length} warnings` : '');
    result.errors = errors.slice(0, 15);
  }

  return result;
}

function summarizeLint(stdout, stderr, exitCode) {
  const combined = stdout + '\n' + stderr;
  const lines = combined.split('\n');
  const result = { summary: '', violations: [] };

  // Extract problem counts
  let problemMatch = combined.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i);
  if (problemMatch) {
    result.summary = `${problemMatch[1]} problems (${problemMatch[2]} errors, ${problemMatch[3]} warnings)`;
  } else {
    problemMatch = combined.match(/(\d+)\s+errors?,\s*(\d+)\s+warnings?/i);
    if (problemMatch) {
      const total = parseInt(problemMatch[1], 10) + parseInt(problemMatch[2], 10);
      result.summary = `${total} problems (${problemMatch[1]} errors, ${problemMatch[2]} warnings)`;
    }
  }

  if (!result.summary) {
    result.summary = exitCode === 0 ? 'no issues found' : 'lint issues found';
  }

  // Group violations by rule name
  if (exitCode !== 0) {
    const ruleCounts = {};

    for (const line of lines) {
      // ESLint: "rule-name" at end; Biome: "(lint/style/ruleName)"; pylint: "C0301"
      const ruleMatch = line.match(/\(([\w@/.:-]+)\)\s*$/) || line.match(/\s+([\w@/-]+-[\w@/-]+)\s*$/);
      if (ruleMatch && /error|warning|✕|✗/i.test(line)) {
        const rule = ruleMatch[1];
        ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
      }
    }

    // Sort by count descending, take top 10
    result.violations = Object.entries(ruleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule, count]) => ({ rule, count }));
  }

  return result;
}

function summarizeGeneric(stdout, stderr, exitCode) {
  const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
  const result = { summary: '', lines: [] };

  if (!combined) {
    result.summary = exitCode === 0 ? '' : `exited with code ${exitCode}`;
    return result;
  }

  if (combined.length <= GENERIC_FAST_PATH_CHAR_LIMIT) {
    const lines = combined.split('\n');
    // Generic output is often custom tooling where content is intentional.
    // Use generous thresholds — specialized summarizers handle noisy output.
    const showAllLimit = exitCode !== 0 ? 250 : 150;
    if (lines.length <= showAllLimit) {
      result.lines = lines;
      result.summary = exitCode === 0 ? '' : `exited with code ${exitCode}`;
      return result;
    }

    // Non-zero exits: more head/tail lines, broader pattern, higher cap
    const headCount = exitCode !== 0 ? 40 : 25;
    const tailCount = exitCode !== 0 ? 40 : 25;
    const diagCap = exitCode !== 0 ? 25 : 15;
    const diagPattern = exitCode !== 0
      ? /\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception|warn|Warn|WARN|warning|Warning|WARNING|fail|Fail|FAIL|invalid|Invalid|INVALID)\b/
      : /\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception)\b/;

    const head = lines.slice(0, headCount);
    const tail = lines.slice(-tailCount);
    const middle = lines.slice(headCount, -tailCount);
    const diagLines = [];
    for (const line of middle) {
      if (diagLines.length >= diagCap) break;
      if (diagPattern.test(line)) {
        diagLines.push(line);
      }
    }

    const label = exitCode !== 0 ? 'diagnostic' : 'error';
    result.lines = [
      ...head,
      '',
      `... ${middle.length} lines omitted` + (diagLines.length > 0 ? ` (${diagLines.length} ${label} lines shown below)` : ''),
      ''
    ];

    if (diagLines.length > 0) {
      result.lines.push(...diagLines, '');
    }

    result.lines.push(...tail);
    result.summary = `${lines.length} total lines`;
    return result;
  }

  // Large-output fast path: avoid splitting the entire output into an array.
  const totalLines = countLines(combined);
  const headCount = exitCode !== 0 ? 40 : 25;
  const tailCount = exitCode !== 0 ? 40 : 25;
  const diagCap = exitCode !== 0 ? 25 : 15;
  const diagPattern = exitCode !== 0
    ? /\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception|warn|Warn|WARN|warning|Warning|WARNING|fail|Fail|FAIL|invalid|Invalid|INVALID)\b/
    : /\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception)\b/;
  const head = headLines(combined, headCount);
  const tail = tailLines(combined, tailCount);
  const omitted = Math.max(0, totalLines - head.length - tail.length);
  const diagLines = [];

  const middleStart = Math.floor(combined.length * 0.2);
  const middleEnd = Math.floor(combined.length * 0.8);
  const middleSample = sampleTextForAnalysis(combined.slice(middleStart, middleEnd), 80000);

  for (const line of middleSample.split('\n')) {
    if (diagLines.length >= diagCap) break;
    if (diagPattern.test(line)) {
      diagLines.push(line);
    }
  }

  const label = exitCode !== 0 ? 'diagnostic' : 'error';
  result.lines = [
    ...head,
    '',
    `... ${omitted} lines omitted` + (diagLines.length > 0 ? ` (${diagLines.length} ${label} lines shown below)` : ''),
    ''
  ];

  if (diagLines.length > 0) {
    result.lines.push(...diagLines, '');
  }

  result.lines.push(...tail);
  result.summary = `${totalLines} total lines`;

  return result;
}

// ─────────────────────────────────────────────────────────────
// Smart Budget Truncation (generic output + explicit -l/-t)
// ─────────────────────────────────────────────────────────────

function scoreLine(line) {
  const t = line.trim();
  if (!t) return -1;

  let s = 0;

  // Hard error keywords (+3)
  if (/\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception|fail|Fail|FAIL|invalid|Invalid|INVALID)\b/.test(t)) s += 3;

  // Warning keywords (+2)
  if (/\b(warn|Warn|WARN|warning|Warning|WARNING)\b/.test(t)) s += 2;

  // Soft problems — existence and access (+2)
  if (/\b(not found|does not exist|doesn't exist|no such|missing|unavailable)\b/i.test(t)) s += 2;
  if (/\b(denied|refused|rejected|unauthorized|forbidden|inaccessible)\b/i.test(t)) s += 2;

  // Soft problems — state and quality (+2)
  if (/\b(deprecated|obsolete|outdated|stale|insecure|vulnerab\w+)\b/i.test(t)) s += 2;
  if (/\b(cannot|can't|unable|unsupported|unrecognized|unexpected|unhandled|unknown)\b/i.test(t)) s += 2;
  if (/\b(timed? ?out|broken|corrupt(?:ed)?|crash(?:ed)?|abort(?:ed)?|unreachable)\b/i.test(t)) s += 2;

  // Soft problems — lower confidence (+1)
  if (/\b(mismatch|incompatible|conflict|exceeded|exhausted|truncated)\b/i.test(t)) s += 1;
  if (/\b(overflow|leak(?:ed)?|skipped|retrying|degraded|duplicate)\b/i.test(t)) s += 1;

  // Result indicators — unicode + text (+2)
  if (/[✓✗✘✔✕⚠●]/.test(t)) s += 2;
  if (/\b(PASS|VALID|INVALID|SUCCESS|PASSED|FAILED|OK|TIMEOUT|DONE|COMPLETE)\b/.test(t)) s += 2;

  // Section headers and structural markers
  if (/^[━═─┌┐└┘├┤┬┴┼│╔╗╚╝╠╣╦╩╬║]{3,}/.test(t)) s += 1;
  if (/^#{1,4}\s/.test(t)) s += 2;
  if (/^[A-Z][A-Za-z ]+:\s*$/.test(t)) s += 1;
  if (/^──\s/.test(t)) s += 2;

  // Statistics and summaries (+1)
  if (/\b\d+(\.\d+)?%/.test(t)) s += 1;
  if (/\b(Total|Count|Sum|Average|Median|Summary|Result|Statistics)[\s:]/i.test(t)) s += 1;

  // Source references with error context (+2)
  if (/[^\s]+:\d+/.test(t) && /\b(error|warn|fail)/i.test(t)) s += 2;

  // Low-value lines (-1)
  if (/^\[DEBUG/.test(t)) s -= 1;
  if (/^\s*(at |    at )/.test(line)) s -= 1;

  return s;
}

function smartBudgetGeneric(stdout, stderr, exitCode, budget) {
  const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
  const result = { summary: '', lines: [] };

  if (!combined) {
    result.summary = exitCode === 0 ? '' : `exited with code ${exitCode}`;
    return result;
  }

  const lines = combined.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length <= budget) {
    result.lines = lines;
    result.summary = exitCode === 0 ? '' : `exited with code ${exitCode}`;
    return result;
  }

  // Distribute budget: 30% head, 30% tail, rest for scored middle
  const headCount = Math.max(5, Math.ceil(budget * 0.3));
  const tailCount = Math.max(5, Math.ceil(budget * 0.3));
  const markerLines = 3; // blank + omission line + blank
  const middleBudget = Math.max(0, budget - headCount - tailCount - markerLines);

  const head = lines.slice(0, headCount);
  const tail = lines.slice(-tailCount);
  const middle = lines.slice(headCount, lines.length - tailCount);

  // Score and select best middle lines, preserving original order
  let selectedMiddle = [];
  if (middleBudget > 0 && middle.length > 0) {
    const scored = middle.map((line, idx) => ({ line, idx, score: scoreLine(line) }));
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const top = scored.slice(0, middleBudget);
    top.sort((a, b) => a.idx - b.idx); // restore original order
    selectedMiddle = top.map(s => s.line);
  }

  const omitted = middle.length - selectedMiddle.length;

  result.lines = [...head, ''];
  if (omitted > 0) {
    result.lines.push(
      `... ${omitted} lines omitted` +
      (selectedMiddle.length > 0 ? ` (${selectedMiddle.length} high-value lines kept)` : '')
    );
  }
  if (selectedMiddle.length > 0) {
    result.lines.push('', ...selectedMiddle);
  }
  result.lines.push('', ...tail);

  result.summary = `${lines.length} total lines → ${budget} budget`;

  return result;
}

function computeLineBudget(opts) {
  let budget = Infinity;
  if (opts.maxLines < Infinity) {
    budget = Math.min(budget, opts.maxLines - 5); // reserve for headers
  }
  if (opts.maxTokens < Infinity) {
    // ~4 chars/token, ~60 chars/line average
    budget = Math.min(budget, Math.floor((opts.maxTokens * 4) / 60) - 5);
  }
  return budget < Infinity ? Math.max(15, budget) : Infinity;
}

// ─────────────────────────────────────────────────────────────
// Diff Cache (--diff)
// ─────────────────────────────────────────────────────────────

function getCacheDir() {
  return join(process.env.HOME || '/tmp', '.cache', 'tokenlean', 'run');
}

function getCacheKey(command) {
  const cwd = process.cwd();
  return createHash('md5').update(`${cwd}:${command}`).digest('hex').slice(0, 12);
}

function loadPrevious(command) {
  const cacheFile = join(getCacheDir(), `${getCacheKey(command)}.json`);
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf-8'));
  } catch { return null; }
}

function saveCurrent(command, result, type, summary) {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${getCacheKey(command)}.json`);
  writeFileSync(cacheFile, JSON.stringify({
    command, type, exitCode: result.exitCode, elapsed: result.elapsed,
    summary: summary.summary || '',
    failures: summary.failures || [],
    errors: summary.errors || [],
    violations: summary.violations || [],
    timestamp: Date.now()
  }) + '\n', 'utf-8');
}

function diffResults(prev, curr, type) {
  const changes = [];

  if (prev.exitCode !== curr.exitCode) {
    const dir = curr.exitCode === 0 ? 'FIXED' : 'REGRESSED';
    changes.push(`${dir}: exit ${prev.exitCode} -> ${curr.exitCode}`);
  }

  if (type === 'test') {
    // Compare failure lists
    const prevNames = new Set((prev.failures || []).map(f => f.name));
    const currNames = new Set((curr.failures || []).map(f => f.name));

    for (const name of currNames) {
      if (!prevNames.has(name)) changes.push(`  NEW FAILURE: ${name}`);
    }
    for (const name of prevNames) {
      if (!currNames.has(name)) changes.push(`  NOW PASSING: ${name}`);
    }
  }

  if (type === 'build') {
    const prevCount = (prev.errors || []).length;
    const currCount = (curr.errors || []).length;
    if (prevCount !== currCount) {
      changes.push(`  Errors: ${prevCount} -> ${currCount}`);
    }
  }

  if (type === 'lint') {
    const prevCount = (prev.violations || []).reduce((s, v) => s + v.count, 0);
    const currCount = (curr.violations || []).reduce((s, v) => s + v.count, 0);
    if (prevCount !== currCount) {
      changes.push(`  Violations: ${prevCount} -> ${currCount}`);
    }
  }

  return changes;
}

// ─────────────────────────────────────────────────────────────
// Summarize + Render (shared by single and segmented paths)
// ─────────────────────────────────────────────────────────────

// Detect type and summarize one command's output.
function buildSummary(command, stdout, stderr, exitCode, opts, typeArg) {
  const type = typeArg || detectType(command, stdout, stderr);

  // For very large successful outputs, summarize from sampled text only.
  // On failures we keep full output to preserve diagnostics.
  let summaryStdout = stdout;
  let summaryStderr = stderr;
  const totalOutputChars = stdout.length + stderr.length;
  if (exitCode === 0 && totalOutputChars > ANALYSIS_CHAR_LIMIT && type !== 'generic') {
    summaryStdout = sampleTextForAnalysis(stdout, Math.floor(ANALYSIS_CHAR_LIMIT * 0.8));
    summaryStderr = sampleTextForAnalysis(stderr, Math.floor(ANALYSIS_CHAR_LIMIT * 0.2));
  }

  let summary;
  switch (type) {
    case 'test':
      summary = summarizeTest(summaryStdout, summaryStderr, exitCode);
      break;
    case 'build':
      summary = summarizeBuild(summaryStdout, summaryStderr, exitCode);
      break;
    case 'lint':
      summary = summarizeLint(summaryStdout, summaryStderr, exitCode);
      break;
    default: {
      const lineBudget = computeLineBudget(opts);
      summary = lineBudget < Infinity
        ? smartBudgetGeneric(stdout, stderr, exitCode, lineBudget)
        : summarizeGeneric(stdout, stderr, exitCode);
      break;
    }
  }
  return { type, summary };
}

// Turn a summary into renderable lines. Blank entries are preserved so callers
// can reproduce the original spacing (and indent uniformly when needed).
function summaryToLines(type, summary, exitCode, stdout, stderr, opts = {}) {
  // FAILURE PATH — "compress success, pass through failure".
  //
  // The per-framework summarizers (summarizeTest/Build/Lint) parse pass/fail
  // COUNTS reliably but their failure-DETAIL extraction is a long tail of
  // runner-specific regex that silently under-reports: it reported green while
  // tests were red (#59), miscounted failures (#74), and counted "1 failed" but
  // produced an empty failures[] with no test name (#90). The old fallback only
  // showed the tail, so failures buried mid-output were missed entirely.
  //
  // So on any non-zero exit (for a typed run) we STOP trusting the typed detail
  // extraction for the human-readable body and render the raw output through the
  // generic budgeter. scoreLine ranks fail/error/assertion lines highest, so the
  // real failure surfaces from ANYWHERE in the stream — not just the tail. The
  // parsed count rides along as an at-a-glance header but is never the only
  // thing shown, so the result can never read as "passed" when it didn't, and
  // the agent gets ground truth without a rerun. (summary.failures/errors are
  // still populated for JSON/--diff consumers as best-effort metadata.)
  if (exitCode !== 0 && type !== 'generic') {
    const lines = [];
    if (summary.summary) lines.push(summary.summary);
    const budget = computeLineBudget(opts);
    const raw = smartBudgetGeneric(stdout, stderr, exitCode, budget < Infinity ? budget : DEFAULT_FAILURE_BUDGET);
    if (raw.lines.length > 0) {
      lines.push('');
      lines.push(...raw.lines);
    }
    return lines;
  }

  // SUCCESS PATH — compress aggressively; this is where tl_run earns its keep.
  const lines = [];

  if (type === 'test') {
    lines.push(summary.summary);
    if (summary.failures.length > 0) {
      lines.push('');
      for (const f of summary.failures) {
        lines.push(`FAILED: ${f.name}`);
        if (f.message) {
          for (const msgLine of f.message.split('\n')) lines.push(`  ${msgLine}`);
        }
        if (f.location) lines.push(`  at ${f.location}`);
      }
    }
  } else if (type === 'build') {
    lines.push(summary.summary);
    if (summary.errors.length > 0) {
      lines.push('');
      for (const e of summary.errors) lines.push(e);
    }
  } else if (type === 'lint') {
    lines.push(summary.summary);
    if (summary.violations.length > 0) {
      lines.push('');
      lines.push('Top violations:');
      for (const v of summary.violations) lines.push(`  ${v.count}x ${v.rule}`);
    }
  } else {
    if (summary.summary) {
      lines.push(summary.summary);
      lines.push('');
    }
    lines.push(...summary.lines);
  }

  return lines;
}

// Emit summary lines, treating '' as a blank line (skipped in quiet mode, like
// out.blank()) and indenting non-blank lines uniformly when an indent is given.
function emitLines(out, lines, indent = '') {
  for (const line of lines) {
    if (line === '') out.blank();
    else out.add(indent + line);
  }
}

// ─────────────────────────────────────────────────────────────
// Segmented Diff Cache (--diff for chained commands)
// ─────────────────────────────────────────────────────────────

function saveSegmented(command, exitCode, segResults) {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${getCacheKey(command)}.json`), JSON.stringify({
    command,
    type: 'segmented',
    exitCode,
    segments: segResults.filter((s) => s.ran).map((s) => ({ cmd: s.cmd, exitCode: s.exitCode })),
    timestamp: Date.now()
  }) + '\n', 'utf-8');
}

function diffSegmented(prev, exitCode, segResults) {
  const changes = [];
  if (prev.exitCode !== exitCode) {
    changes.push(`${exitCode === 0 ? 'FIXED' : 'REGRESSED'}: exit ${prev.exitCode} -> ${exitCode}`);
  }
  const prevMap = new Map((prev.segments || []).map((s) => [s.cmd, s.exitCode]));
  for (const s of segResults.filter((x) => x.ran)) {
    if (prevMap.has(s.cmd) && prevMap.get(s.cmd) !== s.exitCode) {
      changes.push(`  ${s.cmd}: exit ${prevMap.get(s.cmd)} -> ${s.exitCode}`);
    }
  }
  return changes;
}

// Print the full per-segment report for a chained command, then exit.
async function runSegmentedFlow(command, parsed, timeout, opts, diffMode) {
  const { segments, ops } = parsed;
  const r = await runSegmented(segments, ops, timeout);
  const out = createOutput(opts);
  const ranCount = r.segResults.filter((s) => s.ran).length;

  if (!opts.quiet) {
    out.header(`$ ${command}`);
    const status = r.timedOut ? `timed out after ${formatElapsed(timeout)}` : `exit ${r.exitCode}`;
    out.header(`${formatElapsed(r.elapsed)} | ${status} | ${ranCount}/${segments.length} segments`);
    out.blank();
  }

  const jsonSegments = [];
  for (const s of r.segResults) {
    if (!s.ran) {
      out.add(`[${s.index + 1}] $ ${s.cmd}  (skipped)`);
      jsonSegments.push({ index: s.index, command: s.cmd, ran: false });
      continue;
    }

    const { type, summary } = buildSummary(s.cmd, s.stdout, s.stderr, s.exitCode, opts, null);
    out.add(`[${s.index + 1}] $ ${s.cmd}  -> exit ${s.exitCode} | ${type}`);
    emitLines(out, summaryToLines(type, summary, s.exitCode, s.stdout, s.stderr, opts), '    ');
    out.blank();

    const seg = { index: s.index, command: s.cmd, ran: true, exitCode: s.exitCode, type, summary: summary.summary };
    if (type === 'test') seg.failures = summary.failures;
    else if (type === 'build') { seg.errors = summary.errors; seg.warningCount = summary.warningCount; }
    else if (type === 'lint') seg.violations = summary.violations;
    jsonSegments.push(seg);
  }

  if (diffMode) {
    const prev = loadPrevious(command);
    saveSegmented(command, r.exitCode, r.segResults);
    if (prev) {
      const changes = diffSegmented(prev, r.exitCode, r.segResults);
      out.add(changes.length > 0 ? 'vs previous run:' : 'vs previous run: no change');
      for (const c of changes) out.add(c);
      if (opts.json) out.setData('diff', changes);
    } else {
      out.add('(no previous run to compare — result saved for next --diff)');
    }
  }

  if (opts.json) {
    out.setData('command', command);
    out.setData('exitCode', r.exitCode);
    out.setData('elapsed', formatElapsed(r.elapsed));
    out.setData('type', 'segmented');
    out.setData('timedOut', r.timedOut);
    out.setData('segments', jsonSegments);
  }

  out.print();
  process.exit(r.timedOut ? 124 : r.exitCode);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse common args, but we need to handle our custom args first
  let typeArg = null;
  let raw = false;
  let diffMode = false;
  let noSplit = false;
  let timeout = null;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--type') {
      typeArg = args[++i];
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--diff') {
      diffMode = true;
    } else if (arg === '--no-split') {
      noSplit = true;
    } else if (arg === '--timeout') {
      timeout = parseInt(args[++i], 10);
    } else {
      filteredArgs.push(arg);
    }
  }

  const opts = parseCommonArgs(filteredArgs);

  if (opts.help || opts.remaining.length === 0) {
    console.log(HELP.trim());
    process.exit(0);
  }

  // Validate --type
  if (typeArg && !VALID_TYPES.includes(typeArg)) {
    console.error(`Error: invalid type "${typeArg}". Must be one of: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  // Load config
  const runConfig = getConfig('run') || {};
  const effectiveTimeout = timeout || runConfig.timeout || DEFAULT_TIMEOUT;

  // The command is the first remaining arg (may be quoted)
  const command = opts.remaining.join(' ');

  // Chained command (cmd1 && cmd2, a || b, x; y)? Run each segment in one shell
  // and summarize independently. Skipped when --raw (dump as-is), --type (user
  // forced one type for the whole blob), or --no-split (legacy behavior).
  if (!raw && !typeArg && !noSplit) {
    const parsed = splitTopLevel(command);
    if (parsed) {
      await runSegmentedFlow(command, parsed, effectiveTimeout, opts, diffMode);
      return; // runSegmentedFlow exits the process
    }
  }

  // Execute
  const result = await runCommand(command, effectiveTimeout);

  // Handle timeout
  if (result.timedOut) {
    const out = createOutput(opts);
    out.header(`$ ${command}`);
    out.header(`${formatElapsed(result.elapsed)} | timed out after ${formatElapsed(effectiveTimeout)}`);
    out.blank();
    out.add('Command timed out.');

    if (result.stdout) {
      out.blank();
      out.add('Partial stdout:');
      const partialLines = result.stdout.split('\n').slice(-20);
      out.addLines(partialLines);
    }

    if (opts.json) {
      out.setData('command', command);
      out.setData('exitCode', 124);
      out.setData('elapsed', formatElapsed(result.elapsed));
      out.setData('type', 'timeout');
      out.setData('summary', 'Command timed out');
      out.setData('timedOut', true);
    }

    out.print();
    process.exit(124);
  }

  // Raw mode: output everything as-is
  if (raw) {
    const combined = result.stdout + (result.stderr
      ? `${result.stdout && !result.stdout.endsWith('\n') ? '\n' : ''}${result.stderr}`
      : '');
    if (opts.json) {
      const out = createOutput(opts);
      out.setData('command', command);
      out.setData('exitCode', result.exitCode);
      out.setData('elapsed', formatElapsed(result.elapsed));
      out.setData('type', 'raw');
      out.setData('stdout', result.stdout);
      out.setData('stderr', result.stderr);
      out.setData('output', combined);
      out.print();
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.exitCode);
  }

  // Detect type + summarize
  const { type, summary } = buildSummary(command, result.stdout, result.stderr, result.exitCode, opts, typeArg);

  // Format output
  const out = createOutput(opts);

  if (!opts.quiet) {
    out.header(`$ ${command}`);
    out.header(`${formatElapsed(result.elapsed)} | exit ${result.exitCode} | ${type}`);
    out.blank();
  }

  emitLines(out, summaryToLines(type, summary, result.exitCode, result.stdout, result.stderr, opts));

  // Diff mode: compare with previous run
  if (diffMode) {
    const prev = loadPrevious(command);
    saveCurrent(command, result, type, summary);

    if (prev) {
      const changes = diffResults(prev, { exitCode: result.exitCode, failures: summary.failures, errors: summary.errors, violations: summary.violations }, type);
      if (changes.length > 0) {
        out.blank();
        out.add('vs previous run:');
        for (const c of changes) out.add(c);
      } else {
        out.blank();
        out.add('vs previous run: no change');
      }
      if (opts.json) out.setData('diff', changes);
    } else {
      out.blank();
      out.add('(no previous run to compare — result saved for next --diff)');
    }
  }

  // JSON output data
  if (opts.json) {
    out.setData('command', command);
    out.setData('exitCode', result.exitCode);
    out.setData('elapsed', formatElapsed(result.elapsed));
    out.setData('type', type);
    out.setData('summary', summary.summary);

    if (type === 'test') {
      out.setData('failures', summary.failures);
    } else if (type === 'build') {
      out.setData('errors', summary.errors);
      out.setData('warningCount', summary.warningCount);
    } else if (type === 'lint') {
      out.setData('violations', summary.violations);
    } else {
      out.setData('lines', summary.lines);
    }
  }

  out.print();
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
