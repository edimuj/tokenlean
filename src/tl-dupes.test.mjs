import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const bin = join(repoRoot, 'bin', 'tl-dupes.mjs');

function run(args, cwd = repoRoot) {
  const res = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text mode */ }
  return { ...res, json };
}

describe('tl-dupes CLI', () => {
  it('shows help', () => {
    const res = run(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /duplicate and near-duplicate functions/i);
  });

  it('emits prompt metadata', () => {
    const res = run(['--prompt']);
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).name, 'tl-dupes');
  });

  it('rejects unknown flags', () => {
    const res = run(['--frobnicate']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown argument/);
  });
});

describe('tl-dupes detection', () => {
  let dir;
  const body = 'const out = []; for (const x of input) { if (x.ok) { out.push(x.id); } } return out;';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-dupes-'));
    writeFileSync(join(dir, 'a.js'), `function getId() {\n  ${body}\n}\n`);
    writeFileSync(join(dir, 'b.js'), `function fetchId() {\n  ${body}\n}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects an exact duplicate across files (JSON)', () => {
    const { json, status } = run(['.', '-j'], dir);
    assert.equal(status, 0);
    assert.equal(json.exact.length, 1);
    assert.equal(json.exact[0].count, 2);
    const names = json.exact[0].members.map(m => m.name).sort();
    assert.deepEqual(names, ['fetchId', 'getId']);
  });

  it('--strict exits 1 when duplicates exist', () => {
    const res = run(['.', '--strict'], dir);
    assert.equal(res.status, 1);
  });

  it('exits 0 when no duplicates', () => {
    rmSync(join(dir, 'b.js'));
    const res = run(['.', '--strict'], dir);
    assert.equal(res.status, 0);
  });

  it('--exact-only suppresses the names/structural tiers', () => {
    const { json } = run(['.', '--exact-only', '-j'], dir);
    assert.ok(json.exact.length >= 1);
    assert.equal(json.names, undefined);
    assert.equal(json.structural, undefined);
  });
});
