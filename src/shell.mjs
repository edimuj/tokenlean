/**
 * Safe command execution wrappers for git and ripgrep.
 *
 * Uses spawnSync with array args (no shell) to eliminate
 * shell-injection risks entirely.
 */

import { spawnSync } from 'child_process';

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
  const { cwd, maxBuffer = 10 * 1024 * 1024, timeout } = opts;

  const spawnOpts = { encoding: 'utf-8', maxBuffer };
  if (cwd) spawnOpts.cwd = cwd;
  if (timeout) spawnOpts.timeout = timeout;

  const proc = spawnSync('git', args, spawnOpts);

  if (proc.error || proc.status !== 0) {
    return null;
  }

  return (proc.stdout || '').trim();
}

/**
 * Run a ripgrep command safely with array args (no shell interpolation).
 * rg exit code 1 means no matches — treated as success (returns '').
 * @param {string[]} args  - e.g. ['-n', '--no-heading', '-e', 'pattern', 'path']
 * @param {Object}  [opts]
 * @param {string}  [opts.cwd]
 * @param {number}  [opts.maxBuffer=10*1024*1024]
 * @param {number}  [opts.timeout]
 * @returns {string|null} stdout trimmed, or null on error (exit >= 2)
 */
export function rgCommand(args, opts = {}) {
  const { cwd, maxBuffer = 10 * 1024 * 1024, timeout } = opts;

  const spawnOpts = {
    encoding: 'utf-8',
    maxBuffer,
    stdio: ['pipe', 'pipe', 'ignore']
  };
  if (cwd) spawnOpts.cwd = cwd;
  if (timeout) spawnOpts.timeout = timeout;

  const proc = spawnSync('rg', args, spawnOpts);

  // Exit 1 = no matches (success), exit 2+ = error
  if (proc.error || (proc.status !== null && proc.status >= 2)) {
    return null;
  }

  // Exit 1 (no matches) → return empty string
  if (proc.status === 1) {
    return '';
  }

  return (proc.stdout || '').trim();
}
