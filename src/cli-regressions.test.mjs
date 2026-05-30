import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRipgrepAvailable } from './traverse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RG_SKIP = !isRipgrepAvailable() && 'requires ripgrep binary';

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
  it('TLT-001: tl-snippet escapes regex metacharacters in symbol names', { skip: RG_SKIP }, () => {
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

  it('TLT-034: tl-symbols keeps named re-exports in directory export mode', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-reexport-'));
    const filePath = join(tempDir, 'index.js');
    writeFileSync(filePath, "export { Button as PrimaryButton, Input } from './components.js';\n", 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', tempDir, '-e', '-q']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /index\.js: PrimaryButton, Input/);
      assert.doesNotMatch(result.stdout, /0 files, 0 symbols/);
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

  it('TLT-049: tl-run does not let stale stderr failure summaries override passing stdout', () => {
    const nodePath = JSON.stringify(process.execPath);
    const script = [
      "console.log('Tests: 1942 passed, 1942 total');",
      "console.error('Tests: 28 failed, 1914 passed, 1942 total');"
    ].join(' ');
    const command = `${nodePath} -e ${JSON.stringify(script)}`;

    const result = runCli(['bin/tl-run.mjs', command, '--type', 'test', '-j']);
    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.exitCode, 0);
    assert.strictEqual(parsed.summary, '1942 passed');
    assert.deepStrictEqual(parsed.failures, []);
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

  it('TLT-053: tl-advise routes GitHub issue work to issue tools', () => {
    const result = runCli(['bin/tl-advise.mjs', 'fix github issue #3', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'github-issue');
    assert.strictEqual(parsed.suggestions[0].command, 'tl gh issue read -R owner/repo 3');

    const review = runCli(['bin/tl-advise.mjs', 'review issue #3', '-j']);
    assert.strictEqual(review.status, 0, review.stdout || review.stderr);
    assert.strictEqual(JSON.parse(review.stdout).intent, 'github-issue');
  });

  it('TLT-054: tl-advise routes issue closing to batched issue close', () => {
    const result = runCli(['bin/tl-advise.mjs', 'close issues 2 and 3', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'github-issue');
    assert.strictEqual(parsed.suggestions[1].command, 'tl gh issue close -R owner/repo 2 3 -c "<summary>"');
  });

  it('TLT-055: tl-advise routes validation commands through tl-run', () => {
    const result = runCli(['bin/tl-advise.mjs', 'run typecheck', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'validate');
    assert.strictEqual(parsed.suggestions[0].command, 'tl run "npm run typecheck" --type build');
  });

  it('TLT-056: tl-advise routes maintenance and search work to dedicated tools', () => {
    const unused = runCli(['bin/tl-advise.mjs', 'find unused exports', '-j']);
    assert.strictEqual(unused.status, 0, unused.stdout || unused.stderr);
    const unusedParsed = JSON.parse(unused.stdout);
    assert.strictEqual(unusedParsed.intent, 'maintenance');
    assert.strictEqual(unusedParsed.suggestions[0].command, 'tl unused .');

    const search = runCli(['bin/tl-advise.mjs', 'search for auth code', '-j']);
    assert.strictEqual(search.status, 0, search.stdout || search.stderr);
    const searchParsed = JSON.parse(search.stdout);
    assert.strictEqual(searchParsed.intent, 'search');
    assert.strictEqual(searchParsed.suggestions[0].command, 'tl search auth');
  });

  it('TLT-057: tl-advise avoids tl-symbols for non-code files', () => {
    const result = runCli(['bin/tl-advise.mjs', 'inspect large README.md', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);
    const commands = parsed.suggestions.map(item => item.command);

    assert.strictEqual(commands[0], 'tl context README.md');
    assert.ok(!commands.some(command => command.includes('tl symbols README.md')));
  });

  it('TLT-058: tl-advise routes dependency work through npm and docs tools', () => {
    const result = runCli(['bin/tl-advise.mjs', 'upgrade react', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.intent, 'deps');
    assert.strictEqual(parsed.suggestions[0].command, 'tl npm react --versions');
    assert.strictEqual(parsed.suggestions[1].command, 'tl context7 react "migration guide"');
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

  it('TLT-035: tl-pack review treats existing file targets as file-review context', () => {
    const result = runCli(['bin/tl-pack.mjs', 'review', 'src/cache.mjs', '--budget', '900', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.strictEqual(parsed.pack, 'review');
    assert.strictEqual(parsed.target, 'src/cache.mjs');
    assert.deepStrictEqual(
      parsed.sections.map(section => section.title),
      ['File profile', 'Blast radius']
    );
    assert.strictEqual(parsed.sections[0].command, 'tl analyze src/cache.mjs');
  });

  it('TLT-039: tl-pack review does not route directories into file-only review tools', { skip: RG_SKIP }, () => {
    const result = runCli(['bin/tl-pack.mjs', 'review', 'src', '--budget', '900', '-j']);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.deepStrictEqual(
      parsed.sections.map(section => section.title),
      ['Project structure', 'Entry points']
    );
    assert.strictEqual(parsed.sections[0].command, 'tl structure src --depth 1');
    assert.doesNotMatch(result.stdout, /EISDIR/);
    assert.doesNotMatch(result.stdout, /tl analyze src/);
  });

  it('TLT-042: tl-pack refactor treats directory targets as area context', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-pack-refactor-dir-'));
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'api.ts'), [
      'export function loadUser() {',
      '  return { id: 1 };',
      '}'
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-pack.mjs', 'refactor', srcDir, '--budget', '4000', '-j']);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.pack, 'refactor');
      assert.strictEqual(parsed.target, srcDir);
      assert.deepStrictEqual(
        parsed.sections.map(section => section.title),
        ['Project structure', 'Exported symbols', 'Context hotspots', 'Entry points']
      );
      assert.strictEqual(parsed.sections[0].command, `tl structure ${srcDir} --depth 2`);
      assert.match(parsed.sections[1].command, /^tl symbols .+ --exports-only --max-lines 40$/);
      assert.doesNotMatch(result.stdout, /EISDIR/);
      assert.doesNotMatch(result.stdout, /tl analyze/);
      assert.doesNotMatch(result.stdout, /tl impact/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-051: tl-pack debug keeps prose targets as context instead of shell commands', () => {
    const target = 'delivery attempts dead-letter observability issue 43';
    const result = runCli(['bin/tl-pack.mjs', 'debug', target, '--budget', '900', '-j']);

    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);
    const output = parsed.sections[0].output.join('\n');

    assert.strictEqual(parsed.failed, false);
    assert.strictEqual(parsed.sections[0].title, 'Command result');
    assert.strictEqual(parsed.sections[0].exitCode, 0);
    assert.match(output, /kept as context only/);
    assert.doesNotMatch(output, /delivery: not found/);
  });

  it('TLT-059: tl-pack emits copy-pasteable commands for args with spaces', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-pack-command-quote-'));
    const spacedDir = join(tempDir, 'space dir');
    const filePath = join(spacedDir, 'a file.ts');
    mkdirSync(spacedDir, { recursive: true });
    writeFileSync(filePath, 'export function x() { return 1; }\n', 'utf-8');

    try {
      const refactor = runCli(['bin/tl-pack.mjs', 'refactor', filePath, '--budget', '900', '-j']);
      assert.strictEqual(refactor.status, 0, refactor.stdout || refactor.stderr);
      const parsedRefactor = JSON.parse(refactor.stdout);
      assert.strictEqual(parsedRefactor.sections[0].command, `tl analyze ${JSON.stringify(filePath)}`);
      assert.strictEqual(parsedRefactor.omittedSections[0].command, `tl related ${JSON.stringify(filePath)}`);

      const debug = runCli(['bin/tl-pack.mjs', 'debug', 'npm test -- --help', '--budget', '900', '-j']);
      assert.strictEqual(debug.status, 0, debug.stdout || debug.stderr);
      const parsedDebug = JSON.parse(debug.stdout);
      assert.strictEqual(parsedDebug.sections[0].command, 'tl run "npm test -- --help" --type test');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-052: tl-symbols rejects markdown files with a useful alternative', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-symbols-markdown-'));
    const filePath = join(tempDir, 'README.md');
    writeFileSync(filePath, '# Notes\n\nUse prose here.\n', 'utf-8');

    try {
      const result = runCli(['bin/tl-symbols.mjs', filePath, '-q']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Not a code file for tl-symbols/);
      assert.match(result.stderr, /Read tool/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-043: tl-gh issue close uses batched non-interactive GraphQL calls', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-gh-close-batch-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'if (process.env.GH_PROMPT_DISABLED !== "1") process.exit(42);',
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");',
      'const queryArg = args.find(arg => arg.startsWith("query=")) || "";',
      'const query = queryArg.slice("query=".length);',
      'if (query.includes("repository(")) {',
      '  process.stdout.write(JSON.stringify({ data: { repository: { issue1378: { id: "I_1378" }, issue1379: { id: "I_1379" } } } }) + "\\n");',
      '} else {',
      '  process.stdout.write(JSON.stringify({ data: { close1378: { issue: { number: 1378 } }, close1379: { issue: { number: 1379 } } } }) + "\\n");',
      '}'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      const result = spawnSync(process.execPath, [
        'bin/tl-gh.mjs',
        'issue',
        'close',
        '-R',
        'edimuj/app-chat-game',
        '1378',
        '1379',
        '-c',
        'Fixed in Felix playtest polish batch.',
        '-j'
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GH_LOG: logPath,
          PATH: `${tempDir}:${process.env.PATH}`
        }
      });
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      const queryCalls = calls.filter(call => call[0] === 'api' && call[1] === 'graphql');
      const queryText = queryCalls[0].find(arg => arg.startsWith('query=')).slice('query='.length);
      const mutationText = queryCalls[1].find(arg => arg.startsWith('query=')).slice('query='.length);

      assert.deepStrictEqual(parsed.results.map(item => item.status), ['closed', 'closed']);
      assert.strictEqual(queryCalls.length, 2);
      assert.match(queryText, /issue1378: issue\(number: 1378\)/);
      assert.match(queryText, /issue1379: issue\(number: 1379\)/);
      assert.match(mutationText, /close1378: closeIssue/);
      assert.match(mutationText, /close1379: closeIssue/);
      assert.match(mutationText, /stateReason: COMPLETED/);
      assert.match(mutationText, /comment1378: addComment/);
      assert.match(mutationText, /comment1379: addComment/);
      assert.match(mutationText, /Fixed in Felix playtest polish batch\./);
      assert.ok(!calls.some(call => call[0] === 'issue' && call[1] === 'close'));
      assert.ok(!calls.some(call => call.includes('PATCH') || call.includes('POST')));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-045: tl-gh issue read aliases view and returns direct sub-issues', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-gh-issue-read-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'if (process.env.GH_PROMPT_DISABLED !== "1") process.exit(42);',
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");',
      'process.stdout.write(JSON.stringify({ data: { repository: { issue: {',
      '  number: 434,',
      '  title: "Parent issue",',
      '  state: "OPEN",',
      '  body: "Parent body",',
      '  url: "https://github.com/edimuj/app-chat-game/issues/434",',
      '  createdAt: "2026-05-09T00:00:00Z",',
      '  closedAt: null,',
      '  author: { login: "edimuj" },',
      '  assignees: { nodes: [{ login: "agent" }] },',
      '  labels: { nodes: [{ name: "P1" }] },',
      '  comments: { totalCount: 2 },',
      '  subIssues: {',
      '    totalCount: 1,',
      '    nodes: [{',
      '      number: 435,',
      '      title: "Child issue",',
      '      state: "CLOSED",',
      '      body: "Child body",',
      '      url: "https://github.com/edimuj/app-chat-game/issues/435",',
      '      labels: { nodes: [{ name: "fixed" }] },',
      '      assignees: { nodes: [] },',
      '      comments: { totalCount: 0 }',
      '    }]',
      '  }',
      '} } } }) + "\\n");'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      const result = spawnSync(process.execPath, [
        'bin/tl-gh.mjs',
        'issue',
        'read',
        '-R',
        'edimuj/app-chat-game',
        '434',
        '--no-body',
        '-j'
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GH_LOG: logPath,
          PATH: `${tempDir}:${process.env.PATH}`
        }
      });
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      const queryText = calls[0].find(arg => arg.startsWith('query=')).slice('query='.length);

      assert.strictEqual(parsed.issue.number, 434);
      assert.strictEqual(parsed.issue.title, 'Parent issue');
      assert.deepStrictEqual(parsed.issue.labels, ['P1']);
      assert.deepStrictEqual(parsed.issue.assignees, ['agent']);
      assert.strictEqual(parsed.issue.subIssues[0].number, 435);
      assert.strictEqual(parsed.issue.subIssues[0].title, 'Child issue');
      assert.match(queryText, /subIssues\(first: 100\)/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-046: tl-gh issue close-batch maps partial GraphQL errors per issue', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-gh-close-partial-'));
    const ghPath = join(tempDir, 'gh');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'const queryArg = args.find(arg => arg.startsWith("query=")) || "";',
      'const query = queryArg.slice("query=".length);',
      'if (query.includes("repository(")) {',
      '  process.stdout.write(JSON.stringify({ data: { repository: { issue1378: { id: "I_1378" }, issue1379: { id: "I_1379" } } } }) + "\\n");',
      '} else {',
      '  process.stdout.write(JSON.stringify({',
      '    data: {',
      '      close1378: { issue: { number: 1378 } },',
      '      comment1378: null,',
      '      close1379: null,',
      '      comment1379: null',
      '    },',
      '    errors: [',
      '      { message: "comment body rejected", path: ["comment1378"] },',
      '      { message: "already closed by policy", path: ["close1379"] }',
      '    ]',
      '  }) + "\\n");',
      '}'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      const result = spawnSync(process.execPath, [
        'bin/tl-gh.mjs',
        'issue',
        'close-batch',
        '-R',
        'edimuj/app-chat-game',
        '1378',
        '1379',
        '-c',
        'Fixed in Felix playtest polish batch.',
        '-j'
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH}`
        }
      });
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.results[0].status, 'closed');
      assert.strictEqual(parsed.results[0].warning, 'comment body rejected');
      assert.strictEqual(parsed.results[1].status, 'failed');
      assert.strictEqual(parsed.results[1].error, 'already closed by policy');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-050: tl-gh issue close-batch binary-splits a failing chunk to isolate the bad issue and recover the rest', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-gh-close-chunk-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");',
      'const queryArg = args.find(arg => arg.startsWith("query=")) || "";',
      'const query = queryArg.slice("query=".length);',
      'if (query.includes("repository(")) {',
      '  const nums = [...query.matchAll(/issue(\\d+): issue/g)].map(m => Number(m[1]));',
      '  const fields = Object.fromEntries(nums.map(n => [`issue${n}`, { id: `I_${n}` }]));',
      '  process.stdout.write(JSON.stringify({ data: { repository: fields } }) + "\\n");',
      '  process.exit(0);',
      '}',
      // Mutations: succeed for the first chunk (1..10). Issue 11 is "poison" —
      // any mutation containing it throws, forcing a recursive binary split that
      // isolates 11 and lets 12..15 through on the sub-batches that omit it.
      'const closeNums = [...query.matchAll(/close(\\d+): closeIssue/g)].map(m => Number(m[1]));',
      'if (closeNums.includes(11)) {',
      '  process.stderr.write("Query has complexity fees, exceeding max\\n");',
      '  process.exit(1);',
      '}',
      'const data = {};',
      'for (const n of closeNums) { data[`close${n}`] = { issue: { number: n } }; }',
      'process.stdout.write(JSON.stringify({ data }) + "\\n");'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      const issueNums = Array.from({ length: 15 }, (_, i) => String(i + 1));
      const result = spawnSync(process.execPath, [
        'bin/tl-gh.mjs',
        'issue',
        'close-batch',
        '-R',
        'edimuj/app-chat-game',
        ...issueNums,
        '-j'
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GH_LOG: logPath,
          PATH: `${tempDir}:${process.env.PATH}`
        }
      });
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      const mutationCalls = calls.filter(c => {
        const q = (c.find(a => a.startsWith('query=')) || '').slice('query='.length);
        return q.startsWith('mutation') || q.includes('closeIssue');
      });

      // The failing second chunk gets split (>2 mutation requests total),
      // rather than the whole chunk being marked failed in one shot.
      assert.ok(mutationCalls.length > 2, `expected the failing chunk to split (>2 requests), got ${mutationCalls.length}`);

      // Everything except the poison issue 11 closes; results stay in input order.
      const closed = parsed.results.filter(r => r.status === 'closed').map(r => Number(r.number));
      const failed = parsed.results.filter(r => r.status === 'failed').map(r => Number(r.number));
      assert.deepStrictEqual(closed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
      assert.deepStrictEqual(failed, [11]);
      assert.match(parsed.results.find(r => Number(r.number) === 11).error, /complexity|exceed/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-036: tl-guard detects cycles through side-effect imports', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-guard-cycle-'));
    writeFileSync(join(tempDir, 'a.js'), "import './b.js';\nexport const a = 1;\n", 'utf-8');
    writeFileSync(join(tempDir, 'b.js'), "import './a.js';\nexport const b = 1;\n", 'utf-8');

    try {
      const result = runCli([
        join(repoRoot, 'bin/tl-guard.mjs'),
        '--no-secrets',
        '--no-todos',
        '--no-unused',
        '-j'
      ], tempDir);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.checks.circular.status, 'warn');
      assert.match(parsed.checks.circular.details[0].cycle, /a\.js -> b\.js -> a\.js/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-040: tl-guard detects cycles through commented dynamic imports', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-guard-dynamic-cycle-'));
    writeFileSync(join(tempDir, 'a.js'), "import(/* webpackChunkName: 'b' */ './b.js');\n", 'utf-8');
    writeFileSync(join(tempDir, 'b.js'), "import './a.js';\n", 'utf-8');

    try {
      const result = runCli([
        join(repoRoot, 'bin/tl-guard.mjs'),
        '--no-secrets',
        '--no-todos',
        '--no-unused',
        '-j'
      ], tempDir);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.checks.circular.status, 'warn');
      assert.match(parsed.checks.circular.details[0].cycle, /a\.js -> b\.js -> a\.js/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-041: tl-guard ignores dynamic imports without relative string specs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-guard-dynamic-nonrelative-'));
    writeFileSync(join(tempDir, 'a.js'), [
      "const mod = import(moduleName);",
      "const pkg = import('react');",
      "export const a = 1;"
    ].join('\n') + '\n', 'utf-8');

    try {
      const result = runCli([
        join(repoRoot, 'bin/tl-guard.mjs'),
        '--no-secrets',
        '--no-todos',
        '--no-unused',
        '-j'
      ], tempDir);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.checks.circular.status, 'pass');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-047: tl-guard caps noisy unused details by default', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-guard-unused-limit-'));
    for (let i = 1; i <= 25; i++) {
      writeFileSync(join(tempDir, `f${i}.js`), `export const unused${i} = ${i};\n`, 'utf-8');
    }

    try {
      const result = runCli([
        join(repoRoot, 'bin/tl-guard.mjs'),
        '--no-secrets',
        '--no-todos',
        '--no-circular',
        '-j'
      ], tempDir);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.checks.unused.status, 'warn');
      assert.strictEqual(parsed.checks.unused.count, 25);
      assert.strictEqual(parsed.checks.unused.details.length, 20);
      assert.strictEqual(parsed.checks.unused.omittedDetails, 5);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-048: tl-guard --full returns all noisy details', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-guard-full-details-'));
    for (let i = 1; i <= 25; i++) {
      writeFileSync(join(tempDir, `a${i}.js`), `import './b${i}.js';\n`, 'utf-8');
      writeFileSync(join(tempDir, `b${i}.js`), `import './a${i}.js';\n`, 'utf-8');
    }

    try {
      const result = runCli([
        join(repoRoot, 'bin/tl-guard.mjs'),
        '--no-secrets',
        '--no-todos',
        '--no-unused',
        '--full',
        '-j'
      ], tempDir);
      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.checks.circular.status, 'warn');
      assert.strictEqual(parsed.checks.circular.count, 25);
      assert.strictEqual(parsed.checks.circular.details.length, 25);
      assert.strictEqual(parsed.checks.circular.omittedDetails, undefined);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-037: tl-parallel keeps env-prefixed commands intact', () => {
    const script = 'console.log(process.env.NODE_ENV)';
    const result = runCli([
      'bin/tl-parallel.mjs',
      `NODE_ENV=tokenlean ${process.execPath} -e ${JSON.stringify(script)}`,
      '-j'
    ]);
    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.results[0].command.startsWith('NODE_ENV=tokenlean '), true);
    assert.strictEqual(parsed.results[0].stdout.trim(), 'tokenlean');
  });

  it('TLT-038: tl-parallel timeout terminates child process groups', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-parallel-timeout-'));
    const sentinel = join(tempDir, 'sentinel.txt');
    const script = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 800)`;

    try {
      const result = runCli([
        'bin/tl-parallel.mjs',
        '-T',
        '100',
        `${process.execPath} -e ${JSON.stringify(script)}`,
        '-q'
      ]);
      assert.strictEqual(result.status, 1, result.stdout || result.stderr);
      assert.match(result.stdout, /\[TIMEOUT\]/);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1100));
      assert.throws(() => readFileSync(sentinel, 'utf-8'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-029: tl doctor --agents includes agent integration checks', { skip: RG_SKIP }, () => {
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

  it('TLT-030: tl-hook run -j returns shared policy decisions', () => {
    const result = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'run', '-j'], {
      cwd: repoRoot,
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' }
      }),
      encoding: 'utf-8'
    });

    assert.strictEqual(result.status, 0, result.stdout || result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.decision.id, 'bash-test');
    assert.strictEqual(parsed.decision.alternative, 'tl run "npm test"');
  });

  it('TLT-030b: tl-hook deduplicates Codex nudges per session id', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-hook-seen-'));
    const env = {
      ...process.env,
      TMPDIR: tempDir,
      CODEX_THREAD_ID: 'codex-session-1',
      TL_HOOK_NUDGE_TTL_MS: '900000',
    };
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    try {
      const first = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'run', '--target', 'codex'], {
        cwd: repoRoot,
        env,
        input,
        encoding: 'utf-8'
      });
      const second = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'run', '--target', 'codex'], {
        cwd: repoRoot,
        env,
        input,
        encoding: 'utf-8'
      });

      assert.strictEqual(first.status, 0, first.stdout || first.stderr);
      assert.strictEqual(second.status, 0, second.stdout || second.stderr);
      assert.match(first.stdout, /\[tl\] wrap with tl-run/);
      assert.strictEqual(second.stdout, '');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-031: tl-hook install codex writes a managed hook block', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-codex-hooks-'));
    try {
      const result = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'install', 'codex'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir },
        encoding: 'utf-8'
      });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /Installed tokenlean hooks into Codex/);

      const config = readFileSync(join(tempDir, '.codex', 'config.toml'), 'utf-8');
      assert.match(config, /# tokenlean hooks: begin/);
      assert.match(config, /features\.codex_hooks = true/);
      assert.match(config, /\[\[hooks\.PreToolUse\]\]/);
      assert.match(config, /command = "tl-hook run --target codex"/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-032: tl-hook install codex preserves existing features table', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-codex-features-'));
    try {
      mkdirSync(join(tempDir, '.codex'), { recursive: true });
      writeFileSync(join(tempDir, '.codex', 'config.toml'), [
        '[features]',
        'fast_mode = true',
        '',
        '[mcp_servers.tokenlean]',
        'command = "tl"',
        ''
      ].join('\n'), 'utf-8');

      const install = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'install', 'codex'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir },
        encoding: 'utf-8'
      });
      assert.strictEqual(install.status, 0, install.stdout || install.stderr);

      const installedConfig = readFileSync(join(tempDir, '.codex', 'config.toml'), 'utf-8');
      assert.match(installedConfig, /\[features\]\ncodex_hooks = true # tokenlean-managed\nfast_mode = true/);
      assert.doesNotMatch(installedConfig, /features\.codex_hooks = true/);

      const uninstall = spawnSync(process.execPath, ['bin/tl-hook.mjs', 'uninstall', 'codex'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir },
        encoding: 'utf-8'
      });
      assert.strictEqual(uninstall.status, 0, uninstall.stdout || uninstall.stderr);

      const config = readFileSync(join(tempDir, '.codex', 'config.toml'), 'utf-8');
      assert.doesNotMatch(config, /tokenlean hooks: begin/);
      assert.doesNotMatch(config, /codex_hooks/);
      assert.match(config, /fast_mode = true/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-033: tl doctor --agents does not warn for missing project MCP when user config exists', { skip: RG_SKIP }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-doctor-user-mcp-'));
    try {
      mkdirSync(join(tempDir, '.codex'), { recursive: true });
      writeFileSync(join(tempDir, '.codex', 'config.toml'), [
        '[mcp_servers.tokenlean]',
        'command = "tl"',
        'args = ["mcp"]',
        ''
      ].join('\n'), 'utf-8');

      const result = spawnSync(process.execPath, ['bin/tl.mjs', 'doctor', '--agents'], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir },
        encoding: 'utf-8'
      });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /- project MCP: not configured \(\.mcp\.json\)/);
      assert.match(result.stdout, /✓ user-level tokenlean MCP\/config: reference found/);
      assert.doesNotMatch(result.stdout, /⚠ project MCP: tokenlean not found in \.mcp\.json/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TLT-060: tl push -A stages everything and bypasses the multi-file guard', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-push-all-'));
    const gitIn = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    try {
      gitIn('init', '-q');
      gitIn('config', 'user.email', 't@t.t');
      gitIn('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      gitIn('add', '-A');
      gitIn('commit', '-qm', 'init');
      // Two modified + one untracked → would trip the guard without -A.
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      writeFileSync(join(repo, 'b.txt'), 'b2\n');
      writeFileSync(join(repo, 'c.txt'), 'c\n');

      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin/tl-push.mjs'), 'feat: stage all', '-A', '--no-push'
      ], { cwd: repo, encoding: 'utf-8' });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const staged = spawnSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout;
      assert.match(staged, /a\.txt/);
      assert.match(staged, /b\.txt/);
      assert.match(staged, /c\.txt/); // untracked file included by -A
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('TLT-061: tl push without -A still guards multiple modified files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-push-guard-'));
    const gitIn = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    try {
      gitIn('init', '-q');
      gitIn('config', 'user.email', 't@t.t');
      gitIn('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      gitIn('add', '-A');
      gitIn('commit', '-qm', 'init');
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      writeFileSync(join(repo, 'b.txt'), 'b2\n');

      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin/tl-push.mjs'), 'feat: oops', '--no-push'
      ], { cwd: repo, encoding: 'utf-8' });

      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Multiple modified files/);
      assert.match(result.stderr, /use -A to stage all/);
      // Nothing should have been committed beyond init.
      const log = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' }).stdout.trim();
      assert.strictEqual(log.split('\n').length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('TLT-062: tl push -F reads a multi-line commit body from a file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-push-msgfile-'));
    const gitIn = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    try {
      gitIn('init', '-q');
      gitIn('config', 'user.email', 't@t.t');
      gitIn('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      gitIn('add', '-A');
      gitIn('commit', '-qm', 'init');
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      const msgPath = join(repo, 'msg.txt');
      writeFileSync(msgPath, 'subject line\n\nbody paragraph\n- a bullet\n');

      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin/tl-push.mjs'), '-F', msgPath, 'a.txt', '--no-push'
      ], { cwd: repo, encoding: 'utf-8' });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      // Human summary shows only the subject line.
      assert.match(result.stdout, /subject line/);
      assert.doesNotMatch(result.stdout.split('\n')[0], /a bullet/);
      // The committed message carries the full multi-line body.
      const body = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: repo, encoding: 'utf-8' }).stdout;
      assert.match(body, /subject line\n\nbody paragraph\n- a bullet/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('TLT-063: tl run surfaces node:test failure names and counts (not an empty failures array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenlean-run-nodetest-'));
    try {
      const testFile = join(dir, 'sample.test.mjs');
      writeFileSync(testFile, [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('passing one', () => { assert.equal(1, 1); });",
        "test('a failing case', () => { assert.equal(2, 3, 'two should equal three'); });"
      ].join('\n') + '\n', 'utf-8');

      // Strip the parent test-runner context so the inner `node --test` emits
      // its normal standalone output (otherwise it switches to child-reporter mode).
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;

      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin/tl-run.mjs'), `node --test ${testFile}`, '-j'
      ], { cwd: repoRoot, encoding: 'utf-8', env: childEnv });

      const parsed = JSON.parse(result.stdout);
      assert.match(parsed.summary, /1 passed/);
      assert.match(parsed.summary, /1 failed/);
      assert.ok(parsed.failures.length >= 1, 'failures array should not be empty');
      const failing = parsed.failures.find(f => /a failing case/.test(f.name));
      assert.ok(failing, `expected the failing test name to be surfaced, got ${JSON.stringify(parsed.failures)}`);
      assert.match(failing.message, /two should equal three|AssertionError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('TLT-064: tl diff surfaces untracked (new) files that git diff omits', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-diff-untracked-'));
    const gitIn = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    try {
      gitIn('init', '-q');
      gitIn('config', 'user.email', 't@t.t');
      gitIn('config', 'user.name', 't');
      writeFileSync(join(repo, 'tracked.txt'), 'a\n');
      gitIn('add', '-A');
      gitIn('commit', '-qm', 'init');
      writeFileSync(join(repo, 'tracked.txt'), 'a\nb\n');     // tracked modification
      writeFileSync(join(repo, 'brand-new.txt'), 'x\ny\nz\n'); // untracked new file

      const result = spawnSync(process.execPath, [
        join(repoRoot, 'bin/tl-diff.mjs'), '-j'
      ], { cwd: repo, encoding: 'utf-8' });

      assert.strictEqual(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      const newFile = parsed.files.find(f => f.path === 'brand-new.txt');
      assert.ok(newFile, `untracked file should be surfaced, got ${JSON.stringify(parsed.files.map(f => f.path))}`);
      assert.strictEqual(newFile.isNew, true);
      assert.strictEqual(newFile.additions, 3);
      // Tracked modification still present too.
      assert.ok(parsed.files.some(f => f.path === 'tracked.txt'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
