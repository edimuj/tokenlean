import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, calculateStats, analyzeRuntimeProfile } from './perf-bench.mjs';

describe('percentile', () => {
  it('returns null for empty input', () => {
    assert.equal(percentile([], 50), null);
  });

  it('calculates p50 correctly for odd sample count', () => {
    assert.equal(percentile([10, 20, 30], 50), 20);
  });

  it('interpolates percentile for even sample count', () => {
    assert.equal(percentile([10, 20, 30, 40], 75), 32.5);
  });
});

describe('calculateStats', () => {
  it('returns expected stats for fixed samples', () => {
    const stats = calculateStats([100, 200, 300, 400]);
    assert.equal(stats.count, 4);
    assert.equal(stats.min, 100);
    assert.equal(stats.max, 400);
    assert.equal(stats.mean, 250);
    assert.equal(stats.p50, 250);
    assert.equal(stats.p95, 385);
    assert.ok(stats.stdev > 111 && stats.stdev < 112);
  });
});

describe('analyzeRuntimeProfile', () => {
  it('recommends workload-first optimization when startup share is small', () => {
    const result = analyzeRuntimeProfile([
      { id: 'node_startup_baseline', stats: { p50: 20 } },
      { id: 'tl-impact', stats: { p50: 500 } },
      { id: 'tl-related', stats: { p50: 420 } }
    ]);

    assert.ok(result.startupShare < 0.15);
    assert.match(result.recommendation, /Prioritize algorithm, I\/O, subprocess, and caching optimizations/);
  });

  it('recommends startup-focused optimization when startup share is high', () => {
    const result = analyzeRuntimeProfile([
      { id: 'node_startup_baseline', stats: { p50: 180 } },
      { id: 'tl-symbols', stats: { p50: 400 } }
    ]);

    assert.ok(result.startupShare >= 0.30);
    assert.match(result.recommendation, /Process startup is a large share/);
  });
});
