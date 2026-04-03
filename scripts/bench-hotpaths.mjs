#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  calculateStats,
  analyzeRuntimeProfile,
  renderSummaryTable,
  formatMs
} from '../src/perf-bench.mjs';

const DEFAULT_SCENARIO = 'benchmarks/agent-hotpaths.json';
const DEFAULT_RUNS = 12;
const DEFAULT_WARMUP = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

function parseIntOption(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    scenario: DEFAULT_SCENARIO,
    runs: DEFAULT_RUNS,
    warmup: DEFAULT_WARMUP,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    out: null,
    filter: null
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--scenario') {
      options.scenario = argv[++idx];
    } else if (arg === '--runs') {
      options.runs = parseIntOption(argv[++idx], '--runs');
    } else if (arg === '--warmup') {
      options.warmup = parseIntOption(argv[++idx], '--warmup');
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = parseIntOption(argv[++idx], '--timeout-ms');
    } else if (arg === '--out') {
      options.out = argv[++idx];
    } else if (arg === '--filter') {
      options.filter = argv[++idx];
    } else if (arg === '--json' || arg === '-j') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run bench:hotpaths -- [options]

Options:
  --scenario <path>     Scenario JSON file (default: ${DEFAULT_SCENARIO})
  --runs <n>            Timed runs per command (default: ${DEFAULT_RUNS})
  --warmup <n>          Warmup runs per command (default: ${DEFAULT_WARMUP})
  --timeout-ms <n>      Timeout per run in ms (default: ${DEFAULT_TIMEOUT_MS})
  --filter <text>       Only run commands whose id includes text
  --out <path>          Output file path (default: benchmarks/results/<timestamp>.json)
  -j, --json            Print JSON result to stdout
  -h, --help            Show this help
`);
}

function validateScenario(data, scenarioPath) {
  if (!data || typeof data !== 'object') {
    throw new Error(`Scenario file is not a JSON object: ${scenarioPath}`);
  }

  if (!Array.isArray(data.commands) || data.commands.length === 0) {
    throw new Error(`Scenario file must define a non-empty commands array: ${scenarioPath}`);
  }

  data.commands.forEach((command, idx) => {
    if (!command || typeof command !== 'object') {
      throw new Error(`commands[${idx}] must be an object`);
    }
    if (typeof command.id !== 'string' || command.id.trim() === '') {
      throw new Error(`commands[${idx}].id must be a non-empty string`);
    }
    if (!Array.isArray(command.argv) || command.argv.length === 0 || !command.argv.every(x => typeof x === 'string')) {
      throw new Error(`commands[${idx}].argv must be a non-empty string array`);
    }
  });
}

function runCommandOnce(command, timeoutMs) {
  return new Promise((resolveRun) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd || process.cwd(),
      env: { ...process.env, ...(command.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      resolveRun({
        ok: code === 0 && !timedOut,
        elapsedMs,
        code,
        signal,
        timeout: timedOut,
        stdoutSample: stdout.trim().slice(0, 280),
        stderrSample: stderr.trim().slice(0, 280)
      });
    });
  });
}

async function benchmarkCommand(command, options) {
  for (let idx = 0; idx < options.warmup; idx += 1) {
    const warmupResult = await runCommandOnce(command, options.timeoutMs);
    if (!warmupResult.ok) {
      return {
        id: command.id,
        label: command.label || command.id,
        argv: command.argv,
        runs: options.runs,
        warmup: options.warmup,
        samples: [],
        failures: options.runs,
        stats: null,
        firstFailure: warmupResult
      };
    }
  }

  const samples = [];
  const failures = [];

  for (let idx = 0; idx < options.runs; idx += 1) {
    const runResult = await runCommandOnce(command, options.timeoutMs);
    if (runResult.ok) {
      samples.push(runResult.elapsedMs);
    } else {
      failures.push(runResult);
    }
  }

  return {
    id: command.id,
    label: command.label || command.id,
    argv: command.argv,
    runs: options.runs,
    warmup: options.warmup,
    samples,
    failures: failures.length,
    stats: calculateStats(samples),
    firstFailure: failures[0] || null
  };
}

function buildDefaultOutputPath(scenarioName) {
  const now = new Date();
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '_').slice(0, 15);
  return `benchmarks/results/${scenarioName || 'scenario'}-${timestamp}.json`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const scenarioPath = resolve(options.scenario);
  const rawScenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  validateScenario(rawScenario, scenarioPath);

  const commands = options.filter
    ? rawScenario.commands.filter(command => command.id.includes(options.filter))
    : rawScenario.commands;

  if (commands.length === 0) {
    throw new Error(`No commands matched filter '${options.filter}'`);
  }

  const startedAt = new Date().toISOString();
  const results = [];

  for (const command of commands) {
    process.stderr.write(`Benchmarking ${command.id} ...\n`);
    // eslint-disable-next-line no-await-in-loop
    results.push(await benchmarkCommand(command, options));
  }

  const profile = analyzeRuntimeProfile(results);
  const finishedAt = new Date().toISOString();
  const outputData = {
    scenario: {
      name: rawScenario.name || 'unnamed-scenario',
      description: rawScenario.description || '',
      path: scenarioPath
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    options,
    startedAt,
    finishedAt,
    results,
    profile
  };

  const outputPath = resolve(options.out || buildDefaultOutputPath(rawScenario.name));
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outputData, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nScenario: ${outputData.scenario.name}\n`);
  if (outputData.scenario.description) {
    process.stdout.write(`${outputData.scenario.description}\n`);
  }
  process.stdout.write(`Runs: ${options.runs} (warmup: ${options.warmup})\n\n`);
  process.stdout.write(`${renderSummaryTable(results)}\n\n`);

  process.stdout.write('Runtime attribution\n');
  process.stdout.write(`- Startup share: ${profile.startupShare === null ? 'n/a' : `${(profile.startupShare * 100).toFixed(1)}%`}\n`);
  process.stdout.write(`- Median workload p50: ${formatMs(profile.medianWorkloadP50)}\n`);
  process.stdout.write(`- Recommendation: ${profile.recommendation}\n\n`);

  const failed = results.filter(result => result.failures > 0);
  if (failed.length > 0) {
    process.stdout.write('Failures\n');
    failed.forEach((result) => {
      const failure = result.firstFailure;
      process.stdout.write(`- ${result.id}: code=${failure.code}, timeout=${failure.timeout}, stderr=${failure.stderrSample || '<empty>'}\n`);
    });
    process.stdout.write('\n');
  }

  const slowest = [...results].filter(result => result.stats).sort((a, b) => b.stats.p95 - a.stats.p95).slice(0, 3);
  if (slowest.length > 0) {
    process.stdout.write('Slowest commands (p95)\n');
    slowest.forEach((result, idx) => {
      process.stdout.write(`${idx + 1}. ${result.id}: ${formatMs(result.stats.p95)}\n`);
    });
    process.stdout.write('\n');
  }

  process.stdout.write(`Wrote: ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
