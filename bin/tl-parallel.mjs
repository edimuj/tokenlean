#!/usr/bin/env node

/**
 * tl-parallel - Run commands in parallel with structured results
 *
 * Runs multiple commands concurrently and returns structured output,
 * grouping successes and failures separately. Designed for AI agents
 * that need parallel execution without mixed/confusing output.
 *
 * Usage: tl-parallel <cmd1> [cmd2] ... [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-parallel',
    desc: 'Run commands in parallel with structured results',
    when: 'search',
    example: 'tl-parallel "npm test" "npm run lint" "tl symbols src/"'
  }));
  process.exit(0);
}

import { spawn } from 'node:child_process';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const HELP = `
tl-parallel - Run commands in parallel with structured results

Usage: tl-parallel <cmd1> [cmd2] ... [options]
       echo '["cmd1","cmd2"]' | tl-parallel

Runs multiple commands concurrently, groups results by success/failure.
Each command string can be prefixed with a label: "label=command".

Options:
  -T, --timeout <ms>    Per-command timeout in ms (default: 60000)
  --max <n>             Max concurrent commands (default: 20)
  --lines <n>           Max output lines per command (default: 60)
  --raw                 Show full output per command, no truncation
${COMMON_OPTIONS_HELP}

Examples:
  tl-parallel "npm test" "npm run lint" "tl symbols src/"
  tl-parallel "tests=npm test" "lint=eslint ." "build=npm run build"
  tl-parallel -T 120000 "slow-cmd" "fast-cmd"
  echo '["npm test","npm run lint"]' | tl-parallel
  echo '[{"label":"tests","cmd":"npm test"}]' | tl-parallel
`;

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_LINES_PER_CMD = 60;

// ─────────────────────────────────────────────────────────────
// ANSI Stripping
// ─────────────────────────────────────────────────────────────

function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\|\x1b[^[\]]/g,
    ''
  );
}

// ─────────────────────────────────────────────────────────────
// Elapsed time formatting
// ─────────────────────────────────────────────────────────────

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

// ─────────────────────────────────────────────────────────────
// Command parsing
// ─────────────────────────────────────────────────────────────

function parseCommand(input) {
  if (typeof input === 'object' && input !== null) {
    return {
      label: input.label || input.name || deriveLabel(input.cmd || input.command),
      cmd: input.cmd || input.command
    };
  }
  const str = String(input);
  const eqIdx = str.indexOf('=');
  if (eqIdx > 0 && eqIdx < 30 && !/\s/.test(str.slice(0, eqIdx))) {
    return { label: str.slice(0, eqIdx), cmd: str.slice(eqIdx + 1) };
  }
  return { label: deriveLabel(str), cmd: str };
}

function deriveLabel(cmd) {
  const trimmed = cmd.trim();
  // Use first 2 words as label, max 30 chars
  const words = trimmed.split(/\s+/).slice(0, 2).join(' ');
  return words.length <= 30 ? words : words.slice(0, 29) + '\u2026';
}

// ─────────────────────────────────────────────────────────────
// Command execution
// ─────────────────────────────────────────────────────────────

function runOne(cmd, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const chunks = { stdout: [], stderr: [] };
    let killed = false;

    const child = spawn(cmd, {
      shell: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }
    });

    child.stdout.on('data', chunk => chunks.stdout.push(chunk));
    child.stderr.on('data', chunk => chunks.stderr.push(chunk));

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 5s grace period
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, timeout);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 127,
        elapsed: Date.now() - start,
        timedOut: false
      });
    });

    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        stdout: stripAnsi(Buffer.concat(chunks.stdout).toString('utf-8')),
        stderr: stripAnsi(Buffer.concat(chunks.stderr).toString('utf-8')),
        exitCode: killed ? 124 : (code ?? 1),
        elapsed: Date.now() - start,
        timedOut: killed
      });
    });
  });
}

async function runAll(commands, timeout, maxConcurrent) {
  const results = [];
  let running = 0;
  let nextIdx = 0;

  return new Promise(resolve => {
    function tryStart() {
      while (running < maxConcurrent && nextIdx < commands.length) {
        const idx = nextIdx++;
        const { label, cmd } = commands[idx];
        running++;

        runOne(cmd, timeout).then(result => {
          results[idx] = { label, cmd, ...result };
          running--;
          if (results.filter(Boolean).length === commands.length) {
            resolve(results);
          } else {
            tryStart();
          }
        });
      }
    }

    if (commands.length === 0) {
      resolve([]);
    } else {
      tryStart();
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Output truncation (simple head+tail, no smart summarization)
// ─────────────────────────────────────────────────────────────

function truncateOutput(text, maxLines) {
  if (!text) return [];
  const lines = text.split('\n');
  // Strip trailing empty line from trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length <= maxLines) return lines;

  const headCount = Math.ceil(maxLines * 0.6);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;

  return [
    ...lines.slice(0, headCount),
    `... ${omitted} lines omitted ...`,
    ...lines.slice(-tailCount)
  ];
}

// ─────────────────────────────────────────────────────────────
// Stdin reading
// ─────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) { resolve(null); return; }
      try {
        const parsed = JSON.parse(text);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        // Try JSONL
        const lines = text.split('\n').filter(l => l.trim());
        try {
          resolve(lines.map(l => JSON.parse(l)));
        } catch {
          // Treat as one command per line
          resolve(lines);
        }
      }
    });
    process.stdin.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let timeout = DEFAULT_TIMEOUT;
  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  let maxLinesPerCmd = DEFAULT_LINES_PER_CMD;
  let raw = false;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-T' || arg === '--timeout') {
      timeout = parseInt(args[++i], 10) || DEFAULT_TIMEOUT;
    } else if (arg === '--max') {
      maxConcurrent = parseInt(args[++i], 10) || DEFAULT_MAX_CONCURRENT;
    } else if (arg === '--lines') {
      maxLinesPerCmd = parseInt(args[++i], 10) || DEFAULT_LINES_PER_CMD;
    } else if (arg === '--raw') {
      raw = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  const opts = parseCommonArgs(filteredArgs);

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  // Gather commands from args and/or stdin
  let commands = opts.remaining.map(parseCommand);

  if (commands.length === 0) {
    const stdinItems = await readStdin();
    if (stdinItems) {
      commands = stdinItems.map(parseCommand);
    }
  }

  if (commands.length === 0) {
    console.error('No commands provided. Run tl-parallel --help for usage.');
    process.exit(1);
  }

  // Deduplicate labels
  const seen = new Map();
  for (const cmd of commands) {
    const count = seen.get(cmd.label) || 0;
    seen.set(cmd.label, count + 1);
    if (count > 0) cmd.label = `${cmd.label} (${count + 1})`;
  }

  // Execute
  const totalStart = Date.now();
  const results = await runAll(commands, timeout, maxConcurrent);
  const totalElapsed = Date.now() - totalStart;

  const ok = results.filter(r => r.exitCode === 0);
  const failed = results.filter(r => r.exitCode !== 0);

  // JSON output
  if (opts.json) {
    const data = {
      total: results.length,
      passed: ok.length,
      failed: failed.length,
      elapsed: formatElapsed(totalElapsed),
      results: results.map(r => ({
        label: r.label,
        command: r.cmd,
        status: r.exitCode === 0 ? 'ok' : 'fail',
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        elapsed: formatElapsed(r.elapsed),
        stdout: r.stdout,
        stderr: r.stderr
      }))
    };
    console.log(JSON.stringify(data, null, 2));
    process.exit(failed.length > 0 ? 1 : 0);
  }

  // Text output
  const out = createOutput(opts);

  if (!opts.quiet) {
    out.header(`tl-parallel: ${results.length} commands | ${ok.length} ok, ${failed.length} failed | ${formatElapsed(totalElapsed)}`);
    out.blank();
  }

  const linesLimit = raw ? Infinity : maxLinesPerCmd;

  // Successes first
  for (const r of ok) {
    out.add(`[ok] ${r.label} (${formatElapsed(r.elapsed)})`);

    const combined = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
    if (combined) {
      const lines = truncateOutput(combined, linesLimit);
      for (const line of lines) out.add(line);
    }
    out.blank();
  }

  // Failures
  for (const r of failed) {
    const tag = r.timedOut ? 'TIMEOUT' : 'FAIL';
    out.add(`[${tag}] ${r.label} (exit ${r.exitCode}, ${formatElapsed(r.elapsed)})`);

    // For failures, show stderr prominently if present, then stdout
    const parts = [];
    if (r.stderr.trim()) parts.push(r.stderr.trim());
    if (r.stdout.trim()) parts.push(r.stdout.trim());
    const combined = parts.join('\n');

    if (combined) {
      const lines = truncateOutput(combined, linesLimit);
      for (const line of lines) out.add(line);
    }
    out.blank();
  }

  out.print();
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
