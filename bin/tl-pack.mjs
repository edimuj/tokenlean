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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP = `
tl-pack - Workflow context packs for common agent tasks

Usage: tl-pack <pack> [target] [options]

Packs:
  onboard [path]        Project shape, entry points, stack, and token hotspots
  review [target]      Review context for current branch, staged diff, or branch/PR
  pr <target>          PR/branch review briefing
  refactor <file>      File profile, impact, related files, and test mapping
  debug [command]      Token-efficient command output plus likely follow-up checks

Options:
  --budget N           Approximate output budget; smaller budgets collect fewer sections
  --list               List available packs
  --full               Pass fuller output to selected underlying tools where useful
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
    summary: 'Project shape, entry points, stack, and token hotspots',
    targetLabel: 'path',
    defaultTarget: '.'
  },
  review: {
    summary: 'Review context for current branch, staged diff, or branch/PR',
    targetLabel: 'target',
    defaultTarget: null
  },
  pr: {
    summary: 'PR/branch review briefing',
    targetLabel: 'target',
    defaultTarget: null
  },
  refactor: {
    summary: 'File profile, impact, related files, and test mapping',
    targetLabel: 'file',
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
  const positional = [];

  for (const arg of options.remaining) {
    if (arg === '--list') list = true;
    else if (arg === '--full') full = true;
    else positional.push(arg);
  }

  return {
    ...options,
    budget,
    list,
    full,
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
  const command = `tl ${name}${args.length ? ` ${args.join(' ')}` : ''}`;
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

function section(title, name, args, opts = {}) {
  return {
    title,
    name,
    args,
    command: `tl ${name}${args.length ? ` ${args.join(' ')}` : ''}`,
    optional: Boolean(opts.optional),
    timeout: opts.timeout,
  };
}

function executeSection(item) {
  if (!item.name) return item;
  return runTool(item.name, item.args, {
    title: item.title,
    optional: item.optional,
    timeout: item.timeout,
  });
}

function buildOnboard(target, options) {
  return [
    section('Project structure', 'structure', [target, '--depth', budgetTier(options) === 'small' ? '1' : options.full ? '3' : '2']),
    section('Entry points', 'entry', [target]),
    section('Technology stack', 'stack', []),
    section('Context hotspots', 'context', [target, '--top', options.full ? '20' : '10'])
  ];
}

function buildReview(target, options) {
  if (target) {
    return buildPr(target, options);
  }

  return [
    section('Commit context', 'commit-prep', options.full ? ['--full'] : []),
    section('Current diff', 'diff', options.full ? ['--full'] : []),
    section('Pre-commit risks', 'guard', [], { optional: true, timeout: 45000 })
  ];
}

function buildPr(target, options) {
  if (!target) {
    return [
      {
        title: 'Missing target',
        command: 'tl pack pr <target>',
        exitCode: 1,
        output: 'Provide a PR number, branch, or revision target.',
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

  const analyzeArgs = [target];
  if (options.full) analyzeArgs.push('--full');

  return [
    section('File profile', 'analyze', analyzeArgs),
    section('Blast radius', 'impact', [target]),
    section('Related files', 'related', [target]),
    section('Test mapping', 'test-map', [target])
  ];
}

function buildDebug(target, options) {
  const sections = [];

  if (target) {
    sections.push(section('Command result', 'run', [target, '--type', 'test'], { timeout: 300000 }));
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

function renderPack(pack, target, sections, options) {
  const out = createOutput(options);
  const budgeted = applyBudget(sections, options);
  const includedSections = budgeted.included.map(executeSection);
  const failures = includedSections.filter(s => s.exitCode !== 0 && !s.optional);
  const optionalFailures = includedSections.filter(s => s.exitCode !== 0 && s.optional);
  const compactSections = includedSections.map(item => ({
    title: item.title,
    command: item.command,
    exitCode: item.exitCode,
    optional: item.optional,
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
renderPack(options.pack, options.target, sections, options);
