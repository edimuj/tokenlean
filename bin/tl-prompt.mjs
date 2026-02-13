#!/usr/bin/env node

/**
 * tl-prompt - Output AI agent instructions for tokenlean tools
 *
 * Dynamically discovers all tl-* commands and generates instructions
 * by calling each with --prompt flag.
 *
 * Usage:
 *   tl-prompt                 # Full instructions (markdown)
 *   tl-prompt --minimal       # Compact version
 *   tl-prompt --list          # Simple list
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prompt info for tl-prompt (meta!)
if (process.argv.includes('--prompt')) {
  process.exit(0);  // No output - this IS the prompt tool
}

/**
 * Discover all tl-* tools and get their prompt info
 */
function discoverTools() {
  const tools = [];
  const binDir = __dirname;

  // Tools excluded from prompt output (low-value or deprecated)
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
        const info = JSON.parse(result);
        tools.push(info);
      }
    } catch (e) {
      // Tool doesn't support --prompt or errored - skip it
    }
  }

  return tools;
}

/**
 * Group tools by their 'when' category
 */
function groupTools(tools) {
  const groups = {
    'before-read': { title: 'Before Reading Files', tools: [] },
    'before-modify': { title: 'Before Modifying Files', tools: [] },
    'search': { title: 'Searching', tools: [] }
  };

  for (const tool of tools) {
    const group = groups[tool.when] || groups['search'];
    group.tools.push(tool);
  }

  return groups;
}

function generateFull(tools) {
  const groups = groupTools(tools);

  let output = `## tokenlean CLI Tools

Use these tools to explore the codebase efficiently and save context tokens.
`;

  for (const [key, group] of Object.entries(groups)) {
    if (group.tools.length === 0) continue;

    output += `
### ${group.title}

| Command | Purpose |
|---------|---------|
`;
    for (const tool of group.tools) {
      output += `| \`${tool.name}\` | ${tool.desc} |\n`;
    }
  }

  output += `
### Rules

- **Before reading a source file**, run \`tl-symbols <file>\` first to see signatures. Only read the full file if you need implementation details.
- **Before modifying a file**, run \`tl-impact <file>\` to understand what depends on it and what might break.
- **Before committing**, run \`tl-guard\` to catch secrets, new TODOs, unused exports, and circular dependencies.
- **When running tests, builds, or linters**, wrap with \`tl-run "<command>"\` instead of running directly — it extracts only errors and key output.
- **When exploring an unfamiliar codebase**, start with \`tl-structure\` before diving into files.
- **Before reading a large file**, check \`tl-context <file>\` — if it's over 1000 tokens, use \`tl-symbols\` or \`tl-snippet <name>\` instead.

### Tips

- All tools support \`-j\` (JSON), \`-q\` (quiet), \`-l N\` (limit lines), \`-t N\` (limit tokens), and \`--help\`
- Use \`tl-analyze <file>\` for a composite profile (symbols + deps + impact + complexity + related) in one call
`;

  return output;
}

function generateMinimal(tools) {
  const groups = groupTools(tools);

  let lines = ['## tokenlean Tools', ''];

  for (const [key, group] of Object.entries(groups)) {
    if (group.tools.length === 0) continue;

    const names = group.tools.map(t => `\`${t.name}\``).join(', ');
    const label = group.title.replace(' Files', '').toLowerCase();
    lines.push(`${label}: ${names}`);
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- Before reading a source file, run `tl-symbols <file>` first. Only read the full file if you need implementation details.');
  lines.push('- Before modifying a file, run `tl-impact <file>` to check what depends on it.');
  lines.push('- Before committing, run `tl-guard` to catch secrets, TODOs, unused exports, and circular deps.');
  lines.push('- Wrap test/build/lint commands with `tl-run "<cmd>"` for token-efficient output.');
  lines.push('- For large files (>1000 tokens), use `tl-symbols` or `tl-snippet <name>` instead of reading.');
  lines.push('- All tools support `-j` (JSON), `-q` (quiet), `-l N` (limit lines), `--help`.');

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
  tl-prompt              Full markdown instructions
  tl-prompt --minimal    Compact version (fewer tokens)
  tl-prompt --list       Simple list of tools
  tl-prompt --json       Raw JSON data
  tl-prompt --help       Show this help

Integration examples:
  # Add to CLAUDE.md
  tl-prompt >> CLAUDE.md

  # Add to .cursorrules
  tl-prompt --minimal >> .cursorrules

  # Use in a hook (regenerate on session start)
  tl-prompt > .ai-tools.md
`);
  process.exit(0);
}

// Discover tools dynamically
const tools = discoverTools();

if (tools.length === 0) {
  console.error('No tools found. Make sure tl-* commands are in the same directory.');
  process.exit(1);
}

if (args.includes('--json')) {
  console.log(JSON.stringify(tools, null, 2));
} else if (args.includes('--minimal') || args.includes('-m')) {
  console.log(generateMinimal(tools));
} else if (args.includes('--list') || args.includes('-l')) {
  console.log(generateList(tools));
} else {
  console.log(generateFull(tools));
}
