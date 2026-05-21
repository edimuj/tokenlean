import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToolCall, rewriteShellCommand, formatNudge } from './hook-policy.mjs';

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

  it('does not recommend tl-symbols for markdown Read calls', () => {
    const decision = evaluateToolCall({
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    }, {
      stat: () => ({ size: 50000 }),
    });

    assert.equal(decision, null);
  });

  it('does not recommend tl-symbols for cat on non-code files', () => {
    const decision = evaluateToolCall({
      tool_name: 'Bash',
      tool_input: { command: 'cat README.md' },
    });

    assert.equal(decision.id, 'bash-cat-non-code');
    assert.equal(decision.alternative, 'Read tool');
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

describe('formatNudge', () => {
  it('emits hookSpecificOutput with permissionDecision for claude-code (default)', () => {
    const result = JSON.parse(formatNudge('[tl] use tl-run'));
    assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(result.hookSpecificOutput.permissionDecisionReason, '[tl] use tl-run');
    assert.equal(result.systemMessage, undefined);
  });

  it('emits hookSpecificOutput for explicit claude-code target', () => {
    const result = JSON.parse(formatNudge('[tl] use tl-run', 'claude-code'));
    assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('emits systemMessage without permissionDecision for codex target', () => {
    const result = JSON.parse(formatNudge('[tl] use tl-run', 'codex'));
    assert.equal(result.systemMessage, '[tl] use tl-run');
    assert.equal(result.hookSpecificOutput, undefined);
  });
});
