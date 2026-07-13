import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capRunResultText, IN_PROCESS_TOOL_NAMES, TOOLS, registerTools, runArgs, runJobDir, withCwdHint } from './mcp-tools.mjs';

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

  it('tl-mcp --tools registers a selected strict GitHub schema through the real process entrypoint', () => {
    const binPath = fileURLToPath(new URL('../bin/tl-mcp.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [binPath, '--tools', 'gh_issue_close'], {
      input: '',
      encoding: 'utf-8',
      timeout: 5000,
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
  });

  it('keeps successful and failing CLI stderr separate from parseable JSON stdout', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-stderr-'));
    const hookPath = join(tempDir, 'warning.cjs');
    const sourcePath = join(tempDir, 'api.js');
    const originalNodeOptions = process.env.NODE_OPTIONS;

    writeFileSync(hookPath, "process.stderr.write('wrapper warning\\n');\n", 'utf-8');
    writeFileSync(sourcePath, 'export function api() { return 1; }\n', 'utf-8');

    try {
      process.env.NODE_OPTIONS = `--require=${hookPath}`;

      const contextTool = TOOLS.find(tool => tool.name === 'tl_context');
      const success = await contextTool.handler({ path: sourcePath });
      assert.strictEqual(success.isError, undefined);
      assert.doesNotThrow(() => JSON.parse(success.content[0].text));
      assert.match(success.content[1].text, /^\[stderr\]\nwrapper warning/);

      const runTool = TOOLS.find(tool => tool.name === 'tl_run');
      const failure = await runTool.handler({ command: 'false', raw: true, cwd: tempDir });
      assert.strictEqual(failure.isError, true);
      const failurePayload = JSON.parse(failure.content[0].text);
      assert.strictEqual(failurePayload.exitCode, 1);
      assert.match(failure.content[1].text, /^\[stderr\]\nwrapper warning/);
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs hot read-only tools in-process instead of launching Node CLI children', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-in-process-'));
    const sourcePath = join(tempDir, 'api.js');
    const hookPath = join(tempDir, 'forbid-node-child.cjs');
    const originalNodeOptions = process.env.NODE_OPTIONS;

    writeFileSync(sourcePath, 'export function api() { return 1; }\n', 'utf-8');
    writeFileSync(hookPath, 'process.exit(73);\n', 'utf-8');

    const calls = {
      tl_structure: { path: tempDir, depth: 1, cwd: tempDir },
      tl_snippet: { name: 'api', file: sourcePath, cwd: tempDir },
      tl_symbols: { files: [sourcePath], cwd: tempDir },
      tl_related: { file: sourcePath, cwd: tempDir },
      tl_deps: { file: sourcePath, cwd: tempDir },
      tl_impact: { file: sourcePath, cwd: tempDir },
      tl_lookup: { query: 'api', path: tempDir, cwd: tempDir },
      tl_dupes: { path: tempDir, exactOnly: true, cwd: tempDir },
    };

    try {
      process.env.NODE_OPTIONS = `--require=${hookPath}`;
      assert.deepEqual(new Set(IN_PROCESS_TOOL_NAMES), new Set(Object.keys(calls)));
      for (const [name, input] of Object.entries(calls)) {
        const result = await TOOLS.find(tool => tool.name === name).handler(input);
        assert.equal(result.isError, undefined, `${name}: ${result.content?.[0]?.text}`);
        assert.doesNotThrow(() => JSON.parse(result.content[0].text), name);
      }
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
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

  it('tl_run advertises commandTimeoutMs/commandTimeoutSeconds plus a documented "timeout" alias', () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const schemaKeys = new Set(Object.keys(runTool.schema.shape));

    assert.ok(schemaKeys.has('commandTimeoutMs'));
    assert.ok(schemaKeys.has('commandTimeoutSeconds'));
    assert.ok(schemaKeys.has('timeout'));
  });

  it('tl_run schema keeps "timeout" instead of silently stripping it as an unknown key', () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const parsed = runTool.schema.parse({ command: 'echo hi', timeout: 5 });
    assert.strictEqual(parsed.timeout, 5);
  });

  it('tl_run schema exposes limit/maxTokens/noSplit budget params', () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    for (const key of ['limit', 'maxTokens', 'noSplit']) {
      assert.ok(runTool.schema.shape[key], `schema should accept "${key}"`);
    }
  });

  it('tl_run wires limit/maxTokens/noSplit through to the tl-run CLI flags (-l/-t/--no-split)', () => {
    const args = runArgs({ command: 'echo hi', limit: 40, maxTokens: 2000, noSplit: true });
    assert.deepStrictEqual(args, ['echo hi', '-l', '40', '-t', '2000', '--no-split', '-j']);
  });

  it('makes every MCP input schema strict', () => {
    for (const tool of TOOLS) {
      const result = tool.schema.safeParse({ bogusKey: true });
      assert.strictEqual(result.success, false, tool.name);
      assert.ok(
        result.error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys?.includes('bogusKey')),
        `${tool.name} did not reject bogusKey: ${JSON.stringify(result.error.issues)}`
      );
    }
  });

  it('rejects fractional, negative, zero, and over-limit numeric options', () => {
    const invalid = [
      ['tl_snippet', { name: 'render', context: 1.5 }],
      ['tl_snippet', { name: 'render', context: -1 }],
      ['tl_run', { command: 'echo ok', waitSeconds: 111 }],
      ['tl_run', { command: 'echo ok', limit: 0 }],
      ['tl_deps', { file: 'src/a.js', depth: 0 }],
      ['tl_guard', { detailLimit: -1 }],
      ['tl_dupes', { near: 0 }],
      ['tl_dupes', { near: 1.01 }],
      ['tl_dupes', { minTokens: 1.5 }],
      ['tl_lookup', { query: 'parse', limit: 2.5 }],
      ['tl_lookup', { query: 'parse', minScore: -0.01 }],
      ['tl_context', { top: 0 }],
      ['tl_structure', { depth: 0 }],
      ['tl_structure', { offset: 10_000_001 }],
      ['tl_gh_issue_read', { repo: 'o/r', issue: 1.5 }],
      ['tl_gh_issue_read', { repo: 'o/r', issue: 0 }],
    ];

    for (const [name, input] of invalid) {
      const result = TOOLS.find(tool => tool.name === name).schema.safeParse(input);
      assert.strictEqual(result.success, false, `${name} accepted ${JSON.stringify(input)}`);
    }
  });

  it('rejects conflicting aliases and mutually exclusive input modes', () => {
    const conflicts = [
      ['tl_run', { command: 'echo ok', commandTimeoutMs: 1000, timeout: 2 }],
      ['tl_run', { command: 'echo ok', jobId: randomUUID() }],
      ['tl_tail', { file: 'app.log', maxLines: 20, lines: 20 }],
      ['tl_diff', { ref: 'HEAD~1', staged: true }],
      ['tl_context', { top: 10, all: true }],
      ['tl_pack', { pack: 'debug', target: 'tests', command: 'npm test' }],
      ['tl_gh_issue_read', { repo: 'o/r', issue: 1, number: 2 }],
      ['tl_gh_issue_read', { repo: 'o/r', owner: 'different', issue: 1 }],
      ['tl_gh_issue_read', { repo: 'o/r', issue: 1, full: true, noBody: true }],
      ['tl_gh_issue_add_sub', { repo: 'o/r', parent: 1, issue: 2, children: [3] }],
      ['tl_gh_issue_add_sub', { repo: 'o/r', parent: 1, children: [2], sub: [3] }],
      ['tl_gh_issue_label_batch', { repo: 'o/r', issues: [1], add: 'bug', addLabels: ['P1'] }],
      ['tl_gh_issue_create_batch', { repo: 'o/r', issues: [{ title: 'A' }], specs: [{ title: 'B' }] }],
    ];

    for (const [name, input] of conflicts) {
      const result = TOOLS.find(tool => tool.name === name).schema.safeParse(input);
      assert.strictEqual(result.success, false, `${name} accepted ${JSON.stringify(input)}`);
      assert.match(result.error.issues.map(issue => issue.message).join('\n'), /conflict|only one/i, name);
    }
  });

  it('requires scalar identifiers for single destructive operations', () => {
    const close = TOOLS.find(tool => tool.name === 'tl_gh_issue_close').schema;
    assert.strictEqual(close.safeParse({ repo: 'o/r', issues: 1 }).success, true);
    assert.strictEqual(close.safeParse({ repo: 'o/r', issue_number: 1 }).success, true);
    assert.strictEqual(close.safeParse({ repo: 'o/r', issues: [1, 2] }).success, false);
    assert.strictEqual(close.safeParse({ repo: 'o/r', number: [1, 2] }).success, false);

    const closeBatch = TOOLS.find(tool => tool.name === 'tl_gh_issue_close_batch').schema;
    assert.strictEqual(closeBatch.safeParse({ repo: 'o/r', issues: [1, 2] }).success, true);
    assert.strictEqual(closeBatch.safeParse({
      repo: 'o/r', issues: Array.from({ length: 101 }, (_, index) => index + 1)
    }).success, false);

    const addSub = TOOLS.find(tool => tool.name === 'tl_gh_issue_add_sub').schema;
    assert.strictEqual(addSub.safeParse({ repo: 'o/r', issue_number: 1, children: [2] }).success, true);
    assert.strictEqual(addSub.safeParse({ repo: 'o/r', number: [1, 2], children: [3] }).success, false);
    assert.strictEqual(addSub.safeParse({ repo: 'o/r', issue_number: [1], children: [2] }).success, false);
  });

  it('bounds large strings, file lists, and create batches at the schema boundary', () => {
    const symbols = TOOLS.find(tool => tool.name === 'tl_symbols').schema;
    assert.strictEqual(symbols.safeParse({
      files: Array.from({ length: 1001 }, (_, index) => `f${index}.js`)
    }).success, false);

    const run = TOOLS.find(tool => tool.name === 'tl_run').schema;
    assert.strictEqual(run.safeParse({ command: 'x'.repeat(100_001) }).success, false);

    const create = TOOLS.find(tool => tool.name === 'tl_gh_issue_create_batch').schema;
    assert.strictEqual(create.safeParse({
      repo: 'o/r',
      issues: Array.from({ length: 101 }, (_, index) => ({ title: `Issue ${index}` }))
    }).success, false);
  });

  it('keeps compatibility aliases only when one unambiguous alias is supplied', () => {
    const run = TOOLS.find(tool => tool.name === 'tl_run').schema;
    assert.strictEqual(run.safeParse({ command: 'echo ok', timeout: 5 }).success, true);
    assert.strictEqual(run.safeParse({ jobId: randomUUID(), waitSeconds: 0, tailLines: 5 }).success, true);
    assert.strictEqual(run.safeParse({ jobId: randomUUID(), maxTokens: 500 }).success, true);

    const create = TOOLS.find(tool => tool.name === 'tl_gh_issue_create_batch').schema;
    assert.strictEqual(create.safeParse({ repo: 'o/r', specs: [{ title: 'A' }] }).success, true);
    assert.strictEqual(create.safeParse({ repo: 'o/r', specs: [{ title: 'A', typo: true }] }).success, false);

    const read = TOOLS.find(tool => tool.name === 'tl_gh_issue_read').schema;
    assert.strictEqual(read.safeParse({ repo: 'o/r', owner: 'o', issue_number: 1 }).success, true);
    assert.strictEqual(read.safeParse({ repo: 'OpenAI/r', owner: 'openai', issue_number: 1 }).success, true);
    assert.strictEqual(read.safeParse({ repo: 'r', owner: 'o', issue_number: 1 }).success, true);

    const browse = TOOLS.find(tool => tool.name === 'tl_browse').schema;
    assert.strictEqual(browse.safeParse({ url: 'example.com/docs' }).success, true);
    assert.strictEqual(browse.safeParse({ url: 'ftp://example.com' }).success, false);
  });

  it('capRunResultText tails a huge stdout field instead of returning megabytes, keeping valid JSON', () => {
    const huge = JSON.stringify({ command: 'echo hi', exitCode: 0, type: 'raw', stdout: 'x'.repeat(500_000), stderr: '' });
    const capped = capRunResultText(huge);
    assert.ok(capped.length < huge.length, `expected capped response, got ${capped.length} of ${huge.length} chars`);
    const parsed = JSON.parse(capped);
    assert.match(parsed.stdout, /truncated/);
    assert.ok(parsed.stdout.length < 500_000);
  });

  it('capRunResultText also tails result.stdout for a completed async job payload', () => {
    const huge = JSON.stringify({ jobId: 'x', status: 'completed', result: { stdout: 'y'.repeat(500_000) } });
    const capped = capRunResultText(huge);
    const parsed = JSON.parse(capped);
    assert.match(parsed.result.stdout, /truncated/);
    assert.ok(parsed.result.stdout.length < 500_000);
  });

  it('capRunResultText enforces one aggregate budget across every large output field', () => {
    const field = 'z'.repeat(190_000);
    const huge = JSON.stringify({
      stdout: field,
      stderr: field,
      output: field,
      result: { stdout: field, stderr: field, output: field },
    });
    const capped = capRunResultText(huge);

    assert.ok(capped.length <= 200_000, `aggregate response was ${capped.length} chars`);
    assert.doesNotThrow(() => JSON.parse(capped));
  });

  it('capRunResultText leaves small responses untouched', () => {
    const small = JSON.stringify({ command: 'echo hi', exitCode: 0, stdout: 'ok' });
    assert.strictEqual(capRunResultText(small), small);
  });

  it('tl_run marks an orphaned "running" async job as failed on poll (dead pid)', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const jobId = randomUUID();
    const dir = runJobDir(jobId);
    mkdirSync(dir, { recursive: true });
    const startedAt = new Date().toISOString();
    try {
      writeFileSync(join(dir, 'status.json'), JSON.stringify({
        jobId,
        status: 'running',
        command: 'echo hi',
        cwd: process.cwd(),
        pid: 999999999,
        startedAt,
        updatedAt: startedAt,
      }) + '\n', 'utf-8');

      const result = await runTool.handler({ jobId, waitSeconds: 0 });
      const payload = JSON.parse(result.content[0].text);
      assert.strictEqual(payload.status, 'failed');
      assert.match(payload.error.message, /orphan/i);
      assert.match(payload.legacyError, /orphan/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tl_run treats small legacy MCP timeout values as seconds', async () => {
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

  it('tl_run accepts commandTimeoutSeconds for command runtime limits', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const result = await runTool.handler({
      command: 'node -e "setTimeout(() => process.stdout.write(\'ok\'), 50)"',
      raw: true,
      commandTimeoutSeconds: 1,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.exitCode, 0);
    assert.strictEqual(parsed.stdout, 'ok');
    assert.notStrictEqual(parsed.type, 'timeout');
  });

  it('tl_run accepts commandTimeoutMs for command runtime limits', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const result = await runTool.handler({
      command: 'node -e "setTimeout(() => process.stdout.write(\'ok\'), 50)"',
      raw: true,
      commandTimeoutMs: 1000,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.exitCode, 0);
    assert.strictEqual(parsed.stdout, 'ok');
    assert.notStrictEqual(parsed.type, 'timeout');
  });

  it('tl_run async long-polls and returns completed short jobs in one call', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.stdout.write('async-ok'), 250)"`;

    const startedAt = Date.now();
    const result = await runTool.handler({
      command,
      raw: true,
      async: true,
      commandTimeoutMs: 3000,
      waitSeconds: 5,
      cwd: process.cwd(),
    });
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    assert.ok(elapsed < 2000, `async tl_run took ${elapsed}ms`);

    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.jobId, /^[a-f0-9-]{36}$/i);
    assert.strictEqual(payload.status, 'completed');
    assert.strictEqual(payload.exitCode, 0);
    assert.strictEqual(payload.result.exitCode, 0);
    assert.strictEqual(payload.result.stdout, 'async-ok');
  });

  it('tl_run async can return immediate status only when waitSeconds is zero', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.stdout.write('async-later'), 300)"`;

    const startResult = await runTool.handler({
      command,
      raw: true,
      async: true,
      commandTimeoutMs: 3000,
      waitSeconds: 0,
      cwd: process.cwd(),
    });

    assert.strictEqual(startResult.isError, undefined, startResult.content?.[0]?.text);

    const startPayload = JSON.parse(startResult.content[0].text);
    assert.match(startPayload.jobId, /^[a-f0-9-]{36}$/i);
    assert.match(startPayload.message, /avoid frequent short polling/i);
    assert.deepStrictEqual(startPayload.poll.arguments, {
      jobId: startPayload.jobId,
      waitSeconds: 90,
    });

    let pollResult = null;
    let pollPayload = null;
    for (let i = 0; i < 20; i++) {
      pollResult = await runTool.handler({ jobId: startPayload.jobId, tailLines: 5, waitSeconds: 1 });
      pollPayload = JSON.parse(pollResult.content[0].text);
      if (pollPayload.status === 'completed') break;
      await sleep(50);
    }

    assert.strictEqual(pollPayload.status, 'completed', pollResult.content[0].text);
    assert.strictEqual(pollResult.isError, undefined, pollResult.content[0].text);
    assert.strictEqual(pollPayload.exitCode, 0);
    assert.strictEqual(pollPayload.result.exitCode, 0);
    assert.strictEqual(pollPayload.result.stdout, 'async-later');
  });

  it('tl_run async stores an aggregate-capped result instead of an unbounded job file', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(900000))"`;

    const result = await runTool.handler({
      command,
      raw: true,
      async: true,
      commandTimeoutMs: 3000,
      waitSeconds: 5,
      cwd: process.cwd(),
    });
    const payload = JSON.parse(result.content[0].text);

    assert.strictEqual(payload.status, 'completed');
    assert.strictEqual(payload.result.truncated, true);
    assert.ok(result.content[0].text.length <= 200_000);
    const stored = statSync(join(runJobDir(payload.jobId), 'stdout.json')).size;
    assert.ok(stored < 600_000, `stored async output was ${stored} bytes`);
    rmSync(runJobDir(payload.jobId), { recursive: true, force: true });
  });

  it('tl_run reports unknown async job ids clearly', async () => {
    const runTool = TOOLS.find(tool => tool.name === 'tl_run');
    const result = await runTool.handler({ jobId: '00000000-0000-4000-8000-000000000000' });

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Unknown tl_run jobId/);
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

  it('tl_pack onboard treats prose targets as project queries', async () => {
    const packTool = TOOLS.find(tool => tool.name === 'tl_pack');
    const result = await packTool.handler({
      pack: 'onboard',
      target: 'provider quota orchestrator server runner',
      budget: 900,
      cwd: process.cwd(),
    });

    assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
    const parsed = JSON.parse(result.content[0].text);

    assert.strictEqual(parsed.failed, false);
    assert.deepStrictEqual(
      parsed.sections.map(section => section.title),
      ['Target query', 'Project structure']
    );
    assert.match(parsed.sections[0].output.join('\n'), /treating it as a query/);
    assert.strictEqual(parsed.sections[1].command, 'tl structure . --depth 1');
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

  it('tl_gh_issue_read JSON honors noBody and bodyLines for issues, sub-issues, and comments', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-bodies-'));
    const ghPath = join(tempDir, 'gh');
    const readTool = TOOLS.find(tool => tool.name === 'tl_gh_issue_read');
    const originalPath = process.env.PATH;

    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({ data: { repository: { issue: {',
      '  number: 10, title: "Parent", state: "OPEN", body: "parent one\\nparent two", url: "https://example.test/10",',
      '  createdAt: "2026-01-01T00:00:00Z", closedAt: null, author: { login: "edimuj" },',
      '  assignees: { nodes: [] }, labels: { nodes: [] },',
      '  comments: { totalCount: 1, nodes: [{ author: { login: "reviewer" }, createdAt: "2026-01-02T00:00:00Z", body: "comment one\\ncomment two" }] },',
      '  subIssues: { totalCount: 1, nodes: [{',
      '    number: 11, title: "Child", state: "OPEN", body: "child one\\nchild two", url: "https://example.test/11",',
      '    labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0 }',
      '  }] }',
      '} } } }) + "\\n");',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;

      const omittedResult = await readTool.handler({ repo: 'edimuj/app', issue: 10, comments: true, noBody: true });
      const omitted = JSON.parse(omittedResult.content[0].text).issue;
      assert.strictEqual(Object.hasOwn(omitted, 'body'), false);
      assert.strictEqual(Object.hasOwn(omitted.subIssues[0], 'body'), false);
      assert.strictEqual(Object.hasOwn(omitted.comments.nodes[0], 'body'), false);

      const limitedResult = await readTool.handler({ repo: 'edimuj/app', issue: 10, comments: true, bodyLines: 1 });
      const limited = JSON.parse(limitedResult.content[0].text).issue;
      assert.match(limited.body, /^parent one\n.*1 more line/);
      assert.match(limited.subIssues[0].body, /^child one\n.*1 more line/);
      assert.match(limited.comments.nodes[0].body, /^comment one\n.*1 more line/);
      assert.doesNotMatch(limited.body, /parent two/);
      assert.doesNotMatch(limited.subIssues[0].body, /child two/);
      assert.doesNotMatch(limited.comments.nodes[0].body, /comment two/);
    } finally {
      process.env.PATH = originalPath;
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
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(argv) + "\\n");',
      'if (argv.join(" ").includes("closeIssue")) {',
      '  process.stdout.write(JSON.stringify({ data: { close79: { issue: { number: 79 } } } }) + "\\n");',
      '} else {',
      '  process.stdout.write(JSON.stringify({ data: { repository: { issue79: { id: "ISSUE_79" } } } }) + "\\n");',
      '}',
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
    // tl_gh_* schemas are strict ZodObject instances (see withCwdStrict) rather
    // than raw shapes, so field access goes through .shape.
    for (const name of ['tl_gh_issue_read', 'tl_gh_issue_close', 'tl_gh_issue_close_batch',
      'tl_gh_issue_label_batch', 'tl_gh_project_add_batch', 'tl_gh_issue_create_batch', 'tl_gh_issue_add_sub']) {
      const tool = TOOLS.find(t => t.name === name);
      assert.ok(tool.schema.shape.owner, `${name} should accept "owner"`);
    }
    // The issue-identifier tools also expose the "number" alias (add_sub maps it
    // to the parent identifier).
    for (const name of ['tl_gh_issue_read', 'tl_gh_issue_close', 'tl_gh_issue_close_batch',
      'tl_gh_issue_label_batch', 'tl_gh_project_add_batch', 'tl_gh_issue_add_sub']) {
      const tool = TOOLS.find(t => t.name === name);
      assert.ok(tool.schema.shape.number, `${name} should accept "number"`);
      assert.ok(tool.schema.shape.issue_number, `${name} should accept "issue_number"`);
    }
  });

  it('tl_gh_issue_add_sub accepts the "issue" parent alias and "sub" children alias', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-addsub-newalias-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    // A generic stub that resolves any issue-id lookup to the same fake node
    // id, so tl-gh's add-sub flow gets past parent resolution to the child
    // batch-id lookup (whose query text embeds the child numbers literally)
    // instead of exiting early on "Could not resolve parent".
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(argv) + "\\n");',
      'process.stdout.write(JSON.stringify({ data: { repository: { issue: { id: "FAKE_ISSUE_ID" } } } }) + "\\n");',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;
    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      const tool = TOOLS.find(t => t.name === 'tl_gh_issue_add_sub');
      // "issue" (not "parent") for the parent, and "sub" (not "children") for
      // the sub-issues — the exact confusion traced in vent #219.
      await tool.handler({ repo: 'edimuj/app', issue: 20, sub: [21, 22] });
      const args = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      const flat = args.flat();
      assert.ok(flat.some(a => /number: 20|number=20\b/.test(a)), '"issue" alias should route 20 as the parent identifier');
      assert.ok(flat.some(a => /issue\(number: 21\)/.test(a)), '"sub" alias should route child 21');
      assert.ok(flat.some(a => /issue\(number: 22\)/.test(a)), '"sub" alias should route child 22');
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('tl_gh_issue_add_sub validation errors print the full expected call shape and a literal example', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_add_sub');
    await assert.rejects(
      () => tool.handler({ repo: 'edimuj/app', children: [1, 2] }),
      (err) => {
        assert.match(err.message, /provide "parent"/i);
        assert.match(err.message, /Expected shape/i);
        // The literal, fillable example from the vent #219 fix.
        assert.match(err.message, /"parent":123/);
        assert.match(err.message, /"children":\[124,125\]/);
        return true;
      }
    );
  });

  it('tl_gh_issue_close validation error also includes the full expected shape', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_close');
    await assert.rejects(
      () => tool.handler({ repo: 'edimuj/app' }),
      (err) => {
        // Backward-compatible substring preserved...
        assert.match(err.message, /provide "issues" \(or "issue_number" \/ "number"\)/i);
        // ...plus the new full-shape example.
        assert.match(err.message, /Expected shape/i);
        assert.match(err.message, /"repo":"owner\/repo"/);
        return true;
      }
    );
  });

  it('tl_gh_issue_close accepts "not_planned" as a reason alias (GitHub-MCP convention)', () => {
    const closeTool = TOOLS.find(t => t.name === 'tl_gh_issue_close');
    const closeBatchTool = TOOLS.find(t => t.name === 'tl_gh_issue_close_batch');
    const closeResult = closeTool.schema.safeParse({ repo: 'edimuj/app', issues: 1, reason: 'not_planned' });
    assert.strictEqual(closeResult.success, true, JSON.stringify(closeResult.error?.issues));
    const batchResult = closeBatchTool.schema.safeParse({ repo: 'edimuj/app', issues: [1], reason: 'not_planned' });
    assert.strictEqual(batchResult.success, true, JSON.stringify(batchResult.error?.issues));
  });

  it('tl_gh_issue_read "issue" accepts an array for batch reads (matches its aliases)', () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_read');
    const result = tool.schema.safeParse({ repo: 'edimuj/app', issue: [1, 2, 3] });
    assert.strictEqual(result.success, true, JSON.stringify(result.error?.issues));
  });

  it('tl_gh_issue_create_batch accepts "specs"/"newIssues" aliases for the new-issue array', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-createbatch-alias-'));
    const ghPath = join(tempDir, 'gh');
    const logPath = join(tempDir, 'gh-calls.jsonl');
    // tl-gh's create-batch reads the array from ITS OWN stdin (piped by
    // dispatchToolWithStdin), then shells out to the real "gh" CLI per issue
    // as `gh issue create ... --title <title>` — that's the boundary this
    // stub fakes, logging argv and returning a fake issue URL.
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const argv = process.argv.slice(2);',
      'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(argv) + "\\n");',
      'process.stdout.write("https://github.com/edimuj/app/issues/999\\n");',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_LOG;
    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      process.env.GH_LOG = logPath;
      const tool = TOOLS.find(t => t.name === 'tl_gh_issue_create_batch');
      const result = await tool.handler({ repo: 'edimuj/app', specs: [{ title: 'Alias test' }] });
      assert.strictEqual(result.isError, undefined, result.content?.[0]?.text);
      const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(argv => argv.includes('Alias test')), 'the "specs" alias should reach the created issue title');
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.GH_LOG;
      else process.env.GH_LOG = originalLog;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('GitHub batch mutation tools return aggregate failure counts and MCP errors when none succeed', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-all-fail-'));
    const ghPath = join(tempDir, 'gh');
    const originalPath = process.env.PATH;

    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const argv = process.argv.slice(2);',
      'if (argv.join(" ").includes("projectV2")) {',
      '  process.stdout.write(JSON.stringify({ data: { user: { projectV2: { id: "PROJECT_1" } } } }) + "\\n");',
      '} else {',
      '  process.stderr.write("simulated GitHub failure\\n");',
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    const cases = [
      { name: 'tl_gh_issue_create_batch', args: { repo: 'edimuj/app', issues: [{ title: 'A' }, { title: 'B' }] } },
      { name: 'tl_gh_issue_close_batch', args: { repo: 'edimuj/app', issues: [1, 2] } },
      { name: 'tl_gh_issue_label_batch', args: { repo: 'edimuj/app', issues: [1, 2], add: 'bug' } },
      { name: 'tl_gh_project_add_batch', args: { repo: 'edimuj/app', project: 'edimuj/1', issues: [1, 2] } },
    ];

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      for (const { name, args } of cases) {
        const tool = TOOLS.find(t => t.name === name);
        const result = await tool.handler(args);
        assert.strictEqual(result.isError, true, `${name} should be an MCP error when every item fails`);
        const payload = JSON.parse(result.content[0].text);
        assert.strictEqual(payload.requestedCount, 2, name);
        assert.strictEqual(payload.succeededCount, 0, name);
        assert.strictEqual(payload.failedCount, 2, name);
        assert.strictEqual(payload.failed, true, name);
        assert.strictEqual(payload.partialFailure, false, name);
        assert.strictEqual(payload.results.length, 2, name);
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('GitHub batch mutation tools expose partial success without discarding successful results', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-partial-'));
    const ghPath = join(tempDir, 'gh');
    const originalPath = process.env.PATH;

    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'const issue = process.argv[4];',
      'if (issue === "1") process.exit(0);',
      'process.stderr.write("simulated update failure\\n");',
      'process.exit(1);',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      const tool = TOOLS.find(t => t.name === 'tl_gh_issue_label_batch');
      const result = await tool.handler({ repo: 'edimuj/app', issues: [1, 2], add: 'bug' });
      assert.strictEqual(result.isError, undefined, result.content[0].text);
      const payload = JSON.parse(result.content[0].text);
      assert.strictEqual(payload.requestedCount, 2);
      assert.strictEqual(payload.succeededCount, 1);
      assert.strictEqual(payload.failedCount, 1);
      assert.strictEqual(payload.failed, true);
      assert.strictEqual(payload.partialFailure, true);
      assert.deepStrictEqual(payload.results.map(r => r.status), ['updated', 'failed']);
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ghResolveRepo (via tl_gh_issue_close) rejects a bare repo name with no owner', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_close');
    await assert.rejects(
      () => tool.handler({ repo: 'app', issues: 1 }),
      /Invalid repo "app": expected "owner\/repo"/i
    );
  });

  it('registerTools wires every tool through the real MCP SDK without throwing', () => {
    const server = new McpServer({ name: 'tokenlean-test', version: '0.0.0' });
    assert.doesNotThrow(() => registerTools(server));
    for (const tool of TOOLS) {
      assert.ok(server._registeredTools[tool.name], `${tool.name} should be registered`);
    }
  });

  it('tl_gh_issue_add_sub schema rejects unknown keys end-to-end through the real MCP SDK (vent #219 class)', async () => {
    const server = new McpServer({ name: 'tokenlean-test', version: '0.0.0' });
    registerTools(server);
    const addSub = server._registeredTools['tl_gh_issue_add_sub'];

    await assert.rejects(
      () => server.validateToolInput(addSub, { repo: 'edimuj/app', parent: 1, children: [2], bogusKey: true }, 'tl_gh_issue_add_sub'),
      /bogusKey/i
    );

    // Valid args using the new aliases still parse and reach the handler.
    const parsedGood = await server.validateToolInput(
      addSub, { repo: 'edimuj/app', issue: 1, sub: [2, 3] }, 'tl_gh_issue_add_sub'
    );
    assert.strictEqual(parsedGood.issue, 1);
    assert.deepStrictEqual(parsedGood.sub, [2, 3]);

    // Strictness applies to every tool so typos never silently become defaults.
    const symbols = server._registeredTools['tl_symbols'];
    await assert.rejects(
      () => server.validateToolInput(symbols, { files: 'a.js', bogusKey: true }, 'tl_symbols'),
      /bogusKey/i
    );
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
      assert.ok(tool.schema.shape[key], `schema should accept "${key}"`);
    }
  });

  it('tl_gh_issue_label_batch errors clearly when neither add nor remove is given', async () => {
    const tool = TOOLS.find(t => t.name === 'tl_gh_issue_label_batch');
    await assert.rejects(
      () => tool.handler({ repo: 'edimuj/app', issues: [1] }),
      /at least one of/i
    );
  });

  it('tl_pack debug errors when both command and target are given instead of silently dropping target', async () => {
    const packTool = TOOLS.find(tool => tool.name === 'tl_pack');
    await assert.rejects(
      () => packTool.handler({ pack: 'debug', command: 'npm test', target: 'some extra context', cwd: process.cwd() }),
      /provide either "command".*"target"|not both/i
    );
  });

  it('tl_gh_issue_create_batch does not crash the process on a large stdin payload EPIPE (stub tl-gh exits immediately)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-gh-epipe-'));
    const ghPath = join(tempDir, 'gh');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      'process.exit(0);',
    ].join('\n') + '\n', 'utf-8');
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${tempDir}:${originalPath}`;
      const tool = TOOLS.find(t => t.name === 'tl_gh_issue_create_batch');
      const bigIssues = Array.from({ length: 5000 }, (_, i) => ({ title: `Issue ${i}`, body: 'x'.repeat(2000) }));
      // The important assertion is that this resolves at all — without the
      // stdin error handler, an EPIPE here is an uncaught exception that
      // crashes the whole MCP server process, not just this call.
      const result = await tool.handler({ repo: 'edimuj/app', issues: bigIssues });
      assert.ok(result && Array.isArray(result.content));
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
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
