#!/usr/bin/env node

/**
 * tl-lookup - Find existing functions by name or intent before writing one
 *
 * The prevention half of tl-dupes: search the codebase for a function that
 * already does what you're about to write, and reuse it instead of creating
 * the 14th getId(). Ranking is lexical (name + signature + body), no embeddings.
 *
 * Usage: tl-lookup "<name or intent>" [path] [--limit N] [-j]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-lookup',
    desc: 'Find an existing function by name/intent before writing a new one',
    when: 'before-writing-helper',
    example: 'tl-lookup "format elapsed time"'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { buildFunctionIndex } from '../src/walk.mjs';
import { searchFunctions } from '../src/lookup.mjs';

const HELP = `
tl-lookup - Find existing functions before writing a new one

Searches the codebase for a function matching a name or intent, so you reuse
what exists instead of reinventing it (the cause of duplicate helpers).
Run this BEFORE writing a new utility/helper function.

Usage: tl-lookup "<name or intent>" [path] [options]

The query may be a function name (getUserId) or a phrase describing intent
("get user id from session"). Matching is lexical: function name words first,
then signature and body keywords. It does NOT do semantic search.

Options:
  --limit N, -l N       Max results (default: 15)
  --min-score S         Minimum relevance 0-1 (default: 0.3)
  --tests               Include test/spec files (excluded by default)
${COMMON_OPTIONS_HELP}

Examples:
  tl-lookup getId                      # Anything named like getId
  tl-lookup "strip ansi codes"         # By intent
  tl-lookup formatElapsed src/         # Scoped to a directory
  tl-lookup parseConfig -j             # JSON for tooling
`;

const rawArgs = process.argv.slice(2);
const options = parseCommonArgs(rawArgs);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

// ── Parse args ──
let query = null;
let targetPath = '.';
let minScore = 0.3;
let includeTests = false;

const rem = options.remaining;
for (let i = 0; i < rem.length; i++) {
  const arg = rem[i];
  if (arg === '--min-score') {
    minScore = parseFloat(rem[++i]);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      console.error('Error: --min-score requires a number between 0 and 1');
      process.exit(2);
    }
  }
  else if (arg === '--tests') includeTests = true;
  else if (!arg.startsWith('-')) {
    if (query === null) query = arg;
    else targetPath = arg;
  }
  else { console.error(`Error: unknown argument: ${arg}`); process.exit(2); }
}

if (!query) {
  console.error('Error: a search query is required');
  console.error('Usage: tl-lookup "<name or intent>" [path]');
  process.exit(2);
}

// ── Build index + search ──
const { functions, fileCount, exists } = buildFunctionIndex(targetPath, { includeTests });
if (!exists) { console.error(`Error: path not found: ${targetPath}`); process.exit(1); }

const limit = Number.isFinite(options.maxLines) ? options.maxLines : 15;
const matches = searchFunctions(functions, query, { limit, minScore });

// ── Render ──
const out = createOutput({ ...options, maxLines: Infinity });

if (matches.length === 0) {
  out.header(`No existing function matches "${query}" (${functions.length} scanned in ${fileCount} files)`);
  out.add('Looks safe to write a new one.');
  out.setData('query', query);
  out.setData('matches', []);
  out.print();
  process.exit(0);
}

out.header(`${matches.length} existing match(es) for "${query}" — reuse before writing a new one:`);
out.blank();
for (const m of matches) {
  const pct = Math.round(m.score * 100);
  out.add(`  [${pct}%] ${m.file}:${m.line}  (~${m.tokens} tok)`);
  out.add(`        ${m.signature}`);
}

out.setData('query', query);
out.setData('scanned', functions.length);
out.setData('matches', matches);

out.print();
