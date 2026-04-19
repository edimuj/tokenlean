#!/usr/bin/env node

/**
 * tl-push - Stage, commit, and push in one call
 *
 * Stages specified files (or all changed files), commits with the given
 * message, and pushes to origin. Returns a one-line summary.
 *
 * Usage: tl-push "commit message" [files...] [--no-push] [--amend] [-j]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-push',
    desc: 'Stage, commit, and push in one call',
    when: 'after-changes',
    example: 'tl-push "fix: resolve race condition" src/worker.mjs'
  }));
  process.exit(0);
}

import { spawnSync } from 'node:child_process';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { gitCommand } from '../src/shell.mjs';

const HELP = `
tl-push - Stage, commit, and push in one call

Usage: tl-push "commit message" [files...] [options]

If no files are specified, stages tracked modified files only (git add -u).
If files are specified, stages only those files.

Options:
  --all, -A             Include untracked files (git add -A instead of -u)
  --no-push             Commit only, don't push
  --amend               Amend the previous commit (message optional)
  --dry-run             Show what would happen without doing it
${COMMON_OPTIONS_HELP}

Examples:
  tl-push "feat: add caching"                    # Stage modified, commit, push
  tl-push "feat: new tool" -A                    # Include untracked files too
  tl-push "fix: typo" README.md                  # Stage README.md only
  tl-push "chore: cleanup" --no-push             # Commit without pushing
  tl-push --amend                                # Amend last commit, push
  tl-push "fix: better msg" --amend              # Amend with new message
`;

const DANGEROUS_PATTERNS = [
  /\.env$/,
  /credentials/i,
  /secret/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /token\.json$/,
  /\.npmrc$/
];

function isSensitive(file) {
  return DANGEROUS_PATTERNS.some(p => p.test(file));
}

function git(args) {
  const proc = spawnSync('git', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return {
    ok: proc.status === 0,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim()
  };
}

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let message = null;
let amend = false;
let noPush = false;
let dryRun = false;
let includeUntracked = false;
const files = [];

for (const arg of options.remaining) {
  if (arg === '--no-push') noPush = true;
  else if (arg === '--amend') amend = true;
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--all' || arg === '-A') includeUntracked = true;
  else if (message === null && !arg.startsWith('-')) message = arg;
  else if (!arg.startsWith('-')) files.push(arg);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!message && !amend) {
  console.error('Error: commit message required (or use --amend)');
  console.error('Usage: tl-push "commit message" [files...]');
  process.exit(1);
}

const out = createOutput(options);

const branch = gitCommand(['branch', '--show-current']);
if (!branch) {
  console.error('Error: not on a branch (detached HEAD)');
  process.exit(1);
}

const status = gitCommand(['status', '--short']);
if (!status && !amend) {
  out.header('Nothing to commit');
  out.print();
  process.exit(0);
}

const filesToStage = files.length > 0 ? files : null;

if (filesToStage) {
  const sensitive = filesToStage.filter(isSensitive);
  if (sensitive.length > 0) {
    console.error(`Error: refusing to commit potentially sensitive files: ${sensitive.join(', ')}`);
    console.error('Remove them from the file list or rename if they are safe.');
    process.exit(1);
  }
}

if (dryRun) {
  out.header('Dry run — would execute:');
  if (filesToStage) {
    out.add(`  git add ${filesToStage.join(' ')}`);
  } else {
    out.add(`  git add ${includeUntracked ? '-A' : '-u'}`);
  }
  if (amend) {
    out.add(`  git commit --amend ${message ? `-m "${message}"` : '--no-edit'}`);
  } else {
    out.add(`  git commit -m "${message}"`);
  }
  if (!noPush) out.add(`  git push origin ${branch}`);
  out.print();
  process.exit(0);
}

// Stage
let stageResult;
if (filesToStage) {
  stageResult = git(['add', ...filesToStage]);
} else {
  stageResult = git(['add', includeUntracked ? '-A' : '-u']);
}

if (!stageResult.ok) {
  console.error(`Stage failed: ${stageResult.stderr}`);
  process.exit(1);
}

// Commit
const commitArgs = ['commit'];
if (amend) {
  commitArgs.push('--amend');
  if (message) {
    commitArgs.push('-m', message);
  } else {
    commitArgs.push('--no-edit');
  }
} else {
  commitArgs.push('-m', message);
}

const commitResult = git(commitArgs);
if (!commitResult.ok) {
  if (commitResult.stderr.includes('nothing to commit')) {
    out.header('Nothing to commit');
    out.print();
    process.exit(0);
  }
  console.error(`Commit failed: ${commitResult.stderr}`);
  process.exit(1);
}

const commitMatch = commitResult.stdout.match(/\[(\S+)\s+([a-f0-9]+)\]/);
const shortHash = commitMatch ? commitMatch[2] : '?';

// Push
let pushed = false;
if (!noPush) {
  const pushResult = git(['push', 'origin', branch]);
  if (!pushResult.ok) {
    const pushUpResult = git(['push', '--set-upstream', 'origin', branch]);
    if (!pushUpResult.ok) {
      out.add(`Committed ${shortHash} on ${branch} but push failed: ${pushResult.stderr}`);
      out.setData('committed', true);
      out.setData('pushed', false);
      out.setData('hash', shortHash);
      out.setData('branch', branch);
      out.setData('error', pushResult.stderr);
      out.print();
      process.exit(1);
    }
    pushed = true;
  } else {
    pushed = true;
  }
}

const filesChanged = gitCommand(['diff', '--stat', 'HEAD~1..HEAD']);
const summary = filesChanged
  ? filesChanged.split('\n').pop()?.trim()
  : '';

out.setData('committed', true);
out.setData('pushed', pushed);
out.setData('hash', shortHash);
out.setData('branch', branch);
out.setData('message', message || '(amended)');
if (summary) out.setData('summary', summary);

const action = amend ? 'Amended' : 'Committed';
const pushStr = pushed ? ', pushed' : '';
out.add(`${action} ${shortHash} on ${branch}${pushStr}: ${message || '(no message change)'}`);
if (summary) out.add(summary);

out.print();
