import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToolCall, rewriteShellCommand } from './hook-policy.mjs';

describe('hook policy', () => {
  it('nudges build/test commands toward tl-run', () => {
    const decision = evaluateToolCall({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    assert.equal(decision.id, 'bash-test');
    assert.equal(decision.action, 'wrap');
    assert.equal(decision.alternative, 'tl run "npm test"');
  });

  it('does not nudge commands already using tokenlean', () => {
    const decision = evaluateToolCall({
      tool_name: 'Bash',
      tool_input: { command: 'tl run "npm test"' },
    });

    assert.equal(decision, null);
  });

  it('supports Codex-style command payloads', () => {
    const decision = evaluateToolCall({
      tool: 'exec_command',
      input: { cmd: 'tail -f app.log' },
    });

    assert.equal(decision.id, 'bash-tail');
  });

  it('rewrites safe shell commands for rewriting adapters', () => {
    assert.equal(rewriteShellCommand('npm test'), 'tl-run "npm test"');
    assert.equal(rewriteShellCommand('curl https://example.com/page'), 'tl-browse "https://example.com/page"');
  });
});
