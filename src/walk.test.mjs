import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunctionIndex, clearFunctionIndexCache } from './walk.mjs';

describe('incremental function index', () => {
  let dir;

  afterEach(() => {
    clearFunctionIndexCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reuses unchanged files and reparses only an edited file', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-walk-'));
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    writeFileSync(a, 'function alpha() { return 1; }\n');
    writeFileSync(b, 'function beta() { return 2; }\n');

    const first = buildFunctionIndex(dir, { includeContracts: true });
    assert.equal(first.indexedFiles, 2);
    assert.equal(first.cacheHits, 0);

    const second = buildFunctionIndex(dir, { includeContracts: true });
    assert.equal(second.indexedFiles, 0);
    assert.equal(second.cacheHits, 2);

    writeFileSync(a, 'function alphaChanged() { return 1000; }\n');
    const third = buildFunctionIndex(dir, { includeContracts: true });
    assert.equal(third.indexedFiles, 1);
    assert.equal(third.cacheHits, 1);
    assert.deepEqual(third.functions.map(fn => fn.name).sort(), ['alphaChanged', 'beta']);
  });
});
