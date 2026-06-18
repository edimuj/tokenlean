import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, withCwdHint } from './mcp-tools.mjs';

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

  it('tl_pack debug keeps target context even when it starts with a real command', async () => {
    const packTool = TOOLS.find(tool => tool.name === 'tl_pack');
    const result = await packTool.handler({
      pack: 'debug',
      target: 'tl run and tl_pack command compatibility issues',
      budget: 900,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);
    const output = parsed.sections[0].output.join('\n');

    assert.strictEqual(parsed.failed, false);
    assert.match(output, /kept as context only/);
    assert.doesNotMatch(output, /and: not found/);
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

  it('tl_gh_issue_read reads every issue when identifier aliases are arrays', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-read-batch-'));
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
      'const numberArg = args.find((arg) => arg.startsWith("number="));',
      'const number = Number(numberArg?.slice("number=".length) || 0);',
      'process.stdout.write(JSON.stringify({ data: { repository: { issue: {',
      '  number, title: `Issue ${number}`, state: "OPEN", body: "", url: `https://example.test/${number}`,',
      '  createdAt: "2026-05-09T00:00:00Z", closedAt: null, author: { login: "edimuj" },',
      '  assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 0 },',
      '  subIssues: { totalCount: 0, nodes: [] }',
      '} } } }) + "\\n");'
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      const result = await readTool.handler({ repo: 'edimuj/agent-relay', number: [573, 565], noBody: true });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const parsed = JSON.parse(result.content[0].text);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));

      assert.deepStrictEqual(parsed.issues.map(issue => issue.number), [573, 565]);
      assert.deepStrictEqual(parsed.results, [
        { number: 573, status: 'read' },
        { number: 565, status: 'read' },
      ]);
      assert.strictEqual(parsed.totalItems, 2);
      assert.strictEqual(calls.length, 2);
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_gh tools accept GitHub-MCP-style split owner + issue_number', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-compat-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    const closeTool = TOOLS.find(t => t.name === 'tl_gh_issue_close');
    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;

    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("{}\\n");',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      // GitHub-MCP convention: split owner + bare repo, issue_number instead of issues.
      const result = await closeTool.handler({ owner: 'edimuj', repo: 'agent-relay', issue_number: 79 });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      // tl-gh resolves the issue id via GraphQL first; owner + bare repo were combined,
      // and issue_number was routed to the issue lookup.
      const flat = calls.flat();
      assert.ok(flat.includes('owner=edimuj'), 'owner should reach the gh GraphQL call');
      assert.ok(flat.includes('name=agent-relay'), 'bare repo should be combined with owner');
      assert.ok(flat.some(a => /issue\(number: 79\)/.test(a)), 'issue_number should route to the issue lookup');
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_gh_issue_close requires an issue identifier', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_close');
    await assert.rejects(
      () => tool.handler({ repo: 'edimuj/app' }),
      /provide "issues" \(or "issue_number" \/ "number"\)/i
    );
  });

  it('tl_gh issue tools accept "number" as an identifier alias on every tool', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-number-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;

    // Faithful stub: log every call, and return a project id for the projectV2
    // resolution query so tl_gh_project_add_batch gets PAST project resolution to
    // the issue-id lookup (where the number lands in the gh query) — otherwise it
    // throws "Project not found" before the issue number ever reaches gh. Issue
    // tools see "{}" exactly as before.
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(argv) + "\\n");',
      'if (argv.join(" ").includes("projectV2")) {',
      '  process.stdout.write(JSON.stringify({ data: { user: { projectV2: { id: "PVT_test" } } } }) + "\\n");',
      '} else {',
      '  process.stdout.write("{}\\n");',
      '}',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    // Every tl_gh_issue_* tool should resolve the identifier from a bare `number`.
    const cases = [
      { name: 'tl_gh_issue_read', args: { repo: 'edimuj/app', number: 113 } },
      { name: 'tl_gh_issue_close', args: { repo: 'edimuj/app', number: 113 } },
      { name: 'tl_gh_issue_close_batch', args: { repo: 'edimuj/app', number: [113, 114] } },
      { name: 'tl_gh_issue_label_batch', args: { repo: 'edimuj/app', number: 113, add: 'bug' } },
      { name: 'tl_gh_project_add_batch', args: { repo: 'edimuj/app', project: 'edimuj/1', number: 113 } },
    ];

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      for (const { name, args } of cases) {
        const tool = TOOLS.find(t => t.name === name);
        const before = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
        await tool.handler(args);
        // The bare `number` must resolve and reach the gh invocation for this tool.
        const after = readFileSync(logPath, 'utf-8');
        const fresh = after.slice(before.length);
        assert.ok(/113/.test(fresh), `${name}: "number" should route the issue id (113) to the gh call`);
      }
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_gh tools expose owner + issue_number + number compatibility aliases in their schema', () => {
    for (const name of ['tl_gh_issue_read', 'tl_gh_issue_close', 'tl_gh_issue_close_batch',
      'tl_gh_issue_label_batch', 'tl_gh_project_add_batch', 'tl_gh_issue_create_batch', 'tl_gh_issue_add_sub']) {
      const tool = TOOLS.find(t => t.name === name);
      assert.ok(tool.schema.owner, `${name} should accept "owner"`);
    }
    // The issue-identifier tools also expose the "number" alias (add_sub maps it
    // to the parent identifier).
    for (const name of ['tl_gh_issue_read', 'tl_gh_issue_close', 'tl_gh_issue_close_batch',
      'tl_gh_issue_label_batch', 'tl_gh_project_add_batch', 'tl_gh_issue_add_sub']) {
      const tool = TOOLS.find(t => t.name === name);
      assert.ok(tool.schema.number, `${name} should accept "number"`);
      assert.ok(tool.schema.issue_number, `${name} should accept "issue_number"`);
    }
  });

  it('tl_gh_issue_add_sub resolves the parent from "number"/"issue_number" alias', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-addsub-alias-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("{}\\n");',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;
    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      const tool = TOOLS.find(t => t.name === 'tl_gh_issue_add_sub');
      // No "parent" — only the bare "number" alias. The parent's node-id lookup
      // passes "-F number=10" to gh, proving the alias routed to the parent.
      await tool.handler({ repo: 'edimuj/app', number: 10, children: [11, 12] });
      const calls = readFileSync(logPath, 'utf-8');
      assert.match(calls, /number=10\b/, 'number alias routes to the parent identifier');
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

describe('withCwdHint', () => {
  it('appends a cwd hint to "Not found" errors when no cwd was passed', () => {
    const out = withCwdHint('Not found: src/mcp.ts', {});
    assert.match(out, /Not found: src\/mcp\.ts/);
    assert.match(out, /MCP server's working dir/);
    assert.match(out, /pass cwd=<your project root> or use absolute paths/);
    assert.ok(out.includes(process.cwd()));
  });

  it('tailors the hint when an explicit cwd was passed', () => {
    const out = withCwdHint('Not found: src/mcp.ts', { cwd: '/tmp/project' });
    assert.match(out, /ran with cwd=\/tmp\/project/);
    assert.match(out, /check the path is correct relative to that dir/);
  });

  it('covers Go module path errors (matches vent #66)', () => {
    const out = withCwdHint('directory prefix . does not contain main module', {});
    assert.match(out, /Hint: ran with cwd=/);
  });

  it('leaves non-path errors untouched', () => {
    const msg = 'Invalid filter: "frob". Must be one of: function, class';
    assert.strictEqual(withCwdHint(msg, {}), msg);
  });

  it('handles empty/undefined input safely', () => {
    assert.strictEqual(withCwdHint('', {}), '');
    assert.strictEqual(withCwdHint(undefined, {}), undefined);
  });
});
