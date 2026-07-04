/**
 * MCP tool definitions for tokenlean.
 *
 * Each tool shells out to its CLI counterpart with -j for JSON output.
 * v1: subprocess dispatch (same code path as CLI, zero duplication).
 * v2: hot-path tools move to in-process for speed.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');
const RUN_JOB_ID_RE = /^[a-f0-9-]{36}$/i;
const DEFAULT_ASYNC_WAIT_SECONDS = 90;
const MAX_ASYNC_WAIT_SECONDS = 110;

const asyncRunWorker = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const cfg = JSON.parse(process.argv[1]);

function writeStatus(next) {
  const status = { ...next, updatedAt: new Date().toISOString() };
  const tmp = cfg.statusFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(status) + '\n', 'utf-8');
  fs.renameSync(tmp, cfg.statusFile);
}

writeStatus({
  jobId: cfg.jobId,
  status: 'starting',
  command: cfg.command,
  cwd: cfg.cwd,
  runnerPid: process.pid,
  startedAt: cfg.startedAt,
});

let outFd;
let errFd;
try {
  outFd = fs.openSync(cfg.stdoutFile, 'a');
  errFd = fs.openSync(cfg.stderrFile, 'a');
  const child = spawn(process.execPath, [cfg.toolPath, ...cfg.args], {
    cwd: cfg.cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  writeStatus({
    jobId: cfg.jobId,
    status: 'running',
    command: cfg.command,
    cwd: cfg.cwd,
    runnerPid: process.pid,
    pid: child.pid,
    startedAt: cfg.startedAt,
  });

  child.on('error', (err) => {
    try { fs.appendFileSync(cfg.stderrFile, err.message + '\n', 'utf-8'); } catch {}
    writeStatus({
      jobId: cfg.jobId,
      status: 'failed',
      command: cfg.command,
      cwd: cfg.cwd,
      runnerPid: process.pid,
      pid: child.pid,
      error: err.message,
      startedAt: cfg.startedAt,
      completedAt: new Date().toISOString(),
    });
  });

  child.on('close', (code, signal) => {
    writeStatus({
      jobId: cfg.jobId,
      status: 'completed',
      command: cfg.command,
      cwd: cfg.cwd,
      runnerPid: process.pid,
      pid: child.pid,
      exitCode: code,
      signal,
      startedAt: cfg.startedAt,
      completedAt: new Date().toISOString(),
    });
  });
} catch (err) {
  try {
    if (outFd) fs.closeSync(outFd);
    if (errFd) fs.closeSync(errFd);
    fs.appendFileSync(cfg.stderrFile, err.message + '\n', 'utf-8');
  } catch {}
  writeStatus({
    jobId: cfg.jobId,
    status: 'failed',
    command: cfg.command,
    cwd: cfg.cwd,
    runnerPid: process.pid,
    error: err.message,
    startedAt: cfg.startedAt,
    completedAt: new Date().toISOString(),
  });
}
`;

// Validate an explicitly-provided working directory before spawning. Node's
// spawn reports a missing cwd as "spawn <execPath> ENOENT" (pointing at node,
// not the directory), which masks the real cause — e.g. a worktree removed
// mid-operation. Fail closed with an actionable message instead.
function checkCwd(cwd) {
  if (!cwd) return null;
  try {
    if (!statSync(cwd).isDirectory()) {
      return `Working directory is not a directory: ${cwd}`;
    }
  } catch (err) {
    if (err.code === 'ENOENT') return `Working directory does not exist: ${cwd}`;
    return `Working directory is not accessible: ${cwd} (${err.code || err.message})`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Subprocess dispatch
// ─────────────────────────────────────────────────────────────

async function runCli(tool, args = [], { timeout = 60000, maxBuffer = 50 * 1024 * 1024, cwd } = {}) {
  const toolPath = join(binDir, `tl-${tool}.mjs`);
  const cwdError = checkCwd(cwd);
  if (cwdError) return { stdout: '', stderr: cwdError, ok: false };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [toolPath, ...args], {
      timeout,
      encoding: 'utf-8',
      maxBuffer,
      cwd: cwd || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err) {
    // Process exited non-zero or timed out
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    if (err.killed) return { stdout, stderr: 'Timed out', ok: false };
    return { stdout, stderr: stderr || err.message, ok: false };
  }
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError && { isError: true }),
  };
}

async function runCliWithStdin(tool, args = [], stdinData = '', { timeout = 60000, maxBuffer = 50 * 1024 * 1024, cwd } = {}) {
  const toolPath = join(binDir, `tl-${tool}.mjs`);
  const cwdError = checkCwd(cwd);
  if (cwdError) return { stdout: '', stderr: cwdError, ok: false };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [toolPath, ...args], {
      timeout,
      cwd: cwd || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    child.stdout.on('data', chunk => {
      if (stdout.length < maxBuffer) {
        stdout += chunk;
      } else {
        truncated = true;
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });

    // Large stdin payloads (e.g. create_batch) can EPIPE if the child exits
    // before consuming them. Without a handler this is an uncaught error that
    // crashes the whole MCP server process, not just this call.
    child.stdin.on('error', () => {});
    child.stdin.write(stdinData, 'utf-8');
    child.stdin.end();

    child.on('close', (code, signal) => {
      resolve({
        stdout: (truncated ? stdout.slice(0, maxBuffer) : stdout).trim(),
        stderr: stderr.trim(),
        ok: code === 0 && !signal,
      });
    });

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, ok: false });
    });
  });
}

// Path-resolution failures look like "Not found: src/x.ts" (tl tools), ENOENT,
// or Go's "directory prefix ... does not contain main module". When the MCP
// server's cwd differs from the caller's session/worktree (a shared/global
// server defaults to wherever it was launched, often $HOME), relative paths
// silently miss and the bare error gives no clue why. Append the effective cwd
// and tell the agent to pass `cwd` or absolute paths — turning a confusing
// "Not found" into a self-correcting instruction.
const PATH_ERROR_RE = /\bNot found:|\bENOENT\b|no such file or directory|does not contain main module|cannot find/i;

export function withCwdHint(text, opts) {
  if (!text || !PATH_ERROR_RE.test(text)) return text;
  const effectiveCwd = opts?.cwd || process.cwd();
  if (opts?.cwd) {
    return `${text}\n\nHint: ran with cwd=${effectiveCwd}. Relative paths resolve against it — check the path is correct relative to that dir, or use an absolute path.`;
  }
  return `${text}\n\nHint: ran with cwd=${effectiveCwd} (the MCP server's working dir, which may differ from your session/project/worktree). For relative paths, pass cwd=<your project root> or use absolute paths.`;
}

async function dispatchTool(tool, args, opts) {
  const { stdout, stderr, ok } = await runCli(tool, args, opts);
  if (!ok && !stdout) return textResult(withCwdHint(stderr || 'Tool failed with no output', opts), true);
  // Return stdout; append stderr as note if present and tool succeeded. Once the
  // tool has produced output, trust it over withCwdHint's regex — a non-zero
  // exit can still carry structured/JSON output whose *content* happens to
  // mention "no such file" etc., and appending the hint would corrupt or
  // mislead on top of already-structured output.
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(text || '(no output)', !ok);
}

function runJobsDir() {
  return join(homedir() || '/tmp', '.cache', 'tokenlean', 'mcp-run');
}

export function runJobDir(jobId) {
  if (!RUN_JOB_ID_RE.test(jobId || '')) return null;
  return join(runJobsDir(), jobId);
}

// Async job dirs accumulate under ~/.cache/tokenlean/mcp-run/ forever otherwise
// (one per tl_run async:true call). Sweep anything older than the TTL once per
// process start instead of tracking cleanup per-job.
const RUN_JOB_TTL_MS = 24 * 60 * 60 * 1000;

function sweepStaleRunJobs() {
  const dir = runJobsDir();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  const cutoff = Date.now() - RUN_JOB_TTL_MS;
  for (const entry of entries) {
    const jobDir = join(dir, entry);
    try {
      if (statSync(jobDir).mtimeMs < cutoff) rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // race with another process cleaning up the same dir — ignore
    }
  }
}
sweepStaleRunJobs();

function isRunJobPidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // process exists but we can't signal it — still alive
  }
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function tailText(text, maxLines = 40) {
  if (!text) return '';
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

const MAX_RUN_RESPONSE_CHARS = 200_000; // ~50k tokens — keep megabyte outputs from blowing up the MCP response

// Cap any huge stdout/stderr/output fields inside a tl-run JSON payload,
// tail-preferred, instead of dumping megabytes into the MCP response. Operates
// on the JSON text so it re-serializes to still-valid JSON rather than
// truncating raw bytes mid-structure.
export function capRunResultText(text) {
  if (!text || text.length <= MAX_RUN_RESPONSE_CHARS) return text;
  const tailField = (obj, key) => {
    const value = obj?.[key];
    if (typeof value !== 'string' || value.length <= MAX_RUN_RESPONSE_CHARS) return;
    const dropped = value.length - MAX_RUN_RESPONSE_CHARS;
    obj[key] = `... [${dropped} chars truncated — showing tail; use limit/maxTokens instead of raw:true for smaller output] ...\n${value.slice(-MAX_RUN_RESPONSE_CHARS)}`;
  };
  try {
    const parsed = JSON.parse(text);
    tailField(parsed, 'stdout');
    tailField(parsed, 'stderr');
    tailField(parsed, 'output');
    if (parsed.result) {
      tailField(parsed.result, 'stdout');
      tailField(parsed.result, 'stderr');
      tailField(parsed.result, 'output');
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    const dropped = text.length - MAX_RUN_RESPONSE_CHARS;
    return `... [${dropped} chars truncated — showing tail] ...\n${text.slice(-MAX_RUN_RESPONSE_CHARS)}`;
  }
}

export function runArgs({ command, type, raw, timeoutMs, diff, limit, maxTokens, noSplit }) {
  const args = [command];
  if (type) args.push('--type', type);
  if (raw) args.push('--raw');
  if (timeoutMs) args.push('--timeout', String(timeoutMs));
  if (diff) args.push('--diff');
  if (limit != null) args.push('-l', String(limit));
  if (maxTokens != null) args.push('-t', String(maxTokens));
  if (noSplit) args.push('--no-split');
  args.push('-j');
  return args;
}

function resolveAsyncWaitSeconds(waitSeconds) {
  if (waitSeconds === 0) return 0;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) return DEFAULT_ASYNC_WAIT_SECONDS;
  return Math.min(Math.round(waitSeconds), MAX_ASYNC_WAIT_SECONDS);
}

function readRunJobStatus(jobId) {
  const dir = runJobDir(jobId);
  if (!dir || !existsSync(dir)) return null;
  const statusFile = join(dir, 'status.json');
  const status = readJsonFile(statusFile);
  // A "running" job always has a pid; if that process is gone (runner crashed,
  // host rebooted, ...) the job would otherwise poll as "running" forever.
  if (status.status === 'running' && !isRunJobPidAlive(status.pid)) {
    const orphaned = {
      ...status,
      status: 'failed',
      error: 'Job process is no longer running (orphaned) — the runner exited without recording completion.',
      completedAt: new Date().toISOString(),
    };
    try {
      const tmp = `${statusFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(orphaned)}\n`, 'utf-8');
      renameSync(tmp, statusFile);
    } catch { /* best-effort — next poll retries the liveness check */ }
    return orphaned;
  }
  return status;
}

async function waitForRunJob(jobId, waitSeconds) {
  const deadline = Date.now() + (resolveAsyncWaitSeconds(waitSeconds) * 1000);
  while (Date.now() < deadline) {
    try {
      const status = readRunJobStatus(jobId);
      if (status?.status === 'completed' || status?.status === 'failed') return;
    } catch { /* status may be mid-rename; retry */ }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

async function formatRunJobPoll(jobId, { tailLines, waitSeconds } = {}) {
  const dir = runJobDir(jobId);
  if (!dir || !existsSync(dir)) {
    return textResult(`Unknown tl_run jobId: ${jobId}`, true);
  }

  await waitForRunJob(jobId, waitSeconds);

  let status;
  try {
    status = readRunJobStatus(jobId);
  } catch {
    return textResult(`tl_run job ${jobId} has no readable status yet`, true);
  }

  const stdoutFile = join(dir, 'stdout.json');
  const stderrFile = join(dir, 'stderr.log');
  const stdout = existsSync(stdoutFile) ? readFileSync(stdoutFile, 'utf-8').trim() : '';
  const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, 'utf-8').trim() : '';

  if (status.status === 'completed' || status.status === 'failed') {
    let result = null;
    if (stdout) {
      try { result = JSON.parse(stdout); } catch { /* raw fallback below */ }
    }
    const payload = {
      jobId,
      status: status.status,
      command: status.command,
      cwd: status.cwd,
      pid: status.pid,
      exitCode: status.exitCode ?? (status.status === 'failed' ? 1 : null),
      signal: status.signal ?? null,
      startedAt: status.startedAt,
      completedAt: status.completedAt,
      ...(result ? { result } : { stdout }),
      ...(stderr ? { stderr } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
    const isError = status.status === 'failed' || (Number.isInteger(payload.exitCode) && payload.exitCode !== 0);
    return textResult(capRunResultText(JSON.stringify(payload, null, 2)), isError);
  }

  return textResult(JSON.stringify({
    jobId,
    status: status.status,
    command: status.command,
    cwd: status.cwd,
    pid: status.pid,
    runnerPid: status.runnerPid,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    waitedSeconds: resolveAsyncWaitSeconds(waitSeconds),
    nextPollAfterSeconds: 0,
    message: `Still running after waiting up to ${resolveAsyncWaitSeconds(waitSeconds)}s. Poll again with jobId and waitSeconds:${DEFAULT_ASYNC_WAIT_SECONDS}; avoid frequent short polling.`,
    stdoutTail: tailText(stdout, tailLines),
    stderrTail: tailText(stderr, tailLines),
    poll: { tool: 'tl_run', arguments: { jobId, waitSeconds: DEFAULT_ASYNC_WAIT_SECONDS } },
  }, null, 2));
}

async function startRunJob({ command, type, raw, timeoutMs, diff, limit, maxTokens, noSplit, cwd, tailLines, waitSeconds }) {
  const cwdError = checkCwd(cwd);
  if (cwdError) return textResult(cwdError, true);

  const jobId = randomUUID();
  const dir = runJobDir(jobId);
  const startedAt = new Date().toISOString();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const toolPath = join(binDir, 'tl-run.mjs');
  const args = runArgs({ command, type, raw, timeoutMs, diff, limit, maxTokens, noSplit });
  const statusFile = join(dir, 'status.json');
  const cfg = {
    jobId,
    command,
    cwd: cwd || process.cwd(),
    toolPath,
    args,
    statusFile,
    stdoutFile: join(dir, 'stdout.json'),
    stderrFile: join(dir, 'stderr.log'),
    startedAt,
  };

  writeFileSync(statusFile, JSON.stringify({
    jobId,
    status: 'queued',
    command,
    cwd: cfg.cwd,
    startedAt,
    updatedAt: startedAt,
  }) + '\n', 'utf-8');

  const child = spawn(process.execPath, ['-e', asyncRunWorker, JSON.stringify(cfg)], {
    detached: true,
    stdio: 'ignore',
    cwd: cfg.cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  child.unref();

  return formatRunJobPoll(jobId, { tailLines, waitSeconds });
}

async function dispatchToolWithStdin(tool, args, stdinData, opts) {
  const { stdout, stderr, ok } = await runCliWithStdin(tool, args, stdinData, opts);
  if (!ok && !stdout) return textResult(withCwdHint(stderr || 'Tool failed with no output', opts), true);
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(text || '(no output)', !ok);
}

const cwdSchema = z.string().optional().describe("Working directory for the tool. The MCP server's default cwd may NOT match your session/project/worktree (a shared/global server runs from wherever it was launched). If your file paths are relative, set this to your project root — or pass absolute paths — to avoid \"Not found\" errors.");

function withCwd(schema) {
  return { ...schema, cwd: cwdSchema };
}

// The tl_gh_* tools are where vent #219 traced parameter confusion to: an
// unknown top-level key (e.g. a stray "issue" on a tool that only wired up
// "parent") is silently stripped by zod's default object mode, so the agent
// never sees why its alias didn't take effect. Compose these as an actual
// strict ZodObject (not a raw shape) so unknown keys error with their name
// instead of vanishing. Scoped to the gh family only — the rest of TOOLS stays
// raw-shape/non-strict; see the registerTools() note for why both work.
function withCwdStrict(shape) {
  return z.strictObject({ ...shape, cwd: cwdSchema });
}

// ── GitHub-MCP compatibility ─────────────────────────────────
// The GitHub MCP tools take split `owner` + `repo` and `issue_number`;
// tokenlean's take combined `repo: "owner/repo"` and `issues`. Accept both
// conventions so agents that learned either set don't guess-and-check.
const ghOwnerAlias = {
  owner: z.string().optional().describe(
    'Repo owner, GitHub-MCP style. Optional — combined with "repo" when "repo" is just the bare name.',
  ),
};
const ghIssueNumberAlias = {
  issue_number: z.union([z.number(), z.array(z.number())]).optional()
    .describe('Alias for the issue identifier, GitHub-MCP style (number or array).'),
  number: z.union([z.number(), z.array(z.number())]).optional()
    .describe('Alias for the issue identifier — the bare GitHub field name (number or array). '
      + 'Works on every tl_gh_issue_* tool that takes an existing-issue identifier (add_sub maps it '
      + 'to the parent) — except tl_gh_issue_create_batch, whose "issues" is an array of new-issue '
      + 'objects to create, not identifiers.'),
};

const ghIssueSpecSchema = z.object({
  title: z.string().describe('Issue title'),
  body: z.string().optional().describe('Issue body (markdown)'),
  labels: z.array(z.string()).optional().describe('Labels to apply'),
  assignee: z.string().optional().describe('Assignee username'),
  milestone: z.string().optional().describe('Milestone name'),
});

// Combine split owner+repo into the "owner/repo" form tl-gh expects, and fail
// fast with an actionable message if the result still isn't "owner/repo" —
// otherwise this surfaces many calls deep inside the tl-gh CLI as a cryptic
// GraphQL/lookup failure.
function ghResolveRepo(repo, owner) {
  const resolved = (owner && repo && !repo.includes('/')) ? `${owner}/${repo}` : repo;
  if (resolved && !resolved.includes('/')) {
    throw new Error(
      `Invalid repo "${resolved}": expected "owner/repo". Pass the combined form, or a bare repo `
      + 'name together with "owner" — e.g. { repo: "owner/repo" } or { repo: "repo", owner: "owner" }.'
    );
  }
  return resolved;
}

// Pick the first supplied issue identifier across all accepted aliases.
function ghPickIssues(...candidates) {
  for (const c of candidates) if (c != null) return c;
  return null;
}

// Shared validation-error builder for the tl_gh_* handlers. The vent #219
// trace showed the two-layer problem: zod reports one missing field at a
// time (every alias is optional), then the handler-level throw names only
// the next missing param — so an agent guesses field-by-field instead of
// seeing the whole shape. Every throw below prints the complete expected
// call shape plus a literal, fillable example.
function ghParamError(tool, instruction, expected) {
  return new Error(`${tool}: ${instruction} Expected shape, e.g.: ${JSON.stringify(expected)}`);
}

function ghIssueReadArgs(repo, issueNum, { full, noBody, bodyLines, comments } = {}) {
  const args = ['issue', 'read', '-R', repo, String(issueNum)];
  if (full) args.push('--full');
  if (noBody) args.push('--no-body');
  if (bodyLines) args.push('--body-lines', String(bodyLines));
  if (comments) args.push('--comments');
  args.push('-j');
  return args;
}

// Keep in sync with DEFAULT_TIMEOUT in bin/tl-run.mjs.
const DEFAULT_RUN_TIMEOUT = 300000;

function normalizeMcpTimeoutMs(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  return Math.round(timeout < 1000 ? timeout * 1000 : timeout);
}

function resolveRunTimeoutMs({ commandTimeoutMs, commandTimeoutSeconds, timeout } = {}) {
  if (Number.isFinite(commandTimeoutMs) && commandTimeoutMs > 0) return Math.round(commandTimeoutMs);
  if (Number.isFinite(commandTimeoutSeconds) && commandTimeoutSeconds > 0) return Math.round(commandTimeoutSeconds * 1000);
  return normalizeMcpTimeoutMs(timeout);
}

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'tl_symbols',
    description: 'Extract function/class/type signatures from source files without bodies. Shows API surface in minimal tokens.',
    schema: withCwd({
      files: z.union([
        z.string(),
        z.array(z.string())
      ]).describe('File or directory path(s). Prefer an array when paths may contain spaces.'),
      exportsOnly: z.boolean().optional().describe('Show only exported symbols'),
      filter: z.enum(['function', 'class', 'type', 'constant', 'export']).optional().describe('Filter by symbol type'),
    }),
    handler: async ({ files, exportsOnly, filter, cwd }) => {
      const args = Array.isArray(files) ? files.filter(Boolean) : files.split(/\s+/).filter(Boolean);
      if (exportsOnly) args.push('-e');
      if (filter) args.push('--filter', filter);
      args.push('-j');
      return dispatchTool('symbols', args, { cwd });
    },
  },
  {
    name: 'tl_snippet',
    description: 'Extract function/class/method body by name. Returns just the implementation needed instead of the entire file.',
    schema: withCwd({
      name: z.string().describe('Symbol name(s), comma-separated. Supports Class.method and file:name syntax'),
      file: z.string().optional().describe('File to search in (omit to search project)'),
      context: z.number().optional().describe('Lines of context above/below (default: 0)'),
      all: z.boolean().optional().describe('Show all matches, not just first'),
    }),
    handler: async ({ name, file, context, all, cwd }) => {
      const args = [name];
      if (file) args.push(file);
      if (context) args.push('-c', String(context));
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('snippet', args, { cwd });
    },
  },
  {
    name: 'tl_run',
    description: 'Execute a shell command with token-efficient output. Auto-detects test/build/lint output and summarizes to essentials. For long commands, call with async:true; tokenlean long-polls under MCP client watchdogs and returns either the result or a jobId to poll again.',
    schema: withCwd({
      command: z.string().optional().describe('Shell command to run. Required for normal runs and async starts; omit when polling an async job with jobId.'),
      async: z.boolean().optional().describe('Start command in a background job and long-poll for completion under the MCP client watchdog. Use for long-running test/build gates, e.g. { command: "npm test", async: true, commandTimeoutSeconds: 600, cwd: "/repo" }.'),
      jobId: z.string().optional().describe('Poll a background tl_run job previously started with async:true, e.g. { jobId: "...", waitSeconds: 90 }. Returns running status with tails, or the completed tl_run JSON result.'),
      waitSeconds: z.number().optional().describe('For async starts or jobId polls, wait this many seconds for completion before returning running status. Default: 90, max: 110, use 0 for immediate status. Prefer long waits over frequent polling to avoid quota churn.'),
      tailLines: z.number().optional().describe('Lines of stdout/stderr tail captured so far while an async job is still running (default: 40). Note: tl-run computes its own summarized output only once the underlying command finishes, so tails from the command itself are often sparse or empty until completion.'),
      type: z.enum(['test', 'build', 'lint', 'generic']).optional().describe('Force output type (default: auto-detect)'),
      raw: z.boolean().optional().describe('Show full output, no summarization'),
      commandTimeoutMs: z.number().optional().describe('Child command runtime timeout in milliseconds. This does not extend the MCP client request watchdog; combine with async:true for commands that may run longer than the client allows. Default: 300000ms.'),
      commandTimeoutSeconds: z.number().optional().describe('Child command runtime timeout in seconds. This does not extend the MCP client request watchdog; combine with async:true for long-running gates such as typecheck/test. Default: 300s.'),
      timeout: z.number().optional().describe('Alias for commandTimeoutMs/commandTimeoutSeconds (legacy MCP clients). Values >= 1000 are treated as milliseconds, smaller values as seconds. Prefer commandTimeoutMs or commandTimeoutSeconds for clarity.'),
      diff: z.boolean().optional().describe('Compare against previous run of same command'),
      limit: z.number().optional().describe('Max output lines before truncating (passed to tl-run as -l/--limit). Prefer this over raw:true for large outputs.'),
      maxTokens: z.number().optional().describe('Approximate max output tokens before truncating (passed to tl-run as -t/--max-tokens). Prefer this over raw:true for large outputs.'),
      noSplit: z.boolean().optional().describe('Treat a chained command (e.g. "a && b") as one blob instead of analyzing each part separately (passed to tl-run as --no-split).'),
    }),
    handler: async ({ command, async: asyncMode, jobId, waitSeconds, tailLines, type, raw, commandTimeoutMs, commandTimeoutSeconds, timeout, diff, limit, maxTokens, noSplit, cwd }) => {
      if (jobId) return formatRunJobPoll(jobId, { tailLines, waitSeconds });
      if (!command) return textResult('tl_run requires command, or jobId when polling an async run.', true);
      const timeoutMs = resolveRunTimeoutMs({ commandTimeoutMs, commandTimeoutSeconds, timeout });
      if (asyncMode) return startRunJob({ command, type, raw, timeoutMs, diff, limit, maxTokens, noSplit, cwd, tailLines, waitSeconds });
      const args = runArgs({ command, type, raw, timeoutMs, diff, limit, maxTokens, noSplit });
      // Outer (execFile) timeout is the inner command timeout plus a margin so
      // tl-run can emit its own timeout result before we hard-kill the wrapper.
      const result = await dispatchTool('run', args, { timeout: (timeoutMs || DEFAULT_RUN_TIMEOUT) + 10000, cwd });
      if (result.content?.[0]?.text) result.content[0].text = capRunResultText(result.content[0].text);
      return result;
    },
  },
  {
    name: 'tl_impact',
    description: 'Find all files that import/depend on a given file. Shows blast radius before modifying shared code.',
    schema: withCwd({
      file: z.string().describe('File to analyze dependencies for'),
    }),
    handler: async ({ file, cwd }) => {
      return dispatchTool('impact', [file, '-j'], { cwd });
    },
  },
  {
    name: 'tl_browse',
    description: 'Fetch a URL and return its content as clean markdown. Strips navigation, ads, and boilerplate.',
    schema: withCwd({
      url: z.string().describe('URL to fetch'),
    }),
    handler: async ({ url, cwd }) => {
      return dispatchTool('browse', [url, '-j'], { cwd });
    },
  },
  {
    name: 'tl_tail',
    description: 'Smart log reducer — collapses repeated patterns, highlights errors/warnings. For log files or piped output.',
    schema: withCwd({
      file: z.string().describe('Log file path to analyze'),
      lines: z.number().optional().describe('Max output lines (default: 30)'),
    }),
    handler: async ({ file, lines, cwd }) => {
      const args = [file];
      if (lines) args.push('-l', String(lines));
      args.push('-j');
      return dispatchTool('tail', args, { cwd });
    },
  },
  {
    name: 'tl_guard',
    description: 'Pre-commit quality check — scans for secrets, TODOs, unused exports, circular dependencies, and raw control bytes (NUL) in tracked files.',
    schema: withCwd({
      noSecrets: z.boolean().optional().describe('Skip secrets check'),
      noTodos: z.boolean().optional().describe('Skip TODO/FIXME check'),
      noUnused: z.boolean().optional().describe('Skip unused exports check'),
      noCircular: z.boolean().optional().describe('Skip circular deps check'),
      noCtrlbytes: z.boolean().optional().describe('Skip raw control byte (NUL) check'),
      strict: z.boolean().optional().describe('Treat warnings as failures'),
      full: z.boolean().optional().describe('Return all detail rows instead of the default capped summary'),
      detailLimit: z.number().optional().describe('Maximum detail rows per check (default 20)'),
    }),
    handler: async ({ noSecrets, noTodos, noUnused, noCircular, noCtrlbytes, strict, full, detailLimit, cwd }) => {
      const args = [];
      if (noSecrets) args.push('--no-secrets');
      if (noTodos) args.push('--no-todos');
      if (noUnused) args.push('--no-unused');
      if (noCircular) args.push('--no-circular');
      if (noCtrlbytes) args.push('--no-ctrlbytes');
      if (strict) args.push('--strict');
      if (full) args.push('--full');
      if (detailLimit !== undefined) args.push('--detail-limit', String(detailLimit));
      args.push('-j');
      return dispatchTool('guard', args, { cwd });
    },
  },
  {
    name: 'tl_dupes',
    description: 'Find duplicate / near-duplicate functions across a codebase — copy-paste, renamed clones, and repeated names. Run before writing a new helper, or for periodic cleanup.',
    schema: withCwd({
      path: z.string().optional().describe('Directory or file to scan (default: project root)'),
      near: z.number().optional().describe('Also report near-duplicates at this similarity threshold 0-1 (e.g. 0.85)'),
      minTokens: z.number().optional().describe('Ignore functions smaller than N tokens (default 12)'),
      exactOnly: z.boolean().optional().describe('Only report identical bodies'),
      noNames: z.boolean().optional().describe('Skip the repeated-names tier'),
      noStructural: z.boolean().optional().describe('Skip the structural (renamed-clone) tier'),
      tests: z.boolean().optional().describe('Include test/spec files (excluded by default)'),
      full: z.boolean().optional().describe('Show all groups instead of the default cap'),
    }),
    handler: async ({ path, near, minTokens, exactOnly, noNames, noStructural, tests, full, cwd }) => {
      const args = [];
      if (path) args.push(path);
      if (near !== undefined) args.push('--near', String(near));
      if (minTokens !== undefined) args.push('--min-tokens', String(minTokens));
      if (exactOnly) args.push('--exact-only');
      if (noNames) args.push('--no-names');
      if (noStructural) args.push('--no-structural');
      if (tests) args.push('--tests');
      if (full) args.push('--full');
      args.push('-j');
      return dispatchTool('dupes', args, { cwd });
    },
  },
  {
    name: 'tl_lookup',
    description: 'Find an existing function by name or intent BEFORE writing a new helper — prevents duplicate utility functions. Search first; reuse what it returns instead of creating a near-identical copy.',
    schema: withCwd({
      query: z.string().describe('Function name or intent phrase, e.g. "getUserId" or "format elapsed time"'),
      path: z.string().optional().describe('Directory or file to search (default: project root)'),
      limit: z.number().optional().describe('Max results (default 15)'),
      minScore: z.number().optional().describe('Minimum relevance 0-1 (default 0.3)'),
      tests: z.boolean().optional().describe('Include test/spec files (excluded by default)'),
    }),
    handler: async ({ query, path, limit, minScore, tests, cwd }) => {
      const args = [query];
      if (path) args.push(path);
      if (limit !== undefined) args.push('-l', String(limit));
      if (minScore !== undefined) args.push('--min-score', String(minScore));
      if (tests) args.push('--tests');
      args.push('-j');
      return dispatchTool('lookup', args, { cwd });
    },
  },
  {
    name: 'tl_diff',
    description: 'Token-efficient git diff summary — changed files categorized by risk with context.',
    schema: withCwd({
      ref: z.string().optional().describe('Git ref to diff against (default: staged or HEAD)'),
      file: z.string().optional().describe('Limit diff to specific file'),
    }),
    handler: async ({ ref, file, cwd }) => {
      const args = [];
      if (ref) args.push(ref);
      if (file) args.push('--file', file);
      args.push('-j');
      return dispatchTool('diff', args, { cwd });
    },
  },
  {
    name: 'tl_advise',
    description: 'Recommend the next tokenlean commands for a coding task. Use this before choosing tools for review, debug, refactor, testing, docs, or commit work.',
    schema: withCwd({
      goal: z.string().describe('Natural-language task goal, e.g. "debug failing npm test" or "review PR 123"'),
      all: z.boolean().optional().describe('Show secondary recommendations too'),
    }),
    handler: async ({ goal, all, cwd }) => {
      const args = [goal];
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('advise', args, { cwd });
    },
  },
  {
    name: 'tl_pack',
    description: 'Build a compact workflow context pack for onboard, review, pr, refactor, or debug tasks.',
    schema: withCwd({
      pack: z.enum(['onboard', 'review', 'pr', 'refactor', 'debug']).describe('Workflow pack to run'),
      target: z.string().optional().describe('Optional path, onboard query, revision range, PR/branch target, or task context. For debug packs, use command when you want to execute a command.'),
      command: z.string().optional().describe('Command to execute for debug packs. Prefer this over target when pack is debug.'),
      budget: z.number().optional().describe('Output budget in approximate tokens'),
      full: z.boolean().optional().describe('Include fuller underlying tool output where useful'),
    }),
    handler: async ({ pack, target, command, budget, full, cwd }) => {
      if (pack === 'debug' && target && command) {
        throw new Error(
          'tl_pack: provide either "command" (to execute) or "target" (to keep as context), not both — '
          + 'the tl-pack CLI takes a single positional argument for debug packs. '
          + 'Expected: { pack: "debug", command: "npm test" } or { pack: "debug", target: "some context note" }.'
        );
      }
      const args = [pack];
      const effectiveTarget = pack === 'debug' && command ? command : target;
      if (effectiveTarget) args.push(effectiveTarget);
      if (budget) args.push('--budget', String(budget));
      if (full) args.push('--full');
      if (pack === 'debug' && target && !command) args.push('--context');
      args.push('-j');
      return dispatchTool('pack', args, { timeout: pack === 'debug' ? 305000 : 120000, cwd });
    },
  },
  {
    name: 'tl_analyze',
    description: 'Composite file profile: symbols, dependencies, impact, complexity, and related files in one compact report.',
    schema: withCwd({
      file: z.string().describe('File to analyze'),
      full: z.boolean().optional().describe('Show more detail per section'),
    }),
    handler: async ({ file, full, cwd }) => {
      const args = [file];
      if (full) args.push('--full');
      args.push('-j');
      return dispatchTool('analyze', args, { cwd });
    },
  },
  {
    name: 'tl_related',
    description: 'Find tests, type files, importers, and siblings related to a target file.',
    schema: withCwd({
      file: z.string().describe('Target file'),
    }),
    handler: async ({ file, cwd }) => {
      return dispatchTool('related', [file, '-j'], { cwd });
    },
  },
  {
    name: 'tl_context',
    description: 'Estimate token usage for files or directories before reading them.',
    schema: withCwd({
      path: z.string().optional().describe('File or directory path (default: current directory)'),
      top: z.number().optional().describe('Show top N largest files'),
      all: z.boolean().optional().describe('Show all files'),
    }),
    handler: async ({ path, top, all, cwd }) => {
      const args = [];
      if (path) args.push(path);
      if (top) args.push('--top', String(top));
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('context', args, { cwd });
    },
  },
  {
    name: 'tl_structure',
    description: 'Smart project overview with token estimates and important files/directories.',
    schema: withCwd({
      path: z.string().optional().describe('Project path (default: current directory)'),
      depth: z.number().optional().describe('Maximum depth to show'),
      entryPoints: z.boolean().optional().describe('Highlight entry points'),
      exports: z.boolean().optional().describe('Show top exports inline per file'),
    }),
    handler: async ({ path, depth, entryPoints, exports, cwd }) => {
      const args = [];
      if (path) args.push(path);
      if (depth) args.push('--depth', String(depth));
      if (entryPoints) args.push('--entry-points');
      if (exports) args.push('--exports');
      args.push('-j');
      return dispatchTool('structure', args, { cwd });
    },
  },
  {
    name: 'tl_entry',
    description: 'Find project entry points: main files, routes, handlers, exports, and CLI entry points.',
    schema: withCwd({
      path: z.string().optional().describe('Search path (default: current directory)'),
      type: z.enum(['main', 'routes', 'handlers', 'exports', 'cli']).optional().describe('Entry point type filter'),
    }),
    handler: async ({ path, type, cwd }) => {
      const args = [];
      if (path) args.push(path);
      if (type) args.push('--type', type);
      args.push('-j');
      return dispatchTool('entry', args, { cwd });
    },
  },
  // ── GitHub batch operations ──────────────────────────────────

  {
    name: 'tl_gh_issue_read',
    description: 'Read a GitHub issue with its direct sub-issues, labels, assignees, comment count, and optionally bodies. Pass comments:true to include comment bodies — use this instead of "gh issue view --comments", which prints nothing on a zero-comment issue. "issue" accepts a single number or an array for batch reads.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issue: z.union([z.number(), z.array(z.number())]).optional()
        .describe('Issue number(s) to read — single number or array for batch reads.'),
      ...ghIssueNumberAlias,
      full: z.boolean().optional().describe('Show complete bodies instead of truncating'),
      noBody: z.boolean().optional().describe('Omit issue bodies for compact output'),
      bodyLines: z.number().optional().describe('Lines of body to show per issue (default: 5)'),
      comments: z.boolean().optional().describe('Include comment bodies (the discussion thread), not just the count. Reports "No comments." when there are none — never empty.'),
    }),
    handler: async ({ repo, owner, issue, issue_number, number, full, noBody, bodyLines, comments, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = ghPickIssues(issue, issue_number, number);
      if (raw == null) {
        throw ghParamError('tl_gh_issue_read', 'provide "issue" (or "issue_number" / "number").',
          { repo: 'owner/repo', issue: 123 });
      }
      const issueNums = Array.isArray(raw) ? raw : [raw];
      if (issueNums.length === 1) {
        return dispatchTool('gh', ghIssueReadArgs(repo, issueNums[0], { full, noBody, bodyLines, comments }), { timeout: 120000, cwd });
      }

      const issues = [];
      const results = [];
      for (const issueNum of issueNums) {
        const r = await runCli('gh', ghIssueReadArgs(repo, issueNum, { full, noBody, bodyLines, comments }), { timeout: 120000, cwd });
        if (!r.ok) {
          results.push({
            number: issueNum,
            status: 'failed',
            error: r.stdout || withCwdHint(r.stderr || 'Tool failed with no output', { cwd }),
          });
          continue;
        }
        try {
          const parsed = JSON.parse(r.stdout || '{}');
          if (parsed.issue) {
            issues.push(parsed.issue);
            results.push({ number: parsed.issue.number ?? issueNum, status: 'read' });
          } else {
            results.push({ number: issueNum, status: 'failed', error: 'tl-gh returned no issue object' });
          }
        } catch (err) {
          results.push({ number: issueNum, status: 'failed', error: `Invalid tl-gh JSON: ${err.message}` });
        }
      }

      const failed = results.some(r => r.status === 'failed');
      return textResult(JSON.stringify({
        issues,
        results,
        failed,
        truncated: false,
        totalItems: issueNums.length,
      }, null, 2), failed && issues.length === 0);
    },
  },
  {
    name: 'tl_gh_issue_add_sub',
    description: 'Link existing issues as sub-issues of a parent issue via GitHub GraphQL. '
      + 'Example: { repo: "owner/repo", parent: 123, children: [124, 125] }.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      parent: z.number().optional().describe('Parent issue number. Aliases: issue, number, issue_number.'),
      issue: z.number().optional().describe('Alias for "parent" — the issue number acting as the sub-issue parent.'),
      ...ghIssueNumberAlias,
      children: z.array(z.number()).optional().describe(
        'Child issue numbers to link as sub-issues. Aliases: sub, sub_issues, subIssues. '
        + 'Example: { repo: "owner/repo", parent: 123, children: [124, 125] }.'
      ),
      sub: z.array(z.number()).optional().describe('Alias for "children".'),
      sub_issues: z.array(z.number()).optional().describe('Alias for "children".'),
      subIssues: z.array(z.number()).optional().describe('Alias for "children".'),
    }),
    handler: async ({ repo, owner, parent, issue, issue_number, number, children, sub, sub_issues, subIssues, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      // Accept the same parent identifier under parent / issue / number / issue_number
      // so one identifier name works across every tl_gh_issue_* tool (vent #114/#219 class).
      const rawParent = ghPickIssues(parent, issue, issue_number, number);
      const parentNum = Array.isArray(rawParent) ? rawParent[0] : rawParent;
      const rawChildren = ghPickIssues(children, sub, sub_issues, subIssues);
      if (parentNum == null) {
        throw ghParamError('tl_gh_issue_add_sub', 'provide "parent" (or "issue" / "number" / "issue_number").',
          { repo: 'owner/repo', parent: 123, children: [124, 125] });
      }
      if (!rawChildren || !rawChildren.length) {
        throw ghParamError('tl_gh_issue_add_sub', 'provide "children" (or "sub" / "sub_issues" / "subIssues").',
          { repo: 'owner/repo', parent: 123, children: [124, 125] });
      }
      const args = ['issue', 'add-sub', '-R', repo, '--parent', String(parentNum), ...rawChildren.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_close',
    description: 'Close one or more GitHub issues with optional comment and close reason.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.union([z.number(), z.array(z.number())]).optional().describe('Issue number or issue numbers to close'),
      ...ghIssueNumberAlias,
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned', 'not_planned']).optional()
        .describe('Close reason: "completed" or "not planned" (also accepts "not_planned", the GitHub-MCP convention). Default: completed.'),
    }),
    handler: async ({ repo, owner, issues, issue_number, number, comment, reason, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = ghPickIssues(issues, issue_number, number);
      if (raw == null) {
        throw ghParamError('tl_gh_issue_close', 'provide "issues" (or "issue_number" / "number").',
          { repo: 'owner/repo', issues: 123 });
      }
      const issueList = Array.isArray(raw) ? raw : [raw];
      const args = ['issue', 'close', '-R', repo, ...issueList.map(String)];
      if (comment) args.push('-c', comment);
      if (reason) args.push('--reason', reason);
      args.push('-j');
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_close_batch',
    description: 'Close multiple issues at once with optional comment and reason. Alias-compatible with tl_gh_issue_close.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.array(z.number()).optional().describe('Issue numbers to close'),
      ...ghIssueNumberAlias,
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned', 'not_planned']).optional()
        .describe('Close reason: "completed" or "not planned" (also accepts "not_planned", the GitHub-MCP convention). Default: completed.'),
    }),
    handler: async ({ repo, owner, issues, issue_number, number, comment, reason, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = ghPickIssues(issues, issue_number, number);
      const issueList = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
      if (!issueList.length) {
        throw ghParamError('tl_gh_issue_close_batch', 'provide "issues" (or "issue_number" / "number").',
          { repo: 'owner/repo', issues: [123, 124] });
      }
      const args = ['issue', 'close-batch', '-R', repo, ...issueList.map(String)];
      if (comment) args.push('-c', comment);
      if (reason) args.push('--reason', reason);
      args.push('-j');
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_label_batch',
    description: 'Add and/or remove the SAME labels across multiple issues at once. '
      + 'For different labels per issue, call this once per label set. '
      + 'Labels may be a comma-separated string ("P2,bug") or an array (["P2","bug"]).',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.array(z.number()).optional().describe('Issue numbers to update (same labels applied to all)'),
      ...ghIssueNumberAlias,
      add: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Labels to add — comma-separated string or array. Alias: addLabels'),
      remove: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Labels to remove — comma-separated string or array. Alias: removeLabels'),
      addLabels: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Alias for "add" (accepted so either name works)'),
      removeLabels: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Alias for "remove" (accepted so either name works)'),
    }),
    handler: async ({ repo, owner, issues, issue_number, number, add, remove, addLabels, removeLabels, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const rawIssues = ghPickIssues(issues, issue_number, number);
      const issueList = Array.isArray(rawIssues) ? rawIssues : (rawIssues == null ? [] : [rawIssues]);
      if (!issueList.length) {
        throw ghParamError('tl_gh_issue_label_batch', 'provide "issues" (or "issue_number" / "number").',
          { repo: 'owner/repo', issues: [123, 124], add: 'bug' });
      }
      const toCsv = (v) => (Array.isArray(v) ? v.join(',') : v) || '';
      const addCsv = toCsv(add ?? addLabels);
      const removeCsv = toCsv(remove ?? removeLabels);
      if (!addCsv && !removeCsv) {
        throw ghParamError('tl_gh_issue_label_batch', 'provide at least one of "add" / "remove" (comma-separated string or array of labels).',
          { repo: 'owner/repo', issues: [123], add: 'bug', remove: 'wontfix' });
      }
      const args = ['issue', 'label-batch', '-R', repo, ...issueList.map(String)];
      if (addCsv) args.push('--add', addCsv);
      if (removeCsv) args.push('--remove', removeCsv);
      args.push('-j');
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_project_add_batch',
    description: 'Add existing issues to a GitHub ProjectV2 board in bulk.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      project: z.string().describe('Project identifier (owner/number, e.g. "edimuj/1")'),
      issues: z.array(z.number()).optional().describe('Issue numbers to add to the project'),
      ...ghIssueNumberAlias,
    }),
    handler: async ({ repo, owner, project, issues, issue_number, number, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = ghPickIssues(issues, issue_number, number);
      const issueList = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
      if (!issueList.length) {
        throw ghParamError('tl_gh_project_add_batch', 'provide "issues" (or "issue_number" / "number").',
          { repo: 'owner/repo', project: 'owner/1', issues: [123, 124] });
      }
      const args = ['project', 'add-batch', '-R', repo, '--project', project, ...issueList.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_create_batch',
    description: 'Create multiple issues from a JSON array. Each object: { title, body?, labels?, assignee?, milestone? }. '
      + 'Note: unlike other tl_gh_issue_* tools, "issues" here is an array of NEW issue objects to create, not '
      + 'identifiers of existing issues. Aliases: specs, newIssues.',
    schema: withCwdStrict({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.array(ghIssueSpecSchema).optional().describe('Array of issue objects to create. Aliases: specs, newIssues.'),
      specs: z.array(ghIssueSpecSchema).optional().describe('Alias for "issues".'),
      newIssues: z.array(ghIssueSpecSchema).optional().describe('Alias for "issues".'),
      project: z.string().optional().describe('Add created issues to project (owner/number, e.g. "edimuj/1")'),
    }),
    handler: async ({ repo, owner, issues, specs, newIssues, project, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const issueSpecs = issues ?? specs ?? newIssues;
      if (!issueSpecs || !issueSpecs.length) {
        throw ghParamError('tl_gh_issue_create_batch', 'provide "issues" (or "specs" / "newIssues") — an array of issue objects to create.',
          { repo: 'owner/repo', issues: [{ title: 'Bug: crash on save' }, { title: 'Feature: dark mode' }] });
      }
      const args = ['issue', 'create-batch', '-R', repo];
      if (project) args.push('--project', project);
      args.push('-j');
      return dispatchToolWithStdin('gh', args, JSON.stringify(issueSpecs), { timeout: 120000, cwd });
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────

export function registerTools(server) {
  for (const tool of TOOLS) {
    // registerTool()'s config form accepts either a raw shape (most tools) or
    // an actual Zod schema instance (the strict tl_gh_* schemas) as
    // inputSchema — the legacy server.tool(name, description, schema, cb)
    // argument-sniffing form only recognizes raw shapes, so a real ZodObject
    // there gets misread as an annotations object.
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, tool.handler);
  }
}
