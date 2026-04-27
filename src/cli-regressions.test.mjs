import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('TLT-013: tl-symbols exports-only stays scoped to exported JS/TS symbols on semantic path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-semantic-'));
    const filePath = join(tempDir, 'api.ts');
    writeFileSync(filePath, [
      'export function publicThing() {',
      '  return 1;',
      '}',
      '',
      'function privateThing() {',
      '  return 2;',
      '}',
      '',
      'export const VALUE = 42;',
      'const HIDDEN = 7;'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', filePath, '--exports-only', '-q']);
      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /publicThing/);
      assert.match(result.stdout, /\bVALUE\b/);
      assert.doesNotMatch(result.stdout, /privateThing/);
      assert.doesNotMatch(result.stdout, /\bHIDDEN\b/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-014: tl-snippet resolves JS/TS class field arrow methods via semantic facts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-snippet-semantic-'));
    const filePath = join(tempDir, 'service.ts');
    writeFileSync(filePath, [
      'export class SaveManager {',
      '  save = async (value: number) => {',
      '    return value + 1;',
      '  };',
      '',
      '  other() {',
      '    return 0;',
      '  }',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-snippet.mjs', 'SaveManager.save', filePath, '-q']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /^\s*\d+│\s*save = async \(value: number\) => \{$/m);
      assert.match(result.stdout, /^\s*\d+│\s*return value \+ 1;$/m);
      assert.doesNotMatch(result.stdout, /^\s*\d+│\s*other\(\) \{$/m);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-015: tl-deps resolves TS path aliases via the semantic graph', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-deps-graph-'));
    const configPath = join(tempDir, 'tsconfig.json');
    const targetPath = join(tempDir, 'core.ts');
    const filePath = join(tempDir, 'app.ts');

    writeFileSync(configPath, JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@core': ['core.ts']
        }
      }
    }, null, 2) + '\n', 'utf-8');

    writeFileSync(targetPath, [
      'export function helper() {',
      '  return 1;',
      '}'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(filePath, [
      'import { helper } from \'@core\';',
      '',
      'export function run() {',
      '  return helper();',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-deps.mjs', filePath, '--resolve', '-j']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.totalImports, 1);
      assert.deepStrictEqual(parsed.imports.local.map(item => item.resolvedPath), ['core.ts']);
      assert.strictEqual(parsed.imports.npm.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-016: tl-impact follows JS/TS re-export chains with semantic graph why data', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-impact-graph-'));
    const basePath = join(tempDir, 'base.ts');
    const midPath = join(tempDir, 'mid.ts');
    const consumerPath = join(tempDir, 'consumer.ts');

    writeFileSync(basePath, [
      'export const foo = 1;'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(midPath, [
      'export { foo } from \'./base\';'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(consumerPath, [
      'import { foo } from \'./mid\';',
      '',
      'export function useFoo() {',
      '  return foo;',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-impact.mjs', basePath, '--depth', '2', '--why', '-j']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      const sourceImporters = parsed.importers.source;
      const mid = sourceImporters.find(item => item.relPath === 'mid.ts');
      const consumer = sourceImporters.find(item => item.relPath === 'consumer.ts');

      assert.strictEqual(parsed.backend, 'semantic-graph');
      assert.strictEqual(parsed.totalFiles, 2);
      assert.strictEqual(parsed.exportUsage.foo, 2);
      assert.ok(mid, result.stdout);
      assert.ok(consumer, result.stdout);
      assert.deepStrictEqual(mid.usedBindings, ['foo']);
      assert.strictEqual(consumer.depth, 1);
      assert.strictEqual(consumer.via, 'mid.ts');
      assert.deepStrictEqual(consumer.usedBindings, ['foo']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-017: semantic JS graph captures CommonJS export edge cases', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-graph-cjs-'));
    const filePath = join(tempDir, 'legacy.cjs');
    const consumerPath = join(tempDir, 'consumer.js');
    const { getJsTsGraphFile, getJsTsProjectGraph } = await import('./semantic-js-graph.mjs');

    writeFileSync(filePath, [
      'const foo = () => 1;',
      'const bar = () => 2;',
      'exports[\'foo\'] = foo;',
      'Object.assign(module.exports, {',
      '  bar,',
      '  baz() {',
      '    return 3;',
      '  }',
      '});'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(consumerPath, [
      'const { foo, bar } = require(\'./legacy.cjs\');',
      '',
      'module.exports = {',
      '  run() {',
      '    return foo() + bar();',
      '  }',
      '};'
    ].join('\n') + '\n', 'utf-8');

    try {
      const legacyGraph = getJsTsGraphFile(filePath, { projectRoot: tempDir });
      const projectGraph = getJsTsProjectGraph(filePath, { projectRoot: tempDir });
      const exportNames = legacyGraph.exports.map(item => item.name).sort();
      const reverseEdge = (projectGraph.reverseImports['legacy.cjs'] || [])[0];

      assert.deepStrictEqual(exportNames, ['bar', 'baz', 'foo']);
      assert.strictEqual(reverseEdge.importer, 'consumer.js');
      assert.deepStrictEqual(reverseEdge.bindings.map(item => item.imported).sort(), ['bar', 'foo']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-018: tl-related finds TS path-alias importers via the semantic graph from the target project root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-related-graph-'));
    const packagePath = join(tempDir, 'package.json');
    const configPath = join(tempDir, 'tsconfig.json');
    const dirPath = join(tempDir, 'src');
    const targetPath = join(dirPath, 'core.ts');
    const consumerPath = join(dirPath, 'consumer.ts');

    writeFileSync(packagePath, JSON.stringify({ name: 'related-graph-test' }) + '\n', 'utf-8');
    writeFileSync(configPath, JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@core': ['src/core.ts']
        }
      }
    }, null, 2) + '\n', 'utf-8');

    try {
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(targetPath, [
        'export function helper() {',
        '  return 1;',
        '}'
      ].join('\n') + '\n', 'utf-8');

      writeFileSync(consumerPath, [
        'import { helper } from \'@core\';',
        '',
        'export function run() {',
        '  return helper();',
        '}'
      ].join('\n') + '\n', 'utf-8');

      const result = runCli(['bin/tl-related.mjs', targetPath, '-j']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.backend, 'semantic-graph');
      assert.strictEqual(parsed.file, 'src/core.ts');
      assert.strictEqual(parsed.totalImporters, 1);
      assert.deepStrictEqual(parsed.importers.map(item => item.path), ['src/consumer.ts']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-019: tl-related keeps adjacent tests out of importer results on the semantic path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-related-tests-'));
    const targetPath = join(tempDir, 'service.ts');
    const testPath = join(tempDir, 'service.test.ts');
    const consumerPath = join(tempDir, 'consumer.ts');

    writeFileSync(targetPath, [
      'export function save() {',
      '  return 1;',
      '}'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(testPath, [
      'import { save } from \'./service\';',
      '',
      'save();'
    ].join('\n') + '\n', 'utf-8');

    writeFileSync(consumerPath, [
      'import { save } from \'./service\';',
      '',
      'export function run() {',
      '  return save();',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-related.mjs', targetPath, '-j']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.backend, 'semantic-graph');
      assert.deepStrictEqual(parsed.tests.map(item => item.path), ['service.test.ts']);
      assert.deepStrictEqual(parsed.importers.map(item => item.path), ['consumer.ts']);
      assert.strictEqual(parsed.totalImporters, 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-020: tl-pack lists available workflow packs', () => {
    const result = runCli(['bin/tl-pack.mjs', '--list', '-q']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stdout, /\bonboard\b/);
    assert.match(result.stdout, /\brefactor\b/);
    assert.match(result.stdout, /\bdebug\b/);
  });

  it('TLT-021: tl-pack exposes JSON output for pack discovery', () => {
    const result = runCli(['bin/tl-pack.mjs', '--list', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.packs.onboard);
    assert.ok(parsed.packs.refactor);
    assert.strictEqual(parsed.truncated, false);
  });

  it('TLT-022: tl-pack refactor fails fast for missing files', () => {
    const result = runCli(['bin/tl-pack.mjs', 'refactor', 'missing-file.ts', '-q']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stdout, /Path not found: missing-file\.ts/);
  });

  it('TLT-023: tl umbrella command discovers tl-pack', () => {
    const result = runCli(['bin/tl.mjs', '--list-commands', '--with-desc']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stdout, /^pack\tWorkflow context packs/m);
  });

  it('TLT-024: tl-advise routes PR review goals to tl-pack pr', () => {
    const result = runCli(['bin/tl-advise.mjs', 'review PR 123', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'pr-review');
    assert.strictEqual(parsed.suggestions[0].command, 'tl pack pr 123');
  });

  it('TLT-025: tl-advise routes refactor goals with file paths', () => {
    const result = runCli(['bin/tl-advise.mjs', 'refactor src/cache.mjs', '-q']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stdout, /^1\. tl pack refactor src\/cache\.mjs/m);
    assert.doesNotMatch(result.stdout, /Start with file profile/);
  });

  it('TLT-026: tl umbrella command discovers tl-advise', () => {
    const result = runCli(['bin/tl.mjs', '--list-commands', '--with-desc']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    assert.match(result.stdout, /^advise\tRecommend the next tokenlean commands/m);
  });

  it('TLT-027: tl-advise prefers test routing for add-test goals', () => {
    const result = runCli(['bin/tl-advise.mjs', 'add tests for src/cache.mjs', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'test');
    assert.match(parsed.suggestions[0].command, /^tl related src\/cache\.mjs/);
  });

  it('TLT-028: tl-pack small budgets omit lower-priority sections before output', () => {
    const result = runCli(['bin/tl-pack.mjs', 'refactor', 'bin/tl-pack.mjs', '--budget', '900', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.budgetTier, 'small');
    assert.strictEqual(parsed.sections.length, 2);
    assert.ok(parsed.omittedSections.length >= 1);
    assert.deepStrictEqual(
      parsed.sections.map(section => section.title),
      ['File profile', 'Blast radius']
    );
  });

  it('TLT-029: tl doctor --agents includes agent integration checks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-doctor-agents-'));
    try {
      const result = spawnSync(process.execPath, ['bin/tl.mjs', 'doctor', '--agents'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir },
        encoding: 'utf-8'
      });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /doctor --agents/);
      assert.match(result.stdout, /tokenlean CLI:/);
      assert.match(result.stdout, /project MCP:/);
      assert.match(result.stdout, /Codex MCP\/config:/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
