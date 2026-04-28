/**
 * Session file discovery for tl-audit.
 *
 * Finds Claude Code and Codex session JSONL files
 * by project path, session directory, or direct file path.
 */

import { createReadStream, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { providerLabel } from './audit-analyze.mjs';

// ─────────────────────────────────────────────────────────────
// Provider normalization
// ─────────────────────────────────────────────────────────────

export function normalizeProvider(provider) {
  if (provider == null || provider === '') return 'auto';
  const normalized = String(provider).toLowerCase();
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claudecode') return 'claude';
  if (normalized === 'codex') return 'codex';
  if (normalized === 'auto') return 'auto';
  throw new Error(`Unsupported provider: ${provider}`);
}

// ─────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────

function canonicalPath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function normalizeClaudeProjectPath(projectPath) {
  return canonicalPath(projectPath).replace(/[\/]/g, '-');
}

function isSameOrWithinPath(childPath, parentPath) {
  const rel = relative(canonicalPath(parentPath), canonicalPath(childPath));
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

  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const normalizedCandidates = new Set([
    normalizeClaudeProjectPath(projectPath),
    resolve(projectPath).replace(/[\/]/g, '-'),
  ]);

  const matches = directories.filter(name => [...normalizedCandidates].some(candidate => name === candidate || name.startsWith(`${candidate}-`)));
  if (matches.length > 0) {
    const files = await Promise.all(matches.map(name => listFlatJsonlFiles(join(root, name), 'claude')));
    return files.flat();
  }

  const fallbackFiles = (await Promise.all(directories.map(name => listFlatJsonlFiles(join(root, name), 'claude')))).flat();
  const resolved = await Promise.all(fallbackFiles.map(async (file) => {
    const meta = await readClaudeSessionMeta(file.path);
    if (!meta?.cwd) return null;
    return isSameOrWithinPath(meta.cwd, projectPath) ? file : null;
  }));
  return resolved.filter(Boolean);
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readFirstNonEmptyLine(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (line.trim()) return line;
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readCodexSessionMeta(filePath) {
  const firstLine = await readFirstNonEmptyLine(filePath);
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj || obj.type !== 'session_meta') return null;
  return obj.payload || null;
}

async function readClaudeSessionMeta(filePath) {
  const firstLine = await readFirstNonEmptyLine(filePath);
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj) return null;
  return {
    sessionId: obj.sessionId || null,
    timestamp: obj.timestamp || null,
    cwd: obj.cwd || null,
    slug: obj.slug || null,
  };
}

async function findCodexSessionsForProject(projectPath, count) {
  const root = codexSessionsRoot();
  const allFiles = await listRecursiveJsonlFiles(root, 'codex');
  const resolvedProject = resolve(projectPath);

  if (!Number.isFinite(count)) {
    const matches = await Promise.all(allFiles.map(async file => {
      const meta = await readCodexSessionMeta(file.path);
      if (!meta?.cwd) return null;
      return isSameOrWithinPath(meta.cwd, resolvedProject) ? file : null;
    }));
    return matches.filter(Boolean);
  }

  const files = sortSessionsByNewest(allFiles);
  const matches = [];
  for (const file of files) {
    // For --latest / -n, short-circuit once we have enough newest matches.
    // eslint-disable-next-line no-await-in-loop
    const meta = await readCodexSessionMeta(file.path);
    if (!meta?.cwd) continue;
    if (!isSameOrWithinPath(meta.cwd, resolvedProject)) continue;
    matches.push(file);
    if (matches.length >= count) break;
  }

  return matches;
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
  const firstLine = await readFirstNonEmptyLine(filePath);
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

async function findProjectSessions(projectPath, provider, count) {
  const files = [];
  if (provider === 'auto' || provider === 'claude') {
    files.push(...await findClaudeSessionsForProject(projectPath));
  }
  if (provider === 'auto' || provider === 'codex') {
    files.push(...await findCodexSessionsForProject(projectPath, count));
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
