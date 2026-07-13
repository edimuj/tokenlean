import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundMcpResponseText, registerToolDefinition, TOOLS } from './mcp-tools.mjs';
import { inferMcpResultState, normalizeMcpResult } from './mcp-result.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runCli(name, args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'bin', `tl-${name}.mjs`), ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

describe('structured result states', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('marks unmatched advice as unsupported with an actionable stable error', () => {
    const result = runCli('advise', ['dance interpretively', '-j']);
    assert.equal(result.status, 0);
    assert.equal(result.json.resultState, 'unsupported');
    assert.equal(result.json.error.code, 'TL_ADVISE_UNSUPPORTED_GOAL');
    assert.equal(result.json.error.effectiveCwd, repoRoot);
    assert.equal(result.json.error.recoveryCall.tool, 'tl_advise');
    assert.ok(result.json.suggestions.length > 0, 'fallback suggestions remain compatible');
  });

  it('distinguishes empty and unsupported analysis without dropping legacy fields', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-result-state-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"result-state"}\n');
    writeFileSync(join(dir, 'empty.js'), '// intentionally empty\n');

    const empty = runCli('analyze', ['empty.js', '-j'], dir);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.json.resultState, 'empty');
    assert.equal(empty.json.partialFailure, false);
    assert.ok(empty.json.sections);

    const unsupported = runCli('analyze', [
      'empty.js', '--no-symbols', '--no-deps', '--no-impact', '--no-complexity', '--no-related', '-j'
    ], dir);
    assert.equal(unsupported.status, 0, unsupported.stderr);
    assert.equal(unsupported.json.resultState, 'unsupported');
    assert.equal(unsupported.json.error.code, 'TL_ANALYZE_NO_ENABLED_SECTIONS');
    assert.equal(unsupported.json.error.effectiveCwd, dir);
    assert.equal(unsupported.json.error.recoveryCall.tool, 'tl_analyze');
  });

  it('adds success/empty states to ordinary underlying CLI JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-cli-result-state-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"cli-result-state"}\n');
    writeFileSync(join(dir, 'api.js'), 'export function api() { return 1; }\n');

    const symbols = runCli('symbols', ['api.js', '-j'], dir);
    assert.equal(symbols.status, 0, symbols.stderr);
    assert.equal(symbols.json.resultState, 'success');

    const related = runCli('related', ['api.js', '-j'], dir);
    assert.equal(related.status, 0, related.stderr);
    assert.equal(related.json.resultState, 'empty');
  });

  it('normalizes every partial analysis error while retaining the legacy error string', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-result-partial-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"result-partial"}\n');
    writeFileSync(join(dir, 'notes.txt'), 'not source code\n');

    const result = runCli('analyze', ['-t', '1000', 'notes.txt', '-j'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.resultState, 'partial');
    assert.equal(result.json.partialFailure, true);
    const error = result.json.errors[0];
    assert.equal(typeof error.error, 'string');
    assert.match(error.code, /^TL_ANALYZE_/);
    assert.equal(error.message, error.error);
    assert.equal(error.effectiveCwd, dir);
    assert.equal(error.recoveryCall.tool, 'tl_analyze');
    assert.equal(error.recoveryCall.arguments.file, 'notes.txt');
  });

  it('marks intentionally budget-omitted pack sections as partial, not failed', () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-pack-partial-state-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"pack-partial"}\n');
    writeFileSync(join(dir, 'empty.js'), '// empty\n');

    const result = runCli('pack', ['refactor', 'empty.js', '--budget', '900', '-j'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.resultState, 'partial');
    assert.equal(result.json.partialFailure, false);
    assert.equal(result.json.partialReason, 'budget');
    assert.ok(result.json.omittedSections.length > 0);
    assert.ok(result.json.omittedSections.every(section => section.resultState === 'unsupported'));
  });
});

describe('MCP result normalization', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const tool = name => TOOLS.find(item => item.name === name);

  it('distinguishes success and empty while preserving JSON fields', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-state-'));
    const file = join(dir, 'api.js');
    writeFileSync(file, 'export function api() { return 1; }\n');

    const success = await tool('tl_symbols').handler({ files: [file], cwd: dir });
    assert.equal(success.isError, undefined);
    assert.equal(success.structuredContent.resultState, 'success');
    assert.ok(success.structuredContent.symbols.functions.length > 0);
    assert.equal(JSON.parse(success.content[0].text).resultState, 'success');

    const empty = await tool('tl_snippet').handler({ name: 'DefinitelyMissing', file, cwd: dir });
    assert.equal(empty.isError, undefined);
    assert.equal(empty.structuredContent.resultState, 'empty');
    assert.deepEqual(empty.structuredContent.results, []);
  });

  it('returns stable failed errors with cwd and a structured recovery call', async () => {
    const missingCwd = join(tmpdir(), 'tokenlean-missing-result-state', 'gone');
    const failed = await tool('tl_symbols').handler({ files: ['api.js'], cwd: missingCwd });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.resultState, 'failed');
    assert.equal(failed.structuredContent.error.code, 'TL_MCP_INVALID_CWD');
    assert.equal(failed.structuredContent.error.effectiveCwd, missingCwd);
    assert.equal(failed.structuredContent.error.recoveryCall.tool, 'tl_symbols');
    assert.equal(failed.structuredContent.error.recoveryCall.arguments.cwd, missingCwd);
    const primary = JSON.parse(failed.content[0].text);
    assert.equal(primary.resultState, 'failed');
    assert.equal(primary.error.code, 'TL_MCP_INVALID_CWD');
    assert.equal(primary.error.effectiveCwd, missingCwd);
  });

  it('distinguishes partial and unsupported without treating usable fallbacks as MCP errors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tokenlean-mcp-composite-state-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"mcp-state"}\n');
    writeFileSync(join(dir, 'notes.txt'), 'not source code\n');

    const partial = await tool('tl_analyze').handler({ file: 'notes.txt', cwd: dir });
    assert.equal(partial.isError, undefined);
    assert.equal(partial.structuredContent.resultState, 'partial');
    assert.equal(partial.structuredContent.error.code, 'TL_MCP_PARTIAL_FAILURE');
    assert.equal(partial.structuredContent.error.effectiveCwd, dir);
    assert.equal(partial.structuredContent.error.recoveryCall.tool, 'tl_analyze');

    const unsupported = await tool('tl_advise').handler({ goal: 'dance interpretively', cwd: dir });
    assert.equal(unsupported.isError, undefined);
    assert.equal(unsupported.structuredContent.resultState, 'unsupported');
    assert.equal(unsupported.structuredContent.error.code, 'TL_ADVISE_UNSUPPORTED_GOAL');
    assert.equal(unsupported.structuredContent.error.effectiveCwd, dir);
    assert.ok(unsupported.structuredContent.suggestions.length > 0);
  });

  it('keeps state, errors, and nested truncation ahead of huge payload fields', () => {
    const normalized = normalizeMcpResult(JSON.stringify({
      resultState: 'failed',
      error: {
        code: 'TL_TEST_FAILURE',
        message: 'large failure',
        effectiveCwd: repoRoot,
        recoveryCall: { tool: 'tl_symbols', arguments: { files: ['x.js'], cwd: repoRoot } }
      },
      result: { stdout: 'y'.repeat(100_000), truncated: true },
      payload: 'x'.repeat(100_000)
    }), { context: { toolName: 'tl_symbols', arguments: { files: ['x.js'] }, cwd: repoRoot } });
    const bounded = JSON.parse(boundMcpResponseText(normalized.contentText));
    assert.equal(bounded.resultState, 'failed');
    assert.equal(bounded.error.code, 'TL_TEST_FAILURE');
    assert.equal(bounded.result.truncated, true);
  });

  it('uses tool-aware empty counts without mistaking empty error lists for empty results', () => {
    assert.equal(inferMcpResultState({ symbolCount: 0 }), 'empty');
    assert.equal(inferMcpResultState({ totalImports: 0 }), 'empty');
    assert.equal(inferMcpResultState(
      { totals: { lines: 0 } },
      { context: { toolName: 'tl_tail' } }
    ), 'empty');
    assert.equal(inferMcpResultState(
      { functions: 3, exact: [], structural: [], near: [], names: [] },
      { context: { toolName: 'tl_dupes' } }
    ), 'empty');
    assert.equal(inferMcpResultState(
      { errors: [], checks: { secrets: { count: 0 } } },
      { context: { toolName: 'tl_guard' } }
    ), 'success');
  });

  it('normalizes legacy string errors while preserving the original string', () => {
    const normalized = normalizeMcpResult(JSON.stringify({ status: 'failed', error: 'orphaned job' }), {
      isError: true,
      context: { toolName: 'tl_run', arguments: { jobId: 'abc' }, cwd: repoRoot }
    });
    const payload = JSON.parse(normalized.contentText);
    assert.equal(payload.legacyError, 'orphaned job');
    assert.equal(payload.error.code, 'TL_MCP_TOOL_FAILED');
    assert.equal(payload.error.recoveryCall.arguments.command, 'git status --short');
  });

  it('uses read-only recovery calls for mutation failures', () => {
    const close = normalizeMcpResult(JSON.stringify({
      partialFailure: true,
      results: [{ number: 42, status: 'failed', error: 'not found' }]
    }), {
      context: {
        toolName: 'tl_gh_issue_close',
        arguments: { repo: 'owner/repo', issues: [42, 43], comment: 'done' },
        cwd: repoRoot
      }
    }).structuredContent;
    assert.equal(close.error.recoveryCall.tool, 'tl_gh_issue_read');
    assert.equal(close.error.recoveryCall.arguments.issue, 42);
    assert.equal(close.error.recoveryCall.arguments.comment, undefined);

    const create = normalizeMcpResult(JSON.stringify({ failed: true }), {
      context: {
        toolName: 'tl_gh_issue_create_batch',
        arguments: { repo: 'owner/repo', issues: [{ title: 'Do not replay' }] },
        cwd: repoRoot
      }
    }).structuredContent;
    assert.equal(create.error.recoveryCall.tool, 'tl_run');
    assert.match(create.error.recoveryCall.arguments.command, /^gh issue list /);
    assert.doesNotMatch(create.error.recoveryCall.arguments.command, /Do not replay/);

    const project = normalizeMcpResult(JSON.stringify({ failed: true }), {
      context: {
        toolName: 'tl_gh_project_add_batch',
        arguments: { repo: 'owner/repo', project: 'acme/7', issues: [42] },
        cwd: repoRoot
      }
    }).structuredContent;
    assert.equal(project.error.recoveryCall.tool, 'tl_run');
    assert.match(project.error.recoveryCall.arguments.command, /^gh project item-list '7' --owner 'acme' --format json$/);
    assert.doesNotMatch(project.error.recoveryCall.arguments.command, /42/);
  });

  it('normalizes handler throws inside registered MCP tools', async () => {
    let registeredHandler;
    const server = {
      registerTool(_name, _config, handler) { registeredHandler = handler; }
    };
    registerToolDefinition(server, {
      name: 'tl_test_throw',
      description: 'test',
      schema: {},
      handler: async () => { throw new Error('registered boom'); }
    });

    const result = await registeredHandler({ cwd: '.' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.resultState, 'failed');
    assert.equal(result.structuredContent.error.code, 'TL_MCP_TOOL_FAILED');
    assert.equal(result.structuredContent.error.message, 'registered boom');
    assert.equal(result.structuredContent.error.effectiveCwd, repoRoot);
    assert.equal(result.structuredContent.error.recoveryCall.tool, 'tl_test_throw');
    assert.equal(result.structuredContent.error.recoveryCall.arguments.cwd, repoRoot);
  });
});
