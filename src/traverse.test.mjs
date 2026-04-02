import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateTokensFromSize,
  isRipgrepAvailable,
  listFilesWithRipgrep,
  traverseDirectory,
  listFiles,
  getDirectoryStats,
  batchRipgrep
} from './traverse.mjs';

// ─────────────────────────────────────────────────────────────
// Fixture: create a temp directory with known structure
// ─────────────────────────────────────────────────────────────
let tmpDir;

before(() => {
  tmpDir = join(tmpdir(), `tl-traverse-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  // src/
  mkdirSync(join(tmpDir, 'src'));
  writeFileSync(join(tmpDir, 'src', 'main.mjs'), 'export function main() {}\n');
  writeFileSync(join(tmpDir, 'src', 'utils.mjs'), 'export function helper() {}\nexport const MAX = 10;\n');

  // lib/
  mkdirSync(join(tmpDir, 'lib'));
  writeFileSync(join(tmpDir, 'lib', 'data.json'), '{"key": "value"}\n');

  // Root files
  writeFileSync(join(tmpDir, 'package.json'), '{"name": "test"}\n');
  writeFileSync(join(tmpDir, 'README.md'), '# Test\n');

  // node_modules/ (should be skipped)
  mkdirSync(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');

  // Binary files (should be skipped by extension)
  writeFileSync(join(tmpDir, 'image.jpg'), Buffer.from([0xFF, 0xD8, 0xFF]));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// estimateTokensFromSize
// ─────────────────────────────────────────────────────────────

describe('estimateTokensFromSize', () => {
  it('estimates ~4 bytes per token', () => {
    assert.equal(estimateTokensFromSize(400), 100);
  });

  it('rounds up', () => {
    assert.equal(estimateTokensFromSize(401), 101);
    assert.equal(estimateTokensFromSize(1), 1);
  });

  it('returns 0 for empty', () => {
    assert.equal(estimateTokensFromSize(0), 0);
  });
});

// ─────────────────────────────────────────────────────────────
// isRipgrepAvailable
// ─────────────────────────────────────────────────────────────

describe('isRipgrepAvailable', () => {
  it('returns a boolean', () => {
    const result = isRipgrepAvailable();
    assert.equal(typeof result, 'boolean');
  });

  it('returns true on this system (rg is installed)', () => {
    assert.equal(isRipgrepAvailable(), true);
  });
});

// ─────────────────────────────────────────────────────────────
// traverseDirectory
// ─────────────────────────────────────────────────────────────

describe('traverseDirectory', () => {
  it('returns root DirInfo with correct structure', () => {
    const result = traverseDirectory(tmpDir);
    assert.equal(result.type, 'dir');
    assert.ok(result.children.length > 0);
    assert.ok(typeof result.totalSize === 'number');
    assert.ok(typeof result.totalTokens === 'number');
    assert.ok(typeof result.fileCount === 'number');
  });

  it('skips node_modules', () => {
    const result = traverseDirectory(tmpDir);
    const names = result.children.map(c => c.name);
    assert.ok(!names.includes('node_modules'), 'should skip node_modules');
  });

  it('skips binary extensions', () => {
    const result = traverseDirectory(tmpDir);
    const allFiles = [];
    function collect(node) {
      if (node.type === 'file') allFiles.push(node.name);
      if (node.children) node.children.forEach(collect);
    }
    collect(result);
    assert.ok(!allFiles.includes('image.jpg'), 'should skip .jpg files');
  });

  it('includes src directory', () => {
    const result = traverseDirectory(tmpDir);
    const srcDir = result.children.find(c => c.name === 'src');
    assert.ok(srcDir, 'should include src/');
    assert.equal(srcDir.type, 'dir');
    assert.ok(srcDir.children.length >= 2, 'src/ should have at least 2 files');
  });

  it('marks important dirs and files', () => {
    const result = traverseDirectory(tmpDir);
    const srcDir = result.children.find(c => c.name === 'src');
    assert.ok(srcDir?.important, 'src/ should be marked important');

    const pkgJson = result.children.find(c => c.name === 'package.json');
    assert.ok(pkgJson?.important, 'package.json should be marked important');
  });

  it('respects maxDepth', () => {
    const result = traverseDirectory(tmpDir, { maxDepth: 0 });
    // At depth 0, children should include direct children but dirs should be empty
    const srcDir = result.children.find(c => c.name === 'src');
    if (srcDir) {
      assert.equal(srcDir.children.length, 0, 'depth-limited dirs should have no children');
    }
  });

  it('handles includeFiles=false', () => {
    const result = traverseDirectory(tmpDir, { includeFiles: false });
    const allFiles = [];
    function collect(node) {
      if (node.type === 'file') allFiles.push(node);
      if (node.children) node.children.forEach(collect);
    }
    collect(result);
    assert.equal(allFiles.length, 0, 'should have no file children');
    assert.ok(result.fileCount > 0, 'but should still count files');
  });

  it('includes file stats (size, tokens)', () => {
    const result = traverseDirectory(tmpDir);
    const allFiles = [];
    function collect(node) {
      if (node.type === 'file') allFiles.push(node);
      if (node.children) node.children.forEach(collect);
    }
    collect(result);

    for (const f of allFiles) {
      assert.ok(typeof f.size === 'number', `${f.name} should have size`);
      assert.ok(f.size > 0, `${f.name} should have positive size`);
      assert.ok(typeof f.tokens === 'number', `${f.name} should have tokens`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// listFiles
// ─────────────────────────────────────────────────────────────

describe('listFiles', () => {
  it('returns flat array of files', () => {
    const files = listFiles(tmpDir, { useRipgrep: false });
    assert.ok(Array.isArray(files));
    assert.ok(files.length > 0);
  });

  it('includes relativePath', () => {
    const files = listFiles(tmpDir, { useRipgrep: false });
    for (const f of files) {
      assert.ok(f.relativePath, `${f.name} should have relativePath`);
      assert.ok(!f.relativePath.startsWith('/'), 'relativePath should be relative');
    }
  });

  it('skips node_modules files', () => {
    const files = listFiles(tmpDir, { useRipgrep: false });
    const inNodeModules = files.filter(f => f.relativePath.includes('node_modules'));
    assert.equal(inNodeModules.length, 0, 'should not include node_modules files');
  });

  it('includes important flag', () => {
    const files = listFiles(tmpDir, { useRipgrep: false });
    const pkgJson = files.find(f => f.name === 'package.json');
    assert.ok(pkgJson, 'should include package.json');
    assert.equal(pkgJson.important, true);
  });
});

// ─────────────────────────────────────────────────────────────
// getDirectoryStats
// ─────────────────────────────────────────────────────────────

describe('getDirectoryStats', () => {
  it('returns fileCount, totalSize, totalTokens', () => {
    const stats = getDirectoryStats(tmpDir);
    assert.ok(typeof stats.fileCount === 'number');
    assert.ok(typeof stats.totalSize === 'number');
    assert.ok(typeof stats.totalTokens === 'number');
    assert.ok(stats.fileCount > 0);
    assert.ok(stats.totalSize > 0);
    assert.ok(stats.totalTokens > 0);
  });
});

// ─────────────────────────────────────────────────────────────
// batchRipgrep
// ─────────────────────────────────────────────────────────────

describe('batchRipgrep', () => {
  it('returns results keyed by pattern', () => {
    const result = batchRipgrep(['function', 'export'], 'src/shell.mjs');
    assert.ok('function' in result);
    assert.ok('export' in result);
    assert.ok(result['function'].length > 0);
    assert.ok(result['export'].length > 0);
  });

  it('returns empty arrays for no-match patterns', () => {
    const result = batchRipgrep(['zzz_nonexistent_xyz'], 'src/shell.mjs');
    assert.deepEqual(result['zzz_nonexistent_xyz'], []);
  });

  it('returns empty object for empty patterns', () => {
    const result = batchRipgrep([], 'src/shell.mjs');
    assert.deepEqual(Object.keys(result), []);
  });

  it('includes file, line, content in matches', () => {
    const result = batchRipgrep(['gitCommand'], 'src/shell.mjs');
    const matches = result['gitCommand'];
    assert.ok(matches.length > 0);
    assert.ok(matches[0].file);
    assert.ok(typeof matches[0].line === 'number');
    assert.ok(matches[0].content);
  });

  it('supports filesOnly mode', () => {
    const result = batchRipgrep(['function'], 'src/shell.mjs', { filesOnly: true });
    const matches = result['function'];
    assert.ok(matches.length > 0);
    assert.ok(matches[0].file);
    assert.equal(matches[0].line, undefined, 'filesOnly should not include line numbers');
  });

  it('deduplicates files in filesOnly mode', () => {
    const result = batchRipgrep(['function'], 'src/shell.mjs', { filesOnly: true });
    const files = result['function'].map(m => m.file);
    assert.deepEqual(files, [...new Set(files)], 'no duplicate files');
  });

  it('supports word boundary mode', () => {
    // "git" as a word boundary should match, "gi" should not
    const result = batchRipgrep(['git'], 'src/shell.mjs', { wordBoundary: true });
    assert.ok(result['git'].length > 0, 'should find "git" as whole word');
  });

  it('supports glob filters', () => {
    const result = batchRipgrep(['export'], 'src/', { globs: ['*.mjs'] });
    assert.ok(result['export'].length > 0);
    for (const m of result['export']) {
      assert.ok(m.file.endsWith('.mjs'), 'all matches should be in .mjs files');
    }
  });
});
