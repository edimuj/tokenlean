import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolArguments,
  toEpochMs,
  isWithinSinceDays,
  isSameOrWithinPath,
  normalizeClaudeProjectPath,
  extractTlTool,
  extractCodexShellCommands,
  extractClaudeShellCommands
} from './perf-log-mining.mjs';

describe('parseToolArguments', () => {
  it('parses JSON string arguments', () => {
    const parsed = parseToolArguments('{"cmd":"npm test"}');
    assert.equal(parsed.cmd, 'npm test');
  });

  it('returns empty object on invalid JSON', () => {
    const parsed = parseToolArguments('{broken');
    assert.deepEqual(parsed, {});
  });
});

describe('toEpochMs', () => {
  it('parses ISO timestamp strings', () => {
    assert.equal(toEpochMs('2026-04-03T12:00:00.000Z'), 1775217600000);
  });

  it('returns null for invalid values', () => {
    assert.equal(toEpochMs('not-a-date'), null);
    assert.equal(toEpochMs(null), null);
  });
});

describe('isWithinSinceDays', () => {
  it('returns true when timestamp is inside window', () => {
    const now = Date.parse('2026-04-03T12:00:00.000Z');
    assert.equal(isWithinSinceDays('2026-04-02T13:00:00.000Z', 2, now), true);
  });

  it('returns false when timestamp is outside window', () => {
    const now = Date.parse('2026-04-03T12:00:00.000Z');
    assert.equal(isWithinSinceDays('2026-03-28T11:59:59.000Z', 6, now), false);
  });

  it('returns false for invalid timestamp when filter is active', () => {
    const now = Date.parse('2026-04-03T12:00:00.000Z');
    assert.equal(isWithinSinceDays('invalid', 7, now), false);
  });
});

describe('isSameOrWithinPath', () => {
  it('matches exact path and subpath', () => {
    assert.equal(isSameOrWithinPath('/tmp/a', '/tmp/a'), true);
    assert.equal(isSameOrWithinPath('/tmp/a/b', '/tmp/a'), true);
    assert.equal(isSameOrWithinPath('/tmp/ab', '/tmp/a'), false);
  });
});

describe('normalizeClaudeProjectPath', () => {
  it('normalizes path to Claude project directory form', () => {
    assert.equal(normalizeClaudeProjectPath('/home/edimuj/projects/oss/tokenlean'), 'home-edimuj-projects-oss-tokenlean');
  });
});

describe('extractTlTool', () => {
  it('extracts direct tl invocation', () => {
    assert.equal(extractTlTool('tl-symbols src/file.ts'), 'tl-symbols');
  });

  it('extracts tool after shell chaining token', () => {
    assert.equal(extractTlTool('echo start && tl-impact src/file.ts -q'), 'tl-impact');
  });

  it('extracts node bin invocation', () => {
    assert.equal(extractTlTool('node bin/tl-run.mjs "npm test" -q'), 'tl-run');
  });

  it('does not treat filename mentions as execution', () => {
    assert.equal(extractTlTool('sed -n "1,200p" bin/tl-impact.mjs'), null);
  });

  it('does not treat regex pattern mentions as execution', () => {
    assert.equal(extractTlTool('rg -n "TLT-011|tl-tail collapses" src/cli-regressions.test.mjs'), null);
  });

  it('returns null for non-tokenlean command', () => {
    assert.equal(extractTlTool('npm test'), null);
  });
});

describe('extractCodexShellCommands', () => {
  it('extracts cmd from exec_command call', () => {
    const commands = extractCodexShellCommands({
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"tl-impact src/x.ts"}' }
    });

    assert.deepEqual(commands, ['tl-impact src/x.ts']);
  });

  it('extracts nested cmds from multi_tool_use.parallel', () => {
    const commands = extractCodexShellCommands({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'multi_tool_use.parallel',
        arguments: JSON.stringify({
          tool_uses: [
            { recipient_name: 'functions.exec_command', parameters: { cmd: 'tl-symbols src/a.ts' } },
            { recipient_name: 'functions.exec_command', parameters: { cmd: 'npm test' } },
            { recipient_name: 'functions.other', parameters: { cmd: 'ignore' } }
          ]
        })
      }
    });

    assert.deepEqual(commands, ['tl-symbols src/a.ts', 'npm test']);
  });
});

describe('extractClaudeShellCommands', () => {
  it('extracts Bash tool_use commands', () => {
    const commands = extractClaudeShellCommands({
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'tl-snippet foo src/x.ts' } },
          { type: 'text', text: 'ignore' }
        ]
      }
    });

    assert.deepEqual(commands, ['tl-snippet foo src/x.ts']);
  });
});
