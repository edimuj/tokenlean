#!/usr/bin/env node

/**
 * tl - Tokenlean global CLI entry point
 *
 * Usage: tl <command> [options]
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const BIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const CONFIG_PATH = join(process.cwd(), '.tokenleanrc.json');
const HOOK_SCRIPT = join(BIN_DIR, 'tl-hook.mjs');
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function truncate(text, max = 60) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function readToolMetadata(fileName) {
  const content = readFileSync(join(BIN_DIR, fileName), 'utf8');
  const match = content.match(/^\s*\*\s+(tl-[\w-]+)\s+-\s+(.+)$/m);
  if (!match) return null;
  return { name: match[1], desc: match[2].trim().replace(/\.$/, '') };
}

function listTools() {
  return readdirSync(BIN_DIR)
    .filter(name => /^tl-[\w-]+\.mjs$/.test(name))
    .map(readToolMetadata)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatRows(rows, width) {
  return rows.map(({ name, desc }) => `  ${name.padEnd(width)}${desc}`).join('\n');
}

function printHelp() {
  const commands = [{ name: 'tl doctor', desc: 'Check environment health' }, { name: 'tl update', desc: 'Update tokenlean to latest version' }];
  const tools = listTools().map(({ name, desc }) => ({ name, desc: truncate(desc) }));
  const width = Math.max(...commands.map(row => row.name.length), ...tools.map(row => row.name.length)) + 2;
  console.log([
    `tokenlean v${version} — CLI tools for AI agents`,
    '',
    'Usage: tl <command|tool> [options]',
    '',
    'Commands:',
    formatRows(commands, width),
    '',
    'Tools:',
    formatRows(tools, width),
    '',
    'Run tl <tool> --help or tl-<tool> --help for tool-specific help.'
  ].join('\n'));
}

function resolveToolFile(command) {
  const normalized = command.startsWith('tl-') ? command : `tl-${command}`;
  const file = join(BIN_DIR, `${normalized}.mjs`);
  return existsSync(file) ? file : null;
}

function runTool(toolFile, args) {
  const child = spawn(process.execPath, [toolFile, ...args], { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
}

function captureCommand(file, args) {
  try {
    return {
      ok: true,
      output: execFileSync(file, args, { encoding: 'utf8' }).trim()
    };
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    if (error.status === 0) return { ok: true, output };
    return { ok: false, output, error };
  }
}

function versionLine(file, args, label, pattern) {
  const result = captureCommand(file, args);
  if (!result.ok) return { kind: 'fail', text: `${label}: not found` };
  const firstLine = result.output.split('\n')[0] || '';
  const match = firstLine.match(pattern);
  return { kind: 'pass', text: `${label} ${match ? match[1] : firstLine.trim()}` };
}

function countActiveClaudeHooks() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || (existsSync(join(homedir(), '.claude')) ? join(homedir(), '.claude') : '');
  if (!configDir) return null;
  const settingsPath = join(configDir, 'settings.json');
  if (!existsSync(settingsPath)) return 0;
  try {
    const hooks = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks || {};
    return Object.values(hooks)
      .flatMap(entries => Array.isArray(entries) ? entries : [])
      .filter(entry => entry?.hooks?.some(hook => hook.command?.includes('tl-hook'))).length;
  } catch {
    return -1;
  }
}

function fileContains(path, pattern) {
  if (!existsSync(path)) return false;
  try {
    return pattern.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

function countSkillDirs(path) {
  if (!existsSync(path)) return null;
  try {
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
  } catch {
    return -1;
  }
}

function addAgentChecks(results) {
  const home = homedir();
  const projectMcp = join(process.cwd(), '.mcp.json');
  const codexConfig = join(home, '.codex', 'config.toml');
  const claudeSettings = join(home, '.claude', 'settings.json');
  const agentsPath = join(process.cwd(), 'AGENTS.md');
  const claudePath = join(process.cwd(), 'CLAUDE.md');
  const codexSkills = join(home, '.codex', 'skills');
  const claudeSkills = join(home, '.claude', 'skills');

  results.push({ kind: 'pass', text: `tokenlean CLI: ${version}` });

  if (fileContains(projectMcp, /tokenlean|tl-mcp|tl\s+mcp/i)) {
    results.push({ kind: 'pass', text: 'project MCP: tokenlean configured (.mcp.json)' });
  } else {
    results.push({ kind: 'warn', text: 'project MCP: tokenlean not found in .mcp.json' });
  }

  if (fileContains(codexConfig, /tokenlean|tl-mcp|tl\s+mcp/i)) {
    results.push({ kind: 'pass', text: 'Codex MCP/config: tokenlean reference found' });
  } else if (existsSync(codexConfig)) {
    results.push({ kind: 'warn', text: 'Codex MCP/config: no tokenlean reference in ~/.codex/config.toml' });
  } else {
    results.push({ kind: 'skip', text: 'Codex MCP/config: ~/.codex/config.toml not found' });
  }

  if (fileContains(claudeSettings, /tl-hook|tokenlean|tl-mcp|tl\s+mcp/i)) {
    results.push({ kind: 'pass', text: 'Claude settings: tokenlean reference found' });
  } else if (existsSync(claudeSettings)) {
    results.push({ kind: 'warn', text: 'Claude settings: no tokenlean reference in ~/.claude/settings.json' });
  } else {
    results.push({ kind: 'skip', text: 'Claude settings: ~/.claude/settings.json not found' });
  }

  if (fileContains(agentsPath, /tokenlean|tl\s|tl-/i)) {
    results.push({ kind: 'pass', text: 'project AGENTS.md: tokenlean guidance found' });
  } else if (existsSync(agentsPath)) {
    results.push({ kind: 'warn', text: 'project AGENTS.md: no tokenlean guidance found' });
  } else {
    results.push({ kind: 'skip', text: 'project AGENTS.md: not found' });
  }

  if (fileContains(claudePath, /tokenlean|tl\s|tl-/i)) {
    results.push({ kind: 'pass', text: 'project CLAUDE.md: tokenlean guidance found' });
  } else if (existsSync(claudePath)) {
    results.push({ kind: 'warn', text: 'project CLAUDE.md: no tokenlean guidance found' });
  } else {
    results.push({ kind: 'skip', text: 'project CLAUDE.md: not found' });
  }

  const codexSkillCount = countSkillDirs(codexSkills);
  if (codexSkillCount > 0) {
    results.push({ kind: 'pass', text: `Codex skills: ${codexSkillCount} installed` });
  } else if (codexSkillCount === 0) {
    results.push({ kind: 'warn', text: 'Codex skills: none installed in ~/.codex/skills' });
  } else {
    results.push({ kind: 'skip', text: 'Codex skills: ~/.codex/skills not found' });
  }

  const claudeSkillCount = countSkillDirs(claudeSkills);
  if (claudeSkillCount > 0) {
    results.push({ kind: 'pass', text: `Claude skills: ${claudeSkillCount} installed` });
  } else if (claudeSkillCount === 0) {
    results.push({ kind: 'warn', text: 'Claude skills: none installed in ~/.claude/skills' });
  } else {
    results.push({ kind: 'skip', text: 'Claude skills: ~/.claude/skills not found' });
  }
}

function runDoctor({ agents = false } = {}) {
  const results = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  results.push(
    nodeMajor >= 24
      ? { kind: 'pass', text: `Node.js ${process.version}` }
      : { kind: 'warn', text: `Node.js ${process.version} (recommended >= 24)` }
  );

  results.push(versionLine('rg', ['--version'], 'ripgrep', /^ripgrep\s+([^\s]+)/));
  results.push(versionLine('git', ['--version'], 'git', /^git version\s+(.+)$/));

  const hooks = captureCommand(process.execPath, [HOOK_SCRIPT, 'status', 'claude-code']);
  let activeHooks = (hooks.output.match(/^\s*\[active\]/gm) || []).length;
  if (!activeHooks && hooks.ok && !hooks.output) activeHooks = countActiveClaudeHooks();
  if (activeHooks > 0) {
    results.push({ kind: 'pass', text: `tokenlean hooks: ${activeHooks} active (claude-code)` });
  } else if (
    activeHooks === 0 ||
    activeHooks === null ||
    hooks.ok ||
    /not installed|\.claude not found|Run: tl-hook install claude-code/i.test(hooks.output)
  ) {
    results.push({ kind: 'warn', text: 'tokenlean hooks: not installed (claude-code)' });
  } else {
    results.push({ kind: 'fail', text: 'tokenlean hooks: check failed' });
  }

  if (!existsSync(CONFIG_PATH)) {
    results.push({ kind: 'skip', text: 'config: no .tokenleanrc.json in current directory' });
  } else {
    try {
      JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      results.push({ kind: 'pass', text: 'config: .tokenleanrc.json is valid JSON' });
    } catch {
      results.push({ kind: 'fail', text: 'config: invalid .tokenleanrc.json' });
    }
  }

  if (agents) {
    addAgentChecks(results);
  }

  const symbols = { pass: '✓', warn: '⚠', fail: '✗', skip: '-' };
  const counts = { pass: 0, warn: 0, fail: 0 };
  console.log(`tokenlean v${version} doctor${agents ? ' --agents' : ''}\n`);
  for (const result of results) {
    if (result.kind in counts) counts[result.kind]++;
    console.log(`  ${symbols[result.kind]} ${result.text}`);
  }

  const summary = [`${counts.pass} checks passed`, `${counts.warn} warnings`];
  if (counts.fail > 0) summary.push(`${counts.fail} failed`);
  console.log(`\n${summary.join(', ')}`);
  process.exit(counts.fail > 0 ? 1 : 0);
}

function runUpdate() {
  const child = spawn(NPM_BIN, ['update', '-g', 'tokenlean'], { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
}

function extractFlags(command) {
  const toolFile = resolveToolFile(command);
  if (!toolFile) return [];

  const source = readFileSync(toolFile, 'utf8');
  const flags = new Set();
  const re = /['"](-{1,2}[a-zA-Z][\w-]*)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) flags.add(m[1]);

  // Include common flags if tool uses parseCommonArgs
  if (/parseCommonArgs|COMMON_OPTIONS_HELP/.test(source)) {
    for (const f of ['-l', '--max-lines', '-t', '--max-tokens', '-j', '--json', '-q', '--quiet', '-h', '--help']) {
      flags.add(f);
    }
  }

  return [...flags].sort();
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    printHelp();
    return;
  }

  if (command === '-v' || command === '--version') {
    console.log(version);
    return;
  }

  if (command === '--list-commands') {
    const withDesc = rest.includes('--with-desc');
    const builtins = [
      { name: 'doctor', desc: 'Check environment health' },
      { name: 'update', desc: 'Update tokenlean to latest version' }
    ];
    const tools = listTools().map(({ name, desc }) => ({
      name: name.replace(/^tl-/, ''), desc
    }));
    const all = [...builtins, ...tools].sort((a, b) => a.name.localeCompare(b.name));
    for (const { name, desc } of all) {
      console.log(withDesc ? `${name}\t${desc}` : name);
    }
    return;
  }

  if (command === '--list-flags') {
    const target = rest[0];
    if (!target) { process.exit(1); }
    const flags = extractFlags(target);
    if (flags.length) console.log(flags.join('\n'));
    return;
  }

  if (command === 'doctor') {
    runDoctor({ agents: rest.includes('--agents') });
    return;
  }

  if (command === 'update') {
    runUpdate();
    return;
  }

  const toolFile = resolveToolFile(command);
  if (toolFile) {
    runTool(toolFile, rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run tl --help for usage.');
  process.exit(1);
}

main();
