#!/usr/bin/env node

/**
 * tl-audit - Analyze Claude Code and Codex sessions and estimate token savings.
 *
 * Parses session JSONL files, identifies patterns where tokenlean tools could have
 * reduced token usage (large file reads, verbose command output, etc.), and reports
 * estimated savings.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCommonArgs, createOutput } from '../src/output.mjs';
import { parseSession, mergeSessionMeta, providerLabel } from '../src/audit-analyze.mjs';
import { getCached, setCached } from '../src/cache.mjs';
import {
  summarizeFindings,
  summarizeSavings,
  buildAggregateResults,
  buildProviderBreakdowns,
  buildSummaryLabel,
  buildSummaryJson,
  buildSavingsJson,
  buildSessionJson,
  formatSessionHeader,
  renderSummaryBlock,
} from '../src/audit-format.mjs';
import { normalizeProvider, resolveSessionFiles } from '../src/audit-discover.mjs';

const SESSION_PARSE_CACHE_VERSION = 1;

function getSessionCacheRoot(provider) {
  if (provider === 'claude') return join(homedir(), '.claude');
  if (provider === 'codex') return join(homedir(), '.codex');
  return homedir();
}

function getSessionParseBatchCacheKey(sessionFiles, includeSavings) {
  const signature = sessionFiles
    .map((sessionFile) => ({
      provider: sessionFile.provider,
      path: sessionFile.path,
      size: sessionFile.size,
      mtime: sessionFile.mtime,
    }))
    .sort((a, b) => (
      a.path.localeCompare(b.path) ||
      a.provider.localeCompare(b.provider) ||
      (a.size - b.size) ||
      (a.mtime - b.mtime)
    ));

  return {
    op: 'tl-audit-session-parse-batch',
    version: SESSION_PARSE_CACHE_VERSION,
    sessions: signature,
    includeSavings,
  };
}

const HELP = `Usage: tl-audit [options] [session.jsonl | project-dir | session-dir]

Analyze Claude Code and Codex sessions and estimate how many tokens
could have been saved using tokenlean tools.

Arguments:
  session.jsonl         Path to a specific session JSONL file
  project-dir           Project directory to match sessions for
  session-dir           Provider session directory
  (none)                Auto-detect from current working directory

Options:
  --latest              Analyze the most recent matching session (default)
  --all                 Analyze all matching sessions
  -n <count>            Analyze the N most recent matching sessions
  --provider <name>     Session provider: auto | claude | codex (default: auto)
  --claude-code         Shortcut for --provider claude
  --claudecode          Alias for --claude-code
  --codex               Shortcut for --provider codex
  --project <dir>       Override project path used for session discovery
  --verbose             Show per-session breakdown and detailed findings
  --savings             Also show tokens saved by existing tokenlean usage
  -j, --json            JSON output
  -h, --help            Show help`;

async function mapLimit(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const args = options.remaining;

  let provider = 'auto';
  let verbose = false;
  let showSavings = false;
  let projectOverride = null;
  let count = 1;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      count = Infinity;
    } else if (arg === '--latest') {
      count = 1;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--savings') {
      showSavings = true;
    } else if (arg === '-n') {
      count = parseInt(args[++i], 10) || 1;
    } else if (arg === '--project') {
      projectOverride = args[++i];
    } else if (arg === '--provider') {
      provider = normalizeProvider(args[++i]);
    } else if (arg === '--claude-code' || arg === '--claudecode') {
      provider = 'claude';
    } else if (arg === '--codex') {
      provider = 'codex';
    } else {
      positional.push(arg);
    }
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const target = positional[0] || projectOverride || process.cwd();
  const sessionFiles = await resolveSessionFiles(target, provider, count);

  if (sessionFiles.length === 0) {
    console.error(`No matching ${provider === 'auto' ? '' : providerLabel(provider) + ' '}session files found.`);
    process.exit(1);
  }

  const shouldUseParseBatchCache = !verbose && !Number.isFinite(count);
  let parsedResults = null;
  if (shouldUseParseBatchCache) {
    const parseCacheRoot = getSessionCacheRoot(provider === 'auto' ? null : provider);
    const parseBatchCacheKey = getSessionParseBatchCacheKey(sessionFiles, showSavings);
    parsedResults = getCached(parseBatchCacheKey, parseCacheRoot, { headOnly: true });
    if (parsedResults === null) {
      const sessionConcurrency = 8;
      parsedResults = await mapLimit(sessionFiles, sessionConcurrency, async (sessionFile) => {
        const content = await readFile(sessionFile.path, 'utf8');
        const parsed = parseSession(content, sessionFile.provider, {
          includeSavings: showSavings,
        });
        return {
          file: sessionFile.path,
          provider: sessionFile.provider,
          meta: mergeSessionMeta(parsed.meta, { provider: sessionFile.provider }),
          findings: parsed.findings,
          savings: parsed.savings,
        };
      });
      setCached(parseBatchCacheKey, parsedResults, parseCacheRoot);
    }
  } else {
    const sessionConcurrency = Number.isFinite(count) ? 4 : 8;
    parsedResults = await mapLimit(sessionFiles, sessionConcurrency, async (sessionFile) => {
      const content = await readFile(sessionFile.path, 'utf8');
      const parsed = parseSession(content, sessionFile.provider, {
        includeSavings: showSavings,
      });
      return {
        file: sessionFile.path,
        provider: sessionFile.provider,
        meta: mergeSessionMeta(parsed.meta, { provider: sessionFile.provider }),
        findings: parsed.findings,
        savings: parsed.savings,
      };
    });
  }

  const allResults = parsedResults.map((result) => ({
    ...result,
    summary: summarizeFindings(result.findings),
    savingsSummary: showSavings ? summarizeSavings(result.savings) : null,
  }));

  const aggregate = buildAggregateResults(allResults, showSavings);
  const providerBreakdowns = buildProviderBreakdowns(allResults, showSavings);
  const summaryLabel = buildSummaryLabel(allResults, aggregate.providerCounts);

  if (options.json) {
    const data = {
      requestedProvider: provider,
      sessionsAnalyzed: allResults.length,
      providers: aggregate.providerCounts,
      summary: buildSummaryJson(aggregate.summary),
      byProvider: Object.fromEntries(providerBreakdowns.map(breakdown => [
        breakdown.provider,
        {
          sessionsAnalyzed: breakdown.sessionsAnalyzed,
          summary: buildSummaryJson(breakdown.summary),
          ...(breakdown.savingsSummary ? { savings: buildSavingsJson(breakdown.summary, breakdown.savingsSummary) } : {}),
        },
      ])),
      ...(aggregate.savingsSummary ? { savings: buildSavingsJson(aggregate.summary, aggregate.savingsSummary) } : {}),
      ...(verbose ? { sessions: allResults.map(result => buildSessionJson(result, true)) } : {}),
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const out = createOutput(options);
  renderSummaryBlock(out, summaryLabel, aggregate.summary, aggregate.savingsSummary, {
    showDetailLists: false,
    providerBreakdowns,
  });

  if (verbose) {
    for (const result of allResults) {
      renderSummaryBlock(out, formatSessionHeader(result), result.summary, result.savingsSummary, {
        showDetailLists: true,
        findings: result.findings,
        savings: result.savings,
      });
    }
  }

  out.print();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
