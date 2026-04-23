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
 * Supported tools: claude-code
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const HELP = `Usage: tl-hook <command> [options]

Token-saving hooks for AI coding agents.

Commands:
  run                    Process a tool call (reads JSON from stdin)
  install <tool>         Install hooks into a coding tool
  uninstall <tool>       Remove hooks from a coding tool
  status <tool>          Show current hook installation status

Supported tools:
  claude-code            Claude Code (~/.claude/settings.json)
  opencode               Open Code (~/.config/opencode/plugins/)

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
  tl-hook install opencode
  tl-hook status opencode`;

// --- Patterns (shared with tl-audit) ---

const BUILD_TEST_PATTERNS = [
  /\b(npm|yarn|pnpm|bun)\s+(test|run\s+test|run\s+build|run\s+lint)/,
  /\bnode\s+--test\b/,
  /\b(cargo|go)\s+(test|build|check|clippy)\b/,
  /\b(make|cmake)\b/,
  /\b(pytest|python\s+-m\s+(pytest|unittest))\b/,
  /\b(mvn|gradle)\s+(test|build|compile)\b/,
  /\b(dotnet)\s+(test|build)\b/,
  /\b(mix)\s+(test|compile)\b/,
  /\b(bundle\s+exec\s+r(spec|ake))\b/,
  /\btsc\b/,
  /\beslint\b/,
  /\bprettier\b/,
];

const TAIL_PATTERNS = [
  /^\s*tail\s+/,
];

const NON_CODE_EXTS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'lock', 'svg', 'html', 'css', 'log', 'env',
]);

const LARGE_FILE_BYTES = 12000; // ~300 lines of code

// --- Nudge dedup (once per type, re-nudge after TTL) ---

const NUDGE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

function nudgeOnce(key, message) {
  const p = getSeenPath();
  if (p) {
    const seen = loadSeen(p);
    if (seen[key] && (Date.now() - seen[key]) < NUDGE_TTL_MS) return;
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

function makeNudge(message) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: message,
    }
  });
}

async function runHook() {
  const input = await readStdin();
  if (!input.trim()) return;

  let data;
  try { data = JSON.parse(input); } catch { return; }

  const toolName = data.tool_name;
  const toolInput = data.tool_input || {};

  // --- Read on large code files ---
  if (toolName === 'Read') {
    const filePath = toolInput.file_path;
    if (!filePath) return;

    const ext = filePath.split('.').pop().toLowerCase();
    if (NON_CODE_EXTS.has(ext)) return;

    // Check file size
    let size;
    try { size = statSync(filePath).size; } catch { return; }

    if (size > LARGE_FILE_BYTES) {
      nudgeOnce('read-large', `[tl] ${Math.round(size / 1024)}KB — use tl-symbols + tl-snippet`);
    }
    return;
  }

  // --- Bash patterns ---
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';

    // Skip if already using tokenlean
    if (/\btl-/.test(cmd)) return;

    // Build/test commands
    if (BUILD_TEST_PATTERNS.some(p => p.test(cmd))) {
      nudgeOnce('bash-test', `[tl] wrap with tl-run`);
      return;
    }

    // Tail commands
    if (TAIL_PATTERNS.some(p => p.test(cmd))) {
      nudgeOnce('bash-tail', `[tl] use tl-tail instead`);
      return;
    }

    // cat — nudge to Read tool or tl-symbols
    if (/^\s*cat\s+[^|]/.test(cmd)) {
      nudgeOnce('bash-cat', `[tl] use Read tool, not cat`);
      return;
    }

    // head — nudge to Read with limit
    if (/^\s*head\s/.test(cmd)) {
      nudgeOnce('bash-head', `[tl] use Read with offset/limit`);
      return;
    }

    // curl on URLs (skip API calls with -X, -d, --data, -H with auth)
    if (/^\s*curl\s/.test(cmd) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(cmd)) {
      nudgeOnce('bash-curl', `[tl] use tl-browse instead`);
      return;
    }
  }

  // --- WebFetch — nudge to tl-browse ---
  if (toolName === 'WebFetch') {
    const url = toolInput.url || '';
    if (url) {
      nudgeOnce('webfetch', `[tl] use tl-browse instead`);
    }
    return;
  }
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

// --- Main ---

const TOOL_HANDLERS = {
  'claude-code': { install: installClaudeCode, uninstall: uninstallClaudeCode, status: statusClaudeCode },
  'opencode': { install: installOpenCode, uninstall: uninstallOpenCode, status: statusOpenCode },
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
    await runHook();
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
