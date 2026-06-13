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
import { readFileSync, existsSync } from 'node:fs';
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
With multiple modified files and no explicit list, pass -A to stage everything.

The message may be multi-line (subject + blank line + body). For long bodies,
write them to a file and use -F to avoid shell-quoting.

Options:
  --all, -A             Stage everything incl. untracked (git add -A); also
                        bypasses the "specify which files" guard
  --force, -f           Force-add files (git add -f), for gitignored files
  --message-file, -F P  Read the commit message from file P (multi-line bodies)
  --no-push             Commit only, don't push
  --amend               Amend the previous commit (message optional)
  --dry-run             Show what would happen without doing it
${COMMON_OPTIONS_HELP}

Examples:
  tl-push "feat: add caching"                    # Stage modified, commit, push
  tl-push "feat: new tool" -A                    # Stage all (incl. untracked)
  tl-push "fix: typo" README.md                  # Stage README.md only
  tl-push -F /tmp/msg.txt -A                     # Long body from file, stage all
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

// In-progress git operations that make committing on top dangerous. Checked
// relative to the git dir via `git rev-parse --git-path` so it works correctly
// inside linked worktrees (where the per-worktree git dir is .git/worktrees/<n>).
const IN_PROGRESS_OPS = [
  { path: 'rebase-merge', verb: 'mid-rebase', resolve: 'git rebase --continue / --abort' },
  { path: 'rebase-apply', verb: 'mid-rebase', resolve: 'git rebase --continue / --abort' },
  { path: 'MERGE_HEAD', verb: 'mid-merge', resolve: 'git merge --continue / --abort' },
  { path: 'CHERRY_PICK_HEAD', verb: 'mid-cherry-pick', resolve: 'git cherry-pick --continue / --abort' },
  { path: 'REVERT_HEAD', verb: 'mid-revert', resolve: 'git revert --continue / --abort' }
];

function detectInProgressOp() {
  for (const op of IN_PROGRESS_OPS) {
    const res = git(['rev-parse', '--git-path', op.path]);
    if (res.ok && res.stdout && existsSync(res.stdout)) return op;
  }
  return null;
}

function git(args) {
  const proc = spawnSync('git', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return {
    ok: proc.status === 0,
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim()
  };
}

// Resolve the current branch from MULTIPLE git sources and only declare a
// detached HEAD when ALL of them affirmatively fail. `git branch --show-current`
// alone is ambiguous: it returns empty both when genuinely detached AND when the
// command can't produce output in the calling environment — which is what bit us
// under the Codex sandbox's git env (vent #105), where --show-current came back
// empty while rev-parse/symbolic-ref still reported `main`, producing a false
// "detached HEAD" abort. rev-parse returns the literal "HEAD" only when really
// detached, so it disambiguates; symbolic-ref is the final corroborator.
function detectBranch() {
  const showCurrent = gitCommand(['branch', '--show-current']);
  if (showCurrent) return showCurrent;

  const revParse = gitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (revParse && revParse !== 'HEAD') return revParse;

  const symRef = gitCommand(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (symRef) return symRef;

  return null; // genuinely detached, or git is unusable in this environment
}

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let message = null;
let messageFile = null;
let amend = false;
let noPush = false;
let dryRun = false;
let includeUntracked = false;
let forceAdd = false;
const files = [];

// Collect positional (non-flag) args first; assign them to message/files after
// the loop, since -F may appear before or after the file list.
const positionals = [];
const remaining = options.remaining;
for (let i = 0; i < remaining.length; i++) {
  const arg = remaining[i];
  if (arg === '--no-push') noPush = true;
  else if (arg === '--amend') amend = true;
  else if (arg === '--dry-run') dryRun = true;
  else if (arg === '--all' || arg === '-A') includeUntracked = true;
  else if (arg === '--force' || arg === '-f') forceAdd = true;
  else if (arg === '--message-file' || arg === '-F') {
    messageFile = remaining[++i];
    if (!messageFile) {
      console.error('Error: -F/--message-file requires a path');
      process.exit(2);
    }
  }
  else if (!arg.startsWith('-')) positionals.push(arg);
}

// With -F, every positional is a file to stage (like `git commit -F`).
// Otherwise the first positional is the commit message, the rest are files.
if (messageFile) {
  files.push(...positionals);
} else if (positionals.length > 0) {
  message = positionals[0];
  files.push(...positionals.slice(1));
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (messageFile) {
  try {
    message = readFileSync(messageFile, 'utf-8').replace(/\n+$/, '');
  } catch (e) {
    console.error(`Error: cannot read message file ${messageFile}: ${e.message}`);
    process.exit(1);
  }
  if (!message.trim()) {
    console.error(`Error: message file ${messageFile} is empty`);
    process.exit(2);
  }
}

if (!message && !amend) {
  console.error('Error: commit message required (or use --amend)');
  console.error('Usage: tl-push "commit message" [files...]');
  process.exit(1);
}

const out = createOutput(options);
const subject = message ? message.split('\n')[0] : null;

// Preflight: refuse to commit on top of a half-finished git operation. This
// covers the --amend and --no-push paths too (a mid-rebase amend is just as
// unsafe). Pure safety guard — tl-push has no rebase/merge logic of its own.
const inProgress = detectInProgressOp();
if (inProgress) {
  console.error(
    `tl push: repository is ${inProgress.verb} — resolve and continue, or abort, ` +
    `before committing (${inProgress.resolve}). ` +
    `Refusing to commit on top of an unfinished operation.`
  );
  process.exit(2);
}

const branch = detectBranch();
if (!branch) {
  console.error('Error: not on a branch (detached HEAD). If git reports a branch, the working dir may be misdetected — run with -A from the repo root, or commit with raw git.');
  process.exit(1);
}

const status = gitCommand(['status', '--short']);
if (!status && !amend) {
  out.header('Nothing to commit');
  out.print();
  process.exit(0);
}

const filesToStage = files.length > 0 ? files : null;

if (forceAdd && !filesToStage) {
  console.error('Error: -f/--force requires explicit file list');
  process.exit(1);
}

if (filesToStage) {
  const sensitive = filesToStage.filter(isSensitive);
  if (sensitive.length > 0) {
    console.error(`Error: refusing to commit potentially sensitive files: ${sensitive.join(', ')}`);
    console.error('Remove them from the file list or rename if they are safe.');
    process.exit(1);
  }
}

// Detect what will be staged
let stagedFiles = [];
if (filesToStage) {
  stagedFiles = filesToStage;
} else {
  const tracked = gitCommand(['diff', '--name-only']);
  const alreadyStaged = gitCommand(['diff', '--name-only', '--cached']);
  const trackedList = tracked ? tracked.split('\n').filter(Boolean) : [];
  const stagedList = alreadyStaged ? alreadyStaged.split('\n').filter(Boolean) : [];
  stagedFiles = [...new Set([...trackedList, ...stagedList])];
  if (includeUntracked) {
    const untracked = gitCommand(['ls-files', '--others', '--exclude-standard']);
    if (untracked) stagedFiles.push(...untracked.split('\n').filter(Boolean));
  }
}

// Refuse to auto-stage when multiple files are modified — force explicit file
// list. Bypassed by -A/--all, which is an explicit "stage everything" opt-in.
if (!filesToStage && !includeUntracked && stagedFiles.length > 1 && !amend) {
  console.error(`Multiple modified files — specify which to include (or use -A to stage all):`);
  for (const f of stagedFiles) console.error(`  ${f}`);
  console.error(`\nUsage: tl push "${message}" file1 file2 ...`);
  process.exit(1);
}

if (dryRun) {
  out.header('Dry run — would execute:');
  if (stagedFiles.length > 0) {
    out.add(`Files (${stagedFiles.length}): ${stagedFiles.join(', ')}`);
  }
  if (filesToStage) {
    out.add(`  git add ${forceAdd ? '-f ' : ''}${filesToStage.join(' ')}`);
  } else {
    out.add(`  git add ${includeUntracked ? '-A' : '-u'}`);
  }
  if (amend) {
    out.add(`  git commit --amend ${message ? `-m "${subject}"` : '--no-edit'}`);
  } else {
    out.add(`  git commit -m "${subject}"`);
  }
  if (!noPush) out.add(`  git push origin ${branch}`);
  out.print();
  process.exit(0);
}

// Stage
let stageResult;
if (filesToStage) {
  stageResult = git(['add', ...(forceAdd ? ['-f'] : []), ...filesToStage]);
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
out.add(`${action} ${shortHash} on ${branch}${pushStr}: ${subject || '(no message change)'}`);
if (stagedFiles.length > 0) {
  out.setData('files', stagedFiles);
  out.add(`Files (${stagedFiles.length}): ${stagedFiles.join(', ')}`);
}
if (summary) out.add(summary);

out.print();
