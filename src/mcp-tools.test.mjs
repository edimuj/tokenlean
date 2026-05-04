import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
