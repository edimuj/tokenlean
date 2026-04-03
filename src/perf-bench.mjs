export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (p <= 0) return values[0];
  if (p >= 100) return values[values.length - 1];

  const rank = (p / 100) * (values.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) return values[lower];

  const weight = rank - lower;
  return values[lower] * (1 - weight) + values[upper] * weight;
}

export function calculateStats(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0];
  const max = sorted[count - 1];
  const mean = sorted.reduce((acc, value) => acc + value, 0) / count;
  const variance = sorted.reduce((acc, value) => {
    const delta = value - mean;
    return acc + delta * delta;
  }, 0) / count;

  return {
    count,
    min,
    max,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    stdev: Math.sqrt(variance)
  };
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

export function formatMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(1)}ms`;
}

export function analyzeRuntimeProfile(commandResults) {
  const baseline = commandResults.find(result => result.id === 'node_startup_baseline');
  const workloads = commandResults.filter(result => result.id !== 'node_startup_baseline' && result.stats !== null);

  if (!baseline || !baseline.stats || workloads.length === 0) {
    return {
      recommendation: 'Add a `node_startup_baseline` command and at least one workload command for runtime attribution.',
      startupShare: null,
      medianWorkloadP50: null
    };
  }

  const medianWorkloadP50 = median(workloads.map(result => result.stats.p50));
  const startupShare = medianWorkloadP50 > 0 ? baseline.stats.p50 / medianWorkloadP50 : null;

  let recommendation;
  if (startupShare === null) {
    recommendation = 'Could not compute startup share from collected data.';
  } else if (startupShare >= 0.30) {
    recommendation = 'Process startup is a large share of command latency. TS migration improves safety, but runtime speed gains need startup-focused changes (single binary, long-lived daemon, or native rewrite).';
  } else if (startupShare <= 0.15 && medianWorkloadP50 >= 250) {
    recommendation = 'Startup overhead is small vs workload time. Prioritize algorithm, I/O, subprocess, and caching optimizations before considering Rust rewrite.';
  } else {
    recommendation = 'Mixed profile: get command-level profiling for the slowest 2-3 tools before deciding between deeper Node optimizations and native rewrite.';
  }

  return {
    recommendation,
    startupShare,
    medianWorkloadP50
  };
}

export function renderSummaryTable(commandResults) {
  const headers = ['command', 'p50', 'p95', 'mean', 'stdev', 'failures'];
  const rows = commandResults.map(result => {
    const stats = result.stats;
    return [
      result.id,
      stats ? formatMs(stats.p50) : 'n/a',
      stats ? formatMs(stats.p95) : 'n/a',
      stats ? formatMs(stats.mean) : 'n/a',
      stats ? formatMs(stats.stdev) : 'n/a',
      String(result.failures)
    ];
  });

  const allRows = [headers, ...rows];
  const widths = headers.map((_, idx) => Math.max(...allRows.map(row => row[idx].length)));

  return allRows
    .map((row, rowIdx) => {
      const line = row
        .map((col, colIdx) => col.padEnd(widths[colIdx], ' '))
        .join('  ');
      if (rowIdx === 0) {
        const divider = widths.map(w => '-'.repeat(w)).join('  ');
        return `${line}\n${divider}`;
      }
      return line;
    })
    .join('\n');
}
