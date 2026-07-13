#!/usr/bin/env node

/**
 * tl-pack - Workflow context packs for common agent tasks
 *
 * Composes existing tokenlean tools into one compact briefing so agents
 * can start with the right context instead of manually chaining commands.
 *
 * Usage: tl-pack <pack> [target] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-pack',
    desc: 'Workflow context packs for review, debug, refactor, PRs, and onboarding',
    when: 'before-read',
    example: 'tl-pack refactor src/auth.ts'
  }));
  process.exit(0);
}

import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { shellQuote } from '../src/text-util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP = `
tl-pack - Workflow context packs for common agent tasks

Usage: tl-pack <pack> [target] [options]

Packs:
  onboard [path|query]  Project shape plus optional keyword-oriented context
  review [target]      Review context for current diff, path, revision range, branch, or PR
  pr <target>          PR/branch review briefing
  refactor <path>      File or directory context for a planned refactor
  debug [command]      Token-efficient command output plus likely follow-up checks

Options:
  --budget N           Approximate output budget; smaller budgets collect fewer sections
  --list               List available packs
  --full               Pass fuller output to selected underlying tools where useful
  --context            For debug packs, keep target as context instead of executing it
${COMMON_OPTIONS_HELP}

Examples:
  tl-pack onboard
  tl-pack refactor src/cache.mjs
  tl-pack debug "npm test"
  tl-pack review
  tl-pack pr 123 --budget 4000
  tl-pack --list
`;

const PACKS = {
  onboard: {
    summary: 'Project shape plus optional keyword-oriented context',
    targetLabel: 'path|query',
    defaultTarget: '.'
  },
  review: {
    summary: 'Review context for current diff, path, revision range, branch, or PR',
    targetLabel: 'target',
    defaultTarget: null
  },
  pr: {
    summary: 'PR/branch review briefing',
    targetLabel: 'target',
    defaultTarget: null
  },
  refactor: {
    summary: 'File or directory context for a planned refactor',
    targetLabel: 'path',
    defaultTarget: null
  },
  debug: {
    summary: 'Token-efficient command output plus likely follow-up checks',
    targetLabel: 'command',
    defaultTarget: null
  }
};

function toolPath(name) {
  return join(__dirname, `tl-${name}.mjs`);
}

function formatToolCommand(name, args = []) {
  return `tl ${name}${args.length ? ` ${args.map(shellQuote).join(' ')}` : ''}`;
}

function parseArgs(rawArgs) {
  const normalized = [];
  let budget = null;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--budget') {
      budget = parseInt(rawArgs[i + 1], 10) || null;
      normalized.push('--max-tokens');
      if (rawArgs[i + 1]) normalized.push(rawArgs[++i]);
    } else {
      normalized.push(rawArgs[i]);
    }
  }

  const options = parseCommonArgs(normalized);
  let list = false;
  let full = false;
  let contextOnly = false;
  const positional = [];

  for (const arg of options.remaining) {
    if (arg === '--list') list = true;
    else if (arg === '--full') full = true;
    else if (arg === '--context') contextOnly = true;
    else positional.push(arg);
  }

  return {
    ...options,
    budget,
    list,
    full,
    contextOnly,
    pack: positional[0] || null,
    target: positional.slice(1).join(' ') || null
  };
}

function budgetTier(options) {
  if (options.full) return 'large';
  const budget = options.budget || options.maxTokens;
  if (!Number.isFinite(budget)) return 'medium';
  if (budget < 1500) return 'small';
  if (budget < 3500) return 'medium';
  return 'large';
}

function applyBudget(sections, options) {
  const tier = budgetTier(options);
  const limits = { small: 2, medium: 3, large: Infinity };
  const limit = limits[tier] ?? Infinity;
  const included = [];
  const omitted = [];

  for (const item of sections) {
    if (included.length < limit || item.required) {
      included.push(item);
    } else {
      omitted.push({
        title: item.title,
        command: item.command,
      });
    }
  }

  return { tier, included, omitted };
}

function compactLines(text, maxLines) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  if (lines.length <= maxLines) return lines;
  const head = Math.max(1, Math.ceil(maxLines * 0.65));
  const tail = Math.max(1, maxLines - head - 1);
  return [
    ...lines.slice(0, head),
    `... omitted ${lines.length - head - tail} lines ...`,
    ...lines.slice(-tail)
  ];
}

function runTool(name, args, opts = {}) {
  const commandArgs = [toolPath(name), ...args];
  const command = formatToolCommand(name, args);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: opts.timeout || 30000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb'
    }
  });

  const errorText = result.error
    ? result.error.code === 'ETIMEDOUT'
      ? `Timed out after ${opts.timeout || 30000}ms`
      : result.error.message
    : '';
  const output = [result.stdout || '', result.stderr || '', errorText].filter(Boolean).join('\n').trim();

  return {
    title: opts.title || command,
    command,
    exitCode: result.status ?? (result.error ? 1 : 0),
    output,
    optional: Boolean(opts.optional)
  };
}

async function runToolAsync(name, args, opts = {}) {
  const commandArgs = [toolPath(name), ...args];
  const command = formatToolCommand(name, args);
  const timeout = opts.timeout || 30000;
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, commandArgs, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      env
    });
    const output = [stdout || '', stderr || ''].filter(Boolean).join('\n').trim();
    return {
      title: opts.title || command,
      command,
      exitCode: 0,
      output,
      stdout: stdout || '',
      stderr: stderr || '',
      optional: Boolean(opts.optional)
    };
  } catch (err) {
    const timedOut = err.killed && err.signal === 'SIGTERM';
    const errorText = timedOut
      ? `Timed out after ${timeout}ms`
      : (err.message || '');
    const output = [err.stdout || '', err.stderr || '', errorText].filter(Boolean).join('\n').trim();
    return {
      title: opts.title || command,
      command,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      output,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      optional: Boolean(opts.optional)
    };
  }
}

function section(title, name, args, opts = {}) {
  return {
    title,
    name,
    args,
    command: formatToolCommand(name, args),
    optional: Boolean(opts.optional),
    timeout: opts.timeout,
    structuredAnalyze: Boolean(opts.structuredAnalyze),
  };
}

function analyzedSection(title, toolName, target, analyzeArgs) {
  return {
    title,
    command: formatToolCommand(toolName, [target]),
    optional: false,
    analyzeProjection: toolName,
    analyzeArgs,
  };
}

function countArrays(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0);
}

function formatAnalyzeProfile(data) {
  const lines = [`${data.file || 'File'} (~${data.tokens || 0} tokens)`];
  const symbols = data.symbols || {};
  const exportCount = Array.isArray(symbols.exports) ? symbols.exports.length : 0;
  const functionCount = Array.isArray(symbols.functions) ? symbols.functions.length : 0;
  const classCount = Array.isArray(symbols.classes) ? symbols.classes.length : 0;
  lines.push(`Symbols: ${exportCount} exports, ${functionCount} functions, ${classCount} classes`);
  lines.push(`Dependencies: ${countArrays(data.deps)}`);

  const complexity = Array.isArray(data.complexity) ? data.complexity : [];
  const hotspots = complexity.filter(fn => Number(fn.cyclomatic) >= 10);
  lines.push(`Complexity: ${complexity.length} functions, ${hotspots.length} hotspots`);
  for (const fn of hotspots.slice(0, 8)) {
    lines.push(`  ${fn.name}: cyclomatic ${fn.cyclomatic}, cognitive ${fn.cognitive}`);
  }

  if (data.partialFailure) {
    lines.push(`Partial analysis: ${(data.errors || []).length} section(s) failed`);
    for (const failure of data.errors || []) lines.push(`  ${failure.name}: ${failure.error}`);
  }
  return lines.join('\n');
}

function formatImpactProjection(data) {
  const impact = data.impact || {};
  const summary = data.impactSummary || {};
  // Accept both the established analyze shape and a full tl-impact payload.
  const categories = impact.importers && !Array.isArray(impact.importers) ? impact.importers : impact;
  const totalFiles = Number.isFinite(summary.totalFiles) ? summary.totalFiles : countArrays(categories);
  if (totalFiles === 0) return 'No importers found.';

  const lines = [`${totalFiles} importer(s), ~${summary.totalTokens || impact.totalTokens || 0} tokens`];
  for (const [category, files] of Object.entries(categories)) {
    if (!Array.isArray(files) || files.length === 0) continue;
    lines.push(`${category}:`);
    for (const file of files) lines.push(`  ${file.relPath || file.path}${file.line ? `:${file.line}` : ''}`);
  }
  return lines.join('\n');
}

function formatRelatedProjection(data) {
  const related = data.related || {};
  const summary = data.relatedSummary || {};
  const groups = [
    ['tests', related.tests],
    ['types', related.types],
    ['importers', related.importers],
    ['siblings', related.siblings],
  ];
  const totalFiles = Number.isFinite(summary.totalFiles) ? summary.totalFiles : countArrays(related);
  if (totalFiles === 0) return 'No related files found.';

  const lines = [`${totalFiles} related file(s), ~${summary.totalTokens || related.totalTokens || 0} tokens`];
  for (const [label, files] of groups) {
    if (!Array.isArray(files) || files.length === 0) continue;
    lines.push(`${label}:`);
    for (const file of files) lines.push(`  ${file.path || file.relPath || String(file)}`);
  }
  return lines.join('\n');
}

function getStructuredAnalyze(context, args) {
  const key = JSON.stringify(args);
  if (!context.analyzeRuns.has(key)) {
    const displayCommand = formatToolCommand('analyze', args);
    const jsonArgs = args.includes('--json') || args.includes('-j') ? args : [...args, '--json'];
    context.analyzeRuns.set(key, runToolAsync('analyze', jsonArgs).then((run) => {
      if (run.exitCode !== 0) return { ...run, command: displayCommand, data: null };
      try {
        return { ...run, command: displayCommand, data: JSON.parse(run.stdout) };
      } catch (err) {
        return {
          ...run,
          command: displayCommand,
          exitCode: 1,
          output: `Invalid tl analyze JSON: ${err.message}`,
          data: null,
        };
      }
    }));
  }
  return context.analyzeRuns.get(key);
}

async function executeAnalyzedSection(item, context) {
  const analyzed = await getStructuredAnalyze(context, item.analyzeArgs || item.args);
  const base = {
    title: item.title,
    command: item.command,
    optional: Boolean(item.optional),
  };
  if (analyzed.exitCode !== 0 || !analyzed.data) {
    return { ...base, exitCode: analyzed.exitCode || 1, output: analyzed.output || 'Analysis failed.' };
  }

  if (item.analyzeProjection) {
    const sectionRun = analyzed.data.sections?.[item.analyzeProjection];
    if (sectionRun?.status === 'error') {
      return { ...base, exitCode: 1, output: sectionRun.error || `${item.analyzeProjection} failed`, reusedFrom: analyzed.command };
    }
  }

  const output = item.structuredAnalyze
    ? formatAnalyzeProfile(analyzed.data)
    : item.analyzeProjection === 'impact'
      ? formatImpactProjection(analyzed.data)
      : formatRelatedProjection(analyzed.data);
  return {
    ...base,
    exitCode: 0,
    output,
    ...(item.analyzeProjection ? { reusedFrom: analyzed.command } : {}),
  };
}

async function executeSection(item, context) {
  if (item.structuredAnalyze || item.analyzeProjection) return executeAnalyzedSection(item, context);
  if (!item.name) return item;
  return runToolAsync(item.name, item.args, {
    title: item.title,
    optional: item.optional,
    timeout: item.timeout,
  });
}

function buildOnboard(target, options) {
  if (!existsSync(target)) {
    return buildOnboardQuery(target, options);
  }

  return buildOnboardPath(target, options);
}

function buildOnboardPath(target, options) {
  return [
    section('Project structure', 'structure', [target, '--depth', budgetTier(options) === 'small' ? '1' : options.full ? '3' : '2']),
    section('Entry points', 'entry', [target]),
    section('Technology stack', 'stack', []),
    section('Context hotspots', 'context', [target, '--top', options.full ? '20' : '10'])
  ];
}

function buildOnboardQuery(query, options) {
  const depth = budgetTier(options) === 'small' ? '1' : options.full ? '3' : '2';
  return [
    {
      title: 'Target query',
      command: formatToolCommand('pack', ['onboard', query]),
      exitCode: 0,
      output: `Target is not an existing path; treating it as a query while onboarding the current project: ${query}`,
      optional: false
    },
    section('Project structure', 'structure', ['.', '--depth', depth]),
    section('Query function matches', 'lookup', [query, '.'], { optional: true }),
    section('Entry points', 'entry', ['.']),
    section('Technology stack', 'stack', []),
    section('Context hotspots', 'context', ['.', '--top', options.full ? '20' : '10'])
  ];
}

function buildReview(target, options) {
  if (target) {
    if (isExistingFile(target)) {
      return buildFileReview(target, options);
    }
    if (isExistingDirectory(target)) {
      return buildOnboard(target, options);
    }
    if (isGitRevisionRange(target)) {
      return buildDiffReview(target);
    }
    return buildPr(target, options);
  }

  return [
    section('Commit context', 'commit-prep', options.full ? ['--full'] : []),
    section('Current diff', 'diff', options.full ? ['--full'] : []),
    section('Pre-commit risks', 'guard', [], { optional: true, timeout: 45000 })
  ];
}

// A target like "src/services src/db sdk/src/types.ts" is multiple paths the
// CLI/MCP collapsed into one string. Split it back out only when every token
// resolves to a real path — otherwise it's a single path (possibly with spaces)
// or a non-path target (PR ref, command) and we leave it untouched.
function splitExistingPaths(target) {
  if (!target || typeof target !== 'string') return null;
  const tokens = target.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  if (!tokens.every((t) => existsSync(t))) return null;
  return tokens;
}

function isExistingFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isGitRevisionRange(target) {
  return /^\S+\.{2,3}\S+$/.test(String(target || '').trim());
}

function firstShellToken(command) {
  let rest = String(command || '').trim();

  while (rest) {
    const match = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/);
    if (!match) return null;

    const token = match[1] || match[2] || match[3] || '';
    rest = rest.slice(match[0].length).trimStart();

    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
    return token;
  }

  return null;
}

function executablePathExists(candidate) {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(name, cwd = process.cwd()) {
  const shellBuiltins = new Set([
    ':', '.', '[', 'alias', 'bg', 'break', 'cd', 'command', 'continue',
    'echo', 'eval', 'exec', 'exit', 'export', 'false', 'fg', 'hash',
    'jobs', 'kill', 'pwd', 'read', 'return', 'set', 'shift', 'test',
    'trap', 'true', 'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait'
  ]);
  if (!name) return false;
  if (shellBuiltins.has(name)) return true;

  if (name.includes('/') || name.includes('\\')) {
    const candidate = isAbsolute(name) ? name : join(cwd, name);
    return executablePathExists(candidate);
  }

  const pathDirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  const pathExts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const dir of pathDirs) {
    for (const ext of pathExts) {
      if (executablePathExists(join(dir, `${name}${ext}`))) return true;
    }
  }

  return false;
}

function looksLikeRunnableCommand(command) {
  const token = firstShellToken(command);
  return commandExists(token);
}

function buildFileReview(target, options) {
  const analyzeArgs = [target];
  if (options.full) analyzeArgs.push('--full');

  return [
    section('File profile', 'analyze', analyzeArgs, { structuredAnalyze: true }),
    analyzedSection('Blast radius', 'impact', target, analyzeArgs),
    analyzedSection('Related files', 'related', target, analyzeArgs),
    section('Target diff', 'diff', ['--file', target], { optional: true })
  ];
}

function buildDiffReview(target) {
  return [
    section('Target diff', 'diff', [target]),
    section('Review risk checks', 'guard', [], { optional: true, timeout: 45000 })
  ];
}

function buildDirectoryRefactor(target, options) {
  const tier = budgetTier(options);
  const depth = tier === 'small' ? '1' : options.full ? '3' : '2';
  const symbolLineLimit = options.full ? '80' : '40';

  return [
    section('Project structure', 'structure', [target, '--depth', depth]),
    section('Exported symbols', 'symbols', [target, '--exports-only', '--max-lines', symbolLineLimit]),
    section('Context hotspots', 'context', [target, '--top', options.full ? '20' : '10']),
    section('Entry points', 'entry', [target])
  ];
}

function buildPr(target, options) {
  if (!target) {
    return [
      {
        title: 'Missing target',
        command: 'tl pack pr <target>',
        exitCode: 1,
        output: 'Provide a PR number or branch.',
        optional: false
      }
    ];
  }

  const args = [target];
  if (options.full) args.push('--full');

  return [
    section('PR / branch summary', 'pr', args),
    section('Review risk checks', 'guard', [], { optional: true, timeout: 45000 })
  ];
}

function buildRefactor(target, options) {
  if (!target) {
    return [
      {
        title: 'Missing file',
        command: 'tl pack refactor <file>',
        exitCode: 1,
        output: 'Provide the file you plan to refactor.',
        optional: false
      }
    ];
  }

  if (!existsSync(target)) {
    return [
      {
        title: 'File not found',
        command: `tl pack refactor ${target}`,
        exitCode: 1,
        output: `Path not found: ${target}`,
        optional: false
      }
    ];
  }

  if (isExistingDirectory(target)) {
    return buildDirectoryRefactor(target, options);
  }

  const analyzeArgs = [target];
  if (options.full) analyzeArgs.push('--full');

  return [
    section('File profile', 'analyze', analyzeArgs, { structuredAnalyze: true }),
    analyzedSection('Blast radius', 'impact', target, analyzeArgs),
    analyzedSection('Related files', 'related', target, analyzeArgs),
    section('Test mapping', 'test-map', [target])
  ];
}

function buildDebug(target, options) {
  const sections = [];

  if (target) {
    if (!options.contextOnly && looksLikeRunnableCommand(target)) {
      sections.push(section('Command result', 'run', [target, '--type', 'test'], { timeout: 300000 }));
    } else {
      sections.push({
        title: 'Command result',
        command: 'tl pack debug <command>',
        exitCode: 0,
        output: options.contextOnly
          ? `Target kept as context only: ${target}`
          : `Target kept as context only because it does not start with an executable command: ${target}`,
        optional: true
      });
    }
  } else {
    sections.push({
      title: 'Command result',
      command: 'tl pack debug <command>',
      exitCode: 0,
      output: 'No command provided. Pass a failing command to get a compact repro summary.',
      optional: true
    });
  }

  sections.push(section('Changed-file tests', 'test', ['--dry-run'], { optional: true, timeout: 45000 }));
  sections.push(section('Error map', 'errors', ['.'], { optional: true }));
  if (options.full) sections.push(section('Recent hotspots', 'hotspots', [], { optional: true }));

  return sections;
}

function buildPack(pack, target, options) {
  const config = PACKS[pack];
  const effectiveTarget = target || config?.defaultTarget;

  // Path-oriented packs accept multiple paths in one target string; build the
  // per-path sections for each and tag titles so the output stays readable.
  if (['onboard', 'review', 'refactor'].includes(pack)) {
    const paths = splitExistingPaths(effectiveTarget);
    if (paths) {
      return paths.flatMap((p) =>
        (buildPack(pack, p, options) || []).map((s) => ({ ...s, title: `${s.title} — ${p}` }))
      );
    }
  }

  if (pack === 'onboard') return buildOnboard(effectiveTarget, options);
  if (pack === 'review') return buildReview(effectiveTarget, options);
  if (pack === 'pr') return buildPr(effectiveTarget, options);
  if (pack === 'refactor') return buildRefactor(effectiveTarget, options);
  if (pack === 'debug') return buildDebug(effectiveTarget, options);
  return null;
}

function printList(out) {
  out.header('Available packs:');
  for (const [name, config] of Object.entries(PACKS)) {
    out.add(`  ${name.padEnd(10)} ${config.summary}`);
  }
  out.setData('packs', PACKS);
  out.print();
}

async function renderPack(pack, target, sections, options) {
  const out = createOutput(options);
  const budgeted = applyBudget(sections, options);
  const executionContext = { analyzeRuns: new Map() };
  // Execute all included sections concurrently; Promise.all preserves order.
  const includedSections = await Promise.all(budgeted.included.map(item => executeSection(item, executionContext)));
  const failures = includedSections.filter(s => s.exitCode !== 0 && !s.optional);
  const optionalFailures = includedSections.filter(s => s.exitCode !== 0 && s.optional);
  const compactSections = includedSections.map(item => ({
    title: item.title,
    command: item.command,
    exitCode: item.exitCode,
    optional: item.optional,
    ...(item.reusedFrom ? { reusedFrom: item.reusedFrom } : {}),
    output: compactLines(item.output || '(no output)', budgeted.tier === 'small' ? 12 : options.full ? 60 : 24)
  }));

  out.setData('pack', pack);
  out.setData('target', target);
  out.setData('budgetTier', budgeted.tier);
  out.setData('sections', compactSections);
  out.setData('omittedSections', budgeted.omitted);
  out.setData('failed', failures.length > 0);

  out.header(`Context pack: ${pack}${target ? ` (${target})` : ''}`);
  out.header(PACKS[pack]?.summary || '');
  out.header(`Budget tier: ${budgeted.tier}`);
  out.blank();

  for (const item of includedSections) {
    const status = item.exitCode === 0 ? 'ok' : item.optional ? 'skip' : 'fail';
    out.add(`${item.title} [${status}]`);
    out.add(`$ ${item.command}`);
    const lines = compactSections.find(sectionItem => sectionItem.title === item.title)?.output || [];
    for (const line of lines) out.add(`  ${line}`);
    out.blank();
  }

  if (optionalFailures.length > 0) {
    out.add(`Optional checks skipped or failed: ${optionalFailures.length}`);
  }

  if (budgeted.omitted.length > 0) {
    out.add('Omitted by budget:');
    for (const item of budgeted.omitted) {
      out.add(`  ${item.title} ($ ${item.command})`);
    }
  }

  out.print();
  process.exit(failures.length > 0 ? 1 : 0);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const out = createOutput(options);

if (options.list || !options.pack) {
  printList(out);
  process.exit(0);
}

if (!PACKS[options.pack]) {
  console.error(`Unknown pack: ${options.pack}`);
  console.error(`Run "tl pack --list" to see available packs.`);
  process.exit(1);
}

const sections = buildPack(options.pack, options.target, options);
await renderPack(options.pack, options.target, sections, options);
