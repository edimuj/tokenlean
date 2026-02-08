#!/usr/bin/env node

/**
 * tl-blame - Compact per-line authorship
 *
 * Shows who changed each line recently, in a token-efficient format.
 * Groups consecutive lines by the same author/commit for readability.
 *
 * Usage: tl-blame <file> [--full]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-blame',
    desc: 'Compact per-line authorship',
    when: 'before-read',
    example: 'tl-blame src/api.ts'
  }));
  process.exit(0);
}

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-blame - Compact per-line authorship

Usage: tl-blame <file> [options]

Options:
  --full                Show every line (default: group consecutive same-author lines)
  --since <date>        Only show changes after date
  -L <start>,<end>      Blame specific line range (e.g., -L 10,20)
  --summary             Show only author summary, no line details
${COMMON_OPTIONS_HELP}

Examples:
  tl-blame src/api.ts              # Grouped blame
  tl-blame src/api.ts --full       # Every line
  tl-blame src/api.ts -L 50,100    # Lines 50-100 only
  tl-blame src/api.ts --summary    # Just author stats

Output format (grouped):
  [hash] author (date) lines X-Y
    line content preview...
`;

// ─────────────────────────────────────────────────────────────
// Git Blame
// ─────────────────────────────────────────────────────────────

function getBlame(filePath, options = {}) {
  const { since = null, lineRange = null } = options;

  const args = ['blame', '--porcelain'];

  if (since) {
    args.push(`--since=${since}`);
  }

  if (lineRange) {
    args.push(`-L${lineRange}`);
  }

  args.push('--', filePath);

  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && result.stderr) {
    if (result.stderr.includes('not a git repository')) {
      throw new Error('Not in a git repository');
    }
    if (result.stderr.includes('no such path')) {
      throw new Error('File not tracked by git');
    }
    throw new Error(result.stderr);
  }

  return parseBlame(result.stdout || '');
}

function parseBlame(output) {
  const lines = [];
  const commits = new Map();

  const outputLines = output.split('\n');
  let i = 0;

  while (i < outputLines.length) {
    const line = outputLines[i];
    if (!line) {
      i++;
      continue;
    }

    // Commit line: hash origLine finalLine [numLines]
    const commitMatch = line.match(/^([a-f0-9]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (commitMatch) {
      const hash = commitMatch[1];
      const lineNum = parseInt(commitMatch[3], 10);

      // Read metadata until we hit the content line (starts with \t)
      i++;
      let author = '';
      let date = '';

      while (i < outputLines.length && !outputLines[i].startsWith('\t')) {
        const metaLine = outputLines[i];

        if (metaLine.startsWith('author ')) {
          author = metaLine.slice(7);
        } else if (metaLine.startsWith('author-time ')) {
          const timestamp = parseInt(metaLine.slice(12), 10);
          date = new Date(timestamp * 1000).toISOString().slice(0, 10);
        }

        i++;
      }

      // Content line (starts with \t)
      let content = '';
      if (i < outputLines.length && outputLines[i].startsWith('\t')) {
        content = outputLines[i].slice(1);
        i++;
      }

      // Store commit info
      if (!commits.has(hash)) {
        commits.set(hash, { author, date, shortHash: hash.slice(0, 7) });
      }

      lines.push({
        hash,
        lineNum,
        content
      });
    } else {
      i++;
    }
  }

  return { lines, commits };
}

function groupBlameLines(lines, commits) {
  const groups = [];
  let currentGroup = null;

  for (const line of lines) {
    if (!currentGroup || currentGroup.hash !== line.hash) {
      // Start new group
      if (currentGroup) {
        groups.push(currentGroup);
      }
      currentGroup = {
        hash: line.hash,
        startLine: line.lineNum,
        endLine: line.lineNum,
        preview: line.content.trim().slice(0, 60),
        ...commits.get(line.hash)
      };
    } else {
      // Extend current group
      currentGroup.endLine = line.lineNum;
    }
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

function getAuthorSummary(lines, commits) {
  const authorStats = new Map();

  for (const line of lines) {
    const commit = commits.get(line.hash);
    if (!commit) continue;

    const author = commit.author;
    if (!authorStats.has(author)) {
      authorStats.set(author, { lines: 0, commits: new Set() });
    }

    const stats = authorStats.get(author);
    stats.lines++;
    stats.commits.add(line.hash);
  }

  return [...authorStats.entries()]
    .map(([author, stats]) => ({
      author,
      lines: stats.lines,
      commits: stats.commits.size,
      percentage: Math.round((stats.lines / lines.length) * 100)
    }))
    .sort((a, b) => b.lines - a.lines);
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let showFull = false;
let since = null;
let lineRange = null;
let summaryOnly = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--full') {
    showFull = true;
  } else if (arg === '--since') {
    since = options.remaining[++i];
  } else if (arg === '-L') {
    lineRange = options.remaining[++i];
  } else if (arg.startsWith('-L')) {
    lineRange = arg.slice(2);
  } else if (arg === '--summary') {
    summaryOnly = true;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const filePath = remaining[0];

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, filePath);
const out = createOutput(options);

try {
  const { lines, commits } = getBlame(filePath, { since, lineRange });

  if (lines.length === 0) {
    console.log('No blame data found');
    process.exit(0);
  }

  const authorSummary = getAuthorSummary(lines, commits);

  // Set JSON data
  out.setData('file', relPath);
  out.setData('totalLines', lines.length);
  out.setData('authors', authorSummary);

  if (summaryOnly) {
    // Just show author summary
    out.header(`${relPath} - ${lines.length} lines`);
    out.blank();

    out.add('Author Summary:');
    for (const { author, lines: lineCount, commits: commitCount, percentage } of authorSummary) {
      out.add(`  ${author.padEnd(25)} ${String(lineCount).padStart(5)} lines (${percentage}%) in ${commitCount} commits`);
    }
  } else if (showFull) {
    // Show every line
    out.header(`${relPath} - ${lines.length} lines`);
    out.blank();

    for (const line of lines) {
      const commit = commits.get(line.hash);
      const age = formatDate(commit.date);
      const authorShort = commit.author.slice(0, 12).padEnd(12);
      out.add(`${commit.shortHash} ${age.padEnd(4)} ${authorShort} │ ${line.content}`);
    }
  } else {
    // Grouped output (default)
    const groups = groupBlameLines(lines, commits);

    out.header(`${relPath} - ${lines.length} lines in ${groups.length} blocks`);
    out.blank();

    for (const group of groups) {
      const age = formatDate(group.date);
      const lineRange = group.startLine === group.endLine
        ? `L${group.startLine}`
        : `L${group.startLine}-${group.endLine}`;

      out.add(`${group.shortHash} ${group.author} (${age}) ${lineRange}`);

      if (group.preview) {
        const preview = group.preview.length > 55 ? group.preview.slice(0, 52) + '...' : group.preview;
        out.add(`  ${preview}`);
      }
      out.blank();
    }

    // Summary at bottom
    if (!options.quiet) {
      out.add('---');
      out.add(`${authorSummary.length} author(s): ${authorSummary.map(a => `${a.author} (${a.percentage}%)`).join(', ')}`);
    }
  }

  out.setData('groups', showFull ? null : groupBlameLines(lines, commits));
  out.print();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
