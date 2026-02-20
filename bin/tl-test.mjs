#!/usr/bin/env node

/**
 * tl-test - Run only tests relevant to changed files
 *
 * Detects changed files via git, maps each to test files using
 * tl-test-map, then executes them. Closes the modify-verify loop.
 *
 * Usage: tl-test [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-test',
    desc: 'Run tests relevant to changed files',
    when: 'after-modify',
    example: 'tl-test'
  }));
  process.exit(0);
}

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, categorizeFile } from '../src/project.mjs';
import { gitCommand } from '../src/shell.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP = `
tl-test - Run tests relevant to changed files

Usage: tl-test [options]

Options:
  --since <ref>         Compare against branch/commit (default: unstaged + staged)
  --dry-run             List test files without executing
  --runner <cmd>        Override test command (default: node --test)
  --all                 Run all discovered tests, not just for changed files
${COMMON_OPTIONS_HELP}

Examples:
  tl-test                           # Tests for uncommitted changes
  tl-test --since main              # Tests for changes vs main branch
  tl-test --dry-run                 # List tests without running
  tl-test --runner "npx jest"       # Use Jest instead of node --test
  tl-test -j                        # JSON output
`;

// ─────────────────────────────────────────────────────────────
// Changed File Detection
// ─────────────────────────────────────────────────────────────

function getChangedFiles(projectRoot, sinceRef) {
  const files = new Set();

  if (sinceRef) {
    // Compare against a ref (branch, tag, commit)
    const diff = gitCommand(['diff', '--name-only', sinceRef], { cwd: projectRoot });
    if (diff) {
      for (const f of diff.split('\n').filter(Boolean)) {
        files.add(join(projectRoot, f));
      }
    }
  } else {
    // Unstaged changes
    const unstaged = gitCommand(['diff', '--name-only'], { cwd: projectRoot });
    if (unstaged) {
      for (const f of unstaged.split('\n').filter(Boolean)) {
        files.add(join(projectRoot, f));
      }
    }

    // Staged changes
    const staged = gitCommand(['diff', '--cached', '--name-only'], { cwd: projectRoot });
    if (staged) {
      for (const f of staged.split('\n').filter(Boolean)) {
        files.add(join(projectRoot, f));
      }
    }
  }

  // Filter to existing source files (not deleted, not test files themselves)
  return [...files].filter(f => {
    if (!existsSync(f)) return false;
    const cat = categorizeFile(f, projectRoot);
    return cat === 'source';
  });
}

// ─────────────────────────────────────────────────────────────
// Test Mapping via tl-test-map
// ─────────────────────────────────────────────────────────────

function findTestsForFile(filePath) {
  try {
    const toolPath = join(__dirname, 'tl-test-map.mjs');
    const proc = spawnSync(process.execPath, [toolPath, filePath, '--json'], {
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (proc.error || proc.status !== 0) return [];
    const data = JSON.parse(proc.stdout);
    return (data.tests || []).map(t => t.path || t.relPath).filter(Boolean);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Test Execution
// ─────────────────────────────────────────────────────────────

function runTests(testFiles, runner, projectRoot) {
  if (runner) {
    // Custom runner — pass test files as args
    const [cmd, ...cmdArgs] = runner.split(/\s+/);
    const relFiles = testFiles.map(f => relative(projectRoot, f));
    const proc = spawnSync(cmd, [...cmdArgs, ...relFiles], {
      encoding: 'utf-8',
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    return {
      stdout: proc.stdout || '',
      stderr: proc.stderr || '',
      exitCode: proc.status ?? 1,
      signal: proc.signal
    };
  }

  // Default: node --test
  const proc = spawnSync(process.execPath, ['--test', ...testFiles], {
    encoding: 'utf-8',
    cwd: projectRoot,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  });

  return {
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    exitCode: proc.status ?? 1,
    signal: proc.signal
  };
}

function summarizeResults(result) {
  const output = result.stdout + '\n' + result.stderr;
  const lines = output.split('\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const line of lines) {
    // Node test runner patterns
    if (/^# pass \d+/i.test(line)) {
      const m = line.match(/# pass (\d+)/i);
      if (m) passed = parseInt(m[1], 10);
    }
    if (/^# fail \d+/i.test(line)) {
      const m = line.match(/# fail (\d+)/i);
      if (m) failed = parseInt(m[1], 10);
    }
    if (/^# skip(ped)? \d+/i.test(line)) {
      const m = line.match(/# skip(?:ped)? (\d+)/i);
      if (m) skipped = parseInt(m[1], 10);
    }
    // Capture failure lines
    if (/^not ok|FAIL|✗|×/.test(line)) {
      failures.push(line.trim());
    }
  }

  // Fallback: count from TAP-like output
  if (passed === 0 && failed === 0) {
    for (const line of lines) {
      if (/^ok \d+/.test(line)) passed++;
      if (/^not ok \d+/.test(line)) failed++;
    }
  }

  return { passed, failed, skipped, failures };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let sinceRef = null;
let dryRun = false;
let runner = null;
let runAll = false;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if (arg === '--since' && options.remaining[i + 1]) {
    sinceRef = options.remaining[++i];
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--runner' && options.remaining[i + 1]) {
    runner = options.remaining[++i];
  } else if (arg === '--all') {
    runAll = true;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Get changed files
const changedFiles = runAll ? [] : getChangedFiles(projectRoot, sinceRef);

if (!runAll && changedFiles.length === 0) {
  out.add('No changed source files detected');
  if (!sinceRef) out.add('(checking unstaged + staged changes)');
  out.print();
  process.exit(0);
}

// Map changed files to tests
const testFileSet = new Set();
const fileToTests = new Map();

if (runAll) {
  // --all mode: discover all test files via git ls-files
  const allFiles = gitCommand(['ls-files', '*.test.*', '*.spec.*'], { cwd: projectRoot });
  if (allFiles) {
    for (const f of allFiles.split('\n').filter(Boolean)) {
      testFileSet.add(join(projectRoot, f));
    }
  }
} else {
  for (const file of changedFiles) {
    const tests = findTestsForFile(file);
    const relFile = relative(projectRoot, file);
    fileToTests.set(relFile, tests);

    for (const test of tests) {
      // Resolve relative paths
      const absTest = test.startsWith('/') ? test : join(projectRoot, test);
      if (existsSync(absTest)) {
        testFileSet.add(absTest);
      }
    }
  }
}

const testFiles = [...testFileSet];

if (testFiles.length === 0) {
  if (!options.quiet) {
    out.add(`${changedFiles.length} changed files, but no associated tests found`);
    out.blank();
    for (const file of changedFiles) {
      out.add(`  ${relative(projectRoot, file)} -> (no tests)`);
    }
  }
  out.setData('changedFiles', changedFiles.map(f => relative(projectRoot, f)));
  out.setData('testFiles', []);
  out.setData('status', 'no-tests');
  out.print();
  process.exit(0);
}

// Dry run — just list tests
if (dryRun) {
  if (!options.quiet) {
    out.add(`Would run ${testFiles.length} test files for ${changedFiles.length} changed files:`);
    out.blank();
  }

  for (const [file, tests] of fileToTests) {
    if (tests.length > 0) {
      out.add(`  ${file}:`);
      for (const test of tests) {
        out.add(`    -> ${test}`);
      }
    }
  }

  out.setData('changedFiles', changedFiles.map(f => relative(projectRoot, f)));
  out.setData('testFiles', testFiles.map(f => relative(projectRoot, f)));
  out.setData('status', 'dry-run');
  out.print();
  process.exit(0);
}

// Execute tests
if (!options.quiet) {
  out.add(`Running ${testFiles.length} test files...`);
  out.blank();
}

const result = runTests(testFiles, runner, projectRoot);
const summary = summarizeResults(result);

if (!options.quiet) {
  // Show mapping
  if (!runAll) {
    for (const [file, tests] of fileToTests) {
      if (tests.length > 0) {
        out.add(`  ${file} -> ${tests.length} test file(s)`);
      }
    }
    out.blank();
  }

  // Show results
  const statusIcon = result.exitCode === 0 ? 'ok' : 'FAIL';
  out.add(`${statusIcon} ${summary.passed} passed, ${summary.failed} failed${summary.skipped ? `, ${summary.skipped} skipped` : ''}`);

  // Show failures
  if (summary.failures.length > 0) {
    out.blank();
    out.add('Failures:');
    for (const failure of summary.failures.slice(0, 10)) {
      out.add(`  ${failure}`);
    }
    if (summary.failures.length > 10) {
      out.add(`  ... and ${summary.failures.length - 10} more`);
    }
  }

  // Show raw output for failed runs if summary didn't capture details
  if (result.exitCode !== 0 && summary.failures.length === 0) {
    out.blank();
    out.add('Output:');
    const outputLines = (result.stdout + '\n' + result.stderr).split('\n').filter(Boolean);
    for (const line of outputLines.slice(-20)) {
      out.add(`  ${line}`);
    }
  }
}

out.setData('changedFiles', changedFiles.map(f => relative(projectRoot, f)));
out.setData('testFiles', testFiles.map(f => relative(projectRoot, f)));
out.setData('passed', summary.passed);
out.setData('failed', summary.failed);
out.setData('skipped', summary.skipped);
out.setData('exitCode', result.exitCode);
out.setData('status', result.exitCode === 0 ? 'pass' : 'fail');

out.print();
process.exit(result.exitCode === 0 ? 0 : 1);
