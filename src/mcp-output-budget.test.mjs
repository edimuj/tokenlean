import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { clearConfigCache } from './config.mjs';
import {
  boundMcpResponseText,
  DEFAULT_MCP_MAX_ITEMS,
  DEFAULT_MCP_MAX_TOKENS,
  getMcpRequestContext,
  registerToolDefinition,
  TOOLS,
  withMcpRequestContext
} from './mcp-tools.mjs';

describe('MCP structured response budgets', () => {
  it('applies safe item/token defaults and returns continuation metadata', () => {
    const source = { rows: Array.from({ length: DEFAULT_MCP_MAX_ITEMS + 5 }, (_, i) => ({ i })) };
    const parsed = withMcpRequestContext('tl_test', {}, () => {
      const context = getMcpRequestContext();
      assert.strictEqual(context.maxItems, DEFAULT_MCP_MAX_ITEMS);
      assert.strictEqual(context.maxTokens, DEFAULT_MCP_MAX_TOKENS);
      return JSON.parse(boundMcpResponseText(JSON.stringify(source)));
    });

    assert.strictEqual(parsed.rows.length, DEFAULT_MCP_MAX_ITEMS);
    assert.strictEqual(parsed.truncated, true);
    assert.deepStrictEqual(parsed.continuation.arguments, {
      offset: DEFAULT_MCP_MAX_ITEMS,
      maxItems: DEFAULT_MCP_MAX_ITEMS,
      maxTokens: DEFAULT_MCP_MAX_TOKENS
    });
  });

  it('uses per-cwd configured ceilings and source pagination arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-mcp-budgets-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 3, maxTokens: 100 } }));
    writeFileSync(join(second, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 5, maxTokens: 200 } }));

    try {
      clearConfigCache();
      withMcpRequestContext('tl_test', { cwd: first, offset: 3 }, () => {
        const context = getMcpRequestContext();
        assert.strictEqual(context.maxItems, 3);
        assert.strictEqual(context.maxTokens, 100);
        assert.strictEqual(context.offset, 3);
      });
      withMcpRequestContext('tl_test', { cwd: second }, () => {
        assert.strictEqual(getMcpRequestContext().maxItems, 5);
        assert.strictEqual(getMcpRequestContext().maxTokens, 200);
      });
    } finally {
      clearConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports continuation offsets without offsetting nested row collections', () => {
    const source = {
      rows: Array.from({ length: 7 }, (_, i) => ({ i, details: [`a${i}`, `b${i}`] })),
      metadata: ['kept']
    };
    const parsed = withMcpRequestContext('tl_test', { maxItems: 2, offset: 2 }, () =>
      JSON.parse(boundMcpResponseText(JSON.stringify(source))));

    assert.deepStrictEqual(parsed.rows.map(row => row.i), [2, 3]);
    assert.deepStrictEqual(parsed.rows[0].details, ['a2', 'b2']);
    assert.deepStrictEqual(parsed.metadata, ['kept']);
    assert.strictEqual(parsed.continuation.nextOffset, 4);
  });

  it('applies default budgets through a registered production MCP handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-mcp-default-page-'));
    const source = join(root, 'src');
    mkdirSync(source);
    for (let i = 0; i < DEFAULT_MCP_MAX_ITEMS + 5; i++) {
      writeFileSync(join(source, `file-${String(i).padStart(3, '0')}.js`), `export function f${i}() { return ${i}; }\n`);
    }

    let registeredHandler;
    const server = {
      registerTool(name, _config, handler) {
        if (name === 'tl_symbols') registeredHandler = handler;
      }
    };
    registerToolDefinition(server, TOOLS.find(tool => tool.name === 'tl_symbols'));

    try {
      const result = await registeredHandler({ files: source, cwd: root });
      const parsed = JSON.parse(result.content[0].text);
      assert.strictEqual(parsed.files.length, DEFAULT_MCP_MAX_ITEMS);
      assert.strictEqual(parsed.truncated, true);
      assert.deepStrictEqual(parsed.continuation.arguments, {
        files: source,
        cwd: root,
        offset: DEFAULT_MCP_MAX_ITEMS,
        maxItems: DEFAULT_MCP_MAX_ITEMS,
        maxTokens: DEFAULT_MCP_MAX_TOKENS
      });
      assert.strictEqual(parsed.continuation.tool, 'tl_symbols');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns distinct registered tl_lookup pages without double-applying offset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-mcp-lookup-pages-'));
    const source = join(root, 'src');
    mkdirSync(source);
    writeFileSync(join(root, '.tokenleanrc.json'), JSON.stringify({ output: { maxLines: 2, maxTokens: 1000 } }));
    writeFileSync(join(source, 'formatters.js'), Array.from({ length: 6 }, (_, i) =>
      `export function formatValue${i}(value) { return String(value); }`).join('\n'));

    let registeredHandler;
    const server = {
      registerTool(name, _config, handler) {
        if (name === 'tl_lookup') registeredHandler = handler;
      }
    };
    registerToolDefinition(server, TOOLS.find(tool => tool.name === 'tl_lookup'));

    try {
      clearConfigCache();
      const first = JSON.parse((await registeredHandler({
        query: 'format value', path: source, cwd: root, limit: 6, maxItems: 2
      })).content[0].text);
      const second = JSON.parse((await registeredHandler(first.continuation.arguments)).content[0].text);

      assert.strictEqual(first.matches.length, 2);
      assert.strictEqual(second.matches.length, 2);
      assert.notDeepStrictEqual(
        first.matches.map(match => match.name),
        second.matches.map(match => match.name)
      );
      assert.strictEqual(first.continuation.nextOffset, 2);
      assert.strictEqual(first.continuation.tool, 'tl_lookup');
      assert.strictEqual(first.continuation.arguments.query, 'format value');
      assert.strictEqual(first.continuation.arguments.path, source);
      assert.strictEqual(first.continuation.arguments.limit, 6);
      assert.strictEqual(second.pagination.collections[0].offset, 2);
    } finally {
      clearConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not advertise replay pagination on mutating MCP schemas', () => {
    const close = TOOLS.find(tool => tool.name === 'tl_gh_issue_close');
    const read = TOOLS.find(tool => tool.name === 'tl_gh_issue_read');
    const pack = TOOLS.find(tool => tool.name === 'tl_pack');
    assert.strictEqual(close.schema.safeParse({ repo: 'owner/repo', issues: 1, offset: 2 }).success, false);
    assert.strictEqual(read.schema.safeParse({ repo: 'owner/repo', issue: 1, offset: 2 }).success, true);
    assert.strictEqual(pack.schema.safeParse({ pack: 'debug', command: 'npm test', offset: 2 }).success, false);
  });

  it('keeps text, structured JSON, and successful stderr inside one token budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-mcp-aggregate-budget-'));
    const hook = join(root, 'noisy.cjs');
    const source = join(root, 'api.js');
    writeFileSync(hook, "process.stderr.write('warning '.repeat(20000));\n");
    writeFileSync(source, 'export function api() { return 1; }\n');

    let registeredHandler;
    const server = {
      registerTool(name, _config, handler) {
        if (name === 'tl_context') registeredHandler = handler;
      }
    };
    registerToolDefinition(server, TOOLS.find(tool => tool.name === 'tl_context'));

    const previousNodeOptions = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = `--require=${hook}`;
      const maxTokens = 200;
      const result = await registeredHandler({ path: source, cwd: root, maxTokens });
      const contentChars = result.content.reduce((sum, item) => sum + (item.text?.length || 0), 0);
      const structuredChars = JSON.stringify(result.structuredContent).length;
      assert.ok(contentChars + structuredChars <= maxTokens * 4,
        `aggregate response used ${contentChars + structuredChars} chars`);
      assert.ok(JSON.stringify(result).length <= maxTokens * 4,
        `serialized MCP response used ${JSON.stringify(result).length} chars`);
      assert.equal(JSON.parse(result.content[0].text).resultState, 'success');
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
