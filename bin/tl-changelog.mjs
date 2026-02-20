#!/usr/bin/env node

/**
 * tl-changelog - Generate changelog from git commits
 *
 * Parses conventional commits and generates formatted changelogs.
 * Supports version ranges, tags, and multiple output formats.
 *
 * Usage: tl-changelog [range] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-changelog',
    desc: 'Generate changelog from commits',
    when: 'release',
    example: 'tl-changelog v0.1.0..v0.2.0'
  }));
  process.exit(0);
}

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { gitCommand } from '../src/shell.mjs';

const HELP = `
tl-changelog - Generate changelog from git commits

Usage: tl-changelog [range] [options]

Options:
  --from <ref>          Start from tag/commit (default: last tag)
  --to <ref>            End at tag/commit (default: HEAD)
  --unreleased          Show changes since last tag
  --all                 Show all commits (not just conventional)
  --draft               Draft a release entry with semver bump suggestion
  --format <fmt>        Output format: markdown, plain, compact (default: markdown)
  --with-hash           Include commit hashes
  --with-author         Include commit authors
  --with-date           Include commit dates
  --group-breaking      Group breaking changes separately
${COMMON_OPTIONS_HELP}

Examples:
  tl-changelog                      # Since last tag
  tl-changelog v0.1.0..v0.2.0       # Between versions
  tl-changelog --from v0.1.0        # From v0.1.0 to HEAD
  tl-changelog --unreleased         # Unreleased changes
  tl-changelog --format plain       # Plain text output
  tl-changelog --with-author        # Include authors
  tl-changelog --draft              # Draft release entry with bump suggestion

Conventional Commits:
  feat:     New features
  fix:      Bug fixes
  docs:     Documentation
  style:    Code style (formatting)
  refactor: Code refactoring
  perf:     Performance improvements
  test:     Tests
  chore:    Maintenance

Breaking changes: feat!: or BREAKING CHANGE in body
`;

// ─────────────────────────────────────────────────────────────
// Git Helpers
// ─────────────────────────────────────────────────────────────

function getLastTag() {
  return gitCommand(['describe', '--tags', '--abbrev=0']);
}

function getAllTags() {
  const tags = gitCommand(['tag', '--sort=-version:refname']);
  return tags ? tags.split('\n').filter(Boolean) : [];
}

function getCommits(from, to = 'HEAD') {
  const range = from ? `${from}..${to}` : to;

  // Get detailed commit info
  // Format: hash|author|date|subject|body
  const format = '%H|%an|%ai|%s|%b%x00';
  const log = gitCommand(['log', range, `--format=${format}`]);

  if (!log) return [];

  const commits = [];
  const entries = log.split('\x00').filter(Boolean);

  for (const entry of entries) {
    const [hash, author, date, subject, ...bodyParts] = entry.split('|');
    const body = bodyParts.join('|').trim();

    commits.push({
      hash: hash?.trim(),
      shortHash: hash?.trim().slice(0, 7),
      author: author?.trim(),
      date: date?.trim().split(' ')[0], // Just the date part
      subject: subject?.trim(),
      body: body
    });
  }

  return commits;
}

// ─────────────────────────────────────────────────────────────
// Commit Parsing
// ─────────────────────────────────────────────────────────────

const COMMIT_TYPES = {
  feat: { label: 'Features', emoji: '', order: 1 },
  fix: { label: 'Bug Fixes', emoji: '', order: 2 },
  perf: { label: 'Performance', emoji: '', order: 3 },
  refactor: { label: 'Refactoring', emoji: '', order: 4 },
  docs: { label: 'Documentation', emoji: '', order: 5 },
  test: { label: 'Tests', emoji: '', order: 6 },
  style: { label: 'Styling', emoji: '', order: 7 },
  chore: { label: 'Chores', emoji: '', order: 8 },
  ci: { label: 'CI/CD', emoji: '', order: 9 },
  build: { label: 'Build', emoji: '', order: 10 },
  revert: { label: 'Reverts', emoji: '', order: 11 },
};

function parseCommit(commit) {
  const { subject, body } = commit;

  // Check for breaking change
  const isBreaking = subject.includes('!:') ||
                     subject.toUpperCase().includes('BREAKING') ||
                     body?.toUpperCase().includes('BREAKING CHANGE');

  // Parse conventional commit format: type(scope): description
  const conventionalMatch = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  if (conventionalMatch) {
    const [, type, scope, bang, description] = conventionalMatch;
    return {
      ...commit,
      type: type.toLowerCase(),
      scope: scope || null,
      description,
      isBreaking: isBreaking || !!bang,
      isConventional: true
    };
  }

  // Try to infer type from keywords
  const lowerSubject = subject.toLowerCase();
  let inferredType = 'other';

  if (lowerSubject.startsWith('fix') || lowerSubject.includes('bug')) {
    inferredType = 'fix';
  } else if (lowerSubject.startsWith('add') || lowerSubject.includes('feature') || lowerSubject.includes('implement')) {
    inferredType = 'feat';
  } else if (lowerSubject.startsWith('update') || lowerSubject.startsWith('improve')) {
    inferredType = 'feat';
  } else if (lowerSubject.startsWith('refactor') || lowerSubject.includes('cleanup')) {
    inferredType = 'refactor';
  } else if (lowerSubject.startsWith('doc') || lowerSubject.includes('readme')) {
    inferredType = 'docs';
  } else if (lowerSubject.startsWith('test')) {
    inferredType = 'test';
  } else if (lowerSubject.includes('perf') || lowerSubject.includes('optim')) {
    inferredType = 'perf';
  } else if (lowerSubject.startsWith('chore') || lowerSubject.includes('deps') || lowerSubject.includes('bump')) {
    inferredType = 'chore';
  }

  return {
    ...commit,
    type: inferredType,
    scope: null,
    description: subject,
    isBreaking,
    isConventional: false
  };
}

function groupCommits(commits, options = {}) {
  const groups = {};
  const breaking = [];

  for (const commit of commits) {
    const parsed = parseCommit(commit);

    // Skip non-conventional if not --all
    if (!options.includeAll && !parsed.isConventional && parsed.type === 'other') {
      continue;
    }

    // Collect breaking changes separately if requested
    if (options.groupBreaking && parsed.isBreaking) {
      breaking.push(parsed);
    }

    // Group by type
    const type = parsed.type;
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(parsed);
  }

  // Sort groups by order
  const sortedGroups = Object.entries(groups)
    .sort(([a], [b]) => {
      const orderA = COMMIT_TYPES[a]?.order || 99;
      const orderB = COMMIT_TYPES[b]?.order || 99;
      return orderA - orderB;
    });

  return { groups: sortedGroups, breaking };
}

// ─────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────

function formatMarkdown(groups, breaking, options = {}) {
  const lines = [];

  // Breaking changes first
  if (breaking.length > 0) {
    lines.push('### ! BREAKING CHANGES');
    lines.push('');
    for (const commit of breaking) {
      lines.push(formatCommitMarkdown(commit, options));
    }
    lines.push('');
  }

  // Regular groups
  for (const [type, commits] of groups) {
    const typeInfo = COMMIT_TYPES[type] || { label: capitalize(type), emoji: '' };
    lines.push(`### ${typeInfo.emoji ? typeInfo.emoji + ' ' : ''}${typeInfo.label}`);
    lines.push('');

    for (const commit of commits) {
      lines.push(formatCommitMarkdown(commit, options));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatCommitMarkdown(commit, options = {}) {
  let line = '- ';

  if (commit.scope) {
    line += `**${commit.scope}:** `;
  }

  line += commit.description;

  const meta = [];
  if (options.withHash) meta.push(`[\`${commit.shortHash}\`]`);
  if (options.withAuthor) meta.push(`@${commit.author}`);
  if (options.withDate) meta.push(commit.date);

  if (meta.length > 0) {
    line += ` (${meta.join(', ')})`;
  }

  if (commit.isBreaking && !options.groupBreaking) {
    line += ' ! ';
  }

  return line;
}

function formatPlain(groups, breaking, options = {}) {
  const lines = [];

  // Breaking changes first
  if (breaking.length > 0) {
    lines.push('BREAKING CHANGES:');
    for (const commit of breaking) {
      lines.push(formatCommitPlain(commit, options));
    }
    lines.push('');
  }

  // Regular groups
  for (const [type, commits] of groups) {
    const typeInfo = COMMIT_TYPES[type] || { label: capitalize(type) };
    lines.push(`${typeInfo.label.toUpperCase()}:`);

    for (const commit of commits) {
      lines.push(formatCommitPlain(commit, options));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatCommitPlain(commit, options = {}) {
  let line = '  - ';

  if (commit.scope) {
    line += `[${commit.scope}] `;
  }

  line += commit.description;

  const meta = [];
  if (options.withHash) meta.push(commit.shortHash);
  if (options.withAuthor) meta.push(commit.author);
  if (options.withDate) meta.push(commit.date);

  if (meta.length > 0) {
    line += ` (${meta.join(', ')})`;
  }

  return line;
}

function formatCompact(groups, breaking, options = {}) {
  const lines = [];

  for (const [type, commits] of groups) {
    const typeInfo = COMMIT_TYPES[type] || { emoji: '-' };
    for (const commit of commits) {
      let line = typeInfo.emoji ? `${typeInfo.emoji} ` : '';
      if (commit.scope) line += `${commit.scope}: `;
      line += commit.description;
      if (commit.isBreaking) line += ' ! ';
      lines.push(line);
    }
  }

  return lines.join('\n');
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─────────────────────────────────────────────────────────────
// Draft Mode — Semver Suggestion
// ─────────────────────────────────────────────────────────────

function suggestBump(commits) {
  const parsed = commits.map(c => parseCommit(c));
  const hasBreaking = parsed.some(c => c.isBreaking);
  const hasFeats = parsed.some(c => c.type === 'feat');

  if (hasBreaking) return 'major';
  if (hasFeats) return 'minor';
  return 'patch';
}

function bumpVersion(version, bump) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  if (bump === 'major') return `${parts[0] + 1}.0.0`;
  if (bump === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function getCurrentVersion(projectRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function formatDraftEntry(version, groups, breaking) {
  const today = new Date().toISOString().split('T')[0];
  const lines = [`## [${version}] - ${today}`, ''];

  // Map commit types to changelog categories
  const CATEGORY_MAP = {
    feat: 'Added',
    fix: 'Fixed',
    perf: 'Changed',
    refactor: 'Changed',
    docs: 'Changed',
    style: 'Changed',
    chore: 'Changed',
    ci: 'Changed',
    build: 'Changed',
    test: 'Changed',
    revert: 'Changed'
  };

  // Group by changelog category
  const categories = {};
  for (const [type, commits] of groups) {
    const category = CATEGORY_MAP[type] || 'Changed';
    if (!categories[category]) categories[category] = [];
    for (const commit of commits) {
      categories[category].push(commit);
    }
  }

  // Output in standard order: Added, Changed, Fixed
  const ORDER = ['Added', 'Changed', 'Fixed'];
  for (const category of ORDER) {
    const commits = categories[category];
    if (!commits || commits.length === 0) continue;

    lines.push(`### ${category}`);
    for (const commit of commits) {
      let desc = commit.description;
      if (commit.scope) desc = `**${commit.scope}:** ${desc}`;
      lines.push(`- ${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let fromRef = null;
let toRef = 'HEAD';
let format = 'markdown';
let includeAll = false;
let withHash = false;
let withAuthor = false;
let withDate = false;
let groupBreaking = false;
let draft = false;
let range = null;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--from' && options.remaining[i + 1]) {
    fromRef = options.remaining[++i];
  } else if (arg === '--to' && options.remaining[i + 1]) {
    toRef = options.remaining[++i];
  } else if (arg === '--unreleased') {
    fromRef = getLastTag();
    toRef = 'HEAD';
  } else if (arg === '--all') {
    includeAll = true;
  } else if (arg === '--format' && options.remaining[i + 1]) {
    format = options.remaining[++i];
  } else if (arg === '--with-hash') {
    withHash = true;
  } else if (arg === '--with-author') {
    withAuthor = true;
  } else if (arg === '--with-date') {
    withDate = true;
  } else if (arg === '--group-breaking') {
    groupBreaking = true;
  } else if (arg === '--draft') {
    draft = true;
  } else if (!arg.startsWith('-') && arg.includes('..')) {
    range = arg;
  } else if (!arg.startsWith('-')) {
    fromRef = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Parse range if provided
if (range) {
  const [from, to] = range.split('..');
  fromRef = from || getLastTag();
  toRef = to || 'HEAD';
}

// Default: since last tag
if (!fromRef && !range) {
  fromRef = getLastTag();
  if (!fromRef) {
    // No tags, get all commits
    fromRef = gitCommand(['rev-list', '--max-parents=0', 'HEAD']); // First commit
  }
}

// Get commits
const commits = getCommits(fromRef, toRef);

if (commits.length === 0) {
  out.header('No commits found in range');
  out.print();
  process.exit(0);
}

// Group and format
const formatOptions = { withHash, withAuthor, withDate, groupBreaking, includeAll };
const { groups, breaking } = groupCommits(commits, formatOptions);

// Draft mode — output release entry with bump suggestion
if (draft) {
  const currentVersion = getCurrentVersion(projectRoot);
  const bump = suggestBump(commits);
  const nextVersion = bumpVersion(currentVersion, bump);

  const typeCounts = groups.map(([type, c]) => `${c.length} ${type}`).join(', ');

  if (options.json) {
    out.setData('currentVersion', currentVersion);
    out.setData('suggestedBump', bump);
    out.setData('nextVersion', nextVersion);
    out.setData('commits', commits.map(c => parseCommit(c)));
    out.setData('entry', formatDraftEntry(nextVersion, groups, breaking));
  } else {
    out.add(`Suggested bump: ${bump} (${typeCounts})`);
    out.blank();
    out.add(formatDraftEntry(nextVersion, groups, breaking));
  }

  out.print();
  process.exit(0);
}

// Generate title
let title = '';
if (range) {
  title = range;
} else if (fromRef && toRef === 'HEAD') {
  title = `${fromRef}..HEAD (Unreleased)`;
} else {
  title = `${fromRef}..${toRef}`;
}

// Output based on format
if (options.json) {
  out.setData('range', { from: fromRef, to: toRef });
  out.setData('commits', commits.map(c => parseCommit(c)));
  out.setData('groups', Object.fromEntries(groups));
  out.setData('breaking', breaking);
  out.setData('summary', {
    total: commits.length,
    breaking: breaking.length,
    byType: Object.fromEntries(groups.map(([type, commits]) => [type, commits.length]))
  });
} else {
  out.header(`## ${title}`);
  out.blank();

  if (format === 'markdown') {
    out.add(formatMarkdown(groups, breaking, formatOptions));
  } else if (format === 'plain') {
    out.add(formatPlain(groups, breaking, formatOptions));
  } else if (format === 'compact') {
    out.add(formatCompact(groups, breaking, formatOptions));
  }

  // Summary line
  const typeBreakdown = groups.map(([type, commits]) => {
    const info = COMMIT_TYPES[type] || { emoji: '-' };
    return `${commits.length} ${type}`;
  }).join(', ');

  out.stats(`---\n${commits.length} commits: ${typeBreakdown}`);
}

out.print();
