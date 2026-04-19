#!/usr/bin/env node

/**
 * tl-commit-prep - Pre-commit context in one call
 *
 * Outputs status, diff stat, and recent log — everything an agent needs
 * to compose a commit message, in a single tool call.
 *
 * Usage: tl-commit-prep [--full] [-j] [-q]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-commit-prep',
    desc: 'Pre-commit context: status + diff stat + recent log',
    when: 'before-commit',
    example: 'tl-commit-prep'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { gitCommand } from '../src/shell.mjs';

const HELP = `
tl-commit-prep - Pre-commit context in one call

Outputs status, diff stat, and recent log so an agent can compose
a commit message without multiple git calls.

Usage: tl-commit-prep [options]

Options:
  --full                Include full diff (not just stat)
  --staged              Show only staged changes
${COMMON_OPTIONS_HELP}

Examples:
  tl-commit-prep                # Status + diff stat + log
  tl-commit-prep --full         # Include full diff content
  tl-commit-prep -j             # JSON output
`;

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let full = false;
let staged = false;
for (const arg of options.remaining) {
  if (arg === '--full') full = true;
  else if (arg === '--staged') staged = true;
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const status = gitCommand(['status', '--short']);
const branch = gitCommand(['branch', '--show-current']);
const log = gitCommand(['log', '--oneline', '-5']);

const diffArgs = ['diff', '--stat=200'];
if (staged) diffArgs.splice(1, 0, '--cached');
const diffStat = gitCommand(diffArgs);

let diffFull = null;
if (full) {
  const fullArgs = ['diff'];
  if (staged) fullArgs.push('--cached');
  diffFull = gitCommand(fullArgs);
}

const stagedDiffStat = staged ? diffStat : gitCommand(['diff', '--cached', '--stat=200']);
const stagedFiles = gitCommand(['diff', '--cached', '--name-only']);

const out = createOutput(options);

out.setData('branch', branch);
out.setData('status', status);
out.setData('stagedFiles', stagedFiles ? stagedFiles.split('\n') : []);
out.setData('diffStat', diffStat);
out.setData('recentLog', log);
if (diffFull) out.setData('diff', diffFull);

out.header(`Branch: ${branch || '(detached)'}`);
out.blank();

if (status) {
  out.add('Status:');
  for (const line of status.split('\n')) {
    out.add(`  ${line}`);
  }
  out.blank();
} else {
  out.add('Status: clean (nothing to commit)');
  out.print();
  process.exit(0);
}

if (stagedDiffStat) {
  out.add('Staged changes:');
  for (const line of stagedDiffStat.split('\n')) {
    out.add(`  ${line}`);
  }
  out.blank();
} else if (!staged) {
  out.add('Staged: (nothing staged)');
  out.blank();
}

if (!staged && diffStat) {
  out.add('Unstaged changes:');
  for (const line of diffStat.split('\n')) {
    out.add(`  ${line}`);
  }
  out.blank();
}

if (log) {
  out.add('Recent commits:');
  for (const line of log.split('\n')) {
    out.add(`  ${line}`);
  }
}

if (diffFull) {
  out.blank();
  out.add('Full diff:');
  for (const line of diffFull.split('\n')) {
    out.add(line);
  }
}

out.print();
