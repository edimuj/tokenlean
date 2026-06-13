/**
 * MCP tool definitions for tokenlean.
 *
 * Each tool shells out to its CLI counterpart with -j for JSON output.
 * v1: subprocess dispatch (same code path as CLI, zero duplication).
 * v2: hot-path tools move to in-process for speed.
 */

import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');

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
  // Return stdout; append stderr as note if present and tool succeeded
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(ok ? (text || '(no output)') : withCwdHint(text || '(no output)', opts), !ok);
}

async function dispatchToolWithStdin(tool, args, stdinData, opts) {
  const { stdout, stderr, ok } = await runCliWithStdin(tool, args, stdinData, opts);
  if (!ok && !stdout) return textResult(withCwdHint(stderr || 'Tool failed with no output', opts), true);
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(ok ? (text || '(no output)') : withCwdHint(text || '(no output)', opts), !ok);
}

const cwdSchema = z.string().optional().describe("Working directory for the tool. The MCP server's default cwd may NOT match your session/project/worktree (a shared/global server runs from wherever it was launched). If your file paths are relative, set this to your project root — or pass absolute paths — to avoid \"Not found\" errors.");

function withCwd(schema) {
  return { ...schema, cwd: cwdSchema };
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
    .describe('Alias for the issue param, GitHub-MCP style (number or array).'),
};

// Combine split owner+repo into the "owner/repo" form tl-gh expects.
function ghResolveRepo(repo, owner) {
  if (owner && repo && !repo.includes('/')) return `${owner}/${repo}`;
  return repo;
}

// Keep in sync with DEFAULT_TIMEOUT in bin/tl-run.mjs.
const DEFAULT_RUN_TIMEOUT = 120000;

function normalizeMcpTimeoutMs(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  return Math.round(timeout < 1000 ? timeout * 1000 : timeout);
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
    description: 'Execute a shell command with token-efficient output. Auto-detects test/build/lint output and summarizes to essentials.',
    schema: withCwd({
      command: z.string().describe('Shell command to run'),
      type: z.enum(['test', 'build', 'lint', 'generic']).optional().describe('Force output type (default: auto-detect)'),
      raw: z.boolean().optional().describe('Show full output, no summarization'),
      timeout: z.number().optional().describe('Command timeout. Values under 1000 are treated as seconds; larger values are treated as ms. Default: 120000ms.'),
      diff: z.boolean().optional().describe('Compare against previous run of same command'),
    }),
    handler: async ({ command, type, raw, timeout, diff, cwd }) => {
      const timeoutMs = normalizeMcpTimeoutMs(timeout);
      const args = [command];
      if (type) args.push('--type', type);
      if (raw) args.push('--raw');
      if (timeoutMs) args.push('--timeout', String(timeoutMs));
      if (diff) args.push('--diff');
      args.push('-j');
      // Outer (execFile) timeout is the inner command timeout plus a margin so
      // tl-run can emit its own timeout result before we hard-kill the wrapper.
      return dispatchTool('run', args, { timeout: (timeoutMs || DEFAULT_RUN_TIMEOUT) + 10000, cwd });
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
      target: z.string().optional().describe('Optional path, PR/branch target, or task context. For debug packs, use command when you want to execute a command.'),
      command: z.string().optional().describe('Command to execute for debug packs. Prefer this over target when pack is debug.'),
      budget: z.number().optional().describe('Output budget in approximate tokens'),
      full: z.boolean().optional().describe('Include fuller underlying tool output where useful'),
    }),
    handler: async ({ pack, target, command, budget, full, cwd }) => {
      const args = [pack];
      const effectiveTarget = pack === 'debug' && command ? command : target;
      if (effectiveTarget) args.push(effectiveTarget);
      if (budget) args.push('--budget', String(budget));
      if (full) args.push('--full');
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
    description: 'Read a GitHub issue with its direct sub-issues, labels, assignees, comments count, and optionally bodies.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issue: z.number().optional().describe('Issue number to read'),
      ...ghIssueNumberAlias,
      full: z.boolean().optional().describe('Show complete bodies instead of truncating'),
      noBody: z.boolean().optional().describe('Omit issue bodies for compact output'),
      bodyLines: z.number().optional().describe('Lines of body to show per issue (default: 5)'),
    }),
    handler: async ({ repo, owner, issue, issue_number, full, noBody, bodyLines, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const issueNum = issue ?? (Array.isArray(issue_number) ? issue_number[0] : issue_number);
      if (issueNum == null) throw new Error('tl_gh_issue_read: provide "issue" (or "issue_number").');
      const args = ['issue', 'read', '-R', repo, String(issueNum)];
      if (full) args.push('--full');
      if (noBody) args.push('--no-body');
      if (bodyLines) args.push('--body-lines', String(bodyLines));
      args.push('-j');
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_add_sub',
    description: 'Link existing issues as sub-issues of a parent issue via GitHub GraphQL.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      parent: z.number().describe('Parent issue number'),
      children: z.array(z.number()).describe('Child issue numbers to link as sub-issues'),
    }),
    handler: async ({ repo, owner, parent, children, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const args = ['issue', 'add-sub', '-R', repo, '--parent', String(parent), ...children.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_close',
    description: 'Close one or more GitHub issues with optional comment and close reason.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.union([z.number(), z.array(z.number())]).optional().describe('Issue number or issue numbers to close'),
      ...ghIssueNumberAlias,
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned']).optional().describe('Close reason (default: completed)'),
    }),
    handler: async ({ repo, owner, issues, issue_number, comment, reason, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = issues ?? issue_number;
      if (raw == null) throw new Error('tl_gh_issue_close: provide "issues" (or "issue_number").');
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
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.array(z.number()).optional().describe('Issue numbers to close'),
      ...ghIssueNumberAlias,
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned']).optional().describe('Close reason (default: completed)'),
    }),
    handler: async ({ repo, owner, issues, issue_number, comment, reason, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = issues ?? issue_number;
      const issueList = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
      if (!issueList.length) throw new Error('tl_gh_issue_close_batch: provide "issues" (or "issue_number").');
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
    schema: withCwd({
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
    handler: async ({ repo, owner, issues, issue_number, add, remove, addLabels, removeLabels, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const rawIssues = issues ?? issue_number;
      const issueList = Array.isArray(rawIssues) ? rawIssues : (rawIssues == null ? [] : [rawIssues]);
      if (!issueList.length) throw new Error('tl_gh_issue_label_batch: provide "issues" (or "issue_number").');
      const toCsv = (v) => (Array.isArray(v) ? v.join(',') : v) || '';
      const addCsv = toCsv(add ?? addLabels);
      const removeCsv = toCsv(remove ?? removeLabels);
      if (!addCsv && !removeCsv) {
        throw new Error('tl_gh_issue_label_batch: provide at least one of "add" / "remove" (comma-separated string or array of labels).');
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
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      project: z.string().describe('Project identifier (owner/number, e.g. "edimuj/1")'),
      issues: z.array(z.number()).optional().describe('Issue numbers to add to the project'),
      ...ghIssueNumberAlias,
    }),
    handler: async ({ repo, owner, project, issues, issue_number, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const raw = issues ?? issue_number;
      const issueList = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
      if (!issueList.length) throw new Error('tl_gh_project_add_batch: provide "issues" (or "issue_number").');
      const args = ['project', 'add-batch', '-R', repo, '--project', project, ...issueList.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_create_batch',
    description: 'Create multiple issues from a JSON array. Each object: { title, body?, labels?, assignee?, milestone? }.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo, or bare name with "owner")'),
      ...ghOwnerAlias,
      issues: z.array(z.object({
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (markdown)'),
        labels: z.array(z.string()).optional().describe('Labels to apply'),
        assignee: z.string().optional().describe('Assignee username'),
        milestone: z.string().optional().describe('Milestone name'),
      })).describe('Array of issue objects to create'),
      project: z.string().optional().describe('Add created issues to project (owner/number, e.g. "edimuj/1")'),
    }),
    handler: async ({ repo, owner, issues, project, cwd }) => {
      repo = ghResolveRepo(repo, owner);
      const args = ['issue', 'create-batch', '-R', repo];
      if (project) args.push('--project', project);
      args.push('-j');
      return dispatchToolWithStdin('gh', args, JSON.stringify(issues), { timeout: 120000, cwd });
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────

export function registerTools(server) {
  for (const tool of TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }
}
