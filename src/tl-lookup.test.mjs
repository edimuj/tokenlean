import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const bin = join(repoRoot, 'bin', 'tl-lookup.mjs');

function run(args, cwd = repoRoot) {
  const res = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text */ }
  return { ...res, json };
}

describe('tl-lookup CLI', () => {
  it('shows help', () => {
    const res = run(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Find existing functions/i);
  });

  it('emits prompt metadata', () => {
    assert.equal(JSON.parse(run(['--prompt']).stdout).name, 'tl-lookup');
  });

  it('requires a query', () => {
    const res = run([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /query is required/);
  });

  it('rejects unknown flags', () => {
    const res = run(['x', '--frobnicate']);
    assert.equal(res.status, 2);
  });
});

describe('tl-lookup search', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-lookup-'));
    writeFileSync(join(dir, 'util.js'),
      'function stripAnsi(s) {\n  return s.replace(/\\x1b\\[[0-9;]*m/g, "");\n}\n');
    writeFileSync(join(dir, 'other.js'),
      'function unrelatedThing() {\n  return doSomethingEntirely();\n}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds an existing function by name (JSON)', () => {
    const { json, status } = run(['stripAnsi', '.', '-j'], dir);
    assert.equal(status, 0);
    assert.ok(json.matches.length >= 1);
    assert.equal(json.matches[0].name, 'stripAnsi');
    assert.ok(json.matches[0].score >= 0.9);
  });

  it('finds by intent phrase', () => {
    const { json } = run(['strip ansi codes', '.', '-j'], dir);
    assert.equal(json.matches[0].name, 'stripAnsi');
  });

  it('reports nothing for a novel query', () => {
    const { json, status } = run(['quantum teleporter', '.', '-j'], dir);
    assert.equal(status, 0);
    assert.deepEqual(json.matches, []);
  });
});
