#!/usr/bin/env node

/**
 * tl-audit - Analyze a Claude Code session and estimate token savings from tokenlean tools.
 *
 * Parses session JSONL files, identifies patterns where tokenlean tools could have
 * reduced token usage (large file reads, verbose command output, etc.), and reports
 * estimated savings.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseCommonArgs, createOutput, estimateTokens, formatTokens } from '../src/output.mjs';

const HELP = `Usage: tl-audit [options] [session.jsonl | project-dir]

Analyze a Claude Code session and estimate how many tokens
could have been saved using tokenlean tools.

Arguments:
  session.jsonl    Path to a specific session JSONL file
  project-dir      Path to a Claude project directory
  (none)           Auto-detect from current working directory

Options:
  --latest         Analyze the most recent session (default)
  --all            Analyze all sessions in the project
  -n <count>       Analyze the N most recent sessions
  --project <dir>  Override project directory detection
  --verbose        Show individual findings
  -j, --json       JSON output
  -h, --help       Show help`;

// --- Patterns that indicate saveable token waste ---

const BUILD_TEST_PATTERNS = [
  /\b(npm|yarn|pnpm|bun)\s+(test|run\s+test|run\s+build|run\s+lint)/,
  /\bnode\s+--test\b/,
  /\b(cargo|go)\s+(test|build|check|clippy)\b/,
  /\b(make|cmake)\b/,
  /\b(pytest|python\s+-m\s+(pytest|unittest))\b/,
  /\b(mvn|gradle)\s+(test|build|compile)\b/,
  /\b(dotnet)\s+(test|build)\b/,
  /\b(mix)\s+(test|compile)\b/,
  /\b(bundle\s+exec\s+r(spec|ake))\b/,
  /\btsc\b/,
  /\beslint\b/,
  /\bprettier\b/,
];

const CAT_PATTERNS = [
  /^\s*cat\s+[^|]/,
];

const TAIL_PATTERNS = [
  /^\s*tail\s+/,
];

const GREP_PATTERNS = [
  /^\s*(grep|rg|ag)\s+/,
];

const FIND_PATTERNS = [
  /^\s*(find|fd)\s+/,
  /^\s*ls\s+(-[a-zA-Z]*R|-[a-zA-Z]*l)/,
];

const CURL_PATTERNS = [
  /^\s*curl\s/,
];

const HEAD_PATTERNS = [
  /^\s*head\s+/,
];

// Compression ratios (estimated fraction of tokens retained with tokenlean)
const RATIOS = {
  READ_LARGE_TO_SYMBOLS: 0.20,      // tl-symbols returns ~20% of full file
  READ_LARGE_TO_SNIPPET: 0.10,      // tl-snippet returns ~10% of full file (when you need 1 function)
  BASH_BUILD_TO_RUN: 0.35,          // tl-run compresses build/test output ~65%
  BASH_CAT_TO_SYMBOLS: 0.20,        // cat whole file → tl-symbols
  BASH_TAIL_TO_TLTAIL: 0.30,        // tl-tail collapses repeats, summarizes ~70%
  BASH_GREP_TO_GREP: 0.80,          // minor savings from Grep tool
  BASH_FIND_TO_GLOB: 0.70,          // minor savings from Glob tool
  BASH_CURL_TO_BROWSE: 0.30,        // tl-browse returns clean markdown ~70% savings
  BASH_HEAD_TO_READ: 0.80,          // Read with limit is slightly more efficient
  WEBFETCH_TO_BROWSE: 0.30,         // tl-browse returns cleaner markdown ~70% savings
};

const CHARS_PER_TOKEN = 4;
const LARGE_FILE_THRESHOLD = 150;   // lines - below this, just Read
const SIGNIFICANT_RESULT = 500;     // chars - ignore tiny results

function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

function parseSession(jsonlContent) {
  const lines = jsonlContent.trim().split('\n');
  const toolCalls = new Map();
  const findings = [];
  let sessionMeta = null;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!sessionMeta && obj.sessionId) {
      sessionMeta = {
        sessionId: obj.sessionId,
        timestamp: obj.timestamp,
        cwd: obj.cwd,
        slug: obj.slug,
      };
    }

    const content = obj.message?.content;
    if (!Array.isArray(content) && typeof content !== 'string') continue;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];

    for (const block of blocks) {
      // Collect tool calls
      if (block.type === 'tool_use') {
        toolCalls.set(block.id, {
          name: block.name,
          input: block.input || {},
        });
      }

      // Analyze tool results
      if (block.type === 'tool_result') {
        const call = toolCalls.get(block.tool_use_id);
        if (!call) continue;

        const resultText = typeof block.content === 'string'
          ? block.content
          : (Array.isArray(block.content)
            ? block.content.map(c => c.text || '').join('\n')
            : JSON.stringify(block.content));

        const chars = resultText.length;
        if (chars < SIGNIFICANT_RESULT) continue;

        const tokens = Math.ceil(chars / CHARS_PER_TOKEN);

        // Pattern: Read on large files (only code files, not markdown/config/etc)
        if (call.name === 'Read') {
          const lines = countLines(resultText);
          const file = call.input.file_path || 'unknown';
          const ext = file.split('.').pop().toLowerCase();
          const nonCodeExts = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'lock', 'svg', 'html', 'css', 'log', 'env', 'gitignore', 'dockerignore', 'editorconfig']);
          if (lines > LARGE_FILE_THRESHOLD && !nonCodeExts.has(ext)) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.READ_LARGE_TO_SYMBOLS));
            findings.push({
              category: 'read-large-file',
              tool: 'Read',
              suggestion: 'tl-symbols + tl-snippet',
              file: basename(file),
              filePath: file,
              lines,
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `${lines} lines read — tl-symbols would show structure (~${RATIOS.READ_LARGE_TO_SYMBOLS * 100}%), then tl-snippet for specific functions`,
            });
          }
        }

        // Pattern: Bash with build/test commands
        if (call.name === 'Bash') {
          const cmd = call.input.command || '';

          if (BUILD_TEST_PATTERNS.some(p => p.test(cmd))) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_BUILD_TO_RUN));
            findings.push({
              category: 'build-test-output',
              tool: 'Bash',
              suggestion: 'tl-run',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `Build/test output (${tokens} tokens) — tl-run compresses ~${(1 - RATIOS.BASH_BUILD_TO_RUN) * 100}%`,
            });
          } else if (TAIL_PATTERNS.some(p => p.test(cmd))) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_TAIL_TO_TLTAIL));
            findings.push({
              category: 'tail-command',
              tool: 'Bash (tail)',
              suggestion: 'tl-tail',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `tail via Bash (${tokens} tokens) — tl-tail collapses repeats and summarizes ~70%`,
            });
          } else if (CAT_PATTERNS.some(p => p.test(cmd))) {
            const lines = countLines(resultText);
            // Extract filename from cat/head command, skip non-code files
            const fileMatch = cmd.match(/^\s*(?:cat|head)\s+(?:-[^\s]+\s+)*(\S+)/);
            const catFile = fileMatch?.[1] || '';
            const catExt = catFile.split('.').pop().toLowerCase();
            const nonCodeExts = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'lock', 'svg', 'html', 'css', 'log', 'env']);
            if (lines > LARGE_FILE_THRESHOLD && !nonCodeExts.has(catExt)) {
              const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_CAT_TO_SYMBOLS));
              findings.push({
                category: 'cat-large-file',
                tool: 'Bash (cat/head)',
                suggestion: 'tl-symbols + tl-snippet',
                command: cmd.slice(0, 120),
                actualTokens: tokens,
                estimatedTokens: tokens - savedTokens,
                savedTokens,
                detail: `cat/head on ${lines}-line output — use tl-symbols for structure`,
              });
            }
          } else if (GREP_PATTERNS.some(p => p.test(cmd))) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_GREP_TO_GREP));
            findings.push({
              category: 'grep-command',
              tool: 'Bash (grep/rg)',
              suggestion: 'Grep tool',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `grep/rg via Bash (${tokens} tokens) — Grep tool has better integration`,
            });
          } else if (FIND_PATTERNS.some(p => p.test(cmd))) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_FIND_TO_GLOB));
            findings.push({
              category: 'find-command',
              tool: 'Bash (find/ls)',
              suggestion: 'Glob tool',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `find/ls via Bash (${tokens} tokens) — Glob tool is more efficient`,
            });
          } else if (HEAD_PATTERNS.some(p => p.test(cmd))) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_HEAD_TO_READ));
            findings.push({
              category: 'head-command',
              tool: 'Bash (head)',
              suggestion: 'Read tool (with limit)',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `head via Bash (${tokens} tokens) — Read tool with offset/limit is better integrated`,
            });
          } else if (CURL_PATTERNS.some(p => p.test(cmd)) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(cmd)) {
            const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_CURL_TO_BROWSE));
            findings.push({
              category: 'curl-command',
              tool: 'Bash (curl)',
              suggestion: 'tl-browse',
              command: cmd.slice(0, 120),
              actualTokens: tokens,
              estimatedTokens: tokens - savedTokens,
              savedTokens,
              detail: `curl via Bash (${tokens} tokens) — tl-browse returns clean markdown, ~70% fewer tokens`,
            });
          }
        }

        // Pattern: WebFetch — tl-browse is more token-efficient
        if (call.name === 'WebFetch') {
          const savedTokens = Math.round(tokens * (1 - RATIOS.WEBFETCH_TO_BROWSE));
          findings.push({
            category: 'webfetch',
            tool: 'WebFetch',
            suggestion: 'tl-browse',
            command: (call.input.url || '').slice(0, 120),
            actualTokens: tokens,
            estimatedTokens: tokens - savedTokens,
            savedTokens,
            detail: `WebFetch (${tokens} tokens) — tl-browse returns cleaner markdown, ~70% fewer tokens`,
          });
        }
      }
    }
  }

  return { findings, meta: sessionMeta };
}

function summarizeFindings(findings) {
  const byCategory = {};
  let totalActual = 0;
  let totalSaved = 0;

  for (const f of findings) {
    if (!byCategory[f.category]) {
      byCategory[f.category] = { count: 0, actualTokens: 0, savedTokens: 0, suggestion: f.suggestion };
    }
    byCategory[f.category].count++;
    byCategory[f.category].actualTokens += f.actualTokens;
    byCategory[f.category].savedTokens += f.savedTokens;
    totalActual += f.actualTokens;
    totalSaved += f.savedTokens;
  }

  return { byCategory, totalActual, totalSaved, totalFindings: findings.length };
}

async function findProjectDir(cwd) {
  // Convert CWD to Claude's project directory naming convention
  const normalized = cwd.replace(/\//g, '-');
  const claudeDir = join(homedir(), '.claude', 'projects');
  const projectDir = join(claudeDir, normalized);

  try {
    await stat(projectDir);
    return projectDir;
  } catch {
    // Try listing and matching
    const dirs = await readdir(claudeDir);
    const match = dirs.find(d => normalized.startsWith(d) || d === normalized);
    if (match) return join(claudeDir, match);
    return null;
  }
}

async function findSessions(projectDir, count) {
  const entries = await readdir(projectDir);
  const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));

  // Get modification times and sort by most recent
  const withStats = await Promise.all(
    jsonlFiles.map(async f => {
      const fullPath = join(projectDir, f);
      const s = await stat(fullPath);
      return { path: fullPath, mtime: s.mtimeMs, size: s.size };
    })
  );

  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats.slice(0, count);
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const args = options.remaining;

  let all = false;
  let latest = true;
  let count = 1;
  let verbose = false;
  let projectOverride = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') { all = true; latest = false; }
    else if (a === '--latest') { latest = true; }
    else if (a === '--verbose') { verbose = true; }
    else if (a === '-n') { count = parseInt(args[++i], 10) || 1; latest = false; }
    else if (a === '--project') { projectOverride = args[++i]; }
    else positional.push(a);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Determine what to analyze
  let sessionFiles = [];

  if (positional.length > 0) {
    const target = resolve(positional[0]);
    const s = await stat(target);

    if (s.isFile() && target.endsWith('.jsonl')) {
      sessionFiles = [{ path: target, mtime: s.mtimeMs, size: s.size }];
    } else if (s.isDirectory()) {
      const n = all ? Infinity : count;
      sessionFiles = await findSessions(target, n);
    }
  } else {
    const projectDir = projectOverride
      ? resolve(projectOverride)
      : await findProjectDir(process.cwd());

    if (!projectDir) {
      console.error('Could not find Claude session directory for current project.');
      console.error('Try: tl-audit <path-to-session.jsonl>');
      process.exit(1);
    }

    const n = all ? Infinity : count;
    sessionFiles = await findSessions(projectDir, n);
  }

  if (sessionFiles.length === 0) {
    console.error('No session files found.');
    process.exit(1);
  }

  // Analyze sessions
  const allResults = [];

  for (const sf of sessionFiles) {
    const content = await readFile(sf.path, 'utf8');
    const { findings, meta } = parseSession(content);
    const summary = summarizeFindings(findings);
    allResults.push({ file: sf.path, meta, findings, summary });
  }

  // Output
  if (options.json) {
    const data = allResults.map(r => ({
      session: r.meta?.slug || basename(r.file, '.jsonl'),
      timestamp: r.meta?.timestamp,
      cwd: r.meta?.cwd,
      totalFindings: r.summary.totalFindings,
      totalActualTokens: r.summary.totalActual,
      totalSavedTokens: r.summary.totalSaved,
      savingsPercent: r.summary.totalActual > 0
        ? Math.round((r.summary.totalSaved / r.summary.totalActual) * 100)
        : 0,
      categories: r.summary.byCategory,
      ...(verbose ? { findings: r.findings } : {}),
    }));
    console.log(JSON.stringify(data.length === 1 ? data[0] : data, null, 2));
    return;
  }

  const out = createOutput(options);

  for (const result of allResults) {
    const { meta, findings, summary } = result;
    const sessionLabel = meta?.slug || basename(result.file, '.jsonl');
    const date = meta?.timestamp ? new Date(meta.timestamp).toLocaleDateString() : '';

    out.header(`Session: ${sessionLabel}${date ? ` (${date})` : ''}`);

    if (summary.totalFindings === 0) {
      out.add('  No significant savings opportunities found.');
      out.blank();
      continue;
    }

    // Category breakdown
    const cats = Object.entries(summary.byCategory)
      .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

    const rows = cats.map(([cat, data]) => [
      cat,
      `${data.count}x`,
      formatTokens(data.actualTokens),
      formatTokens(data.savedTokens),
      `-> ${data.suggestion}`,
    ]);

    out.add('  Category                Count  Actual     Saveable   Suggestion');
    out.add('  ' + '-'.repeat(76));
    for (const [cat, count, actual, saved, suggestion] of rows) {
      out.add(`  ${cat.padEnd(22)} ${count.padStart(5)}  ${actual.padStart(8)}  ${saved.padStart(10)}   ${suggestion}`);
    }
    out.blank();

    // Totals
    const pct = summary.totalActual > 0
      ? Math.round((summary.totalSaved / summary.totalActual) * 100)
      : 0;
    out.add(`  Total tool output:  ${formatTokens(summary.totalActual)}`);
    out.add(`  Saveable:           ${formatTokens(summary.totalSaved)} (${pct}%)`);
    out.blank();

    // Verbose: individual findings
    if (verbose) {
      out.add('  Findings:');
      const sorted = [...findings].sort((a, b) => b.savedTokens - a.savedTokens);
      for (const f of sorted.slice(0, 20)) {
        const label = f.file || f.command || '';
        out.add(`    [${formatTokens(f.savedTokens).trim()} saveable] ${label}`);
        out.add(`      ${f.detail}`);
      }
      if (sorted.length > 20) {
        out.add(`    ... and ${sorted.length - 20} more`);
      }
      out.blank();
    }
  }

  // Multi-session aggregate
  if (allResults.length > 1) {
    const totalActual = allResults.reduce((s, r) => s + r.summary.totalActual, 0);
    const totalSaved = allResults.reduce((s, r) => s + r.summary.totalSaved, 0);
    const pct = totalActual > 0 ? Math.round((totalSaved / totalActual) * 100) : 0;

    out.header(`Aggregate (${allResults.length} sessions)`);
    out.add(`  Total tool output:  ${formatTokens(totalActual)}`);
    out.add(`  Saveable:           ${formatTokens(totalSaved)} (${pct}%)`);
  }

  out.print();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
