/**
 * Compatibility layer for invoking synchronous tokenlean CLI entry points
 * inside the long-lived MCP server.
 *
 * CLI modules retain their argv/console/process.exit contract for direct use,
 * while MCP calls reuse already-loaded parser modules and process caches. The
 * invocation must stay synchronous: changing cwd and capturing process globals
 * would be unsafe across an await boundary.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { realpathSync } from 'node:fs';

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  // npm link/global bin shims commonly reach the entry point through a
  // symlink, while import.meta.url is canonicalized by Node.
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(metaUrl));
}

class CliExit extends Error {
  constructor(code = 0) {
    super(`CLI exited with status ${code}`);
    this.name = 'CliExit';
    this.code = Number.isInteger(code) ? code : 0;
  }
}

export function invokeInProcessCli(run, args = [], { cwd } = {}) {
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  const previousWarn = console.warn;
  const previousMcpBudget = process.env.TOKENLEAN_MCP_RESPONSE_BUDGET;
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  const capture = target => (...values) => target.push(format(...values));

  try {
    if (cwd) process.chdir(cwd);
    process.env.TOKENLEAN_MCP_RESPONSE_BUDGET = '1';
    process.exitCode = undefined;
    console.log = capture(stdout);
    console.error = capture(stderr);
    console.warn = capture(stderr);
    process.exit = code => { throw new CliExit(code); };

    const result = run(args);
    if (result && typeof result.then === 'function') {
      throw new TypeError('In-process CLI entry points must remain synchronous');
    }
    if (Number.isInteger(process.exitCode)) exitCode = process.exitCode;
  } catch (error) {
    if (error instanceof CliExit) {
      exitCode = error.code;
    } else {
      exitCode = 1;
      stderr.push(error?.stack || error?.message || String(error));
    }
  } finally {
    process.exit = previousExit;
    process.exitCode = previousExitCode;
    console.log = previousLog;
    console.error = previousError;
    console.warn = previousWarn;
    if (previousMcpBudget === undefined) delete process.env.TOKENLEAN_MCP_RESPONSE_BUDGET;
    else process.env.TOKENLEAN_MCP_RESPONSE_BUDGET = previousMcpBudget;
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
  }

  return {
    stdout: stdout.join('\n').trim(),
    stderr: stderr.join('\n').trim(),
    ok: exitCode === 0,
    exitCode
  };
}
