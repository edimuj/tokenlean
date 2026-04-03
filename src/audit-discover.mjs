/**
 * Session file discovery for tl-audit.
 *
 * Finds Claude Code and Codex session JSONL files
 * by project path, session directory, or direct file path.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { providerLabel } from './audit-analyze.mjs';

// ─────────────────────────────────────────────────────────────
// Provider normalization
// ─────────────────────────────────────────────────────────────

export function normalizeProvider(provider) {
  if (provider === 'claude-code' || provider === 'claudecode') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'auto' || !provider) return 'auto';
  throw new Error(`Unsupported provider: ${provider}`);
}

// ─────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────

function normalizeClaudeProjectPath(projectPath) {
  return resolve(projectPath).replace(/[\\/]/g, '-');
}

function isSameOrWithinPath(childPath, parentPath) {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

function claudeSessionsRoot() {
  return join(homedir(), '.claude', 'projects');
}

function codexSessionsRoot() {
  return join(homedir(), '.codex', 'sessions');
}

// ─────────────────────────────────────────────────────────────
// File listing helpers
// ─────────────────────────────────────────────────────────────

async function listFlatJsonlFiles(dir, provider) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = await Promise.all(entries
    .filter(entry => entry.endsWith('.jsonl'))
    .map(async entry => {
      const path = join(dir, entry);
      const info = await stat(path);
      return { path, mtime: info.mtimeMs, size: info.size, provider };
    }));

  return files;
}

async function listRecursiveJsonlFiles(dir, provider) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listRecursiveJsonlFiles(path, provider);
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(path);
      return [{ path, mtime: info.mtimeMs, size: info.size, provider }];
    }
    return [];
  }));

  return nested.flat();
}

// ─────────────────────────────────────────────────────────────
// Project session matching
// ─────────────────────────────────────────────────────────────

async function findClaudeSessionsForProject(projectPath) {
  const root = claudeSessionsRoot();
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const normalized = normalizeClaudeProjectPath(projectPath);
  const matches = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name === normalized || name.startsWith(`${normalized}-`));

  const files = await Promise.all(matches.map(name => listFlatJsonlFiles(join(root, name), 'claude')));
  return files.flat();
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readCodexSessionMeta(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const firstLine = content.split('\n').find(line => line.trim());
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj || obj.type !== 'session_meta') return null;
  return obj.payload || null;
}

async function findCodexSessionsForProject(projectPath) {
  const root = codexSessionsRoot();
  const files = await listRecursiveJsonlFiles(root, 'codex');
  const resolvedProject = resolve(projectPath);

  const matches = await Promise.all(files.map(async file => {
    const meta = await readCodexSessionMeta(file.path);
    if (!meta?.cwd) return null;
    return isSameOrWithinPath(meta.cwd, resolvedProject) ? file : null;
  }));

  return matches.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Provider detection
// ─────────────────────────────────────────────────────────────

function detectSessionDirProvider(target) {
  const resolved = resolve(target);
  if (isSameOrWithinPath(resolved, claudeSessionsRoot())) return 'claude';
  if (isSameOrWithinPath(resolved, codexSessionsRoot())) return 'codex';
  return null;
}

async function detectSessionFileProvider(filePath) {
  const content = await readFile(filePath, 'utf8');
  const firstLine = content.split('\n').find(line => line.trim());
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj) return null;
  if (obj.type === 'session_meta') return 'codex';
  if (obj.sessionId || obj.message || obj.cwd) return 'claude';
  return null;
}

// ─────────────────────────────────────────────────────────────
// Session sorting / limiting
// ─────────────────────────────────────────────────────────────

function sortSessionsByNewest(sessions) {
  return [...sessions].sort((a, b) => b.mtime - a.mtime);
}

function limitSessions(sessions, count) {
  if (!Number.isFinite(count)) return sessions;
  return sessions.slice(0, count);
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export async function findProjectSessions(projectPath, provider, count) {
  const files = [];
  if (provider === 'auto' || provider === 'claude') {
    files.push(...await findClaudeSessionsForProject(projectPath));
  }
  if (provider === 'auto' || provider === 'codex') {
    files.push(...await findCodexSessionsForProject(projectPath));
  }
  return limitSessions(sortSessionsByNewest(files), count);
}

export async function resolveSessionFiles(targetPath, provider, count) {
  const target = resolve(targetPath);
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch {
    throw new Error(`Path not found: ${target}`);
  }

  if (targetStat.isFile()) {
    if (!target.endsWith('.jsonl')) {
      throw new Error(`Session file must be a .jsonl file: ${target}`);
    }

    const detected = await detectSessionFileProvider(target);
    if (!detected) {
      throw new Error(`Could not detect session provider for ${target}`);
    }
    if (provider !== 'auto' && provider !== detected) {
      throw new Error(`${target} is a ${providerLabel(detected)} session, not ${providerLabel(provider)}`);
    }
    return [{ path: target, mtime: targetStat.mtimeMs, size: targetStat.size, provider: detected }];
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Unsupported target: ${target}`);
  }

  const sessionDirProvider = detectSessionDirProvider(target);
  if (sessionDirProvider) {
    if (provider !== 'auto' && provider !== sessionDirProvider) {
      throw new Error(`${target} is a ${providerLabel(sessionDirProvider)} session directory, not ${providerLabel(provider)}`);
    }

    const files = sessionDirProvider === 'claude'
      ? await listFlatJsonlFiles(target, 'claude')
      : await listRecursiveJsonlFiles(target, 'codex');
    return limitSessions(sortSessionsByNewest(files), count);
  }

  return findProjectSessions(target, provider, count);
}
