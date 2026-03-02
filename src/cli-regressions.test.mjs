import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
