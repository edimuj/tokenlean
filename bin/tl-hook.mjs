#!/usr/bin/env node

/**
 * tl-hook - Token-saving hooks for AI coding agents.
 *
 * Subcommands:
 *   tl-hook run          Read tool call JSON from stdin, output nudge (used by hooks)
 *   tl-hook install <tool>   Install hooks into a coding tool's config
 *   tl-hook uninstall <tool> Remove hooks from a coding tool's config
 *   tl-hook status <tool>    Show current hook status
 *
 * Supported tools: claude-code, codex, opencode
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { evaluateToolCall } from '../src/hook-policy.mjs';

const HELP = `Usage: tl-hook <command> [options]

Token-saving hooks for AI coding agents.

Commands:
  run                    Process a tool call (reads JSON from stdin)
  install <tool>         Install hooks into a coding tool
  uninstall <tool>       Remove hooks from a coding tool
  status <tool>          Show current hook installation status

Supported tools:
  claude-code            Claude Code (~/.claude/settings.json)
  codex                  Codex (~/.codex/hooks.json or ~/.Codex/hooks.json)
  opencode               Open Code (~/.config/opencode/plugins/)
  pi                     Pi (~/.pi/agent/extensions/tokenlean-hook.ts)

Options (claude-code only):
  --global               Install to ~/.claude/ (global user config)
  --rig <name>           Install to a specific claude-rig profile
  --all-rigs             Install to all claude-rig profiles

By default, claude-code auto-detects if running inside a claude-rig
session (via CLAUDE_CONFIG_DIR) and installs there. Falls back to --global.

Examples:
  tl-hook install claude-code
  tl-hook install claude-code --global
  tl-hook install claude-code --rig cli-node
  tl-hook install claude-code --all-rigs
  tl-hook install codex
  tl-hook status --all
  tl-hook install opencode
  tl-hook install pi
  tl-hook status pi
  tl-hook status opencode`;

// --- Nudge dedup (once per type, re-nudge after TTL) ---

const TTL_HIGH   =  5 * 60 * 1000;  // 5 min  — high-impact (large reads, curl)
const TTL_MEDIUM = 15 * 60 * 1000;  // 15 min — medium (grep, find, git, heredoc)
const TTL_LOW    = 30 * 60 * 1000;  // 30 min — low (test builds, tail)
const NUDGE_TTL_MS = TTL_LOW;       // kept for compatibility

function getSeenPath() {
  const port = process.env.CLAUDE_CODE_SSE_PORT;
  if (!port) return null;
  return join(tmpdir(), `tl-hook-${port}.seen`);
}

function loadSeen(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function statSyncSafe(path) {
  try { return statSync(path); } catch { return null; }
}

function nudgeOnce(key, message, ttl = NUDGE_TTL_MS) {
  const p = getSeenPath();
  if (p) {
    const seen = loadSeen(p);
    if (seen[key] && (Date.now() - seen[key]) < ttl) return;
    seen[key] = Date.now();
    writeFileSync(p, JSON.stringify(seen), 'utf8');
  }
  console.log(makeNudge(message));
}

// --- Hook runner ---

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    // Timeout after 1s in case stdin is empty
    setTimeout(() => resolve(data), 1000);
  });
}

function detectHookFormat(data) {
  const format = (process.env.TOKENLEAN_HOOK_FORMAT || '').toLowerCase();
  if (format === 'codex' || format === 'claude' || format === 'pi') return format;
  if (process.env.PI_CODING_AGENT) return 'pi';
  if (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_PROJECT_DIR) return 'claude';
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_CI) return 'codex';
  // Detect codex from payload transcript path when env vars aren't set
  if (data?.transcript_path?.includes('/.codex/')) return 'codex';
  return 'claude';
}

function makeNudge(message) {
  // Both Claude Code and Codex use the same hookSpecificOutput format
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: message,
    }
  });
}

function resolveCodexConfigDir() {
  const candidates = [
    join(homedir(), '.Codex'),
    join(homedir(), '.codex'),
  ];

  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {}
  }

  return candidates[0];
}

function getCodexHooksPath() {
  return join(resolveCodexConfigDir(), 'hooks.json');
}

function buildCodexHookConfig() {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'tl-hook run', timeout: 3 }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'tl-hook run', timeout: 3 }],
        },
        {
          matcher: 'WebFetch',
          hooks: [{ type: 'command', command: 'tl-hook run', timeout: 3 }],
        },
      ],
    },
  };
}

async function runHook({ json = false } = {}) {
  const input = await readStdin();
  if (!input.trim()) return;

  let data;
  try { data = JSON.parse(input); } catch { return; }

  const decision = evaluateToolCall(data);
  if (json) {
    console.log(JSON.stringify({ decision }, null, 2));
    return;
  }

  if (decision) nudgeOnce(decision.id, decision.message);
}

// --- Claude Code installer ---

function listAllRigs() {
  const rigsDir = join(homedir(), '.claude-rig', 'rigs');
  try {
    return readdirSync(rigsDir).filter(name => {
      try { return statSync(join(rigsDir, name)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

function resolveClaudeConfigDir(args) {
  const globalDir = join(homedir(), '.claude');

  // Explicit --global flag
  if (args.includes('--global')) {
    try { statSync(globalDir); } catch {
      console.error('Claude Code is not installed (~/.claude not found).');
      console.error('Currently only Claude Code is supported.');
      process.exit(1);
    }
    return { configDir: globalDir, label: 'global (~/.claude)' };
  }

  // Explicit --rig <name>
  const rigIdx = args.indexOf('--rig');
  if (rigIdx !== -1) {
    const rigName = args[rigIdx + 1];
    if (!rigName || rigName.startsWith('-')) {
      console.error('Missing rig name. Usage: --rig <name>');
      process.exit(1);
    }
    const rigDir = join(homedir(), '.claude-rig', 'rigs', rigName);
    try {
      statSync(rigDir);
    } catch {
      // Check if claude-rig is installed (rigs dir exists)
      try {
        statSync(join(homedir(), '.claude-rig', 'rigs'));
      } catch {
        console.error(`claude-rig is not installed. --rig requires claude-rig.`);
        console.error(`Install it from: https://github.com/edimuj/claude-rig`);
        process.exit(1);
      }
      console.error(`Rig "${rigName}" not found at ${rigDir}`);
      process.exit(1);
    }
    return { configDir: rigDir, label: `rig "${rigName}"` };
  }

  // Auto-detect: CLAUDE_CONFIG_DIR set by claude-rig
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) {
    // Extract rig name from path for display
    const rigMatch = envDir.match(/\.claude-rig\/rigs\/([^/]+)/);
    const label = rigMatch ? `rig "${rigMatch[1]}" (auto-detected)` : envDir;
    return { configDir: envDir, label };
  }

  // Default: global
  try { statSync(globalDir); } catch {
    console.error('Claude Code is not installed (~/.claude not found).');
    console.error('Currently only Claude Code is supported.');
    process.exit(1);
  }
  return { configDir: globalDir, label: 'global (~/.claude)' };
}

function buildHookConfig() {
  return {
    PreToolUse: [
      {
        matcher: 'Read',
        hooks: [{
          type: 'command',
          command: 'tl-hook run',
          timeout: 3000,
        }],
      },
      {
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'tl-hook run',
          timeout: 3000,
        }],
      },
      {
        matcher: 'WebFetch',
        hooks: [{
          type: 'command',
          command: 'tl-hook run',
          timeout: 3000,
        }],
      },
    ],
  };
}

function buildCodexManagedBlock({ includeFeatureFlag = true } = {}) {
  const lines = [
    '# tokenlean hooks: begin',
  ];
  if (includeFeatureFlag) {
    lines.push('features.codex_hooks = true');
    lines.push('');
  }

  for (const group of buildHookConfig().PreToolUse) {
    lines.push('[[hooks.PreToolUse]]');
    lines.push(`matcher = ${JSON.stringify(group.matcher)}`);
    for (const hook of group.hooks) {
      lines.push('');
      lines.push('[[hooks.PreToolUse.hooks]]');
      lines.push(`type = ${JSON.stringify(hook.type)}`);
      lines.push(`command = ${JSON.stringify(hook.command)}`);
      lines.push(`timeout = ${hook.timeout}`);
    }
    lines.push('');
  }

  lines.push('# tokenlean hooks: end');
  return lines.join('\n');
}

function stripManagedCodexBlock(content) {
  return content
    .replace(/\n?# tokenlean hooks: begin\n[\s\S]*?# tokenlean hooks: end\n?/g, '\n')
    .replace(/^\s*codex_hooks\s*=\s*true\s+# tokenlean-managed\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

function hasCodexHooksFeatureSetting(content) {
  return /(^|\n)\s*(features\.)?codex_hooks\s*=/.test(content);
}

function hasFeaturesTable(content) {
  return /(^|\n)\s*\[features\]\s*(?:#.*)?(\n|$)/.test(content);
}

function hasDisabledCodexHooksFeature(content) {
  return /(^|\n)\s*(features\.)?codex_hooks\s*=\s*false\b/.test(content);
}

function addManagedFeatureTableSetting(content) {
  return content.replace(
    /(^|\n)(\s*\[features\]\s*(?:#.*)?\n)/,
    `$1$2codex_hooks = true # tokenlean-managed\n`
  );
}

async function loadSettings(path) {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveSettings(path, settings) {
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function isTokenleanHook(hookEntry) {
  return hookEntry?.hooks?.some(h => h.command?.includes('tl-hook'));
}

async function installClaudeCode(configDir, label) {
  const settingsPath = join(configDir, 'settings.json');
  const settings = await loadSettings(settingsPath);

  if (!settings.hooks) settings.hooks = {};

  const hookConfig = buildHookConfig();

  for (const [event, matchers] of Object.entries(hookConfig)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    for (const newMatcher of matchers) {
      // Remove any existing tokenlean hook for this matcher
      settings.hooks[event] = settings.hooks[event].filter(
        existing => !(existing.matcher === newMatcher.matcher && isTokenleanHook(existing))
      );
      // Add the new one
      settings.hooks[event].push(newMatcher);
    }
  }

  await saveSettings(settingsPath, settings);
  console.log(`Installed tokenlean hooks into Claude Code [${label}].`);
  console.log(`  Config: ${settingsPath}`);
  console.log('  Hooks: PreToolUse (Read, Bash, WebFetch)');
  console.log('');
  console.log('The agent will now receive token-saving suggestions when:');
  console.log('  - Reading large code files (>300 lines) — use tl-symbols/tl-snippet');
  console.log('  - Running build/test commands — use tl-run');
  console.log('  - Using tail — use tl-tail');
  console.log('  - Using cat/head via Bash — use Read tool');
  console.log('  - Using curl on URLs — use tl-browse');
  console.log('  - Using WebFetch — use tl-browse');
}

async function uninstallClaudeCode(configDir, label) {
  const settingsPath = join(configDir, 'settings.json');
  const settings = await loadSettings(settingsPath);

  if (!settings.hooks) {
    console.log(`No hooks configured in Claude Code [${label}].`);
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(entry => !isTokenleanHook(entry));
    removed += before - settings.hooks[event].length;

    // Clean up empty arrays
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await saveSettings(settingsPath, settings);

  if (removed > 0) {
    console.log(`Removed ${removed} tokenlean hook(s) from Claude Code [${label}].`);
  } else {
    console.log(`No tokenlean hooks found in Claude Code [${label}].`);
  }
}

async function statusClaudeCode(configDir, label) {
  const settingsPath = join(configDir, 'settings.json');
  const settings = await loadSettings(settingsPath);

  console.log(`Claude Code [${label}]`);
  console.log(`  Config: ${settingsPath}`);

  const hooks = settings.hooks || {};
  let found = 0;

  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of matchers) {
      if (isTokenleanHook(matcher)) {
        found++;
        console.log(`  [active] ${event} (${matcher.matcher || '*'})`);
      }
    }
  }

  if (found === 0) {
    console.log('  No tokenlean hooks installed.');
    console.log('  Run: tl-hook install claude-code');
  } else {
    console.log(`  ${found} hook(s) active.`);
  }
}

// --- Codex installer ---

async function installCodex() {
  const configDir = resolveCodexConfigDir();
  await mkdir(configDir, { recursive: true });

  const hooksPath = getCodexHooksPath();
  const settings = await loadSettings(hooksPath);
  const hookConfig = buildCodexHookConfig();

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

  for (const newMatcher of hookConfig.hooks.PreToolUse) {
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
      existing => !(existing.matcher === newMatcher.matcher && isTokenleanHook(existing))
    );
    settings.hooks.PreToolUse.push(newMatcher);
  }

  await saveSettings(hooksPath, settings);
  console.log('Installed tokenlean hooks into Codex.');
  console.log(`  Config: ${hooksPath}`);
  console.log('  Hooks: PreToolUse (Read, Bash, WebFetch)');
}

async function uninstallCodex() {
  const hooksPath = getCodexHooksPath();
  const settings = await loadSettings(hooksPath);

  if (!settings.hooks) {
    console.log('No hooks configured in Codex.');
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const filtered = entries.filter(entry => !isTokenleanHook(entry));
    removed += entries.length - filtered.length;

    if (filtered.length > 0) settings.hooks[event] = filtered;
    else delete settings.hooks[event];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await saveSettings(hooksPath, settings);

  if (removed > 0) console.log(`Removed ${removed} tokenlean hook(s) from Codex.`);
  else console.log('No tokenlean hooks found in Codex.');
}

async function statusCodex() {
  const hooksPath = getCodexHooksPath();
  const settings = await loadSettings(hooksPath);

  console.log('Codex');
  console.log(`  Config: ${hooksPath}`);

  const hooks = settings.hooks || {};
  const matchers = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const active = matchers.filter(isTokenleanHook);

  if (active.length === 0) {
    console.log('  No tokenlean hooks installed.');
    console.log('  Run: tl-hook install codex');
    return;
  }

  for (const matcher of active) {
    console.log(`  [active] PreToolUse (${matcher.matcher || '*'})`);
  }
  console.log(`  ${active.length} hook(s) active.`);
}

// --- Open Code installer ---

const __dirname = dirname(fileURLToPath(import.meta.url));

function getOpenCodePluginPath() {
  return join(homedir(), '.config', 'opencode', 'plugins', 'tokenlean.js');
}

async function installOpenCode() {
  const configDir = join(homedir(), '.config', 'opencode');
  try { statSync(configDir); } catch {
    console.error('Open Code is not installed (~/.config/opencode not found).');
    console.error('Install it from: https://opencode.ai');
    process.exit(1);
  }

  const pluginDir = join(configDir, 'plugins');
  await mkdir(pluginDir, { recursive: true });

  const templatePath = join(__dirname, '..', 'src', 'opencode-plugin.js');
  const content = await readFile(templatePath, 'utf8');
  const pluginPath = getOpenCodePluginPath();
  await writeFile(pluginPath, content, 'utf8');

  console.log('Installed tokenlean plugin into Open Code.');
  console.log(`  Plugin: ${pluginPath}`);
  console.log('');
  console.log('The plugin will automatically:');
  console.log('  - Wrap build/test commands with tl-run (~65% output compression)');
  console.log('  - Replace curl with tl-browse (clean markdown output)');
}

async function uninstallOpenCode() {
  const pluginPath = getOpenCodePluginPath();
  try {
    await unlink(pluginPath);
    console.log('Removed tokenlean plugin from Open Code.');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No tokenlean plugin found in Open Code.');
    } else {
      throw err;
    }
  }
}

async function statusOpenCode() {
  const pluginPath = getOpenCodePluginPath();
  console.log('Open Code');
  console.log(`  Plugin: ${pluginPath}`);
  try {
    statSync(pluginPath);
    console.log('  [active] tokenlean plugin installed');
  } catch {
    console.log('  Not installed.');
    console.log('  Run: tl-hook install opencode');
  }
}

// --- Pi installer ---

function getPiExtensionPath() {
  return join(homedir(), '.pi', 'agent', 'extensions', 'tokenlean-hook.ts');
}

async function installPi() {
  const piDir = join(homedir(), '.pi');
  try { statSync(piDir); } catch {
    console.error('Pi is not installed (~/.pi not found).');
    console.error('Install it from: https://shittycodingagent.ai');
    process.exit(1);
  }

  const extensionDir = join(piDir, 'agent', 'extensions');
  await mkdir(extensionDir, { recursive: true });

  const templatePath = join(__dirname, '..', 'src', 'pi-extension.ts');
  const content = await readFile(templatePath, 'utf8');
  const extensionPath = getPiExtensionPath();
  await writeFile(extensionPath, content, 'utf8');

  console.log('Installed tokenlean extension into Pi.');
  console.log(`  Extension: ${extensionPath}`);
  console.log('  Hooks: tool_call (bash, read, webfetch)');
  console.log('');
  console.log('Restart Pi to activate.');
}

async function uninstallPi() {
  const extensionPath = getPiExtensionPath();
  try {
    await unlink(extensionPath);
    console.log('Removed tokenlean extension from Pi.');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No tokenlean extension found in Pi.');
    } else {
      throw err;
    }
  }
}

async function statusPi() {
  const extensionPath = getPiExtensionPath();
  console.log('Pi');
  console.log(`  Extension: ${extensionPath}`);
  try {
    statSync(extensionPath);
    console.log('  [active] tokenlean extension installed');
  } catch {
    console.log('  Not installed.');
    console.log('  Run: tl-hook install pi');
  }
}

// --- Main ---

const TOOL_HANDLERS = {
  'claude-code': { install: installClaudeCode, uninstall: uninstallClaudeCode, status: statusClaudeCode },
  'codex': { install: installCodex, uninstall: uninstallCodex, status: statusCodex },
  'opencode': { install: installOpenCode, uninstall: uninstallOpenCode, status: statusOpenCode },
  'pi': { install: installPi, uninstall: uninstallPi, status: statusPi },
};

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  const tool = args[1];

  if (command === 'run') {
    await runHook({ json: args.includes('-j') || args.includes('--json') });
    return;
  }

  if (command === 'status' && tool === '--all') {
    const claudeDir = join(homedir(), '.claude');
    if (statSyncSafe(claudeDir)?.isDirectory()) {
      await statusClaudeCode(claudeDir, 'global (~/.claude)');
    } else {
      console.log('Claude Code [global (~/.claude)]');
      console.log('  Not installed.');
      console.log('  Run: tl-hook install claude-code');
    }
    console.log('');
    await statusCodex();
    console.log('');
    await statusOpenCode();
    return;
  }

  if (!tool) {
    console.error(`Missing tool argument. Supported: ${Object.keys(TOOL_HANDLERS).join(', ')}`);
    process.exit(1);
  }

  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    console.error(`Unknown tool: ${tool}. Supported: ${Object.keys(TOOL_HANDLERS).join(', ')}`);
    process.exit(1);
  }

  // Claude Code needs config dir resolution (--global, --rig, --all-rigs, auto-detect)
  if (tool === 'claude-code') {
    if (!['install', 'uninstall', 'status'].includes(command)) {
      console.error(`Unknown command: ${command}. Use install, uninstall, status, or run.`);
      process.exit(1);
    }

    if (args.includes('--all-rigs')) {
      const rigs = listAllRigs();
      if (rigs.length === 0) {
        console.error('No claude-rig profiles found.');
        console.error('Install claude-rig from: https://github.com/edimuj/claude-rig');
        process.exit(1);
      }
      const rigsDir = join(homedir(), '.claude-rig', 'rigs');
      for (const name of rigs) {
        await handler[command](join(rigsDir, name), `rig "${name}"`);
        console.log('');
      }
    } else {
      const { configDir, label } = resolveClaudeConfigDir(args);
      await handler[command](configDir, label);
    }
  } else {
    if (command === 'install') await handler.install();
    else if (command === 'uninstall') await handler.uninstall();
    else if (command === 'status') await handler.status();
    else {
      console.error(`Unknown command: ${command}. Use install, uninstall, status, or run.`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
