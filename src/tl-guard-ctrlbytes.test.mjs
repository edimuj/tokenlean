import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const guardBin = join(repoRoot, 'bin', 'tl-guard.mjs');

// Only exercise the ctrlbytes check — the others need network/project shape.
const ISOLATE = ['--no-secrets', '--no-todos', '--no-unused', '--no-circular'];

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function runGuard(cwd, extra = []) {
  const res = spawnSync(process.execPath, [guardBin, ...ISOLATE, ...extra, '-j'], {
    cwd, encoding: 'utf8'
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* non-json (e.g. quiet) */ }
  return { ...res, json };
}

describe('tl-guard ctrlbytes check', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-guard-ctrl-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 't@t.t'], dir);
    git(['config', 'user.name', 't'], dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeBytes(name, bytes) {
    writeFileSync(join(dir, name), Buffer.from(bytes));
  }
  function add() { git(['add', '-A'], dir); }

  it('passes a clean repo', () => {
    writeFileSync(join(dir, 'ok.ts'), 'export const x = 1;\n');
    add();
    const { json } = runGuard(dir);
    assert.equal(json.checks.ctrlbytes.status, 'pass');
    assert.equal(json.checks.ctrlbytes.count, 0);
  });

  it('flags a raw NUL in a source file, reporting offset and byte name', () => {
    // `const s = "a\0b";` — NUL at byte 12
    writeBytes('runner.ts', [...Buffer.from('const s = "a'), 0x00, ...Buffer.from('b";\n')]);
    add();
    const { json } = runGuard(dir);
    const c = json.checks.ctrlbytes;
    assert.equal(c.status, 'warn');
    assert.equal(c.count, 1);
    assert.equal(c.details[0].file, 'runner.ts');
    assert.equal(c.details[0].name, 'NUL');
    assert.equal(c.details[0].offset, 12);
  });

  it('flags a raw ESC byte', () => {
    writeBytes('color.ts', [...Buffer.from('const c = "'), 0x1b, ...Buffer.from('[31m";\n')]);
    add();
    const { json } = runGuard(dir);
    assert.equal(json.checks.ctrlbytes.status, 'warn');
    assert.equal(json.checks.ctrlbytes.details[0].name, 'ESC');
  });

  it('does NOT flag a genuine binary without a known extension', () => {
    // Dense control bytes (a real/compressed binary signature), no extension.
    const bytes = [];
    for (let i = 0; i < 256; i++) bytes.push(i % 256); // includes many control bytes
    writeBytes('blob', bytes);
    add();
    const { json } = runGuard(dir);
    assert.equal(json.checks.ctrlbytes.status, 'pass');
  });

  it('skips files with known binary extensions even if they contain NUL', () => {
    writeBytes('logo.png', [0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]);
    add();
    const { json } = runGuard(dir);
    assert.equal(json.checks.ctrlbytes.status, 'pass');
  });

  it('--strict turns a control-byte finding into a hard failure', () => {
    writeBytes('runner.ts', [...Buffer.from('x'), 0x00, ...Buffer.from('\n')]);
    add();
    const warn = runGuard(dir);
    assert.equal(warn.status, 0, 'warn-only without --strict');
    const strict = runGuard(dir, ['--strict']);
    assert.equal(strict.status, 1, '--strict should exit 1');
  });

  it('--no-ctrlbytes disables the check', () => {
    writeBytes('runner.ts', [...Buffer.from('x'), 0x00, ...Buffer.from('\n')]);
    add();
    const { json } = runGuard(dir, ['--no-ctrlbytes']);
    assert.equal(json.checks.ctrlbytes, undefined);
  });
});
