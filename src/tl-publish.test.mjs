import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const bin = join(repoRoot, 'bin', 'tl-publish.mjs');

function run(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

describe('tl-publish arg handling', () => {
  it('shows help with the availability-gate purpose', () => {
    const res = run(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /availability gate/i);
  });

  it('emits prompt metadata', () => {
    const res = run(['--prompt']);
    assert.equal(res.status, 0);
    const meta = JSON.parse(res.stdout);
    assert.equal(meta.name, 'tl-publish');
  });

  it('rejects unknown arguments with exit 2', () => {
    const res = run(['frobnicate']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown argument/);
  });

  it('requires a command after --verify', () => {
    const res = run(['--verify']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--verify requires/);
  });

  it('rejects a non-numeric --timeout', () => {
    const res = run(['--timeout', 'soon']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--timeout requires/);
  });
});

describe('tl-publish dry-run', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-publish-test-'));
    writeFileSync(join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-pkg', version: '1.2.3' }, null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('plans bump + publish + push + gate + install for "patch -g"', () => {
    const res = run(['patch', '-g', '--verify', 'demo --help', '--dry-run'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /npm version patch/);
    assert.match(res.stdout, /npm publish/);
    assert.match(res.stdout, /git push --follow-tags/);
    assert.match(res.stdout, /npm view demo-pkg@.* --prefer-online/);
    assert.match(res.stdout, /npm install -g demo-pkg@.* --prefer-online/);
    assert.match(res.stdout, /demo --help/);
  });

  it('omits bump and push when no bump arg is given', () => {
    const res = run(['--dry-run'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /npm version/);
    assert.doesNotMatch(res.stdout, /git push/);
    assert.match(res.stdout, /npm publish/);
  });

  it('omits the gate line under --no-wait', () => {
    const res = run(['--no-wait', '--dry-run'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /poll:/);
  });
});
