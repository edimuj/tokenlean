import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function runCli(args, cwd = repoRoot) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf-8'
  });
}

function waitFor(predicate, timeoutMs = 8000, intervalMs = 25) {
  const started = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return Promise.race([
    new Promise(resolvePromise => {
      child.once('exit', (code, signal) => {
        resolvePromise({ code, signal });
      });
    }),
    new Promise((_, rejectPromise) => {
      setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

describe('CLI regressions', () => {
  it('TLT-001: tl-snippet escapes regex metacharacters in symbol names', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-snippet-'));
    const filePath = join(tempDir, 'sample.rb');
    writeFileSync(filePath, [
      'def foo?',
      '  true',
      'end',
      '',
      'def foo',
      '  false',
      'end'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-snippet.mjs', 'foo?', filePath, '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /^\s*\d+│\s*def foo\?$/m);
      assert.ok(!/^\s*\d+│\s*def foo$/m.test(result.stdout), result.stdout);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-002: tl-symbols applies --filter in directory mode', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-'));
    const filePath = join(tempDir, 'api.ts');
    writeFileSync(filePath, [
      'export class Widget {',
      '  run() {}',
      '}',
      '',
      'export function doThing() {',
      '  return 1;',
      '}',
      '',
      'export const VALUE = 42;'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', tempDir, '--filter', 'function', '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /doThing\(\)/);
      assert.doesNotMatch(result.stdout, /\bWidget\b/);
      assert.doesNotMatch(result.stdout, /\bVALUE\b/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-003: tl-run shows stderr details when tests exit non-zero without parsed failures', () => {
    const nodePath = JSON.stringify(process.execPath);
    const script = "console.log('1 passing'); console.error('fatal setup'); process.exit(1)";
    const command = `${nodePath} -e ${JSON.stringify(script)}`;

    const result = runCli(['bin/tl-run.mjs', command, '--type', 'test', '-q']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /1 passed/);
    assert.match(result.stdout, /fatal setup/);
  });

  it('TLT-004: tl-snippet fails fast for explicit missing target file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-snippet-missing-'));
    const unrelatedFile = join(tempDir, 'other.ts');
    const missingFile = join(tempDir, 'does-not-exist.ts');

    writeFileSync(unrelatedFile, [
      'export function estimateTokens() {',
      '  return 123;',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-snippet.mjs', 'estimateTokens', missingFile, '-q']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stdout, /Target file not found or unreadable:/);
      assert.doesNotMatch(result.stdout, /No definition found for "estimateTokens"/);
      assert.doesNotMatch(result.stdout, /^\s*\d+│\s*export function estimateTokens/m);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-005: tl-symbols keeps multi-line generic signatures intact', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-generic-'));
    const filePath = join(tempDir, 'generic.ts');
    writeFileSync(filePath, [
      'export type Mapper<',
      '  TInput,',
      '  TOutput',
      '> = {',
      '  map: (value: TInput) => TOutput;',
      '};'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', filePath, '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /Mapper<\s*TInput,\s*TOutput\s*>/);
      assert.doesNotMatch(result.stdout, /Mapper<\s*$/m);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-006: tl-run --raw preserves stdout/stderr channels', () => {
    const nodePath = JSON.stringify(process.execPath);
    const script = "process.stdout.write('OUT\\n'); process.stderr.write('ERR\\n')";
    const command = `${nodePath} -e ${JSON.stringify(script)}`;

    const result = runCli(['bin/tl-run.mjs', command, '--raw']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /OUT/);
    assert.doesNotMatch(result.stdout, /ERR/);
    assert.match(result.stderr, /ERR/);
  });

  it('TLT-007: tl-snippet --all still returns all matches after caching changes', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-snippet-all-'));
    const filePath = join(tempDir, 'multi.ts');
    writeFileSync(filePath, [
      'class A {',
      '  save() {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class B {',
      '  save() {',
      '    return 2;',
      '  }',
      '}',
      '',
      'function save() {',
      '  return 3;',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-snippet.mjs', 'save', filePath, '--all', '-j']);
      assert.strictEqual(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.totalDefinitions, 3);
      assert.strictEqual(parsed.results.length, 3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-008: tl-run still detects test summaries in large outputs', () => {
    const nodePath = JSON.stringify(process.execPath);
    const script = [
      "for (let i = 0; i < 20000; i++) console.log('log-line-' + i);",
      "console.log('Tests: 0 failed, 3 passed, 3 total');"
    ].join(' ');
    const command = `${nodePath} -e ${JSON.stringify(script)}`;

    const result = runCli(['bin/tl-run.mjs', command, '-q']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /3 passed/);
    assert.doesNotMatch(result.stdout, /total lines/);
  });

  it('TLT-009: tl-symbols function filter preserves fallback extraction for non-fast languages', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-fallback-'));
    const filePath = join(tempDir, 'main.swift');
    writeFileSync(filePath, [
      'func helper() -> Int {',
      '  return 1',
      '}',
      '',
      'func main() -> Int {',
      '  return helper()',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', tempDir, '--filter', 'function', '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /helper\(\)/);
      assert.match(result.stdout, /main\(\)/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-010: tl-snippet no-match fallback is compact and suggestion-based', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-snippet-fallback-'));
    const filePath = join(tempDir, 'api.ts');
    const lines = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`export function item${i}() { return ${i}; }`);
    }
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-snippet.mjs', 'doesNotExist', filePath, '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /No definition found for "doesNotExist"/);
      assert.match(result.stdout, /Closest symbols:/);
      assert.doesNotMatch(result.stdout, /Full file:/);
      assert.doesNotMatch(result.stdout, /^Functions:$/m);
      const lineCount = result.stdout.trim().split('\n').length;
      assert.ok(lineCount < 25, `Expected compact fallback, got ${lineCount} lines`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-011: tl-tail collapses repeats and surfaces error/warn clusters', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-tail-'));
    const filePath = join(tempDir, 'app.log');
    writeFileSync(filePath, [
      'INFO boot complete',
      'WARN cache nearing limit',
      'ERROR db connection failed',
      'ERROR db connection failed',
      'INFO heartbeat ok',
      'INFO heartbeat ok',
      'INFO heartbeat ok',
      'WARN retrying request'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-tail.mjs', filePath, '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /errors:/);
      assert.match(result.stdout, /2x ERROR db connection failed/);
      assert.match(result.stdout, /warnings:/);
      assert.match(result.stdout, /repeated clusters:/);
      assert.match(result.stdout, /3x INFO heartbeat ok/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-012: tl-tail --follow emits updated summary when log grows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-tail-follow-'));
    const filePath = join(tempDir, 'app.log');
    writeFileSync(filePath, [
      'INFO boot complete',
      'WARN warmup retry'
    ].join('\n') + '\n', 'utf-8');

    const child = spawn(process.execPath, ['bin/tl-tail.mjs', filePath, '--follow', '-q'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    try {
      await waitFor(() => (stdout.match(/^summary:/gm) || []).length >= 1, 6000);

      appendFileSync(filePath, [
        'ERROR downstream failed',
        'ERROR downstream failed',
        'WARN retrying request'
      ].join('\n') + '\n', 'utf-8');

      await waitFor(() => {
        const summaryCount = (stdout.match(/^summary:/gm) || []).length;
        return summaryCount >= 2 &&
          /errors:/.test(stdout) &&
          /2x ERROR downstream failed/.test(stdout) &&
          /warnings:/.test(stdout);
      }, 10000);

      child.kill('SIGINT');
      const exited = await waitForExit(child, 5000);
      assert.strictEqual(
        exited.code,
        0,
        `Expected exit code 0, got ${exited.code} (signal=${exited.signal || 'none'})\nstderr:\n${stderr}`
      );
      assert.match(stdout, /repeated clusters:/);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        try {
          await waitForExit(child, 2000);
        } catch {
          child.kill('SIGKILL');
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
