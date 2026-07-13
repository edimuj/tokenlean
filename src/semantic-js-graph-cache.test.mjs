import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from './cache.mjs';
import {
  clearJsTsGraphMemoryCache,
  getJsTsGraphMemoryStats,
  getJsTsProjectGraph
} from './semantic-js-graph.mjs';

describe('semantic JS graph cache invalidation', () => {
  it('rebuilds after an importer is edited again while already dirty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-semantic-graph-cache-'));
    const base = join(dir, 'base.js');
    const consumer = join(dir, 'consumer.js');
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

    try {
      clearJsTsGraphMemoryCache();
      git('init', '-q');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
      writeFileSync(base, 'export const value = 1;\n');
      writeFileSync(consumer, 'export const consumer = 0;\n');
      git('add', '.');
      git('commit', '-qm', 'init');

      writeFileSync(consumer, "import { value } from './base.js';\nexport const consumer = value;\n");
      const first = getJsTsProjectGraph(base, { projectRoot: dir });
      assert.equal(first.reverseImports['base.js']?.length, 1);

      const warm = getJsTsProjectGraph(base, { projectRoot: dir });
      assert.strictEqual(warm.files, first.files, 'unchanged graph should be reused by reference');
      assert.equal(getJsTsGraphMemoryStats().hits, 1);

      writeFileSync(consumer, 'export const consumer = 2;\n');
      const second = getJsTsProjectGraph(base, { projectRoot: dir });
      assert.deepEqual(second.reverseImports['base.js'] || [], []);
      assert.equal(getJsTsGraphMemoryStats().incrementalUpdates, 1);
      assert.strictEqual(second.files['base.js'], first.files['base.js'], 'unchanged AST node should be retained');
      assert.notStrictEqual(second.files['consumer.js'], first.files['consumer.js'], 'dirty AST node should be rebuilt');
    } finally {
      clearJsTsGraphMemoryCache();
      clearCache(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
