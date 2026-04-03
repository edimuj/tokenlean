import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeFindings,
  summarizeSavings,
  summarizeProviders,
  buildAggregateResults,
  buildProviderBreakdowns,
  getSavingsPercent,
  getCaptureRate,
  formatProviderCounts,
  buildSummaryLabel,
  sessionLabel,
  formatSessionHeader,
  buildSummaryJson,
  buildSavingsJson,
  buildSessionJson,
} from './audit-format.mjs';

const FINDINGS = [
  { category: 'build-test-output', suggestion: 'tl-run', actualTokens: 1000, savedTokens: 650 },
  { category: 'build-test-output', suggestion: 'tl-run', actualTokens: 500, savedTokens: 325 },
  { category: 'read-large-file', suggestion: 'tl-symbols', actualTokens: 800, savedTokens: 640 },
];

const SAVINGS = [
  { tool: 'tl-run', actualTokens: 200, rawEstimate: 571, savedTokens: 371 },
  { tool: 'tl-symbols', actualTokens: 100, rawEstimate: 500, savedTokens: 400 },
];

describe('summarizeFindings', () => {
  it('groups findings by category', () => {
    const summary = summarizeFindings(FINDINGS);
    assert.equal(Object.keys(summary.byCategory).length, 2);
    assert.equal(summary.byCategory['build-test-output'].count, 2);
    assert.equal(summary.byCategory['read-large-file'].count, 1);
  });

  it('sums totals correctly', () => {
    const summary = summarizeFindings(FINDINGS);
    assert.equal(summary.totalActual, 2300);
    assert.equal(summary.totalSaved, 1615);
    assert.equal(summary.totalFindings, 3);
  });

  it('handles empty findings', () => {
    const summary = summarizeFindings([]);
    assert.equal(summary.totalFindings, 0);
    assert.equal(summary.totalActual, 0);
  });
});

describe('summarizeSavings', () => {
  it('groups savings by tool', () => {
    const summary = summarizeSavings(SAVINGS);
    assert.equal(Object.keys(summary.byTool).length, 2);
    assert.equal(summary.byTool['tl-run'].count, 1);
  });

  it('sums totals correctly', () => {
    const summary = summarizeSavings(SAVINGS);
    assert.equal(summary.totalSaved, 771);
    assert.equal(summary.totalUses, 2);
  });
});

describe('summarizeProviders', () => {
  it('counts providers', () => {
    const results = [
      { meta: { provider: 'claude' } },
      { meta: { provider: 'claude' } },
      { meta: { provider: 'codex' } },
    ];
    const counts = summarizeProviders(results);
    assert.equal(counts.claude, 2);
    assert.equal(counts.codex, 1);
  });
});

describe('getSavingsPercent', () => {
  it('calculates percentage', () => {
    assert.equal(getSavingsPercent({ totalActual: 1000, totalSaved: 650 }), 65);
  });

  it('returns 0 when totalActual is 0', () => {
    assert.equal(getSavingsPercent({ totalActual: 0, totalSaved: 0 }), 0);
  });
});

describe('getCaptureRate', () => {
  it('calculates rate', () => {
    const summary = { totalSaved: 500 };
    const savingsSummary = { totalSaved: 500 };
    assert.equal(getCaptureRate(summary, savingsSummary), 50);
  });

  it('returns 0 when null', () => {
    assert.equal(getCaptureRate(null, null), 0);
  });

  it('returns 0 when no total', () => {
    assert.equal(getCaptureRate({ totalSaved: 0 }, { totalSaved: 0 }), 0);
  });
});

describe('formatProviderCounts', () => {
  it('formats provider counts', () => {
    const result = formatProviderCounts({ claude: 3, codex: 1 });
    assert.ok(result.includes('3 Claude Code'));
    assert.ok(result.includes('1 Codex'));
  });
});

describe('buildSummaryLabel', () => {
  it('formats with providers', () => {
    const label = buildSummaryLabel([1, 2, 3], { claude: 3 });
    assert.ok(label.includes('3 sessions'));
    assert.ok(label.includes('Claude Code'));
  });

  it('singular session', () => {
    const label = buildSummaryLabel([1], { claude: 1 });
    assert.ok(label.includes('1 session'));
  });
});

describe('sessionLabel', () => {
  it('prefers slug', () => {
    assert.equal(sessionLabel({ meta: { slug: 'my-run' }, file: 'x.jsonl' }), 'my-run');
  });

  it('falls back to sessionId', () => {
    assert.equal(sessionLabel({ meta: { sessionId: 'abc' }, file: 'x.jsonl' }), 'abc');
  });

  it('falls back to filename', () => {
    assert.equal(sessionLabel({ meta: {}, file: '/path/to/session.jsonl' }), 'session');
  });
});

describe('formatSessionHeader', () => {
  it('includes provider and date', () => {
    const result = formatSessionHeader({
      meta: { slug: 'run-1', provider: 'claude', timestamp: '2026-01-15T12:00:00Z' },
    });
    assert.ok(result.includes('run-1'));
    assert.ok(result.includes('Claude Code'));
    assert.ok(result.includes('1/15/2026'));
  });
});

describe('buildSummaryJson', () => {
  it('builds correct shape', () => {
    const summary = summarizeFindings(FINDINGS);
    const json = buildSummaryJson(summary);
    assert.equal(json.totalFindings, 3);
    assert.equal(json.totalActualTokens, 2300);
    assert.equal(json.totalSavedTokens, 1615);
    assert.ok(json.savingsPercent > 0);
    assert.ok('categories' in json);
  });
});

describe('buildSavingsJson', () => {
  it('builds correct shape', () => {
    const summary = summarizeFindings(FINDINGS);
    const savingsSummary = summarizeSavings(SAVINGS);
    const json = buildSavingsJson(summary, savingsSummary);
    assert.equal(json.totalUses, 2);
    assert.ok(json.totalSavedTokens > 0);
    assert.ok('byTool' in json);
    assert.ok('captureRate' in json);
  });
});

describe('buildSessionJson', () => {
  it('builds session shape', () => {
    const result = {
      meta: { provider: 'claude', slug: 'test', timestamp: '2026-01-01', cwd: '/proj' },
      provider: 'claude',
      file: 'test.jsonl',
      summary: summarizeFindings(FINDINGS),
      savingsSummary: null,
      findings: FINDINGS,
      savings: SAVINGS,
    };
    const json = buildSessionJson(result, false);
    assert.equal(json.provider, 'claude');
    assert.equal(json.session, 'test');
    assert.ok('summary' in json);
    assert.ok(!('findings' in json), 'non-verbose should not include findings');
  });

  it('includes findings when verbose', () => {
    const result = {
      meta: { provider: 'claude', slug: 'test' },
      file: 'test.jsonl',
      summary: summarizeFindings([]),
      savingsSummary: null,
      findings: FINDINGS,
      savings: [],
    };
    const json = buildSessionJson(result, true);
    assert.ok('findings' in json);
    assert.equal(json.findings.length, 3);
  });
});

describe('buildAggregateResults', () => {
  it('aggregates multiple results', () => {
    const results = [
      { findings: FINDINGS.slice(0, 2), savings: SAVINGS.slice(0, 1), meta: { provider: 'claude' } },
      { findings: FINDINGS.slice(2), savings: SAVINGS.slice(1), meta: { provider: 'codex' } },
    ];
    const agg = buildAggregateResults(results, true);
    assert.equal(agg.findings.length, 3);
    assert.equal(agg.savings.length, 2);
    assert.equal(agg.providerCounts.claude, 1);
    assert.equal(agg.providerCounts.codex, 1);
  });
});

describe('buildProviderBreakdowns', () => {
  it('groups by provider', () => {
    const results = [
      { findings: FINDINGS.slice(0, 1), savings: [], meta: { provider: 'claude' } },
      { findings: FINDINGS.slice(1, 2), savings: [], meta: { provider: 'claude' } },
      { findings: FINDINGS.slice(2), savings: [], meta: { provider: 'codex' } },
    ];
    const breakdowns = buildProviderBreakdowns(results, false);
    assert.equal(breakdowns.length, 2);
    const claude = breakdowns.find(b => b.provider === 'claude');
    assert.equal(claude.sessionsAnalyzed, 2);
  });
});
