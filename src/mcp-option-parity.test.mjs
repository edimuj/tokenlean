import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOLS,
  browseArgs,
  diffArgs,
  impactArgs,
  tailArgs,
} from './mcp-tools.mjs';

function tool(name) {
  const found = TOOLS.find(candidate => candidate.name === name);
  assert.ok(found, `missing MCP tool ${name}`);
  return found;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

describe('MCP option parity', () => {
  it('maps impact depth/why and browse timeout/token/native options exactly', () => {
    assert.deepEqual(
      impactArgs({ file: 'src/api.ts', depth: 3, why: true }),
      ['src/api.ts', '--depth', '3', '--why', '-j'],
    );
    assert.deepEqual(
      browseArgs({ url: 'https://example.com', timeout: 2500, maxTokens: 800, noNative: true }),
      ['https://example.com', '--timeout', '2500', '-t', '800', '--no-native', '-j'],
    );
  });

  it('distinguishes input tailLines from summarized maxLines', () => {
    assert.deepEqual(
      tailArgs({ file: 'app.log', tailLines: 900, maxLines: 25 }),
      ['app.log', '--tail-lines', '900', '-l', '25', '-j'],
    );
    assert.throws(
      () => tailArgs({ file: 'app.log', maxLines: 25, lines: 30 }),
      /conflict/i,
    );
  });

  it('passes staged/breaking/stat-only diff flags and rejects staged plus ref', () => {
    assert.deepEqual(
      diffArgs({ file: 'src/api.ts', staged: true, breaking: true, statOnly: true }),
      ['--staged', '--breaking', '--stat-only', '--file', 'src/api.ts', '-j'],
    );
    assert.throws(
      () => diffArgs({ ref: 'main', staged: true }),
      /conflict/i,
    );
  });

  it('tl_tail actually limits source input with tailLines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-tail-lines-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, 'FIRST_UNIQUE_ERROR\nSECOND_UNIQUE_WARNING\n', 'utf8');

    try {
      const result = await tool('tl_tail').handler({ file: log, tailLines: 1, cwd: dir });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.totals.lines, 1);
      assert.equal(payload.recent[0].text, 'SECOND_UNIQUE_WARNING');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tl_diff runs staged breaking-change detection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-diff-options-'));
    const file = join(dir, 'api.js');

    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      writeFileSync(file, 'export function removedApi(value) { return value; }\n', 'utf8');
      git(dir, 'add', 'api.js');
      git(dir, 'commit', '-qm', 'initial');
      writeFileSync(file, 'export function replacementApi(value) { return value; }\n', 'utf8');
      git(dir, 'add', 'api.js');

      const result = await tool('tl_diff').handler({ staged: true, breaking: true, cwd: dir });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.totalFiles, 1);
      assert.ok(payload.breakingChanges?.[0]?.removed.includes('removedApi'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
