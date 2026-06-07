import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from './mcp-tools.mjs';

describe('MCP tool definitions', () => {
  it('exposes context-governor tools', () => {
    const names = new Set(TOOLS.map(tool => tool.name));

    assert.ok(names.has('tl_advise'));
    assert.ok(names.has('tl_pack'));
    assert.ok(names.has('tl_analyze'));
    assert.ok(names.has('tl_related'));
    assert.ok(names.has('tl_context'));
    assert.ok(names.has('tl_structure'));
    assert.ok(names.has('tl_entry'));
    assert.ok(names.has('tl_gh_issue_read'));
    assert.ok(names.has('tl_gh_issue_close'));
  });

  it('tl_symbols accepts structured file arrays so paths with spaces survive', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-symbols-'));
    const spacedDir = join(tempDir, 'space dir');
    const filePath = join(spacedDir, 'api file.js');
    const symbolsTool = TOOLS.find(tool => tool.name === 'tl_symbols');

    try {
      mkdirSync(spacedDir);
      writeFileSync(filePath, 'export function spacedName() { return 1; }\n', 'utf-8');
      const result = await symbolsTool.handler({ files: [filePath] });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const parsed = JSON.parse(result.content[0].text);
      assert.strictEqual(parsed.symbols.functions[0], 'export function spacedName()');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_run respects explicit cwd for shared MCP server sessions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-cwd-'));
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');

    try {
      const result = await runTool.handler({
        command: 'node -e "process.stdout.write(process.cwd())"',
        raw: true,
        cwd: tempDir,
      });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const parsed = JSON.parse(result.content[0].text);
      assert.strictEqual(parsed.stdout, tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_run treats small MCP timeout values as seconds', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const result = await runTool.handler({
      command: 'node -e "setTimeout(() => process.stdout.write(\'ok\'), 50)"',
      raw: true,
      timeout: 1,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.exitCode, 0);
    assert.strictEqual(parsed.stdout, 'ok');
    assert.notStrictEqual(parsed.type, 'timeout');
  });

  it('tl_pack debug does not execute prose targets from MCP calls', async () => {
    const packTool = TOOLS.find(tool => tool.name === 'tl_pack');
    const result = await packTool.handler({
      pack: 'debug',
      target: 'delivery attempts dead-letter observability issue 43',
      budget: 900,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);
    const output = parsed.sections[0].output.join('\n');

    assert.strictEqual(parsed.failed, false);
    assert.match(output, /kept as context only/);
    assert.doesNotMatch(output, /delivery: not found/);
  });

  it('tl_gh_issue_read dispatches the natural issue read workflow', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-read-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    const readTool = TOOLS.find(tool => tool.name === 'tl_gh_issue_read');
    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;

    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'if (process.env.GH_PROMPT_DISABLED !== "1") process.exit(42);',
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");',
      'process.stdout.write(JSON.stringify({ data: { repository: { issue: {',
      '  number: 434, title: "Parent issue", state: "OPEN", body: "", url: "https://example.test/434",',
      '  createdAt: "2026-05-09T00:00:00Z", closedAt: null, author: { login: "edimuj" },',
      '  assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0 },',
      '  subIssues: { totalCount: 1, nodes: [{',
      '    number: 435, title: "Child issue", state: "OPEN", body: "", url: "https://example.test/435",',
      '    labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }',
      '  }] }',
      '} } } }) + "\\n");'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      const result = await readTool.handler({ repo: 'edimuj/app-chat-game', issue: 434, noBody: true });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const parsed = JSON.parse(result.content[0].text);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));

      assert.strictEqual(parsed.issue.number, 434);
      assert.strictEqual(parsed.issue.subIssues[0].number, 435);
      assert.match(calls[0].find(arg => arg.startsWith('query=')), /subIssues\(first: 100\)/);
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_gh_issue_label_batch exposes add/remove plus addLabels/removeLabels aliases', () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_label_batch');
    for (const key of ['add', 'remove', 'addLabels', 'removeLabels']) {
      assert.ok(tool.schema[key], `schema should accept "${key}"`);
    }
  });

  it('tl_gh_issue_label_batch errors clearly when neither add nor remove is given', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_label_batch');
    await assert.rejects(
      () => tool.handler({ repo: 'edimuj/app', issues: [1] }),
      /at least one of/i
    );
  });

  it('tl_run reports a missing cwd clearly instead of "spawn node ENOENT"', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_run');
    const missing = join(tmpdir(), 'tokenlean-no-such-worktree-xyz', 'gone');
    const result = await tool.handler({ command: 'echo hi', cwd: missing });
    assert.strictEqual(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /Working directory does not exist/);
    assert.match(text, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(text, /ENOENT/);
  });

  it('tl_run rejects a cwd that exists but is a file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-cwd-file-'));
    const filePath = join(tempDir, 'not-a-dir.txt');
    try {
      writeFileSync(filePath, 'x', 'utf-8');
      const tool = TOOLS.find(t => t.name === 'tl_run');
      const result = await tool.handler({ command: 'echo hi', cwd: filePath });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /not a directory/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
