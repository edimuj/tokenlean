import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function runHook(payload, env = {}) {
  return spawnSync(process.execPath, ['bin/tl-hook.mjs', 'run'], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe('tl-hook codex compatibility', () => {
  it('stays silent for Codex advisory nudges by default', () => {
    const result = runHook({
      session_id: 's1',
      turn_id: 't1',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rg foo .' },
      tool_use_id: 'u1',
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), '');
  });

  it('can emit Codex systemMessage nudges when explicitly enabled', () => {
    const result = runHook({
      session_id: 's1',
      turn_id: 't1',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rg foo .' },
      tool_use_id: 'u1',
    }, {
      TOKENLEAN_CODEX_WARNINGS: '1',
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      systemMessage: '[tl] use Grep tool, not bash',
    });
  });

  it('preserves Claude hookSpecificOutput nudges', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'rg foo .' },
    }, {
      TOKENLEAN_HOOK_FORMAT: 'claude',
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '[tl] use Grep tool, not bash',
      },
    });
  });
});
