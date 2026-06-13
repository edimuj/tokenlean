import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pushBin = join(repoRoot, 'bin', 'tl-push.mjs');

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function runPush(args, cwd) {
  return spawnSync(process.execPath, [pushBin, ...args], { cwd, encoding: 'utf8' });
}

describe('tl-push in-progress operation guard', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-push-test-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], dir);
    git(['commit', '-qm', 'initial'], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function headHash() {
    return git(['rev-parse', 'HEAD'], dir).stdout.trim();
  }

  it('refuses with exit 2 when mid-rebase, without creating a commit', () => {
    // Fake an interactive rebase in progress.
    mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const before = headHash();

    const res = runPush(['feat: should be refused', '--no-push'], dir);

    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /mid-rebase/);
    assert.equal(headHash(), before, 'no commit should have been created');
  });

  it('refuses when mid-merge', () => {
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${headHash()}\n`);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');

    const res = runPush(['feat: refused', '--no-push'], dir);

    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /mid-merge/);
  });

  it('refuses an --amend during a cherry-pick', () => {
    writeFileSync(join(dir, '.git', 'CHERRY_PICK_HEAD'), `${headHash()}\n`);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const before = headHash();

    const res = runPush(['--amend', '--no-push'], dir);

    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /mid-cherry-pick/);
    assert.equal(headHash(), before);
  });

  it('refuses even under --dry-run', () => {
    writeFileSync(join(dir, '.git', 'REVERT_HEAD'), `${headHash()}\n`);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');

    const res = runPush(['feat: refused', '--dry-run'], dir);

    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /mid-revert/);
  });

  it('allows a normal commit when no operation is in progress', () => {
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const before = headHash();

    const res = runPush(['feat: ok', '--no-push'], dir);

    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(headHash(), before, 'a commit should have been created');
  });
});

describe('tl-push branch detection (vent #105)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-push-branch-'));
    git(['init', '-q'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', 'a.txt'], dir);
    git(['commit', '-qm', 'initial'], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('still refuses a genuinely detached HEAD', () => {
    // Detach onto the current commit. All branch sources fail affirmatively, so
    // the guard must still fire — the #105 fix must not blind the real check.
    const head = git(['rev-parse', 'HEAD'], dir).stdout.trim();
    git(['checkout', '-q', '--detach', head], dir);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');

    const res = runPush(['feat: nope', '--no-push'], dir);

    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /detached HEAD/);
  });

  it('commits on a non-default branch name (detection resolves the real branch)', () => {
    git(['checkout', '-q', '-b', 'trunk'], dir);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const before = git(['rev-parse', 'HEAD'], dir).stdout.trim();

    const res = runPush(['feat: on trunk', '--no-push'], dir);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /on trunk/);
    assert.notEqual(git(['rev-parse', 'HEAD'], dir).stdout.trim(), before);
  });
});
