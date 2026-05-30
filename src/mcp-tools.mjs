/**
 * MCP tool definitions for tokenlean.
 *
 * Each tool shells out to its CLI counterpart with -j for JSON output.
 * v1: subprocess dispatch (same code path as CLI, zero duplication).
 * v2: hot-path tools move to in-process for speed.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');

// ─────────────────────────────────────────────────────────────
// Subprocess dispatch
// ─────────────────────────────────────────────────────────────

async function runCli(tool, args = [], { timeout = 60000, maxBuffer = 50 * 1024 * 1024, cwd } = {}) {
  const toolPath = join(binDir, `tl-${tool}.mjs`);
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

async function dispatchTool(tool, args, opts) {
  const { stdout, stderr, ok } = await runCli(tool, args, opts);
  if (!ok && !stdout) return textResult(stderr || 'Tool failed with no output', true);
  // Return stdout; append stderr as note if present and tool succeeded
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(text || '(no output)', !ok);
}

async function dispatchToolWithStdin(tool, args, stdinData, opts) {
  const { stdout, stderr, ok } = await runCliWithStdin(tool, args, stdinData, opts);
  if (!ok && !stdout) return textResult(stderr || 'Tool failed with no output', true);
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(text || '(no output)', !ok);
}

const cwdSchema = z.string().optional().describe('Working directory to run the tool in. Useful for shared MCP servers; defaults to the MCP server cwd.');

function withCwd(schema) {
  return { ...schema, cwd: cwdSchema };
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
      timeout: z.number().optional().describe('Command timeout in ms (default: 300000)'),
      diff: z.boolean().optional().describe('Compare against previous run of same command'),
    }),
    handler: async ({ command, type, raw, timeout, diff, cwd }) => {
      const args = [command];
      if (type) args.push('--type', type);
      if (raw) args.push('--raw');
      if (timeout) args.push('--timeout', String(timeout));
      if (diff) args.push('--diff');
      args.push('-j');
      return dispatchTool('run', args, { timeout: (timeout || 300000) + 5000, cwd });
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
    description: 'Pre-commit quality check — scans for secrets, TODOs, unused exports, and circular dependencies.',
    schema: withCwd({
      noSecrets: z.boolean().optional().describe('Skip secrets check'),
      noTodos: z.boolean().optional().describe('Skip TODO/FIXME check'),
      noUnused: z.boolean().optional().describe('Skip unused exports check'),
      noCircular: z.boolean().optional().describe('Skip circular deps check'),
      strict: z.boolean().optional().describe('Treat warnings as failures'),
      full: z.boolean().optional().describe('Return all detail rows instead of the default capped summary'),
      detailLimit: z.number().optional().describe('Maximum detail rows per check (default 20)'),
    }),
    handler: async ({ noSecrets, noTodos, noUnused, noCircular, strict, full, detailLimit, cwd }) => {
      const args = [];
      if (noSecrets) args.push('--no-secrets');
      if (noTodos) args.push('--no-todos');
      if (noUnused) args.push('--no-unused');
      if (noCircular) args.push('--no-circular');
      if (strict) args.push('--strict');
      if (full) args.push('--full');
      if (detailLimit !== undefined) args.push('--detail-limit', String(detailLimit));
      args.push('-j');
      return dispatchTool('guard', args, { cwd });
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
      repo: z.string().describe('Target repository (owner/repo)'),
      issue: z.number().describe('Issue number to read'),
      full: z.boolean().optional().describe('Show complete bodies instead of truncating'),
      noBody: z.boolean().optional().describe('Omit issue bodies for compact output'),
      bodyLines: z.number().optional().describe('Lines of body to show per issue (default: 5)'),
    }),
    handler: async ({ repo, issue, full, noBody, bodyLines, cwd }) => {
      const args = ['issue', 'read', '-R', repo, String(issue)];
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
      repo: z.string().describe('Target repository (owner/repo)'),
      parent: z.number().describe('Parent issue number'),
      children: z.array(z.number()).describe('Child issue numbers to link as sub-issues'),
    }),
    handler: async ({ repo, parent, children, cwd }) => {
      const args = ['issue', 'add-sub', '-R', repo, '--parent', String(parent), ...children.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_close',
    description: 'Close one or more GitHub issues with optional comment and close reason.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo)'),
      issues: z.union([z.number(), z.array(z.number())]).describe('Issue number or issue numbers to close'),
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned']).optional().describe('Close reason (default: completed)'),
    }),
    handler: async ({ repo, issues, comment, reason, cwd }) => {
      const issueList = Array.isArray(issues) ? issues : [issues];
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
      repo: z.string().describe('Target repository (owner/repo)'),
      issues: z.array(z.number()).describe('Issue numbers to close'),
      comment: z.string().optional().describe('Comment to add when closing'),
      reason: z.enum(['completed', 'not planned']).optional().describe('Close reason (default: completed)'),
    }),
    handler: async ({ repo, issues, comment, reason, cwd }) => {
      const args = ['issue', 'close-batch', '-R', repo, ...issues.map(String)];
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
      repo: z.string().describe('Target repository (owner/repo)'),
      issues: z.array(z.number()).describe('Issue numbers to update (same labels applied to all)'),
      add: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Labels to add — comma-separated string or array. Alias: addLabels'),
      remove: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Labels to remove — comma-separated string or array. Alias: removeLabels'),
      addLabels: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Alias for "add" (accepted so either name works)'),
      removeLabels: z.union([z.string(), z.array(z.string())]).optional()
        .describe('Alias for "remove" (accepted so either name works)'),
    }),
    handler: async ({ repo, issues, add, remove, addLabels, removeLabels, cwd }) => {
      const toCsv = (v) => (Array.isArray(v) ? v.join(',') : v) || '';
      const addCsv = toCsv(add ?? addLabels);
      const removeCsv = toCsv(remove ?? removeLabels);
      if (!addCsv && !removeCsv) {
        throw new Error('tl_gh_issue_label_batch: provide at least one of "add" / "remove" (comma-separated string or array of labels).');
      }
      const args = ['issue', 'label-batch', '-R', repo, ...issues.map(String)];
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
      repo: z.string().describe('Target repository (owner/repo)'),
      project: z.string().describe('Project identifier (owner/number, e.g. "edimuj/1")'),
      issues: z.array(z.number()).describe('Issue numbers to add to the project'),
    }),
    handler: async ({ repo, project, issues, cwd }) => {
      const args = ['project', 'add-batch', '-R', repo, '--project', project, ...issues.map(String), '-j'];
      return dispatchTool('gh', args, { timeout: 120000, cwd });
    },
  },
  {
    name: 'tl_gh_issue_create_batch',
    description: 'Create multiple issues from a JSON array. Each object: { title, body?, labels?, assignee?, milestone? }.',
    schema: withCwd({
      repo: z.string().describe('Target repository (owner/repo)'),
      issues: z.array(z.object({
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (markdown)'),
        labels: z.array(z.string()).optional().describe('Labels to apply'),
        assignee: z.string().optional().describe('Assignee username'),
        milestone: z.string().optional().describe('Milestone name'),
      })).describe('Array of issue objects to create'),
      project: z.string().optional().describe('Add created issues to project (owner/number, e.g. "edimuj/1")'),
    }),
    handler: async ({ repo, issues, project, cwd }) => {
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
