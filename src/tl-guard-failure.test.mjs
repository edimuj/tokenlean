import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const guardBin = join(repoRoot, 'bin', 'tl-guard.mjs');

describe('tl-guard execution failures', () => {
  it('reports an enabled search check as error and exits nonzero when rg cannot run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-guard-search-failure-'));
    try {
      const result = spawnSync(process.execPath, [
        guardBin,
        '--no-secrets',
        '--no-todos',
        '--no-unused',
        '--no-ctrlbytes',
        '-j'
      ], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: dir }
      });

      assert.equal(result.status, 1, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.checks.circular.status, 'error');
      assert.match(parsed.checks.circular.error, /rg search failed|ENOENT/i);
      assert.equal(parsed.summary.errors, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats git-dependent checks as non-applicable outside a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-guard-git-failure-'));
    try {
      const result = spawnSync(process.execPath, [
        guardBin,
        '--no-unused',
        '--no-circular',
        '-j'
      ], { cwd: dir, encoding: 'utf8' });

      assert.equal(result.status, 0, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.checks.secrets.status, 'pass');
      assert.equal(parsed.checks.todos.status, 'pass');
      assert.equal(parsed.checks.ctrlbytes.status, 'pass');
      assert.match(parsed.checks.ctrlbytes.note, /not applicable/i);
      assert.equal(parsed.summary.errors, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a git check is applicable but git cannot execute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-guard-git-exec-failure-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);

      const result = spawnSync(process.execPath, [
        guardBin,
        '--no-todos',
        '--no-unused',
        '--no-circular',
        '--no-ctrlbytes',
        '-j'
      ], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: dir }
      });

      assert.equal(result.status, 1, result.stdout || result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.checks.secrets.status, 'error');
      assert.match(parsed.checks.secrets.error, /staged file list/i);
      assert.equal(parsed.summary.errors, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
