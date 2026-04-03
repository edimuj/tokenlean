import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeProvider, resolveSessionFiles } from './audit-discover.mjs';

let originalHome;
let tmpHome;

before(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'tl-audit-discover-'));
  process.env.HOME = tmpHome;
});

after(() => {
  process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('normalizeProvider', () => {
  it('accepts claude directly', () => {
    assert.equal(normalizeProvider('claude'), 'claude');
  });

  it('normalizes claude-code to claude', () => {
    assert.equal(normalizeProvider('claude-code'), 'claude');
  });

  it('normalizes claudecode to claude', () => {
    assert.equal(normalizeProvider('claudecode'), 'claude');
  });

  it('keeps codex as codex', () => {
    assert.equal(normalizeProvider('codex'), 'codex');
  });

  it('normalizes provider names case-insensitively', () => {
    assert.equal(normalizeProvider('ClAuDe'), 'claude');
    assert.equal(normalizeProvider('CoDeX'), 'codex');
  });

  it('normalizes auto', () => {
    assert.equal(normalizeProvider('auto'), 'auto');
  });

  it('normalizes null/undefined to auto', () => {
    assert.equal(normalizeProvider(null), 'auto');
    assert.equal(normalizeProvider(undefined), 'auto');
  });

  it('throws on unsupported provider', () => {
    assert.throws(() => normalizeProvider('invalid'), /Unsupported provider/);
  });
});

describe('resolveSessionFiles', () => {
  it('returns newest matching Codex project sessions for --latest', async () => {
    const projectRoot = join(tmpHome, 'work', 'proj-a');
    mkdirSync(projectRoot, { recursive: true });

    const codexDayDir = join(tmpHome, '.codex', 'sessions', '2026', '04', '03');
    mkdirSync(codexDayDir, { recursive: true });

    const newestMatch = join(codexDayDir, 'rollout-2026-04-03T12-00-00-aaaaaaaa.jsonl');
    const middleNoMatch = join(codexDayDir, 'rollout-2026-04-03T11-00-00-bbbbbbbb.jsonl');
    const oldestMatch = join(codexDayDir, 'rollout-2026-04-03T10-00-00-cccccccc.jsonl');

    writeFileSync(newestMatch, `${JSON.stringify({ type: 'session_meta', payload: { cwd: projectRoot } })}\n{"type":"response_item"}\n`);
    writeFileSync(middleNoMatch, `${JSON.stringify({ type: 'session_meta', payload: { cwd: join(tmpHome, 'work', 'proj-b') } })}\n`);
    writeFileSync(oldestMatch, `${JSON.stringify({ type: 'session_meta', payload: { cwd: join(projectRoot, 'nested') } })}\n`);

    const base = Date.now();
    utimesSync(oldestMatch, base / 1000 - 30, base / 1000 - 30);
    utimesSync(middleNoMatch, base / 1000 - 20, base / 1000 - 20);
    utimesSync(newestMatch, base / 1000 - 10, base / 1000 - 10);

    const files = await resolveSessionFiles(projectRoot, 'codex', 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].provider, 'codex');
    assert.equal(files[0].path, newestMatch);
  });

  it('detects Codex provider from first non-empty line for direct file target', async () => {
    const codexDayDir = join(tmpHome, '.codex', 'sessions', '2026', '04', '03');
    mkdirSync(codexDayDir, { recursive: true });
    const sessionFile = join(codexDayDir, 'rollout-2026-04-03T13-00-00-dddddddd.jsonl');
    writeFileSync(
      sessionFile,
      `\n${JSON.stringify({ type: 'session_meta', payload: { cwd: join(tmpHome, 'work', 'proj-a') } })}\n${'x'.repeat(50000)}\n`
    );

    const files = await resolveSessionFiles(sessionFile, 'auto', 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].provider, 'codex');
    assert.equal(files[0].path, sessionFile);
  });
});
