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

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { getConfig } from '../src/config.mjs';

const HELP = `
tl-run - Smart command runner with token-efficient output

Usage: tl-run <command> [options]

Wraps shell commands and produces token-efficient summaries.
Auto-detects output type (test/build/lint/generic) and extracts
only what matters.

Options:
  --type <type>         Force output type: test, build, lint, generic (default: auto)
  --raw                 Show full output, no summarization
  --timeout <ms>        Command timeout in ms (default: 300000 / 5min)
  --diff                Compare output against previous run of same command
${COMMON_OPTIONS_HELP}

Examples:
  tl-run "npm test"                     # Auto-detect, summarize
  tl-run "cargo build" --type build     # Force type
  tl-run "eslint src/" --raw            # Full output, no summarization
  tl-run "npm test" -j                  # JSON structured output
  tl-run "long-command" --timeout 60000 # Custom timeout
`;

const VALID_TYPES = ['test', 'build', 'lint', 'generic'];

// ─────────────────────────────────────────────────────────────
// ANSI Stripping
// ─────────────────────────────────────────────────────────────

function stripAnsi(str) {
  // CSI sequences: ESC [ ... final_byte
  // OSC sequences: ESC ] ... ST
  // Single-char escapes: ESC followed by single char
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\|\x1b[^[\]]/g,
    ''
  );
}

// ─────────────────────────────────────────────────────────────
// Command Execution
// ─────────────────────────────────────────────────────────────

function runCommand(command, timeout) {
  const start = Date.now();

  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb'
    }
  });

  const elapsed = Date.now() - start;

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: 124,  // Standard timeout exit code
        elapsed,
        timedOut: true
      };
    }
    return {
      stdout: '',
      stderr: result.error.message,
      exitCode: 127,
      elapsed,
      timedOut: false
    };
  }

  return {
    stdout: stripAnsi(result.stdout || ''),
    stderr: stripAnsi(result.stderr || ''),
    exitCode: result.status ?? 1,
    elapsed,
    timedOut: false
  };
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
  const combined = stdout + '\n' + stderr;

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
  const combined = stdout + '\n' + stderr;
  const lines = combined.split('\n');
  const result = { summary: '', failures: [], parsed: false };

  // Extract pass/fail counts from various test runners
  let passed = 0, failed = 0, skipped = 0, total = 0;
  let goPassed = 0, goFailed = 0;
  let foundCounts = false;

  for (const line of lines) {
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
    // Gated behind summary indicators to avoid matching random log lines
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
  }

  // Go fallback: use per-package counts if no other runner was detected
  if (!foundCounts && (goPassed > 0 || goFailed > 0)) {
    passed = goPassed;
    failed = goFailed;
    foundCounts = true;
  }

  if (!foundCounts) {
    total = total || (passed + failed + skipped);
  }

  // Build summary line
  const parts = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  result.summary = parts.length > 0 ? parts.join(', ') : (exitCode === 0 ? 'all passed' : 'tests failed');
  result.parsed = foundCounts;

  // When exit is non-zero but runner reports 0 failures, note it
  // (common with Jest console warnings, unhandled promise warnings, etc.)
  if (exitCode !== 0 && failed === 0 && foundCounts) {
    result.summary += ` (exit ${exitCode})`;
  }

  // Extract failure details — only when the runner actually reports failures,
  // or when we couldn't parse counts (unknown state). Avoids false positives
  // from Jest console blocks, warnings, etc. when all tests actually pass.
  if (exitCode !== 0 && (failed > 0 || !foundCounts)) {
    let inFailure = false;
    let currentFailure = null;
    let failureCount = 0;

    // Jest/Vitest: when ● blocks exist, use only those (they have assertion
    // details). FAIL suite lines and ✕ indicators are redundant noise.
    const hasJestBullets = lines.some(l => /^\s*●\s+/.test(l) && !/●\s+Console\s*$/i.test(l));

    for (const line of lines) {
      if (failureCount >= 10) break;

      // Detect failure start patterns
      let failStart;
      if (hasJestBullets) {
        failStart = /^\s*●\s+/.test(line) && !/●\s+Console\s*$/i.test(line)
          ? line.match(/^(\s*)?●\s+(.+)/) : null;
      } else {
        failStart =
          line.match(/^(\s*)?(FAIL|✕|✗|×|✘)\s+(.+)/i) ||
          line.match(/^(\s*)?(FAILED):\s*(.+)/i) ||
          line.match(/^\s*\d+\)\s+(.+)/);
      }

      if (failStart) {
        if (currentFailure) {
          result.failures.push(currentFailure);
        }
        const name = (failStart[3] || failStart[2] || failStart[1] || '').trim();
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
  const lines = combined.split('\n');
  const result = { summary: '', lines: [] };

  if (lines.length <= 50) {
    // Short output: pass through as-is
    result.lines = lines;
    result.summary = exitCode === 0 ? '' : `exited with code ${exitCode}`;
  } else {
    // Long output: head + errors from middle + tail
    const head = lines.slice(0, 10);
    const tail = lines.slice(-10);

    // Extract error-like lines from the middle
    const middle = lines.slice(10, -10);
    const errorLines = [];
    for (const line of middle) {
      if (errorLines.length >= 10) break;
      if (/\b(error|Error|ERROR|fatal|FATAL|panic|PANIC|exception|Exception)\b/.test(line)) {
        errorLines.push(line);
      }
    }

    result.lines = [
      ...head,
      '',
      `... ${middle.length} lines omitted` + (errorLines.length > 0 ? ` (${errorLines.length} error lines shown below)` : ''),
      ''
    ];

    if (errorLines.length > 0) {
      result.lines.push(...errorLines, '');
    }

    result.lines.push(...tail);
    result.summary = `${lines.length} total lines`;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Format Elapsed Time
// ─────────────────────────────────────────────────────────────

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
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
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // Parse common args, but we need to handle our custom args first
  let typeArg = null;
  let raw = false;
  let diffMode = false;
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
  const effectiveTimeout = timeout || runConfig.timeout || 300000;

  // The command is the first remaining arg (may be quoted)
  const command = opts.remaining.join(' ');

  // Execute
  const result = runCommand(command, effectiveTimeout);

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
    const combined = result.stdout + (result.stderr ? result.stderr : '');
    if (opts.json) {
      const out = createOutput(opts);
      out.setData('command', command);
      out.setData('exitCode', result.exitCode);
      out.setData('elapsed', formatElapsed(result.elapsed));
      out.setData('type', 'raw');
      out.setData('output', combined);
      out.print();
    } else {
      process.stdout.write(combined);
    }
    process.exit(result.exitCode);
  }

  // Detect type
  const type = typeArg || detectType(command, result.stdout, result.stderr);

  // Summarize based on type
  let summary;
  switch (type) {
    case 'test':
      summary = summarizeTest(result.stdout, result.stderr, result.exitCode);
      break;
    case 'build':
      summary = summarizeBuild(result.stdout, result.stderr, result.exitCode);
      break;
    case 'lint':
      summary = summarizeLint(result.stdout, result.stderr, result.exitCode);
      break;
    default:
      summary = summarizeGeneric(result.stdout, result.stderr, result.exitCode);
      break;
  }

  // Format output
  const out = createOutput(opts);

  if (!opts.quiet) {
    out.header(`$ ${command}`);
    out.header(`${formatElapsed(result.elapsed)} | exit ${result.exitCode} | ${type}`);
    out.blank();
  }

  if (type === 'test') {
    out.add(summary.summary);
    if (summary.failures.length > 0) {
      out.blank();
      for (const f of summary.failures) {
        out.add(`FAILED: ${f.name}`);
        if (f.message) {
          for (const msgLine of f.message.split('\n')) {
            out.add(`  ${msgLine}`);
          }
        }
        if (f.location) {
          out.add(`  at ${f.location}`);
        }
      }
    }
  } else if (type === 'build') {
    out.add(summary.summary);
    if (summary.errors.length > 0) {
      out.blank();
      for (const e of summary.errors) {
        out.add(e);
      }
    }
  } else if (type === 'lint') {
    out.add(summary.summary);
    if (summary.violations.length > 0) {
      out.blank();
      out.add('Top violations:');
      for (const v of summary.violations) {
        out.add(`  ${v.count}x ${v.rule}`);
      }
    }
  } else {
    // generic
    if (summary.summary) {
      out.add(summary.summary);
      out.blank();
    }
    out.addLines(summary.lines);
  }

  // Fallback: when exit != 0 and the summarizer extracted no details,
  // show raw stderr/output so the agent can diagnose the actual error.
  if (result.exitCode !== 0 && type !== 'generic') {
    const hasDetails = (type === 'test' && (summary.failures.length > 0 || summary.parsed)) ||
                       (type === 'build' && summary.errors.length > 0) ||
                       (type === 'lint' && summary.violations.length > 0);

    if (!hasDetails) {
      const stderrLines = result.stderr.trim().split('\n').filter(l => l.trim());
      const stdoutLines = result.stdout.trim().split('\n').filter(l => l.trim());

      out.blank();
      if (stderrLines.length > 0) {
        out.add('stderr:');
        out.addLines(stderrLines.slice(-30));
        if (stderrLines.length > 30) out.add(`... ${stderrLines.length - 30} earlier lines omitted`);
      }
      if (stdoutLines.length > 0 && stderrLines.length < 5) {
        out.add('output (last lines):');
        out.addLines(stdoutLines.slice(-20));
      }
    }
  }

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

main();
