#!/usr/bin/env node

/**
 * tl-prompt - Output AI agent instructions for tokenlean tools
 *
 * Generates tiered instructions: core tools agents use 90% of the time,
 * decision rules for when to use them, and a full catalog for discovery.
 *
 * Usage:
 *   tl-prompt                 # Full instructions (markdown)
 *   tl-prompt --minimal       # Compact version (for CLAUDE.md / .cursorrules)
 *   tl-prompt --codex         # Codex-optimized instructions (for AGENTS.md)
 *   tl-prompt --list          # Simple name: desc list
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--prompt')) {
  process.exit(0);
}

// The tools agents actually reach for (from real agent feedback)
const CORE_TOOLS = [
  { name: 'tl-symbols',  usage: 'tl-symbols <file>',               desc: 'Function/class signatures without bodies' },
  { name: 'tl-snippet',  usage: 'tl-snippet <name> <file>',        desc: 'Extract one function/class by name' },
  { name: 'tl-impact',   usage: 'tl-impact <file>',                desc: 'What depends on this file (run before modifying)' },
  { name: 'tl-run',      usage: 'tl-run "<cmd>"',                  desc: 'Token-efficient command output (tests, builds, linters)' },
  { name: 'tl-guard',    usage: 'tl-guard',                        desc: 'Pre-commit check (secrets, TODOs, unused exports, circular deps)' },
  { name: 'tl-structure', usage: 'tl-structure',                   desc: 'Project overview with token estimates' },
  { name: 'tl-browse',   usage: 'tl-browse <url>',                 desc: 'Fetch any URL as clean markdown' },
  { name: 'tl-context7', usage: 'tl-context7 <lib> [query] -t N', desc: 'Latest library/framework docs' },
  { name: 'tl-component', usage: 'tl-component <file>',            desc: 'React component profile (props, hooks, state)' },
  { name: 'tl-analyze',  usage: 'tl-analyze <file>',               desc: 'Composite file profile (symbols + deps + impact + complexity)' },
];

const CORE_NAMES = new Set(CORE_TOOLS.map(t => t.name));

function discoverTools() {
  const tools = [];
  const binDir = __dirname;
  const skip = new Set(['tl-prompt.mjs', 'tl-secrets.mjs', 'tl-stack.mjs', 'tl-todo.mjs']);

  const files = readdirSync(binDir)
    .filter(f => f.startsWith('tl-') && f.endsWith('.mjs') && !skip.has(f));

  for (const file of files) {
    try {
      const result = execSync(`node "${join(binDir, file)}" --prompt`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (result) {
        tools.push(JSON.parse(result));
      }
    } catch (e) {
      // Tool doesn't support --prompt or errored
    }
  }

  return tools;
}

function generateFull(tools) {
  const rest = tools.filter(t => !CORE_NAMES.has(t.name));

  let output = `## tokenlean — CLI tools for AI agents

### When to use tl-* vs. just reading the file

- **<150 lines**: Just read it — tl-* overhead costs more than the file itself
- **150-400 lines**: \`tl-symbols\` first, then \`tl-snippet <name>\` for specific functions
- **400+ lines**: Always \`tl-symbols\` first — never read the whole file unless you truly need it all
- **Tests/builds/linters**: Always wrap with \`tl-run\` — filters noise, saves hundreds of tokens

### Core tools

| Command | Purpose |
|---------|---------|
`;

  for (const tool of CORE_TOOLS) {
    output += `| \`${tool.usage}\` | ${tool.desc} |\n`;
  }

  output += `
### Rules

- **Before reading a source file**, run \`tl-symbols <file>\` first. Only read the full file if you need implementation details.
- **Before modifying a file**, run \`tl-impact <file>\` to understand what depends on it and what might break.
- **Before committing**, run \`tl-guard\` to catch secrets, new TODOs, unused exports, and circular deps.
- **When running commands**, wrap with \`tl-run "<cmd>"\` — it extracts only errors and key output.
- **When exploring an unfamiliar codebase**, start with \`tl-structure\` before diving into files.
- **When you need library docs**, use \`tl-context7 <lib> [query] -t N\` — your training data is stale.
- All tools support \`-j\` (JSON), \`-q\` (quiet), \`-l N\` (limit lines), \`-t N\` (limit tokens), and \`--help\`.
`;

  if (rest.length > 0) {
    output += `
### Full catalog

`;

    const groups = {
      'before-read': { title: 'Understanding code', tools: [] },
      'before-modify': { title: 'Before changing code', tools: [] },
      'search': { title: 'Search and utilities', tools: [] }
    };

    for (const tool of rest) {
      const group = groups[tool.when] || groups['search'];
      group.tools.push(tool);
    }

    for (const [, group] of Object.entries(groups)) {
      if (group.tools.length === 0) continue;
      const names = group.tools.map(t => `\`${t.name}\` ${t.desc}`).join(' | ');
      output += `**${group.title}:** ${names}\n\n`;
    }
  }

  return output;
}

function generateFullCodex(tools) {
  const rest = tools.filter(t => !CORE_NAMES.has(t.name));

  let output = `## tokenlean - Codex agent profile

### Codex workflow for token-efficient execution

- **Unknown repository**: Start with \`tl-structure\` to map the project before opening files
- **Before reading implementation**: Run \`tl-symbols <file>\` first; then use \`tl-snippet <name> <file>\` for focused code
- **Before editing**: Run \`tl-impact <file>\` and \`tl-related <file>\` to avoid regressions
- **Tests/build/lint**: Wrap commands with \`tl-run "<cmd>"\` to keep only actionable output
- **Large outputs**: Prefer \`-t N\` and \`-l N\` to cap context usage

### Core tools

| Command | Purpose |
|---------|---------|
`;

  for (const tool of CORE_TOOLS) {
    output += `| \`${tool.usage}\` | ${tool.desc} |\n`;
  }

  output += `
### Codex rules

- Use \`tl-structure\` first when project layout is unclear.
- Use \`tl-symbols\` before reading source files; pull full files only when signatures are insufficient.
- Use \`tl-impact\` before edits and \`tl-guard\` before commit.
- Use \`tl-run\` for noisy commands; use \`--raw\` only when summaries hide needed detail.
- Use \`-j\` when machine-readable output helps chaining.
- Use \`tl-context7 <lib> [query] -t N\` for current docs.
- All tools support \`-j\`, \`-q\`, \`-l N\`, \`-t N\`, and \`--help\`.
`;

  if (rest.length > 0) {
    output += `
### Full catalog

`;

    const groups = {
      'before-read': { title: 'Understanding code', tools: [] },
      'before-modify': { title: 'Before changing code', tools: [] },
      'search': { title: 'Search and utilities', tools: [] }
    };

    for (const tool of rest) {
      const group = groups[tool.when] || groups['search'];
      group.tools.push(tool);
    }

    for (const [, group] of Object.entries(groups)) {
      if (group.tools.length === 0) continue;
      const names = group.tools.map(t => `\`${t.name}\` ${t.desc}`).join(' | ');
      output += `**${group.title}:** ${names}\n\n`;
    }
  }

  return output;
}

function generateMinimal(tools) {
  let lines = [
    '## tokenlean',
    '',
    'When to use: <150 lines just read it. 150-400: `tl-symbols` first, `tl-snippet` for specifics. 400+: always `tl-symbols` first. Tests/builds: always `tl-run`.',
    '',
    'Core tools:',
  ];

  for (const tool of CORE_TOOLS) {
    lines.push(`- \`${tool.usage}\` — ${tool.desc}`);
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- Before reading a source file, run `tl-symbols <file>` first.');
  lines.push('- Before modifying a file, run `tl-impact <file>` to check dependents.');
  lines.push('- Before committing, run `tl-guard`.');
  lines.push('- Wrap test/build/lint commands with `tl-run "<cmd>"`.');
  lines.push('- For library docs, use `tl-context7 <lib> [query] -t N`.');
  lines.push('- All tools: `-j` (JSON), `-q` (quiet), `-l N` (limit), `-t N` (tokens), `--help`.');

  const rest = tools.filter(t => !CORE_NAMES.has(t.name));
  if (rest.length > 0) {
    lines.push('');
    lines.push(`Also available (${rest.length} more): ${rest.map(t => `\`${t.name}\``).join(', ')}`);
  }

  return lines.join('\n');
}

function generateMinimalCodex(tools) {
  let lines = [
    '## tokenlean (Codex profile)',
    '',
    'Workflow: unknown repo -> `tl-structure`; before read -> `tl-symbols`; focused read -> `tl-snippet`; before edit -> `tl-impact` + `tl-related`; tests/build/lint -> `tl-run`.',
    '',
    'Core tools:',
  ];

  for (const tool of CORE_TOOLS) {
    lines.push(`- \`${tool.usage}\` - ${tool.desc}`);
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- Prefer signatures first (`tl-symbols`) before full file reads.');
  lines.push('- Run `tl-impact <file>` before edits and `tl-guard` before commit.');
  lines.push('- Wrap noisy commands with `tl-run "<cmd>"`; use `--raw` only if needed.');
  lines.push('- Use `-t N` and `-l N` aggressively to cap context.');
  lines.push('- Use `-j` when output should be parsed or chained.');
  lines.push('- For docs, use `tl-context7 <lib> [query] -t N`.');

  const rest = tools.filter(t => !CORE_NAMES.has(t.name));
  if (rest.length > 0) {
    lines.push('');
    lines.push(`Also available (${rest.length} more): ${rest.map(t => `\`${t.name}\``).join(', ')}`);
  }

  return lines.join('\n');
}

function generateList(tools) {
  return tools.map(t => `${t.name}: ${t.desc}`).join('\n');
}

// Parse args
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
tl-prompt - Output AI agent instructions for tokenlean tools

Usage:
  tl-prompt              Full markdown instructions (tiered by value)
  tl-prompt --minimal    Compact version (for CLAUDE.md / .cursorrules)
  tl-prompt --codex      Codex-optimized markdown (for AGENTS.md)
  tl-prompt --codex --minimal  Compact Codex profile
  tl-prompt --list       Simple list of tools
  tl-prompt --json       Raw JSON data
  tl-prompt --help       Show this help

Integration examples:
  # Add to CLAUDE.md
  tl-prompt >> CLAUDE.md

  # Compact version for .cursorrules
  tl-prompt --minimal >> .cursorrules

  # Add Codex profile to AGENTS.md
  tl-prompt --codex >> AGENTS.md

  # Use in a hook (regenerate on session start)
  tl-prompt > .ai-tools.md
`);
  process.exit(0);
}

const tools = discoverTools();

if (tools.length === 0) {
  console.error('No tools found. Make sure tl-* commands are in the same directory.');
  process.exit(1);
}

if (args.includes('--json')) {
  console.log(JSON.stringify(tools, null, 2));
} else if (args.includes('--minimal') || args.includes('-m')) {
  if (args.includes('--codex')) {
    console.log(generateMinimalCodex(tools));
  } else {
    console.log(generateMinimal(tools));
  }
} else if (args.includes('--list') || args.includes('-l')) {
  console.log(generateList(tools));
} else {
  if (args.includes('--codex')) {
    console.log(generateFullCodex(tools));
  } else {
    console.log(generateFull(tools));
  }
}
