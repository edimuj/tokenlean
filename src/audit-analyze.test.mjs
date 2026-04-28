import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_LABELS,
  providerLabel,
  RATIOS,
  SAVINGS_RATIOS,
  CHARS_PER_TOKEN,
  BUILD_TEST_PATTERNS,
  mergeSessionMeta,
  parseSession,
} from './audit-analyze.mjs';

describe('providerLabel', () => {
  it('returns Claude Code for claude', () => {
    assert.equal(providerLabel('claude'), 'Claude Code');
  });

  it('returns Codex for codex', () => {
    assert.equal(providerLabel('codex'), 'Codex');
  });

  it('returns raw string for unknown providers', () => {
    assert.equal(providerLabel('other'), 'other');
  });
});

describe('constants', () => {
  it('PROVIDER_LABELS has claude and codex', () => {
    assert.ok('claude' in PROVIDER_LABELS);
    assert.ok('codex' in PROVIDER_LABELS);
  });

  it('RATIOS has expected keys', () => {
    assert.ok(RATIOS.READ_LARGE_TO_SYMBOLS > 0 && RATIOS.READ_LARGE_TO_SYMBOLS < 1);
    assert.ok(RATIOS.BASH_BUILD_TO_RUN > 0 && RATIOS.BASH_BUILD_TO_RUN < 1);
  });

  it('SAVINGS_RATIOS has tl-* tool keys', () => {
    assert.ok('tl-symbols' in SAVINGS_RATIOS);
    assert.ok('tl-run' in SAVINGS_RATIOS);
    assert.ok('tl-browse' in SAVINGS_RATIOS);
  });

  it('CHARS_PER_TOKEN is 4', () => {
    assert.equal(CHARS_PER_TOKEN, 4);
  });

  it('BUILD_TEST_PATTERNS matches common test commands', () => {
    const commands = ['npm test', 'yarn run test', 'cargo test', 'pytest', 'node --test foo.mjs'];
    for (const cmd of commands) {
      assert.ok(BUILD_TEST_PATTERNS.some(p => p.test(cmd)), `should match: ${cmd}`);
    }
  });

  it('BUILD_TEST_PATTERNS does not match regular commands', () => {
    const commands = ['npm install', 'git status', 'cat file.txt'];
    for (const cmd of commands) {
      assert.ok(!BUILD_TEST_PATTERNS.some(p => p.test(cmd)), `should not match: ${cmd}`);
    }
  });
});

describe('mergeSessionMeta', () => {
  it('creates from null existing', () => {
    const result = mergeSessionMeta(null, { provider: 'claude', sessionId: 'abc' });
    assert.equal(result.provider, 'claude');
    assert.equal(result.sessionId, 'abc');
  });

  it('merges with existing', () => {
    const existing = { provider: 'claude', sessionId: 'old', timestamp: null, cwd: '/proj', slug: null };
    const result = mergeSessionMeta(existing, { sessionId: 'new', timestamp: '2026-01-01' });
    assert.equal(result.provider, 'claude');
    assert.equal(result.sessionId, 'new');
    assert.equal(result.timestamp, '2026-01-01');
    assert.equal(result.cwd, '/proj');
  });

  it('preserves existing values when update is empty', () => {
    const existing = { provider: 'codex', sessionId: 'id1', timestamp: 't1', cwd: '/c', slug: 's1' };
    const result = mergeSessionMeta(existing, {});
    assert.equal(result.provider, 'codex');
    assert.equal(result.sessionId, 'id1');
  });
});

describe('parseSession — Claude', () => {
  function makeClaudeJsonl(toolUses) {
    const lines = [];
    for (const { id, name, input, result } of toolUses) {
      lines.push(JSON.stringify({
        type: 'assistant',
        sessionId: 'test-session',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/project',
        slug: 'test',
        message: { content: [{ type: 'tool_use', id, name, input }] },
      }));
      lines.push(JSON.stringify({
        type: 'assistant',
        sessionId: 'test-session',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/project',
        slug: 'test',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
      }));
    }
    return lines.join('\n');
  }

  it('parses empty session', () => {
    const result = parseSession('', 'claude');
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.savings, []);
  });

  it('detects build/test output waste', () => {
    const bigOutput = 'x'.repeat(2000);
    const jsonl = makeClaudeJsonl([{
      id: 'call-1',
      name: 'Bash',
      input: { command: 'npm test' },
      result: bigOutput,
    }]);
    const { findings } = parseSession(jsonl, 'claude');
    assert.ok(findings.length > 0, 'should detect findings');
    assert.equal(findings[0].category, 'build-test-output');
    assert.equal(findings[0].suggestion, 'tl-run');
  });

  it('detects large file read waste', () => {
    const bigContent = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const jsonl = makeClaudeJsonl([{
      id: 'call-2',
      name: 'Read',
      input: { file_path: '/project/src/big.ts' },
      result: bigContent,
    }]);
    const { findings } = parseSession(jsonl, 'claude');
    assert.ok(findings.length > 0);
    assert.equal(findings[0].category, 'read-large-file');
  });

  it('ignores small results', () => {
    const smallOutput = 'ok';
    const jsonl = makeClaudeJsonl([{
      id: 'call-3',
      name: 'Bash',
      input: { command: 'npm test' },
      result: smallOutput,
    }]);
    const { findings } = parseSession(jsonl, 'claude');
    assert.equal(findings.length, 0);
  });

  it('detects tokenlean savings', () => {
    const tlOutput = 'x'.repeat(2000);
    const jsonl = makeClaudeJsonl([{
      id: 'call-4',
      name: 'Bash',
      input: { command: 'tl-run npm test' },
      result: tlOutput,
    }]);
    const { savings } = parseSession(jsonl, 'claude');
    assert.ok(savings.length > 0, 'should detect savings');
    assert.equal(savings[0].tool, 'tl-run');
    assert.ok(savings[0].savedTokens > 0);
  });
  it('detects tokenlean MCP savings for Claude tool calls', () => {
    const tlOutput = 'x'.repeat(2000);
    const jsonl = makeClaudeJsonl([{
      id: 'call-4m',
      name: 'tl_run',
      input: { command: 'npm test', timeout: 1000 },
      result: tlOutput,
    }]);
    const { savings } = parseSession(jsonl, 'claude');
    assert.ok(savings.length > 0, 'should detect savings');
    assert.equal(savings[0].tool, 'tl-run');
    assert.ok(savings[0].command.startsWith('tl-run'));
    assert.ok(savings[0].savedTokens > 0);
  });



  it('detects namespaced tokenlean MCP savings for Claude tool calls', () => {
    const tlOutput = 'x'.repeat(2000);
    const jsonl = makeClaudeJsonl([{
      id: 'call-4mn',
      name: 'mcp__tokenlean__tl_run',
      input: { command: 'npm test' },
      result: tlOutput,
    }]);
    const { savings } = parseSession(jsonl, 'claude');
    assert.ok(savings.length > 0, 'should detect savings');
    assert.equal(savings[0].tool, 'tl-run');
    assert.ok(savings[0].command.startsWith('tl-run'));
  });

  it('keeps Claude detection with non-tool lines present', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'noise-session',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/project',
        slug: 'noise',
        message: { content: 'plain assistant text' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'noise-session',
        timestamp: '2026-01-01T00:00:01Z',
        cwd: '/project',
        slug: 'noise',
        message: { content: [{ type: 'tool_use', id: 'noise-call', name: 'Bash', input: { command: 'npm test' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'noise-session',
        timestamp: '2026-01-01T00:00:02Z',
        cwd: '/project',
        slug: 'noise',
        message: { content: [{ type: 'tool_result', tool_use_id: 'noise-call', content: 'x'.repeat(2000) }] },
      }),
    ];
    const { findings, meta } = parseSession(lines.join('\n'), 'claude', { includeSavings: false });
    assert.ok(findings.some(f => f.category === 'build-test-output'));
    assert.equal(meta.sessionId, 'noise-session');
  });

  it('skips savings analysis when includeSavings is false', () => {
    const tlOutput = 'x'.repeat(2000);
    const jsonl = makeClaudeJsonl([{
      id: 'call-4b',
      name: 'Bash',
      input: { command: 'tl-run npm test' },
      result: tlOutput,
    }]);
    const { savings } = parseSession(jsonl, 'claude', { includeSavings: false });
    assert.deepEqual(savings, []);
  });

  it('populates session meta', () => {
    const jsonl = makeClaudeJsonl([{
      id: 'call-5',
      name: 'Bash',
      input: { command: 'echo hi' },
      result: 'hi',
    }]);
    const { meta } = parseSession(jsonl, 'claude');
    assert.equal(meta.provider, 'claude');
    assert.equal(meta.sessionId, 'test-session');
    assert.ok(meta.timestamp);
  });
});

describe('parseSession — Codex', () => {
  function makeCodexJsonl(calls) {
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'codex-1', timestamp: '2026-01-01T00:00:00Z', cwd: '/project' },
      }),
    ];
    for (const { callId, name, args, output } of calls) {
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
      }));
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: callId, output },
      }));
    }
    return lines.join('\n');
  }

  it('parses codex session with findings', () => {
    const bigOutput = '\nOutput:\n' + 'x'.repeat(2000);
    const jsonl = makeCodexJsonl([{
      callId: 'c1',
      name: 'exec_command',
      args: { cmd: 'cargo test' },
      output: bigOutput,
    }]);
    const { findings, meta } = parseSession(jsonl, 'codex');
    assert.ok(findings.length > 0);
    assert.equal(findings[0].category, 'build-test-output');
    assert.equal(meta.provider, 'codex');
    assert.equal(meta.sessionId, 'codex-1');
  });

  it('detects tokenlean MCP savings for Codex function calls', () => {
    const bigOutput = '\nOutput:\n' + 'x'.repeat(2000);
    const jsonl = makeCodexJsonl([{
      callId: 'c1m',
      name: 'tl_symbols',
      args: { files: 'src/' },
      output: bigOutput,
    }]);
    const { savings } = parseSession(jsonl, 'codex');
    assert.ok(savings.length > 0, 'should detect savings');
    assert.equal(savings[0].tool, 'tl-symbols');
    assert.ok(savings[0].command.startsWith('tl-symbols'));
    assert.ok(savings[0].savedTokens > 0);
  });


  it('detects namespaced tokenlean MCP savings for Codex function calls', () => {
    const bigOutput = '\nOutput:\n' + 'x'.repeat(2000);
    const jsonl = makeCodexJsonl([{
      callId: 'c1mn',
      name: 'mcp__tokenlean__tl_symbols',
      args: { files: 'src/' },
      output: bigOutput,
    }]);
    const { savings } = parseSession(jsonl, 'codex');
    assert.ok(savings.length > 0, 'should detect savings');
    assert.equal(savings[0].tool, 'tl-symbols');
    assert.ok(savings[0].command.startsWith('tl-symbols'));
  });

  it('skips codex savings analysis when includeSavings is false', () => {
    const bigOutput = '\nOutput:\n' + 'x'.repeat(2000);
    const jsonl = makeCodexJsonl([{
      callId: 'c1b',
      name: 'exec_command',
      args: { cmd: 'tl-run npm test' },
      output: bigOutput,
    }]);
    const { savings } = parseSession(jsonl, 'codex', { includeSavings: false });
    assert.deepEqual(savings, []);
  });

  it('throws on unsupported provider', () => {
    assert.throws(() => parseSession('', 'unknown'), /Unsupported provider/);
  });
});
