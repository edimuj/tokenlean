#!/usr/bin/env node

/**
 * tl-history - Recent changes to a file, summarized
 *
 * Shows commit history for a file without full diffs - just commit messages,
 * authors, and dates. Perfect for understanding how a file has evolved.
 *
 * Usage: tl-history <file> [--limit N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-history',
    desc: 'Recent changes to a file (commits only)',
    when: 'before-read',
    example: 'tl-history src/api.ts'
  }));
  process.exit(0);
}

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-history - Recent changes to a file, summarized

Usage: tl-history <file> [options]

Options:
  --limit N, -n N       Number of commits to show (default: 20)
  --since <date>        Only commits after date (e.g., "2 weeks ago", "2024-01-01")
  --author <name>       Filter by author
  --stat                Show file change stats (+/- lines)
  --oneline             Ultra-compact one-line format
${COMMON_OPTIONS_HELP}

Examples:
  tl-history src/api.ts              # Recent commits
  tl-history src/api.ts -n 50        # Last 50 commits
  tl-history src/api.ts --since "1 month ago"
  tl-history src/api.ts --stat       # With change stats
  tl-history src/api.ts --oneline    # Compact format

Output includes:
  - Commit hash (short)
  - Date
  - Author
  - Commit message
`;

// ─────────────────────────────────────────────────────────────
// Git Operations
// ─────────────────────────────────────────────────────────────

function getFileHistory(filePath, options = {}) {
  const {
    limit = 20,
    since = null,
    author = null,
    stat = false
  } = options;

  const args = ['log', `--max-count=${limit}`, '--pretty=format:%H|%h|%ai|%an|%s'];

  if (since) {
    args.push(`--since=${since}`);
  }

  if (author) {
    args.push(`--author=${author}`);
  }

  if (stat) {
    args.push('--numstat');
  }

  args.push('--follow');  // Follow file renames
  args.push('--', filePath);

  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && result.stderr) {
    if (result.stderr.includes('not a git repository')) {
      throw new Error('Not in a git repository');
    }
    throw new Error(result.stderr);
  }

  return parseGitLog(result.stdout || '', stat);
}

function parseGitLog(output, includeStat) {
  const commits = [];
  const lines = output.trim().split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    // Parse commit line: hash|shortHash|date|author|message
    const parts = line.split('|');
    if (parts.length >= 5) {
      const commit = {
        hash: parts[0],
        shortHash: parts[1],
        date: parts[2],
        author: parts[3],
        message: parts.slice(4).join('|'),  // Message might contain |
        stats: null
      };

      i++;

      // If stat mode, parse numstat lines
      if (includeStat) {
        let added = 0;
        let deleted = 0;

        while (i < lines.length && lines[i] && !lines[i].includes('|')) {
          const statLine = lines[i].trim();
          if (statLine) {
            const statParts = statLine.split('\t');
            if (statParts.length >= 2) {
              const a = parseInt(statParts[0], 10) || 0;
              const d = parseInt(statParts[1], 10) || 0;
              added += a;
              deleted += d;
            }
          }
          i++;
        }

        if (added > 0 || deleted > 0) {
          commit.stats = { added, deleted };
        }
      }

      commits.push(commit);
    } else {
      i++;
    }
  }

  return commits;
}

function formatDate(isoDate) {
  // Convert "2024-01-15 14:30:45 +0000" to "Jan 15"
  const date = new Date(isoDate);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();

  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${day}`;
  }

  return `${month} ${day}, ${date.getFullYear()}`;
}

function formatStats(stats) {
  if (!stats) return '';
  const { added, deleted } = stats;
  const parts = [];
  if (added > 0) parts.push(`+${added}`);
  if (deleted > 0) parts.push(`-${deleted}`);
  return parts.length > 0 ? ` (${parts.join('/')})` : '';
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let limit = 20;
let since = null;
let author = null;
let showStat = false;
let oneline = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--limit' || arg === '-n') {
    limit = parseInt(options.remaining[++i], 10) || 20;
  } else if (arg === '--since') {
    since = options.remaining[++i];
  } else if (arg === '--author') {
    author = options.remaining[++i];
  } else if (arg === '--stat') {
    showStat = true;
  } else if (arg === '--oneline') {
    oneline = true;
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
  const commits = getFileHistory(filePath, { limit, since, author, stat: showStat });

  if (commits.length === 0) {
    console.log('No commits found for this file');
    process.exit(0);
  }

  // Set JSON data
  out.setData('file', relPath);
  out.setData('commits', commits);
  out.setData('totalCommits', commits.length);

  // Format output
  out.header(`📜 ${relPath} - ${commits.length} recent commits`);
  out.blank();

  for (const commit of commits) {
    if (oneline) {
      const statsStr = formatStats(commit.stats);
      out.add(`${commit.shortHash} ${formatDate(commit.date)} ${commit.message}${statsStr}`);
    } else {
      const statsStr = formatStats(commit.stats);
      out.add(`${commit.shortHash}  ${formatDate(commit.date).padEnd(12)}  ${commit.author}`);
      out.add(`        ${commit.message}${statsStr}`);
      out.blank();
    }
  }

  // Summary
  if (!options.quiet && !oneline) {
    const authors = new Set(commits.map(c => c.author));
    const oldestDate = commits[commits.length - 1]?.date;
    const oldest = oldestDate ? formatDate(oldestDate) : '';

    out.add(`---`);
    out.add(`${commits.length} commits by ${authors.size} author(s), oldest: ${oldest}`);
  }

  out.print();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
