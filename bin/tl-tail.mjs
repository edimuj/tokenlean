#!/usr/bin/env node

/**
 * tl-tail - Token-efficient log tailing and summarization
 *
 * Usage: tl-tail [log-file] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-tail',
    desc: 'Token-efficient log tailing and summarization',
    when: 'search',
    example: 'tl-tail app.log --tail-lines 400'
  }));
  process.exit(0);
}

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile
} from 'node:fs';
import { resolve } from 'node:path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const HELP = `
tl-tail - Token-efficient log tailing and summarization

Usage: tl-tail [log-file] [options]

Reads logs from a file or stdin, collapses repeated lines into clusters,
and extracts high-signal error/warn summaries.

Options:
  --follow, -f          Follow log file updates (file input only)
  --tail-lines N        Analyze only last N input lines (default: 600)
${COMMON_OPTIONS_HELP}

Examples:
  tl-tail app.log                    # Summarize log file
  tl-tail app.log --follow           # Follow and re-summarize on updates
  npm test 2>&1 | tl-tail            # Summarize piped output
  tl-tail app.log -j                 # JSON output
`;

const DEFAULT_TAIL_LINES = 600;
const TOP_LIMIT = 8;
const RECENT_LIMIT = 10;
const MAX_LINE_PREVIEW = 200;

const ERROR_RE = /\b(error|err\b|fatal|panic|exception|traceback|uncaught|failed|failure|critical|segfault)\b/i;
const WARN_RE = /\b(warn|warning|deprecated|retry|slow)\b/i;

const SEVERITY_RANK = {
  info: 0,
  warn: 1,
  error: 2
};

function parsePositiveInt(value, flagName) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function parseTailArgs(args) {
  let follow = false;
  let tailLines = DEFAULT_TAIL_LINES;
  const filteredArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--follow' || arg === '-f') {
      follow = true;
    } else if (arg === '--tail-lines') {
      if (i + 1 >= args.length) {
        throw new Error('Missing value for --tail-lines');
      }
      tailLines = parsePositiveInt(args[++i], '--tail-lines');
    } else {
      filteredArgs.push(arg);
    }
  }

  return { follow, tailLines, filteredArgs };
}

function stripAnsi(str) {
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\|\x1b[^[\]]/g,
    ''
  );
}

function classifySeverity(line) {
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  return 'info';
}

function normalizeClusterKey(line) {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<ts>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/ig, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/ig, '<hex>')
    .replace(/\b[0-9a-f]{10,}\b/ig, '<hex>')
    .replace(/\b\d+\b/g, '<n>');
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(text) {
  const parts = normalizeNewlines(text).split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function takeTail(lines, count) {
  if (!Number.isFinite(count) || count <= 0) return lines;
  return lines.length > count ? lines.slice(-count) : lines;
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let content = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => {
      content += chunk;
    });
    process.stdin.on('end', () => resolvePromise(content));
    process.stdin.on('error', rejectPromise);
  });
}

function readFileRange(path, start, end) {
  const length = Math.max(0, end - start);
  if (length === 0) return '';

  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function shortenLine(line, maxLength = MAX_LINE_PREVIEW) {
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength - 3)}...`;
}

class LogReducer {
  constructor() {
    this.totalLines = 0;
    this.errorLines = 0;
    this.warningLines = 0;
    this.clusters = new Map();
    this.recentRuns = [];
    this.currentRun = null;
  }

  reset() {
    this.totalLines = 0;
    this.errorLines = 0;
    this.warningLines = 0;
    this.clusters.clear();
    this.recentRuns = [];
    this.currentRun = null;
  }

  ingest(lines) {
    let addedLines = 0;

    for (const rawLine of lines) {
      const line = stripAnsi(rawLine).trimEnd();
      if (!line.trim()) continue;

      addedLines++;
      this.totalLines++;

      const severity = classifySeverity(line);
      if (severity === 'error') this.errorLines++;
      if (severity === 'warn') this.warningLines++;

      const key = normalizeClusterKey(line);
      const existing = this.clusters.get(key);
      if (existing) {
        existing.count++;
        existing.lastSeen = this.totalLines;
        if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) {
          existing.severity = severity;
          existing.sample = line;
        }
      } else {
        this.clusters.set(key, {
          key,
          sample: line,
          count: 1,
          severity,
          firstSeen: this.totalLines,
          lastSeen: this.totalLines
        });
      }

      this.addRecentRun(line, severity);
    }

    return addedLines;
  }

  addRecentRun(line, severity) {
    if (this.currentRun && this.currentRun.text === line) {
      this.currentRun.count++;
      return;
    }

    if (this.currentRun) {
      this.recentRuns.push(this.currentRun);
    }

    this.currentRun = { text: line, severity, count: 1 };
    while (this.recentRuns.length > RECENT_LIMIT * 2) {
      this.recentRuns.shift();
    }
  }

  topClusters(predicate, limit = TOP_LIMIT) {
    return [...this.clusters.values()]
      .filter(predicate)
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map(cluster => ({
        text: shortenLine(cluster.sample),
        count: cluster.count
      }));
  }

  snapshot() {
    const recent = [...this.recentRuns];
    if (this.currentRun) recent.push(this.currentRun);

    return {
      totalLines: this.totalLines,
      uniqueClusters: this.clusters.size,
      errorLines: this.errorLines,
      warningLines: this.warningLines,
      errors: this.topClusters(cluster => cluster.severity === 'error'),
      warnings: this.topClusters(cluster => cluster.severity === 'warn'),
      repeated: this.topClusters(cluster => cluster.count > 1),
      recent: recent.slice(-RECENT_LIMIT).map(run => ({
        text: shortenLine(run.text),
        count: run.count,
        severity: run.severity
      }))
    };
  }
}

function emitSnapshot(options, snapshot, context) {
  const out = createOutput(options);

  if (!options.json) {
    if (!options.quiet) {
      out.header(`${context.source}${context.follow ? ' | follow' : ''}`);
      if (context.addedLines != null) {
        out.header(`+${context.addedLines} lines processed`);
      }
      out.blank();
    }

    out.add(
      `summary: ${snapshot.totalLines} lines, ${snapshot.uniqueClusters} clusters, ` +
      `${snapshot.errorLines} errors, ${snapshot.warningLines} warnings`
    );

    if (snapshot.errors.length > 0) {
      out.blank();
      out.add('errors:');
      for (const item of snapshot.errors) {
        out.add(`  ${item.count}x ${item.text}`);
      }
    }

    if (snapshot.warnings.length > 0) {
      out.blank();
      out.add('warnings:');
      for (const item of snapshot.warnings) {
        out.add(`  ${item.count}x ${item.text}`);
      }
    }

    if (snapshot.repeated.length > 0) {
      out.blank();
      out.add('repeated clusters:');
      for (const item of snapshot.repeated) {
        out.add(`  ${item.count}x ${item.text}`);
      }
    }

    if (snapshot.recent.length > 0) {
      out.blank();
      out.add('recent events:');
      for (const item of snapshot.recent) {
        out.add(`  ${item.count}x ${item.text}`);
      }
    }
  }

  if (options.json) {
    out.setData('source', context.source);
    out.setData('follow', context.follow);
    if (context.addedLines != null) {
      out.setData('addedLines', context.addedLines);
    }
    out.setData('totals', {
      lines: snapshot.totalLines,
      clusters: snapshot.uniqueClusters,
      errors: snapshot.errorLines,
      warnings: snapshot.warningLines
    });
    out.setData('errors', snapshot.errors);
    out.setData('warnings', snapshot.warnings);
    out.setData('repeated', snapshot.repeated);
    out.setData('recent', snapshot.recent);
  }

  out.print();
}

function splitChunkWithRemainder(text, pending) {
  const merged = normalizeNewlines(pending + text);
  const lines = merged.split('\n');
  const remainder = lines.pop() || '';
  return { lines, remainder };
}

async function summarizeSnapshot(filePath, sourceLabel, tailLines, options) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = takeTail(splitLines(content), tailLines);
  const reducer = new LogReducer();
  const addedLines = reducer.ingest(lines);
  emitSnapshot(options, reducer.snapshot(), {
    source: sourceLabel,
    follow: false,
    addedLines
  });
}

async function followFile(filePath, sourceLabel, tailLines, options) {
  let reducer = new LogReducer();
  let pending = '';
  let offset = 0;
  let polling = false;
  let stopped = false;

  const initialContent = readFileSync(filePath, 'utf-8');
  const initialLines = takeTail(splitLines(initialContent), tailLines);
  const initialAdded = reducer.ingest(initialLines);
  emitSnapshot(options, reducer.snapshot(), {
    source: sourceLabel,
    follow: true,
    addedLines: initialAdded
  });
  offset = statSync(filePath).size;

  const stop = (code = 0) => {
    if (stopped) return;
    stopped = true;
    unwatchFile(filePath);
    process.exit(code);
  };

  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  watchFile(filePath, { interval: 400 }, () => {
    if (stopped || polling) return;
    polling = true;

    try {
      const stats = statSync(filePath);

      if (stats.size < offset) {
        // File was truncated or rotated; reset state for new content.
        reducer = new LogReducer();
        pending = '';
        offset = 0;
      }

      if (stats.size <= offset) {
        polling = false;
        return;
      }

      const chunk = readFileRange(filePath, offset, stats.size);
      offset = stats.size;

      const parsed = splitChunkWithRemainder(chunk, pending);
      pending = parsed.remainder;
      const addedLines = reducer.ingest(parsed.lines);

      if (addedLines > 0) {
        emitSnapshot(options, reducer.snapshot(), {
          source: sourceLabel,
          follow: true,
          addedLines
        });
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
      stop(1);
    } finally {
      polling = false;
    }
  });

  await new Promise(() => {});
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { follow, tailLines, filteredArgs } = parseTailArgs(rawArgs);
  const options = parseCommonArgs(filteredArgs);

  if (options.help) {
    console.log(HELP.trim());
    return;
  }

  if (options.remaining.length > 1) {
    throw new Error('Usage: tl-tail [log-file] [options]');
  }

  const inputArg = options.remaining[0];
  if (follow && !inputArg) {
    throw new Error('--follow requires a log file path');
  }

  if (inputArg) {
    const filePath = resolve(process.cwd(), inputArg);
    if (!existsSync(filePath)) {
      throw new Error(`Log file not found: ${inputArg}`);
    }

    if (follow) {
      await followFile(filePath, inputArg, tailLines, options);
      return;
    }

    await summarizeSnapshot(filePath, inputArg, tailLines, options);
    return;
  }

  if (process.stdin.isTTY) {
    throw new Error('No input provided. Pass a file path or pipe logs via stdin.');
  }

  const stdinContent = await readStdin();
  const lines = takeTail(splitLines(stdinContent), tailLines);
  const reducer = new LogReducer();
  const addedLines = reducer.ingest(lines);
  emitSnapshot(options, reducer.snapshot(), {
    source: 'stdin',
    follow: false,
    addedLines
  });
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
