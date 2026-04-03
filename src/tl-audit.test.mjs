import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const auditBin = join(repoRoot, 'bin', 'tl-audit.mjs');
const tlBin = join(repoRoot, 'bin', 'tl.mjs');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
}

function makeLargeOutput(label, lines = 220) {
  return Array.from({ length: lines }, (_, index) => `${label} line ${index}`).join('\n');
}

function writeJsonl(filePath, entries) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function createClaudeSession(homeDir, projectDir, options = {}) {
  const {
    sessionId = 'claude-session-1',
    slug = 'claude-run',
    timestamp = '2026-03-06T10:00:00.000Z',
    mtimeMs = Date.parse(timestamp),
  } = options;

  const normalizedProjectPath = resolve(projectDir).replace(/[\\/]/g, '-');
  const sessionPath = join(homeDir, '.claude', 'projects', normalizedProjectPath, `${sessionId}.jsonl`);

  writeJsonl(sessionPath, [
    {
      type: 'assistant',
      sessionId,
      timestamp,
      cwd: projectDir,
      slug,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'claude-build',
            name: 'Bash',
            input: { command: `cd ${projectDir} && npm test` },
          },
        ],
      },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp,
      cwd: projectDir,
      slug,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'claude-build',
            content: makeLargeOutput('claude build output'),
          },
        ],
      },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp,
      cwd: projectDir,
      slug,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'claude-tokenlean',
            name: 'Bash',
            input: { command: `cd ${projectDir} && tl-run npm test` },
          },
        ],
      },
    },
    {
      type: 'assistant',
      sessionId,
      timestamp,
      cwd: projectDir,
      slug,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'claude-tokenlean',
            content: makeLargeOutput('claude tokenlean output', 180),
          },
        ],
      },
    },
  ]);

  const mtime = new Date(mtimeMs);
  utimesSync(sessionPath, mtime, mtime);
  return sessionPath;
}

function createCodexSession(homeDir, projectDir, options = {}) {
  const {
    sessionId = 'codex-session-1',
    nickname = 'codex-run',
    timestamp = '2026-03-06T12:00:00.000Z',
    mtimeMs = Date.parse(timestamp),
  } = options;

  const sessionPath = join(
    homeDir,
    '.codex',
    'sessions',
    '2026',
    '03',
    '06',
    `${sessionId}.jsonl`
  );

  writeJsonl(sessionPath, [
    {
      type: 'session_meta',
      timestamp,
      payload: {
        id: sessionId,
        timestamp,
        cwd: projectDir,
        agent_nickname: nickname,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'codex-build',
        arguments: JSON.stringify({ cmd: `cd ${projectDir} && npm test` }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'codex-build',
        output: [
          'Chunk ID: test-build',
          'Wall time: 0.01 seconds',
          'Process exited with code 0',
          'Output:',
          makeLargeOutput('codex build output'),
        ].join('\n'),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'codex-tokenlean',
        arguments: JSON.stringify({ cmd: `cd ${projectDir} && tl-run npm test` }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'codex-tokenlean',
        output: [
          'Chunk ID: test-tokenlean',
          'Wall time: 0.01 seconds',
          'Process exited with code 0',
          'Output:',
          makeLargeOutput('codex tokenlean output', 180),
        ].join('\n'),
      },
    },
  ]);

  const mtime = new Date(mtimeMs);
  utimesSync(sessionPath, mtime, mtime);
  return sessionPath;
}

function createAuditFixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tokenlean-audit-'));
  const homeDir = join(tempRoot, 'home');
  const projectDir = join(tempRoot, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  createClaudeSession(homeDir, projectDir, {
    sessionId: 'claude-session-1',
    slug: 'claude-run',
    timestamp: '2026-03-06T10:00:00.000Z',
    mtimeMs: Date.parse('2026-03-06T10:00:00.000Z'),
  });

  createCodexSession(homeDir, projectDir, {
    sessionId: 'codex-session-1',
    nickname: 'codex-run',
    timestamp: '2026-03-06T12:00:00.000Z',
    mtimeMs: Date.parse('2026-03-06T12:00:00.000Z'),
  });

  return {
    tempRoot,
    homeDir,
    projectDir,
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  };
}

describe('tl-audit regressions', () => {
  it('TLA-001: default text output is aggregate-only and mentions both providers', () => {
    const fixture = createAuditFixture();

    try {
      const result = runCli([auditBin, '--all', '--savings'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Summary \(/);
      assert.match(result.stdout, /Claude Code/);
      assert.match(result.stdout, /Codex/);
      assert.match(result.stdout, /Already saved by tokenlean:/);
      assert.doesNotMatch(result.stdout, /^Session:/m);
      assert.doesNotMatch(result.stdout, /\bclaude-run\b/);
      assert.doesNotMatch(result.stdout, /\bcodex-run\b/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('TLA-002: verbose output adds per-session breakdowns for Claude and Codex', () => {
    const fixture = createAuditFixture();

    try {
      const result = runCli([auditBin, '--all', '--savings', '--verbose'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Summary \(/m);
      assert.match(result.stdout, /^Session: claude-run \[Claude Code\]/m);
      assert.match(result.stdout, /^Session: codex-run \[Codex\]/m);
      assert.match(result.stdout, /Findings:/);
      assert.match(result.stdout, /Savings detail:/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('TLA-003: JSON output includes aggregate data, provider counts, and per-session detail only when verbose', () => {
    const fixture = createAuditFixture();

    try {
      const summaryResult = runCli([auditBin, '--all', '--savings', '-j'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });

      assert.strictEqual(summaryResult.status, 0, summaryResult.stderr);
      const summaryData = JSON.parse(summaryResult.stdout);
      assert.strictEqual(summaryData.sessionsAnalyzed, 2);
      assert.deepStrictEqual(summaryData.providers, { claude: 1, codex: 1 });
      assert.ok(summaryData.summary.totalFindings >= 2);
      assert.ok(summaryData.savings.totalUses >= 2);
      assert.ok(!('sessions' in summaryData));

      const verboseResult = runCli([auditBin, '--all', '--savings', '--verbose', '-j'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });

      assert.strictEqual(verboseResult.status, 0, verboseResult.stderr);
      const verboseData = JSON.parse(verboseResult.stdout);
      assert.strictEqual(verboseData.sessions.length, 2);
      assert.deepStrictEqual(
        verboseData.sessions.map(session => session.provider).sort(),
        ['claude', 'codex']
      );
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('TLA-004: provider flags isolate Claude Code and Codex sessions', () => {
    const fixture = createAuditFixture();

    try {
      const codexResult = runCli([auditBin, '--all', '--codex', '--savings', '-j'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });
      assert.strictEqual(codexResult.status, 0, codexResult.stderr);
      const codexData = JSON.parse(codexResult.stdout);
      assert.strictEqual(codexData.sessionsAnalyzed, 1);
      assert.deepStrictEqual(codexData.providers, { codex: 1 });

      const claudeResult = runCli([auditBin, '--all', '--claude-code', '--savings', '-j'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });
      assert.strictEqual(claudeResult.status, 0, claudeResult.stderr);
      const claudeData = JSON.parse(claudeResult.stdout);
      assert.strictEqual(claudeData.sessionsAnalyzed, 1);
      assert.deepStrictEqual(claudeData.providers, { claude: 1 });

      const claudeProviderResult = runCli([auditBin, '--all', '--provider', 'claude', '--savings', '-j'], {
        cwd: fixture.projectDir,
        env: fixture.env,
      });
      assert.strictEqual(claudeProviderResult.status, 0, claudeProviderResult.stderr);
      const claudeProviderData = JSON.parse(claudeProviderResult.stdout);
      assert.strictEqual(claudeProviderData.sessionsAnalyzed, 1);
      assert.deepStrictEqual(claudeProviderData.providers, { claude: 1 });
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('TLA-005: tl dispatches audit subcommands through the main entrypoint', () => {
    const result = runCli([tlBin, 'audit', '--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: tl-audit/);
    assert.match(result.stdout, /--provider <name>/);
    assert.match(result.stdout, /--codex/);
  });
});
