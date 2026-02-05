#!/usr/bin/env node

/**
 * tl-hotspots - Find frequently changed files (git churn analysis)
 *
 * Identifies files that change often - these are usually the most
 * important to understand when working on a codebase. High churn
 * files often indicate core logic, bugs, or areas needing refactoring.
 *
 * Usage: tl-hotspots [path] [--days N]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-hotspots',
    desc: 'Find frequently changed files (git churn)',
    when: 'before-modify',
    example: 'tl-hotspots --days 30'
  }));
  process.exit(0);
}

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, relative, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  shellEscape,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip, isCodeFile } from '../src/project.mjs';
import { getConfig } from '../src/config.mjs';

const HELP = `
tl-hotspots - Find frequently changed files (git churn analysis)

Usage: tl-hotspots [path] [options]

Options:
  --days N, -d N        Analyze last N days (default: 90)
  --top N, -n N         Show top N files (default: 20)
  --authors, -a         Group by author
  --code-only, -c       Only show code files (no config/docs)
${COMMON_OPTIONS_HELP}

Examples:
  tl-hotspots                       # Top 20 hotspots in last 90 days
  tl-hotspots src/ -d 30            # Hotspots in src/ from last 30 days
  tl-hotspots -n 10 -c              # Top 10 code files only
  tl-hotspots -a                    # Show who changes what most

Output shows:
  • Files sorted by change frequency
  • Number of commits touching each file
  • Lines added/removed
  • Token cost to read the file
`;

// ─────────────────────────────────────────────────────────────
// Git Analysis
// ─────────────────────────────────────────────────────────────

function getGitLog(path, days, projectRoot) {
  try {
    // Single quotes around format to prevent shell interpretation of %
    const cmd = `git -C "${shellEscape(projectRoot)}" log --since="${days} days ago" --format='%H|%an|%ad|%s' --date=short --name-only -- "${shellEscape(path)}"`;

    const output = execSync(cmd, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024
    });

    return parseGitLog(output);
  } catch (e) {
    return { commits: [], fileChanges: new Map(), authorChanges: new Map() };
  }
}

function parseGitLog(output) {
  const commits = [];
  const fileChanges = new Map(); // file -> { commits, additions, deletions, authors }
  const authorChanges = new Map(); // author -> { commits, files }

  const lines = output.trim().split('\n');
  let currentCommit = null;

  for (const line of lines) {
    if (line.includes('|')) {
      // Commit line: hash|author|date|subject
      const [hash, author, date, ...subjectParts] = line.split('|');
      currentCommit = {
        hash,
        author,
        date,
        subject: subjectParts.join('|'),
        files: []
      };
      commits.push(currentCommit);

      // Track author
      if (!authorChanges.has(author)) {
        authorChanges.set(author, { commits: 0, files: new Set() });
      }
      authorChanges.get(author).commits++;
    } else if (line.trim() && currentCommit) {
      // File line
      const file = line.trim();
      currentCommit.files.push(file);

      // Track file changes
      if (!fileChanges.has(file)) {
        fileChanges.set(file, { commits: 0, authors: new Set() });
      }
      const fc = fileChanges.get(file);
      fc.commits++;
      fc.authors.add(currentCommit.author);

      // Track author's files
      authorChanges.get(currentCommit.author).files.add(file);
    }
  }

  return { commits, fileChanges, authorChanges };
}

function getFileStats(files, projectRoot) {
  const stats = [];

  for (const [file, data] of files) {
    const fullPath = resolve(projectRoot, file);

    // Skip if file doesn't exist (deleted) or should be skipped
    if (!existsSync(fullPath)) {
      continue;
    }

    const name = basename(file);
    if (shouldSkip(name, false)) {
      continue;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const tokens = estimateTokens(content);
      const lines = content.split('\n').length;

      stats.push({
        file,
        commits: data.commits,
        authors: [...data.authors],
        authorCount: data.authors.size,
        tokens,
        lines
      });
    } catch {
      // Can't read file
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function formatHotspots(stats, out, showAuthors, topN) {
  // Sort by commit count descending
  stats.sort((a, b) => b.commits - a.commits);

  const top = stats.slice(0, topN);
  let totalTokens = 0;

  for (const item of top) {
    totalTokens += item.tokens;

    let line = `  ${item.commits.toString().padStart(3)} commits`;
    line += `  ${item.authorCount.toString().padStart(2)} authors`;
    line += `  ~${formatTokens(item.tokens).padStart(5)}`;
    line += `  ${item.file}`;

    out.add(line);

    if (showAuthors && item.authors.length > 0) {
      out.add(`      └─ ${item.authors.slice(0, 3).join(', ')}${item.authors.length > 3 ? '...' : ''}`);
    }
  }

  return { count: top.length, totalTokens };
}

function formatAuthorSummary(authorChanges, out, topN) {
  const authors = [...authorChanges.entries()]
    .map(([name, data]) => ({
      name,
      commits: data.commits,
      fileCount: data.files.size
    }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, topN);

  out.blank();
  out.add('👥 Top contributors:');

  for (const author of authors) {
    out.add(`  ${author.commits.toString().padStart(3)} commits  ${author.fileCount.toString().padStart(3)} files  ${author.name}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Get config defaults
const hotspotsConfig = getConfig('hotspots') || {};

// Parse tool-specific options (CLI overrides config)
let days = hotspotsConfig.days || 90;
let topN = hotspotsConfig.top || 20;
let showAuthors = false;
let codeOnly = false;

const consumedIndices = new Set();

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--days' || arg === '-d') && options.remaining[i + 1]) {
    const parsed = parseInt(options.remaining[i + 1], 10);
    if (isNaN(parsed) || parsed < 1) {
      console.error(`Error: --days requires a positive integer, got "${options.remaining[i + 1]}"`);
      process.exit(1);
    }
    days = parsed;
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++;
  } else if ((arg === '--top' || arg === '-n') && options.remaining[i + 1]) {
    const parsedTop = parseInt(options.remaining[i + 1], 10);
    if (isNaN(parsedTop) || parsedTop < 1) {
      console.error(`Error: --top requires a positive integer, got "${options.remaining[i + 1]}"`);
      process.exit(1);
    }
    topN = parsedTop;
    consumedIndices.add(i);
    consumedIndices.add(i + 1);
    i++;
  } else if (arg === '--authors' || arg === '-a') {
    showAuthors = true;
    consumedIndices.add(i);
  } else if (arg === '--code-only' || arg === '-c') {
    codeOnly = true;
    consumedIndices.add(i);
  }
}

const targetPath = options.remaining.find((a, i) => !a.startsWith('-') && !consumedIndices.has(i)) || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const resolvedPath = resolve(targetPath);
const relPath = relative(projectRoot, resolvedPath) || '.';

// Check if we're in a git repo
try {
  execSync(`git -C "${shellEscape(projectRoot)}" rev-parse --git-dir`, { encoding: 'utf-8', stdio: 'pipe' });
} catch {
  console.error('Error: Not in a git repository');
  process.exit(1);
}

const out = createOutput(options);

out.header(`\n🔥 Hotspots: ${relPath === '.' ? basename(projectRoot) : relPath}`);
out.header(`   Last ${days} days, top ${topN} files`);
out.blank();

const { commits, fileChanges, authorChanges } = getGitLog(relPath, days, projectRoot);

if (commits.length === 0) {
  out.add('No commits found in the specified time range.');
  out.print();
  process.exit(0);
}

// Filter to code files if requested
let filteredChanges = fileChanges;
if (codeOnly) {
  filteredChanges = new Map(
    [...fileChanges.entries()].filter(([file]) => isCodeFile(file))
  );
}

const stats = getFileStats(filteredChanges, projectRoot);

if (stats.length === 0) {
  out.add('No matching files found.');
  out.print();
  process.exit(0);
}

const { count, totalTokens } = formatHotspots(stats, out, showAuthors, topN);

if (showAuthors && authorChanges.size > 0) {
  formatAuthorSummary(authorChanges, out, 5);
}

out.blank();
out.stats('─'.repeat(50));
out.stats(`📊 ${commits.length} commits, ${stats.length} files changed`);
out.stats(`   Top ${count} files: ~${formatTokens(totalTokens)} tokens to review`);
out.blank();

// JSON data
out.setData('path', relPath);
out.setData('days', days);
out.setData('totalCommits', commits.length);
out.setData('totalFiles', stats.length);
out.setData('hotspots', stats.slice(0, topN));

out.print();
