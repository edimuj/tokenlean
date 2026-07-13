/**
 * Safe command execution wrappers for git and ripgrep.
 *
 * Uses spawnSync with array args (no shell) to eliminate
 * shell-injection risks entirely.
 */

import { spawnSync } from 'node:child_process';

/**
 * Run a git command safely with array args (no shell interpolation).
 * @param {string[]} args  - e.g. ['log', '--oneline', '-5']
 * @param {Object}  [opts]
 * @param {string}  [opts.cwd]
 * @param {number}  [opts.maxBuffer=10*1024*1024]
 * @param {number}  [opts.timeout]
 * @returns {string|null} stdout trimmed, or null on error
 */
export function gitCommand(args, opts = {}) {
  const { cwd, maxBuffer = 10 * 1024 * 1024, timeout, trim = true } = opts;

  const spawnOpts = { encoding: 'utf-8', maxBuffer };
  if (cwd) spawnOpts.cwd = cwd;
  if (timeout) spawnOpts.timeout = timeout;

  const proc = spawnSync('git', args, spawnOpts);

  if (proc.error || proc.status !== 0) {
    return null;
  }

  const stdout = proc.stdout || '';
  return trim ? stdout.trim() : stdout;
}

/**
 * A ripgrep invocation failed to run to completion. Exit code 1 (no matches)
 * is intentionally not an error and is still represented by an empty string.
 */
export class SearchCommandError extends Error {
  constructor(command, args, proc, opts = {}) {
    const stderr = String(proc?.stderr || '').trim();
    const causeMessage = proc?.error?.message || '';
    const status = proc?.status;
    const signal = proc?.signal;
    const reason = proc?.error?.code ||
      (status !== null && status !== undefined ? `exit ${status}` : signal ? `signal ${signal}` : 'unknown failure');
    const detail = stderr || causeMessage;
    super(`${command} search failed (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'SearchCommandError';
    this.code = proc?.error?.code || 'SEARCH_COMMAND_FAILED';
    this.command = command;
    this.args = [...args];
    this.cwd = opts.cwd || process.cwd();
    this.status = status ?? null;
    this.signal = signal ?? null;
    this.stderr = stderr;
  }
}

/**
 * Run a ripgrep command safely with array args (no shell interpolation).
 * rg exit code 1 means no matches — treated as success (returns '').
 * @param {string[]} args  - e.g. ['-n', '--no-heading', '-e', 'pattern', 'path']
 * @param {Object}  [opts]
 * @param {string}  [opts.cwd]
 * @param {number}  [opts.maxBuffer=10*1024*1024]
 * @param {number}  [opts.timeout]
 * @returns {string} stdout trimmed; empty string means no matches
 * @throws {SearchCommandError} when ripgrep cannot run to completion
 */
export function rgCommand(args, opts = {}) {
  const { cwd, maxBuffer = 10 * 1024 * 1024, timeout } = opts;

  const spawnOpts = {
    encoding: 'utf-8',
    maxBuffer,
    stdio: ['pipe', 'pipe', 'pipe']
  };
  if (cwd) spawnOpts.cwd = cwd;
  if (timeout) spawnOpts.timeout = timeout;

  const proc = spawnSync('rg', args, spawnOpts);

  // Exit 1 = no matches (success), exit 2+ / spawn failure = explicit error.
  // Throwing is intentional: callers often cache search results, and returning
  // null here made ENOBUFS/timeouts indistinguishable from a clean empty search.
  if (proc.error || (proc.status !== 0 && proc.status !== 1)) {
    throw new SearchCommandError('rg', args, proc, spawnOpts);
  }

  // Exit 1 (no matches) -> return empty string
  if (proc.status === 1) {
    return '';
  }

  return (proc.stdout || '').trim();
}
