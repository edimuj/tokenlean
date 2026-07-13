import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function runTool(tool, args, cwd = repoRoot) {
  return spawnSync(process.execPath, [join(repoRoot, 'bin', `tl-${tool}.mjs`), ...args], {
    cwd,
    encoding: 'utf-8',
  });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result;
}

describe('MCP CLI underlay regressions', () => {
  it('does not return a same-named method from a different class', () => {
    const result = runTool('snippet', ['DefinitelyNotOutput.render', 'src/output.mjs', '-j']);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);

    assert.deepStrictEqual(parsed.results, []);
    assert.strictEqual(parsed.totalDefinitions, 0);
  });

  it('tl-diff honors --file safely and reports exact numstat counts', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-diff-file-'));
    const target = '-odd name.txt';
    const other = 'other.txt';

    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      writeFileSync(join(repo, target), 'remove-a\nremove-b\nkeep\n', 'utf-8');
      writeFileSync(join(repo, other), 'before\n', 'utf-8');
      git(repo, 'add', '--', target, other);
      git(repo, 'commit', '-qm', 'initial');

      writeFileSync(join(repo, target), [
        'keep',
        ...Array.from({ length: 15 }, (_, i) => `added-${i + 1}`),
      ].join('\n') + '\n', 'utf-8');
      writeFileSync(join(repo, other), 'after\n', 'utf-8');

      const result = runTool('diff', ['HEAD', '--file', target, '-j'], repo);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.totalFiles, 1);
      assert.strictEqual(parsed.files[0].path, target);
      assert.strictEqual(parsed.files[0].additions, 15);
      assert.strictEqual(parsed.files[0].deletions, 2);
      assert.strictEqual(parsed.files[0].changes, 17);
      assert.strictEqual(parsed.totalAdditions, 15);
      assert.strictEqual(parsed.totalDeletions, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('tl-diff reports invalid git refs as structured failures', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tokenlean-diff-error-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Test');
      writeFileSync(join(repo, 'file.txt'), 'content\n', 'utf-8');
      git(repo, 'add', 'file.txt');
      git(repo, 'commit', '-qm', 'initial');

      const result = runTool('diff', ['definitely-not-a-ref', '-j'], repo);
      assert.notStrictEqual(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.strictEqual(parsed.ok, false);
      assert.match(parsed.error.message, /ambiguous argument|unknown revision|bad revision/i);
      assert.match(parsed.error.command, /git diff/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('tl-entry includes its entry-point buckets in JSON', () => {
    const project = mkdtempSync(join(tmpdir(), 'tokenlean-entry-json-'));
    try {
      writeFileSync(join(project, 'package.json'), '{"name":"entry-json"}\n', 'utf-8');
      writeFileSync(join(project, 'index.js'), [
        'const app = express();',
        'app.listen(3000);',
      ].join('\n') + '\n', 'utf-8');

      const result = runTool('entry', ['.', '--type', 'main', '-j'], project);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);

      assert.ok(parsed.entryPoints.main);
      assert.ok(parsed.entryPoints.main.entries.some(entry => entry.file === 'index.js'));
      assert.ok(parsed.totalEntries >= 1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('tl-context JSON honors both --top and --all', () => {
    const project = mkdtempSync(join(tmpdir(), 'tokenlean-context-json-'));
    try {
      writeFileSync(join(project, 'one.js'), '1'.repeat(400), 'utf-8');
      writeFileSync(join(project, 'two.js'), '2'.repeat(300), 'utf-8');
      writeFileSync(join(project, 'three.js'), '3'.repeat(200), 'utf-8');

      const topResult = runTool('context', ['.', '--top', '1', '-j'], project);
      assert.strictEqual(topResult.status, 0, topResult.stderr || topResult.stdout);
      const top = JSON.parse(topResult.stdout);
      assert.strictEqual(top.files.length, 1);
      assert.strictEqual(top.files[0].path, 'one.js');

      const allResult = runTool('context', ['.', '--all', '-j'], project);
      assert.strictEqual(allResult.status, 0, allResult.stderr || allResult.stdout);
      const all = JSON.parse(allResult.stdout);
      assert.strictEqual(all.files.length, 3);
      assert.strictEqual(all.fileCount, 3);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('tl-analyze exposes partial section failures instead of omitting them', () => {
    const project = mkdtempSync(join(tmpdir(), 'tokenlean-analyze-partial-'));
    try {
      writeFileSync(join(project, 'package.json'), '{"name":"analyze-partial"}\n', 'utf-8');
      writeFileSync(join(project, 'notes.txt'), 'not a source file\n', 'utf-8');

      const result = runTool('analyze', ['notes.txt', '-j'], project);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);

      assert.strictEqual(parsed.partial, true);
      assert.strictEqual(parsed.partialFailure, true);
      assert.strictEqual(parsed.sections.symbols.status, 'error');
      assert.match(parsed.sections.symbols.error, /not a code file/i);
      assert.ok(parsed.errors.some(error => error.name === 'symbols'));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('tl-advise excludes unrelated numbers from grammatical issue references', () => {
    const closeResult = runTool('advise', ['close issue 12 after 3 tests pass', '-j']);
    assert.strictEqual(closeResult.status, 0, closeResult.stderr || closeResult.stdout);
    const close = JSON.parse(closeResult.stdout);
    assert.match(close.suggestions[1].command, /issue close -R owner\/repo 12 /);
    assert.doesNotMatch(close.suggestions[1].command, /\b3\b/);

    const listResult = runTool('advise', ['triage issues 12, 13 and 14 by 2026', '-j']);
    assert.strictEqual(listResult.status, 0, listResult.stderr || listResult.stdout);
    const list = JSON.parse(listResult.stdout);
    assert.match(list.suggestions[1].command, /12 13 14$/);
    assert.doesNotMatch(list.suggestions[1].command, /2026/);
  });
});
