#!/usr/bin/env node

/**
 * tl-dupes - Find duplicate and near-duplicate functions across a codebase
 *
 * Scans source files, extracts function bodies, and reports clusters of
 * identical / same-shape / similar implementations — the helper functions
 * agents reinvent instead of reusing. Project-agnostic, multi-language.
 *
 * Usage: tl-dupes [path] [--near [0-1]] [--min-tokens N] [--no-names] [-j]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-dupes',
    desc: 'Find duplicate / near-duplicate functions across a codebase',
    when: 'cleanup',
    example: 'tl-dupes src/ --near'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findDuplicates } from '../src/dupes.mjs';
import { buildFunctionIndex } from '../src/walk.mjs';

const HELP = `
tl-dupes - Find duplicate and near-duplicate functions

Scans source files and clusters functions that are reinvented instead of
reused — the #1 source of drift in large/agent-written codebases.

Usage: tl-dupes [path] [options]

Tiers (most precise first):
  Exact        identical bodies (copy-paste, any name)
  Structural   same shape, different identifiers (renamed clones)
  Near         high token-similarity (lightly-edited clones) — with --near
  Names        same function name in multiple places (awareness)

Detection is lexical/structural: it catches copy-paste, renames and same-shape
clones with high precision. It does NOT find semantic duplicates (same intent,
different code) — that needs embeddings.

Options:
  --near [0-1]          Also report near-duplicates (default threshold 0.85)
  --min-tokens N        Ignore functions smaller than N tokens (default: 12)
  --no-names            Skip the repeated-names tier
  --no-structural       Skip the structural (renamed-clone) tier
  --exact-only          Only report identical bodies
  --tests               Include test/spec files (excluded by default)
  --include-contracts   Include external-contract files (excluded by default)
  --strict              Exit 1 if any duplicates are found (for CI)
  --full                Show all groups (default caps each tier)
${COMMON_OPTIONS_HELP}

Examples:
  tl-dupes                     # Scan the whole project
  tl-dupes src/                # Scan a directory
  tl-dupes --near              # Include near-duplicates
  tl-dupes --exact-only -q     # Just the copy-paste, terse
  tl-dupes --strict            # Fail CI on duplication
`;

const rawArgs = process.argv.slice(2);
const options = parseCommonArgs(rawArgs);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

// ── Parse flags ──
let targetPath = '.';
let near = 0;
let minTokens = 12;
let includeNames = true;
let includeStructural = true;
let exactOnly = false;
let includeTests = false;
let includeContracts = false;
let strict = false;
let full = false;

const rem = options.remaining;
for (let i = 0; i < rem.length; i++) {
  const arg = rem[i];
  if (arg === '--near') {
    const nextVal = parseFloat(rem[i + 1]);
    if (Number.isFinite(nextVal) && nextVal > 0 && nextVal <= 1) { near = nextVal; i++; }
    else near = 0.85;
  }
  else if (arg === '--min-tokens') {
    minTokens = parseInt(rem[++i], 10);
    if (!Number.isInteger(minTokens) || minTokens < 0) {
      console.error('Error: --min-tokens requires a non-negative integer');
      process.exit(2);
    }
  }
  else if (arg === '--no-names') includeNames = false;
  else if (arg === '--no-structural') includeStructural = false;
  else if (arg === '--exact-only') exactOnly = true;
  else if (arg === '--tests') includeTests = true;
  else if (arg === '--include-contracts') includeContracts = true;
  else if (arg === '--strict') strict = true;
  else if (arg === '--full') full = true;
  else if (!arg.startsWith('-')) targetPath = arg;
  else { console.error(`Error: unknown argument: ${arg}`); process.exit(2); }
}

if (exactOnly) { includeNames = false; includeStructural = false; near = 0; }

// ── Gather + index functions ──
const { functions, fileCount, exists } = buildFunctionIndex(targetPath, { includeTests, includeContracts });
if (!exists) { console.error(`Error: path not found: ${targetPath}`); process.exit(1); }
if (fileCount === 0) { console.error('No source files found to scan.'); process.exit(1); }

const result = findDuplicates(functions, {
  minTokens,
  names: includeNames,
  structural: includeStructural,
  near,
});

// ── Render ──
const out = createOutput(options);
const CAP = full ? Infinity : 25;

const totalDupes = result.exact.length + result.structural.length + result.near.length;

out.header(`tl-dupes — ${fileCount} files, ${result.total} functions (${result.scanned} non-trivial ≥${minTokens} tok)`);
out.blank();

function renderGroups(title, groups, lineFor) {
  if (!groups || groups.length === 0) return;
  out.header(`${title} (${groups.length}):`);
  for (const g of groups.slice(0, CAP)) {
    out.add(lineFor(g));
    for (const m of g.members.slice(0, full ? Infinity : 8)) {
      out.add(`      ${m.file}:${m.line} ${m.name}`);
    }
    if (!full && g.members.length > 8) out.add(`      … +${g.members.length - 8} more`);
  }
  if (groups.length > CAP) out.add(`  … ${groups.length - CAP} more group(s); rerun with --full`);
  out.blank();
}

renderGroups('Exact duplicates', result.exact,
  g => `  ×${g.count}  ~${g.tokens} tok  [${[...new Set(g.members.map(m => m.name))].join(', ')}]`);

renderGroups('Structural duplicates (same shape, renamed)', result.structural,
  g => `  ×${g.count}  ~${g.tokens} tok  [${[...new Set(g.members.map(m => m.name))].join(', ')}]`);

if (near > 0) {
  renderGroups(`Near duplicates (≥${near} similarity)`, result.near,
    g => `  ${Math.round(g.similarity * 100)}%  ~${g.tokens} tok`);
}

if (includeNames && result.names.length > 0) {
  out.header(`Repeated names (${result.names.length}):`);
  for (const g of result.names.slice(0, CAP)) {
    const flag = g.distinctImpls > 1 ? `${g.distinctImpls} distinct impls` : 'identical';
    out.add(`  ${g.name} ×${g.count}  (${flag})`);
    for (const m of g.members.slice(0, full ? Infinity : 6)) out.add(`      ${m.file}:${m.line}`);
    if (!full && g.members.length > 6) out.add(`      … +${g.members.length - 6} more`);
  }
  if (result.names.length > CAP) out.add(`  … ${result.names.length - CAP} more; rerun with --full`);
  out.blank();
}

const parts = [`${result.exact.length} exact`];
if (includeStructural) parts.push(`${result.structural.length} structural`);
if (near > 0) parts.push(`${result.near.length} near`);
if (includeNames) parts.push(`${result.names.length} repeated-name`);
out.stats(parts.join(', '));

// JSON data
out.setData('files', fileCount);
out.setData('functions', result.total);
out.setData('exact', result.exact);
if (includeStructural) out.setData('structural', result.structural);
if (near > 0) out.setData('near', result.near);
if (includeNames) out.setData('names', result.names);

out.print();

process.exit(strict && totalDupes > 0 ? 1 : 0);
