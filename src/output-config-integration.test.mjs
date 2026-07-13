import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const structureCli = fileURLToPath(new URL('../bin/tl-structure.mjs', import.meta.url));
const lookupCli = fileURLToPath(new URL('../bin/tl-lookup.mjs', import.meta.url));

describe('configured output production path', () => {
  it('applies .tokenleanrc maxLines/maxTokens to emitted CLI JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-output-cli-'));
    const source = join(root, 'src');
    mkdirSync(source);
    writeFileSync(join(root, '.tokenleanrc.json'), JSON.stringify({
      output: { maxLines: 2, maxTokens: 500 }
    }));
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(source, `${String(i).padStart(2, '0')}-${'long-name-'.repeat(5)}.js`), `export const n${i} = ${i};\n`);
    }

    try {
      const result = spawnSync(process.execPath, [structureCli, '.', '-j'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim().length <= 2000, `JSON was ${result.stdout.trim().length} chars`);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.truncated, true);
      assert.strictEqual(parsed.pagination.limit, 2);
      assert.strictEqual(parsed.pagination.collections[0].returnedItems, 2);
      assert.deepStrictEqual(parsed.continuation.arguments, { offset: 2, maxItems: 2, maxTokens: 500 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('paginates lookup JSON without turning configured maxLines into a search limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-output-lookup-'));
    const source = join(root, 'src');
    mkdirSync(source);
    writeFileSync(join(root, '.tokenleanrc.json'), JSON.stringify({
      output: { maxLines: 2, maxTokens: 1000 }
    }));
    writeFileSync(join(source, 'formatters.js'), Array.from({ length: 6 }, (_, i) =>
      `export function formatValue${i}(value) { return String(value); }`).join('\n'));

    try {
      const firstRun = spawnSync(process.execPath, [lookupCli, 'format value', source, '-j'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
      });
      assert.strictEqual(firstRun.status, 0, firstRun.stderr);
      const first = JSON.parse(firstRun.stdout);
      assert.strictEqual(first.matches.length, 2);
      assert.strictEqual(first.pagination.collections[0].totalItems, 6);

      const secondRun = spawnSync(process.execPath, [lookupCli, 'format value', source, '-j', '--offset', '2'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
      });
      assert.strictEqual(secondRun.status, 0, secondRun.stderr);
      const second = JSON.parse(secondRun.stdout);
      assert.strictEqual(second.matches.length, 2);
      assert.notDeepStrictEqual(first.matches.map(match => match.name), second.matches.map(match => match.name));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
