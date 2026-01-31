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

  const files = readdirSync(binDir)
    .filter(f => f.startsWith('tl-') && f.endsWith('.mjs') && f !== 'tl-prompt.mjs');

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
### Tips

- Prefer \`tl-symbols\` over reading entire files when you only need signatures
- Use \`tl-impact\` before refactoring to understand dependencies
- Check \`tl-context\` to avoid reading unnecessarily large files
- All tools support \`--help\` for more options
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
  lines.push('Prefer `tl-symbols` over reading full files. Use `--help` on any command.');

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
