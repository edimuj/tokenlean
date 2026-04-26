/**
 * Summarization, formatting, and output rendering for tl-audit.
 *
 * Takes parsed analysis results and produces text or JSON output.
 */

import { basename } from 'node:path';
import { formatTokens } from './output.mjs';
import { providerLabel } from './audit-analyze.mjs';

// ─────────────────────────────────────────────────────────────
// Summarization
// ─────────────────────────────────────────────────────────────

export function summarizeFindings(findings) {
  const byCategory = {};
  let totalActual = 0;
  let totalSaved = 0;

  for (const finding of findings) {
    if (!byCategory[finding.category]) {
      byCategory[finding.category] = {
        count: 0,
        actualTokens: 0,
        savedTokens: 0,
        suggestion: finding.suggestion,
      };
    }

    byCategory[finding.category].count++;
    byCategory[finding.category].actualTokens += finding.actualTokens;
    byCategory[finding.category].savedTokens += finding.savedTokens;
    totalActual += finding.actualTokens;
    totalSaved += finding.savedTokens;
  }

  return { byCategory, totalActual, totalSaved, totalFindings: findings.length };
}

export function summarizeSavings(savings) {
  const byTool = {};
  let totalActual = 0;
  let totalSaved = 0;

  for (const saving of savings) {
    if (!byTool[saving.tool]) {
      byTool[saving.tool] = {
        count: 0,
        actualTokens: 0,
        rawEstimate: 0,
        savedTokens: 0,
      };
    }

    byTool[saving.tool].count++;
    byTool[saving.tool].actualTokens += saving.actualTokens;
    byTool[saving.tool].rawEstimate += saving.rawEstimate;
    byTool[saving.tool].savedTokens += saving.savedTokens;
    totalActual += saving.actualTokens;
    totalSaved += saving.savedTokens;
  }

  return { byTool, totalActual, totalSaved, totalUses: savings.length };
}

export function summarizeProviders(results) {
  const counts = {};
  for (const result of results) {
    const provider = result.meta?.provider || result.provider || 'unknown';
    counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

export function buildAggregateResults(results, showSavings) {
  const findings = results.flatMap(result => result.findings);
  const savings = showSavings ? results.flatMap(result => result.savings) : [];
  return {
    summary: summarizeFindings(findings),
    savingsSummary: showSavings ? summarizeSavings(savings) : null,
    providerCounts: summarizeProviders(results),
    findings,
    savings,
  };
}

export function buildProviderBreakdowns(results, showSavings) {
  const groups = new Map();
  for (const result of results) {
    const provider = result.meta?.provider || result.provider || 'unknown';
    if (!groups.has(provider)) {
      groups.set(provider, []);
    }
    groups.get(provider).push(result);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, providerResults]) => ({
      provider,
      sessionsAnalyzed: providerResults.length,
      ...buildAggregateResults(providerResults, showSavings),
    }));
}

// ─────────────────────────────────────────────────────────────
// Plan building
// ─────────────────────────────────────────────────────────────

const CATEGORY_PLANS = {
  'read-large-file': {
    title: 'Stop full-file reads first',
    command: 'tl advise "understand <file>" && tl symbols <file> && tl snippet <symbol> <file>',
    why: 'Large code reads are usually better handled as signatures first, then one focused implementation.',
  },
  'cat-large-file': {
    title: 'Replace large cat/head reads on code files',
    command: 'tl symbols <file> && tl snippet <symbol> <file>',
    why: 'Shell file dumps bypass agent-native limits and usually pull more code than needed.',
  },
  'build-test-output': {
    title: 'Route build and test commands through tl-run',
    command: 'tl run "<test-or-build-command>"',
    why: 'Test/build logs are high-volume and tl-run keeps failures, summaries, and useful stderr.',
  },
  'tail-command': {
    title: 'Use tl-tail for logs',
    command: 'tl tail <log-file>',
    why: 'tl-tail deduplicates repeated lines and surfaces error/warn clusters.',
  },
  'curl-command': {
    title: 'Use tl-browse for read-only web fetches',
    command: 'tl browse <url>',
    why: 'tl-browse returns clean markdown and strips page boilerplate.',
  },
  webfetch: {
    title: 'Prefer tl-browse for documentation pages',
    command: 'tl browse <url>',
    why: 'Clean markdown usually costs less context than raw fetched page content.',
  },
  'head-command': {
    title: 'Prefer bounded reads over shell head',
    command: 'Read with offset/limit, or tl context <path> before reading',
    why: 'Agent-native bounded reads preserve file context better than shell snippets.',
  },
};

export function buildPlan(summary, savingsSummary = null, options = {}) {
  const maxItems = options.maxItems || 5;
  const categories = Object.entries(summary.byCategory)
    .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

  const items = [];
  for (const [category, data] of categories) {
    const template = CATEGORY_PLANS[category] || {
      title: `Reduce ${category}`,
      command: data.suggestion,
      why: 'This category has measurable repeated saveable output.',
    };

    items.push({
      category,
      title: template.title,
      command: template.command,
      why: template.why,
      count: data.count,
      actualTokens: data.actualTokens,
      saveableTokens: data.savedTokens,
      savingsPercent: data.actualTokens > 0 ? Math.round((data.savedTokens / data.actualTokens) * 100) : 0,
    });
  }

  const captureRate = savingsSummary ? getCaptureRate(summary, savingsSummary) : 0;
  const totalPotential = summary.totalSaved + (savingsSummary?.totalSaved || 0);

  if (summary.totalSaved > 0 && captureRate < 80) {
    items.push({
      category: 'agent-setup',
      title: 'Install or tighten tokenlean agent nudges',
      command: 'tl hook install claude-code && tl prompt --codex >> AGENTS.md',
      why: 'The audit still sees avoidable raw tool usage; hooks and project instructions prevent repeated waste.',
      count: 1,
      actualTokens: totalPotential,
      saveableTokens: summary.totalSaved,
      savingsPercent: totalPotential > 0 ? Math.round((summary.totalSaved / totalPotential) * 100) : 0,
    });
  }

  if (summary.totalSaved > 0) {
    items.push({
      category: 'workflow-routing',
      title: 'Start common tasks with packs and advice',
      command: 'tl advise "<task>" or tl pack <onboard|review|refactor|debug>',
      why: 'Routing the first step avoids the expensive mistake of broad reads or raw command output.',
      count: 1,
      actualTokens: summary.totalActual,
      saveableTokens: Math.round(summary.totalSaved * 0.25),
      savingsPercent: 25,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.category;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => b.saveableTokens - a.saveableTokens);

  return {
    totalSaveableTokens: summary.totalSaved,
    captureRate,
    items: deduped.slice(0, maxItems),
  };
}

// ─────────────────────────────────────────────────────────────
// Label / header helpers
// ─────────────────────────────────────────────────────────────

export function getSavingsPercent(summary) {
  return summary.totalActual > 0
    ? Math.round((summary.totalSaved / summary.totalActual) * 100)
    : 0;
}

export function getCaptureRate(summary, savingsSummary) {
  if (!summary || !savingsSummary) return 0;
  const total = summary.totalSaved + savingsSummary.totalSaved;
  if (total <= 0) return 0;
  return Math.round((savingsSummary.totalSaved / total) * 100);
}

export function formatProviderCounts(providerCounts) {
  return Object.entries(providerCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, count]) => `${count} ${providerLabel(provider)}`)
    .join(', ');
}

export function buildSummaryLabel(results, providerCounts) {
  const sessions = `${results.length} session${results.length === 1 ? '' : 's'}`;
  const providers = formatProviderCounts(providerCounts);
  return providers ? `Summary (${sessions}: ${providers})` : `Summary (${sessions})`;
}

export function sessionLabel(result) {
  return result.meta?.slug
    || result.meta?.sessionId
    || basename(result.file, '.jsonl');
}

export function formatSessionHeader(result) {
  const label = sessionLabel(result);
  const provider = providerLabel(result.meta?.provider || result.provider);
  const date = result.meta?.timestamp
    ? new Date(result.meta.timestamp).toLocaleDateString('en-US')
    : '';
  return `Session: ${label} [${provider}]${date ? ` (${date})` : ''}`;
}

// ─────────────────────────────────────────────────────────────
// Text rendering
// ─────────────────────────────────────────────────────────────

export function renderSummaryBlock(out, label, summary, savingsSummary, options = {}) {
  const {
    showDetailLists = false,
    findings = [],
    savings = [],
    providerBreakdowns = [],
  } = options;

  const hasWaste = summary.totalFindings > 0;
  const hasSavings = savingsSummary && savingsSummary.totalUses > 0;

  out.header(label);

  if (!hasWaste && !hasSavings) {
    out.add('  No significant findings.');
    out.blank();
    return;
  }

  if (hasWaste) {
    const categories = Object.entries(summary.byCategory)
      .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

    if (hasSavings) out.add('  Opportunities:');
    out.add('  Category                Count  Actual     Saveable   Suggestion');
    out.add('  ' + '-'.repeat(76));
    for (const [category, data] of categories) {
      out.add(`  ${category.padEnd(22)} ${(data.count + 'x').padStart(5)}  ${formatTokens(data.actualTokens).padStart(8)}  ${formatTokens(data.savedTokens).padStart(10)}   -> ${data.suggestion}`);
    }
    out.blank();
    out.add(`  Still saveable:     ${formatTokens(summary.totalSaved)} of ${formatTokens(summary.totalActual)} (${getSavingsPercent(summary)}%)`);
    out.blank();

    if (showDetailLists) {
      out.add('  Findings:');
      const sorted = [...findings].sort((a, b) => b.savedTokens - a.savedTokens);
      for (const finding of sorted.slice(0, 20)) {
        const detailLabel = finding.file || finding.command || '';
        out.add(`    [${formatTokens(finding.savedTokens).trim()} saveable] ${detailLabel}`);
        out.add(`      ${finding.detail}`);
      }
      if (sorted.length > 20) {
        out.add(`    ... and ${sorted.length - 20} more`);
      }
      out.blank();
    }
  }

  if (providerBreakdowns.length > 1) {
    out.add('  By provider:');
    for (const breakdown of providerBreakdowns) {
      let line = `  ${providerLabel(breakdown.provider).padEnd(12)} ${String(breakdown.sessionsAnalyzed).padStart(3)} session${breakdown.sessionsAnalyzed === 1 ? ' ' : 's'}  ${formatTokens(breakdown.summary.totalSaved).padStart(8)} saveable`;
      if (breakdown.savingsSummary) {
        line += `  ${formatTokens(breakdown.savingsSummary.totalSaved).padStart(8)} saved`;
      }
      out.add(line);
    }
    out.blank();
  }

  if (hasSavings) {
    out.add('  Already saved by tokenlean:');
    const tools = Object.entries(savingsSummary.byTool)
      .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

    out.add('  Tool              Count  Compressed   Raw estimate   Saved');
    out.add('  ' + '-'.repeat(66));
    for (const [tool, data] of tools) {
      out.add(`  ${tool.padEnd(18)} ${(data.count + 'x').padStart(5)}  ${formatTokens(data.actualTokens).padStart(10)}  ${formatTokens(data.rawEstimate).padStart(14)}   ${formatTokens(data.savedTokens)}`);
    }
    out.blank();
    out.add(`  Tokens saved:       ${formatTokens(savingsSummary.totalSaved)} (${savingsSummary.totalUses} uses)`);

    const captureRate = getCaptureRate(summary, savingsSummary);
    if (captureRate > 0 && summary.totalSaved > 0) {
      out.add(`  Capture rate:       ${captureRate}% of potential savings realized`);
    }
    out.blank();

    if (showDetailLists) {
      out.add('  Savings detail:');
      const sorted = [...savings].sort((a, b) => b.savedTokens - a.savedTokens);
      for (const saving of sorted.slice(0, 20)) {
        out.add(`    [${formatTokens(saving.savedTokens).trim()} saved] ${saving.command}`);
      }
      if (sorted.length > 20) {
        out.add(`    ... and ${sorted.length - 20} more`);
      }
      out.blank();
    }
  }
}

export function renderPlanBlock(out, plan) {
  out.add('Plan:');

  if (!plan || plan.items.length === 0 || plan.totalSaveableTokens <= 0) {
    out.add('  No high-impact actions found. Current sessions already look token-conscious.');
    out.blank();
    return;
  }

  out.add(`  Top actions to reduce future context waste (${formatTokens(plan.totalSaveableTokens)} still saveable):`);
  if (plan.captureRate > 0) {
    out.add(`  Current capture rate: ${plan.captureRate}%`);
  }
  out.blank();

  plan.items.forEach((item, index) => {
    out.add(`  ${index + 1}. ${item.title}`);
    out.add(`     Impact: ${item.count}x, ${formatTokens(item.saveableTokens)} saveable (${item.savingsPercent}%)`);
    out.add(`     Run: ${item.command}`);
    out.add(`     Why: ${item.why}`);
  });
  out.blank();
}

// ─────────────────────────────────────────────────────────────
// JSON output builders
// ─────────────────────────────────────────────────────────────

export function buildSummaryJson(summary) {
  return {
    totalFindings: summary.totalFindings,
    totalActualTokens: summary.totalActual,
    totalSavedTokens: summary.totalSaved,
    savingsPercent: getSavingsPercent(summary),
    categories: summary.byCategory,
  };
}

export function buildSavingsJson(summary, savingsSummary) {
  return {
    totalUses: savingsSummary.totalUses,
    compressedTokens: savingsSummary.totalActual,
    rawEstimateTokens: savingsSummary.totalActual + savingsSummary.totalSaved,
    totalSavedTokens: savingsSummary.totalSaved,
    captureRate: getCaptureRate(summary, savingsSummary),
    byTool: savingsSummary.byTool,
  };
}

export function buildPlanJson(plan) {
  return {
    totalSaveableTokens: plan.totalSaveableTokens,
    captureRate: plan.captureRate,
    items: plan.items,
  };
}

export function buildSessionJson(result, verbose) {
  return {
    provider: result.meta?.provider || result.provider,
    session: sessionLabel(result),
    timestamp: result.meta?.timestamp || null,
    cwd: result.meta?.cwd || null,
    summary: buildSummaryJson(result.summary),
    ...(result.savingsSummary ? { savings: buildSavingsJson(result.summary, result.savingsSummary) } : {}),
    ...(verbose ? {
      findings: result.findings,
      ...(result.savingsSummary ? { savingsDetail: result.savings } : {}),
    } : {}),
  };
}
