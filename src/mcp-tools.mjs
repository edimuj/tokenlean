/**
 * MCP tool definitions for tokenlean.
 *
 * Each tool shells out to its CLI counterpart with -j for JSON output.
 * v1: subprocess dispatch (same code path as CLI, zero duplication).
 * v2: hot-path tools move to in-process for speed.
 */

import { execFile } from 'node:child_process';
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

async function runCli(tool, args = [], { timeout = 60000 } = {}) {
  const toolPath = join(binDir, `tl-${tool}.mjs`);
  try {
    const { stdout, stderr } = await execFileAsync('node', [toolPath, ...args], {
      timeout,
      encoding: 'utf-8',
      cwd: process.cwd(),
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

async function dispatchTool(tool, args, opts) {
  const { stdout, stderr, ok } = await runCli(tool, args, opts);
  if (!ok && !stdout) return textResult(stderr || 'Tool failed with no output', true);
  // Return stdout; append stderr as note if present and tool succeeded
  const text = ok && stderr ? `${stdout}\n\n[stderr: ${stderr}]` : stdout;
  return textResult(text || '(no output)', !ok);
}

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'tl_symbols',
    description: 'Extract function/class/type signatures from source files without bodies. Shows API surface in minimal tokens.',
    schema: {
      files: z.string().describe('File or directory path(s), space-separated'),
      exportsOnly: z.boolean().optional().describe('Show only exported symbols'),
      filter: z.enum(['function', 'class', 'type', 'constant', 'export']).optional().describe('Filter by symbol type'),
    },
    handler: async ({ files, exportsOnly, filter }) => {
      const args = files.split(/\s+/).filter(Boolean);
      if (exportsOnly) args.push('-e');
      if (filter) args.push('--filter', filter);
      args.push('-j');
      return dispatchTool('symbols', args);
    },
  },
  {
    name: 'tl_snippet',
    description: 'Extract function/class/method body by name. Returns just the implementation needed instead of the entire file.',
    schema: {
      name: z.string().describe('Symbol name(s), comma-separated. Supports Class.method and file:name syntax'),
      file: z.string().optional().describe('File to search in (omit to search project)'),
      context: z.number().optional().describe('Lines of context above/below (default: 0)'),
      all: z.boolean().optional().describe('Show all matches, not just first'),
    },
    handler: async ({ name, file, context, all }) => {
      const args = [name];
      if (file) args.push(file);
      if (context) args.push('-c', String(context));
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('snippet', args);
    },
  },
  {
    name: 'tl_run',
    description: 'Execute a shell command with token-efficient output. Auto-detects test/build/lint output and summarizes to essentials.',
    schema: {
      command: z.string().describe('Shell command to run'),
      type: z.enum(['test', 'build', 'lint', 'generic']).optional().describe('Force output type (default: auto-detect)'),
      raw: z.boolean().optional().describe('Show full output, no summarization'),
      timeout: z.number().optional().describe('Command timeout in ms (default: 300000)'),
      diff: z.boolean().optional().describe('Compare against previous run of same command'),
    },
    handler: async ({ command, type, raw, timeout, diff }) => {
      const args = [command];
      if (type) args.push('--type', type);
      if (raw) args.push('--raw');
      if (timeout) args.push('--timeout', String(timeout));
      if (diff) args.push('--diff');
      args.push('-j');
      return dispatchTool('run', args, { timeout: (timeout || 300000) + 5000 });
    },
  },
  {
    name: 'tl_impact',
    description: 'Find all files that import/depend on a given file. Shows blast radius before modifying shared code.',
    schema: {
      file: z.string().describe('File to analyze dependencies for'),
    },
    handler: async ({ file }) => {
      return dispatchTool('impact', [file, '-j']);
    },
  },
  {
    name: 'tl_browse',
    description: 'Fetch a URL and return its content as clean markdown. Strips navigation, ads, and boilerplate.',
    schema: {
      url: z.string().describe('URL to fetch'),
    },
    handler: async ({ url }) => {
      return dispatchTool('browse', [url, '-j']);
    },
  },
  {
    name: 'tl_tail',
    description: 'Smart log reducer — collapses repeated patterns, highlights errors/warnings. For log files or piped output.',
    schema: {
      file: z.string().describe('Log file path to analyze'),
      lines: z.number().optional().describe('Max output lines (default: 30)'),
    },
    handler: async ({ file, lines }) => {
      const args = [file];
      if (lines) args.push('-l', String(lines));
      args.push('-j');
      return dispatchTool('tail', args);
    },
  },
  {
    name: 'tl_guard',
    description: 'Pre-commit quality check — scans for secrets, TODOs, unused exports, and circular dependencies.',
    schema: {
      noSecrets: z.boolean().optional().describe('Skip secrets check'),
      noTodos: z.boolean().optional().describe('Skip TODO/FIXME check'),
      noUnused: z.boolean().optional().describe('Skip unused exports check'),
      noCircular: z.boolean().optional().describe('Skip circular deps check'),
      strict: z.boolean().optional().describe('Treat warnings as failures'),
    },
    handler: async ({ noSecrets, noTodos, noUnused, noCircular, strict }) => {
      const args = [];
      if (noSecrets) args.push('--no-secrets');
      if (noTodos) args.push('--no-todos');
      if (noUnused) args.push('--no-unused');
      if (noCircular) args.push('--no-circular');
      if (strict) args.push('--strict');
      args.push('-j');
      return dispatchTool('guard', args);
    },
  },
  {
    name: 'tl_diff',
    description: 'Token-efficient git diff summary — changed files categorized by risk with context.',
    schema: {
      ref: z.string().optional().describe('Git ref to diff against (default: staged or HEAD)'),
      file: z.string().optional().describe('Limit diff to specific file'),
    },
    handler: async ({ ref, file }) => {
      const args = [];
      if (ref) args.push(ref);
      if (file) args.push('--file', file);
      args.push('-j');
      return dispatchTool('diff', args);
    },
  },
  {
    name: 'tl_advise',
    description: 'Recommend the next tokenlean commands for a coding task. Use this before choosing tools for review, debug, refactor, testing, docs, or commit work.',
    schema: {
      goal: z.string().describe('Natural-language task goal, e.g. "debug failing npm test" or "review PR 123"'),
      all: z.boolean().optional().describe('Show secondary recommendations too'),
    },
    handler: async ({ goal, all }) => {
      const args = [goal];
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('advise', args);
    },
  },
  {
    name: 'tl_pack',
    description: 'Build a compact workflow context pack for onboard, review, pr, refactor, or debug tasks.',
    schema: {
      pack: z.enum(['onboard', 'review', 'pr', 'refactor', 'debug']).describe('Workflow pack to run'),
      target: z.string().optional().describe('Optional path, PR/branch target, or command depending on pack'),
      budget: z.number().optional().describe('Output budget in approximate tokens'),
      full: z.boolean().optional().describe('Include fuller underlying tool output where useful'),
    },
    handler: async ({ pack, target, budget, full }) => {
      const args = [pack];
      if (target) args.push(target);
      if (budget) args.push('--budget', String(budget));
      if (full) args.push('--full');
      args.push('-j');
      return dispatchTool('pack', args, { timeout: pack === 'debug' ? 305000 : 120000 });
    },
  },
  {
    name: 'tl_analyze',
    description: 'Composite file profile: symbols, dependencies, impact, complexity, and related files in one compact report.',
    schema: {
      file: z.string().describe('File to analyze'),
      full: z.boolean().optional().describe('Show more detail per section'),
    },
    handler: async ({ file, full }) => {
      const args = [file];
      if (full) args.push('--full');
      args.push('-j');
      return dispatchTool('analyze', args);
    },
  },
  {
    name: 'tl_related',
    description: 'Find tests, type files, importers, and siblings related to a target file.',
    schema: {
      file: z.string().describe('Target file'),
    },
    handler: async ({ file }) => {
      return dispatchTool('related', [file, '-j']);
    },
  },
  {
    name: 'tl_context',
    description: 'Estimate token usage for files or directories before reading them.',
    schema: {
      path: z.string().optional().describe('File or directory path (default: current directory)'),
      top: z.number().optional().describe('Show top N largest files'),
      all: z.boolean().optional().describe('Show all files'),
    },
    handler: async ({ path, top, all }) => {
      const args = [];
      if (path) args.push(path);
      if (top) args.push('--top', String(top));
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('context', args);
    },
  },
  {
    name: 'tl_structure',
    description: 'Smart project overview with token estimates and important files/directories.',
    schema: {
      path: z.string().optional().describe('Project path (default: current directory)'),
      depth: z.number().optional().describe('Maximum depth to show'),
      entryPoints: z.boolean().optional().describe('Highlight entry points'),
      exports: z.boolean().optional().describe('Show top exports inline per file'),
    },
    handler: async ({ path, depth, entryPoints, exports }) => {
      const args = [];
      if (path) args.push(path);
      if (depth) args.push('--depth', String(depth));
      if (entryPoints) args.push('--entry-points');
      if (exports) args.push('--exports');
      args.push('-j');
      return dispatchTool('structure', args);
    },
  },
  {
    name: 'tl_entry',
    description: 'Find project entry points: main files, routes, handlers, exports, and CLI entry points.',
    schema: {
      path: z.string().optional().describe('Search path (default: current directory)'),
      type: z.enum(['main', 'routes', 'handlers', 'exports', 'cli']).optional().describe('Entry point type filter'),
    },
    handler: async ({ path, type }) => {
      const args = [];
      if (path) args.push(path);
      if (type) args.push('--type', type);
      args.push('-j');
      return dispatchTool('entry', args);
    },
  },
  {
    name: 'tl_audit',
    description: 'Analyze token waste in this session or project. Shows what patterns are costing tokens and how many were already saved by tokenlean.',
    schema: {
      path: z.string().optional().describe('Project directory or session file to analyze (default: cwd)'),
      savings: z.boolean().optional().describe('Include tokens saved by tokenlean (default: false)'),
      all: z.boolean().optional().describe('Analyze all sessions, not just the most recent'),
    },
    handler: async ({ path, savings, all }) => {
      const args = [];
      if (path) args.push(path);
      if (savings) args.push('--savings');
      if (all) args.push('--all');
      args.push('-j');
      return dispatchTool('audit', args);
    },
  },
  {
    name: 'tl_deps',
    description: 'Show imports and dependency tree for a file. Reveals what a file depends on without reading it.',
    schema: {
      file: z.string().describe('File to show dependencies for'),
      depth: z.number().optional().describe('Dependency depth to traverse (default: 1)'),
    },
    handler: async ({ file, depth }) => {
      const args = [file];
      if (depth) args.push('-d', String(depth));
      args.push('-j');
      return dispatchTool('deps', args);
    },
  },
  {
    name: 'tl_exports',
    description: 'Show public API surface of a module or directory — what it exports without reading implementations.',
    schema: {
      path: z.string().describe('File or directory to analyze'),
    },
    handler: async ({ path }) => {
      return dispatchTool('exports', [path, '-j']);
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
