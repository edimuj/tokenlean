#!/usr/bin/env node

/**
 * tl-pr - Summarize PR/branch changes for code review
 *
 * Generates a concise summary of changes for efficient code review.
 * Works with local branches or GitHub PRs.
 *
 * Usage: tl-pr [branch|pr-number] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-pr',
    desc: 'Summarize PR/branch changes',
    when: 'code-review',
    example: 'tl-pr feature-branch'
  }));
  process.exit(0);
}

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTokens,
  shellEscape,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, categorizeFile, detectLanguage } from '../src/project.mjs';

const HELP = `
tl-pr - Summarize PR/branch changes for code review

Usage: tl-pr [branch|pr-number] [options]

Options:
  --base <branch>       Base branch to compare against (default: auto-detect)
  --files               Show detailed file list
  --stat                Show git stat (additions/deletions per file)
  --commits             Show commit list
  --full                Show everything (files, stat, commits)
${COMMON_OPTIONS_HELP}

Examples:
  tl-pr                         # Current branch vs main/master
  tl-pr feature-auth            # Specific branch
  tl-pr 123                     # GitHub PR #123 (requires gh CLI)
  tl-pr --base develop          # Compare against develop
  tl-pr --full                  # Full details

Output includes:
  - Change summary (files added/modified/deleted)
  - Categorization (source, tests, config, docs)
  - Size estimate (lines, tokens)
  - Key files to review
`;

// ─────────────────────────────────────────────────────────────
// Git Helpers
// ─────────────────────────────────────────────────────────────

function exec(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    }).trim();
  } catch (err) {
    if (options.throwOnError) throw err;
    return null;
  }
}

function getDefaultBranch() {
  // Try to get default branch from git
  const remote = exec('git remote show origin 2>/dev/null | grep "HEAD branch" | cut -d: -f2');
  if (remote) return remote.trim();

  // Check common names
  const branches = exec('git branch -a');
  if (branches?.includes('main')) return 'main';
  if (branches?.includes('master')) return 'master';

  return 'main';
}

function getCurrentBranch() {
  return exec('git branch --show-current') || exec('git rev-parse --abbrev-ref HEAD');
}

function branchExists(branch) {
  return exec(`git rev-parse --verify "${shellEscape(branch)}" 2>/dev/null`) !== null;
}

function getMergeBase(branch, base) {
  return exec(`git merge-base "${shellEscape(base)}" "${shellEscape(branch)}"`);
}

function getCommits(branch, base) {
  const mergeBase = getMergeBase(branch, base);
  if (!mergeBase) return [];

  const log = exec(`git log --oneline ${mergeBase}..${shellEscape(branch)}`);
  if (!log) return [];

  return log.split('\n').filter(Boolean).map(line => {
    const [hash, ...rest] = line.split(' ');
    return { hash, message: rest.join(' ') };
  });
}

function getDiffStats(branch, base) {
  const mergeBase = getMergeBase(branch, base);
  if (!mergeBase) return null;

  const stat = exec(`git diff --stat ${mergeBase}..${shellEscape(branch)}`);
  const numstat = exec(`git diff --numstat ${mergeBase}..${shellEscape(branch)}`);

  if (!numstat) return null;

  const files = [];
  const lines = numstat.split('\n').filter(Boolean);

  for (const line of lines) {
    const [additions, deletions, file] = line.split('\t');
    files.push({
      file,
      additions: additions === '-' ? 0 : parseInt(additions, 10),
      deletions: deletions === '-' ? 0 : parseInt(deletions, 10)
    });
  }

  return { files, stat };
}

function getChangedFiles(branch, base) {
  const mergeBase = getMergeBase(branch, base);
  if (!mergeBase) return { added: [], modified: [], deleted: [], renamed: [] };

  const diff = exec(`git diff --name-status ${mergeBase}..${shellEscape(branch)}`);
  if (!diff) return { added: [], modified: [], deleted: [], renamed: [] };

  const result = { added: [], modified: [], deleted: [], renamed: [] };

  for (const line of diff.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const file = rest[rest.length - 1]; // For renames, take the new name

    if (status === 'A') result.added.push(file);
    else if (status === 'M') result.modified.push(file);
    else if (status === 'D') result.deleted.push(file);
    else if (status.startsWith('R')) result.renamed.push({ from: rest[0], to: rest[1] });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// GitHub PR Support
// ─────────────────────────────────────────────────────────────

function isGhAvailable() {
  return exec('gh --version') !== null;
}

function getPRInfo(prNumber) {
  if (!isGhAvailable()) return null;

  const json = exec(`gh pr view ${prNumber} --json title,body,author,baseRefName,headRefName,additions,deletions,changedFiles,commits,files,state,mergeable`);
  if (!json) return null;

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Analysis Helpers
// ─────────────────────────────────────────────────────────────

function categorizeFiles(files) {
  const categories = {
    source: [],
    test: [],
    config: [],
    docs: [],
    assets: [],
    other: []
  };

  const configPatterns = [
    /^\./, // Dotfiles
    /config/i,
    /\.json$/,
    /\.ya?ml$/,
    /\.toml$/,
    /\.env/,
    /\.lock$/,
    /package\.json/,
    /tsconfig/,
    /eslint/,
    /prettier/,
    /webpack/,
    /vite/,
    /rollup/,
  ];

  const docPatterns = [
    /\.md$/i,
    /\.mdx$/i,
    /\.txt$/i,
    /readme/i,
    /changelog/i,
    /license/i,
    /docs?\//i,
  ];

  const assetPatterns = [
    /\.(png|jpg|jpeg|gif|svg|ico|webp)$/i,
    /\.(woff|woff2|ttf|eot)$/i,
    /\.(mp3|mp4|wav|webm)$/i,
    /\.(pdf|doc|docx)$/i,
  ];

  for (const file of files) {
    const cat = categorizeFile(file);

    if (cat === 'test') {
      categories.test.push(file);
    } else if (docPatterns.some(p => p.test(file))) {
      categories.docs.push(file);
    } else if (assetPatterns.some(p => p.test(file))) {
      categories.assets.push(file);
    } else if (configPatterns.some(p => p.test(file))) {
      categories.config.push(file);
    } else if (cat === 'source') {
      categories.source.push(file);
    } else {
      categories.other.push(file);
    }
  }

  return categories;
}

function detectChangeType(commits) {
  const types = {
    feature: false,
    fix: false,
    refactor: false,
    docs: false,
    test: false,
    chore: false,
    breaking: false
  };

  for (const commit of commits) {
    const msg = commit.message.toLowerCase();

    if (msg.startsWith('feat') || msg.includes('add') || msg.includes('new')) types.feature = true;
    if (msg.startsWith('fix') || msg.includes('bug') || msg.includes('issue')) types.fix = true;
    if (msg.startsWith('refactor') || msg.includes('refactor') || msg.includes('cleanup')) types.refactor = true;
    if (msg.startsWith('docs') || msg.includes('readme') || msg.includes('documentation')) types.docs = true;
    if (msg.startsWith('test') || msg.includes('test')) types.test = true;
    if (msg.startsWith('chore') || msg.includes('deps') || msg.includes('upgrade')) types.chore = true;
    if (msg.includes('breaking') || msg.includes('!:')) types.breaking = true;
  }

  return types;
}

function identifyKeyFiles(files, stats) {
  const keyFiles = [];

  // Large changes
  for (const stat of stats || []) {
    const changes = stat.additions + stat.deletions;
    if (changes > 100) {
      keyFiles.push({
        file: stat.file,
        reason: `${changes} lines changed`,
        priority: 'high'
      });
    }
  }

  // New source files
  for (const file of files.added || []) {
    const lang = detectLanguage(file);
    if (lang && !file.includes('test') && !file.includes('spec')) {
      keyFiles.push({
        file,
        reason: 'new file',
        priority: 'medium'
      });
    }
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  keyFiles.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return keyFiles.slice(0, 10); // Top 10
}

function estimateReviewTokens(stats) {
  if (!stats?.files) return 0;

  let total = 0;
  for (const file of stats.files) {
    // Rough estimate: additions are new context needed
    total += file.additions * 4; // ~4 chars per token
  }
  return total;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let target = null;
let baseBranch = null;
let showFiles = false;
let showStat = false;
let showCommits = false;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--base' && options.remaining[i + 1]) {
    baseBranch = options.remaining[++i];
  } else if (arg === '--files') {
    showFiles = true;
  } else if (arg === '--stat') {
    showStat = true;
  } else if (arg === '--commits') {
    showCommits = true;
  } else if (arg === '--full') {
    showFiles = true;
    showStat = true;
    showCommits = true;
  } else if (!arg.startsWith('-')) {
    target = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Determine what we're comparing
let branch = target;
let prInfo = null;
let isPR = false;

// Check if target is a PR number
if (target && /^\d+$/.test(target)) {
  prInfo = getPRInfo(target);
  if (prInfo) {
    isPR = true;
    branch = prInfo.headRefName;
    baseBranch = baseBranch || prInfo.baseRefName;
  } else {
    console.error(`Could not fetch PR #${target}. Make sure 'gh' CLI is installed and authenticated.`);
    process.exit(1);
  }
}

// Default to current branch
if (!branch) {
  branch = getCurrentBranch();
}

// Default base branch
if (!baseBranch) {
  baseBranch = getDefaultBranch();
}

// Verify branches exist
if (!isPR && !branchExists(branch)) {
  console.error(`Branch not found: ${branch}`);
  process.exit(1);
}

// Get data
const changedFiles = isPR && prInfo?.files
  ? { added: [], modified: prInfo.files.map(f => f.path), deleted: [] }
  : getChangedFiles(branch, baseBranch);

const allFiles = [
  ...changedFiles.added,
  ...changedFiles.modified,
  ...changedFiles.deleted,
  ...(changedFiles.renamed?.map(r => r.to) || [])
];

const stats = isPR && prInfo
  ? { files: prInfo.files?.map(f => ({ file: f.path, additions: f.additions, deletions: f.deletions })) }
  : getDiffStats(branch, baseBranch);

const commits = isPR && prInfo?.commits
  ? prInfo.commits.map(c => ({ hash: c.oid?.slice(0, 7), message: c.messageHeadline }))
  : getCommits(branch, baseBranch);

const categories = categorizeFiles(allFiles);
const changeTypes = detectChangeType(commits);
const keyFiles = identifyKeyFiles(changedFiles, stats?.files);
const reviewTokens = estimateReviewTokens(stats);

// Calculate totals
const totalAdditions = stats?.files?.reduce((sum, f) => sum + f.additions, 0) || 0;
const totalDeletions = stats?.files?.reduce((sum, f) => sum + f.deletions, 0) || 0;

// Output
if (isPR && prInfo) {
  out.header(`PR #${target}: ${prInfo.title}`);
  out.add(`Author: ${prInfo.author?.login || 'unknown'} | State: ${prInfo.state}`);
} else {
  out.header(`${branch} → ${baseBranch}`);
}
out.blank();

// Summary
out.add(`📊 Summary`);
out.add(`   ${commits.length} commits | ${allFiles.length} files | +${totalAdditions} -${totalDeletions} lines`);
out.add(`   Review size: ~${formatTokens(reviewTokens)} tokens`);
out.blank();

// Change types
const typeLabels = [];
if (changeTypes.breaking) typeLabels.push('⚠️ BREAKING');
if (changeTypes.feature) typeLabels.push('✨ Feature');
if (changeTypes.fix) typeLabels.push('🐛 Fix');
if (changeTypes.refactor) typeLabels.push('♻️ Refactor');
if (changeTypes.docs) typeLabels.push('📝 Docs');
if (changeTypes.test) typeLabels.push('🧪 Tests');
if (changeTypes.chore) typeLabels.push('🔧 Chore');

if (typeLabels.length > 0) {
  out.add(`🏷️  ${typeLabels.join(' | ')}`);
  out.blank();
}

// File breakdown
out.add(`📁 Files Changed`);
if (changedFiles.added.length > 0) out.add(`   Added:    ${changedFiles.added.length}`);
if (changedFiles.modified.length > 0) out.add(`   Modified: ${changedFiles.modified.length}`);
if (changedFiles.deleted.length > 0) out.add(`   Deleted:  ${changedFiles.deleted.length}`);
if (changedFiles.renamed?.length > 0) out.add(`   Renamed:  ${changedFiles.renamed.length}`);
out.blank();

// Categories
out.add(`📂 By Category`);
if (categories.source.length > 0) out.add(`   Source:  ${categories.source.length} files`);
if (categories.test.length > 0) out.add(`   Tests:   ${categories.test.length} files`);
if (categories.config.length > 0) out.add(`   Config:  ${categories.config.length} files`);
if (categories.docs.length > 0) out.add(`   Docs:    ${categories.docs.length} files`);
if (categories.assets.length > 0) out.add(`   Assets:  ${categories.assets.length} files`);
if (categories.other.length > 0) out.add(`   Other:   ${categories.other.length} files`);
out.blank();

// Key files to review
if (keyFiles.length > 0) {
  out.add(`🔍 Key Files to Review`);
  for (const kf of keyFiles.slice(0, 5)) {
    out.add(`   ${kf.file} (${kf.reason})`);
  }
  out.blank();
}

// Detailed file list
if (showFiles) {
  out.add(`📋 All Files`);
  for (const file of changedFiles.added) {
    out.add(`   + ${file}`);
  }
  for (const file of changedFiles.modified) {
    out.add(`   M ${file}`);
  }
  for (const file of changedFiles.deleted) {
    out.add(`   - ${file}`);
  }
  for (const renamed of changedFiles.renamed || []) {
    out.add(`   R ${renamed.from} → ${renamed.to}`);
  }
  out.blank();
}

// Stat
if (showStat && stats?.stat) {
  out.add(`📈 Diff Stat`);
  const statLines = stats.stat.split('\n').slice(0, 20);
  for (const line of statLines) {
    out.add(`   ${line}`);
  }
  if (stats.stat.split('\n').length > 20) {
    out.add(`   ... and more`);
  }
  out.blank();
}

// Commits
if (showCommits && commits.length > 0) {
  out.add(`📝 Commits (${commits.length})`);
  for (const commit of commits.slice(0, 15)) {
    out.add(`   ${commit.hash} ${commit.message}`);
  }
  if (commits.length > 15) {
    out.add(`   ... and ${commits.length - 15} more`);
  }
  out.blank();
}

// JSON data
out.setData('branch', branch);
out.setData('base', baseBranch);
out.setData('commits', commits);
out.setData('files', {
  added: changedFiles.added,
  modified: changedFiles.modified,
  deleted: changedFiles.deleted,
  renamed: changedFiles.renamed
});
out.setData('categories', categories);
out.setData('stats', {
  additions: totalAdditions,
  deletions: totalDeletions,
  filesChanged: allFiles.length,
  commits: commits.length
});
out.setData('changeTypes', changeTypes);
out.setData('keyFiles', keyFiles);
out.setData('reviewTokens', reviewTokens);

out.print();
