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

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HELP = `Usage: tl-hook <command> [options]

Token-saving hooks for AI coding agents.

Commands:
  run                    Process a tool call (reads JSON from stdin)
  install <tool>         Install hooks into a coding tool
  uninstall <tool>       Remove hooks from a coding tool
  status <tool>          Show current hook installation status

Supported tools:
  claude-code            Claude Code (~/.claude/settings.json)

Options:
  -h, --help             Show help

Examples:
  tl-hook install claude-code
  tl-hook uninstall claude-code
  tl-hook status claude-code`;

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

const LARGE_FILE_THRESHOLD = 300;

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
    let lineCount = 0;
    try {
      const result = execFileSync('wc', ['-l', filePath], { encoding: 'utf8', timeout: 2000 });
      lineCount = parseInt(result.trim().split(/\s/)[0], 10) || 0;
    } catch { return; }

    if (lineCount > LARGE_FILE_THRESHOLD) {
      console.log(makeNudge(
        `[tokenlean] This file has ${lineCount} lines. Consider: tl-symbols ${filePath} for structure overview, then tl-snippet <name> ${filePath} for specific functions.`
      ));
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
      const shortCmd = cmd.split('\n')[0].slice(0, 80);
      console.log(makeNudge(
        `[tokenlean] Consider: tl-run "${shortCmd}" — compresses build/test output ~65%, saving tokens.`
      ));
      return;
    }

    // Tail commands
    if (TAIL_PATTERNS.some(p => p.test(cmd))) {
      console.log(makeNudge(
        `[tokenlean] Consider: tl-tail — collapses repeated lines and summarizes log output, saving ~70% tokens.`
      ));
      return;
    }

    // grep/rg/ag — nudge to built-in Grep tool
    if (/^\s*(grep|rg|ag)\s/.test(cmd)) {
      console.log(makeNudge(
        `[tokenlean] Consider using the Grep tool instead of ${cmd.trim().split(/\s/)[0]} via Bash — better integration, avoids shell overhead.`
      ));
      return;
    }

    // cat — nudge to Read tool or tl-symbols
    if (/^\s*cat\s+[^|]/.test(cmd)) {
      console.log(makeNudge(
        `[tokenlean] Consider using the Read tool instead of cat via Bash. For large code files, use tl-symbols for structure overview.`
      ));
      return;
    }

    // head — nudge to Read with limit
    if (/^\s*head\s/.test(cmd)) {
      console.log(makeNudge(
        `[tokenlean] Consider using the Read tool with offset/limit parameters instead of head via Bash.`
      ));
      return;
    }

    // find/fd — nudge to Glob tool
    if (/^\s*(find|fd)\s/.test(cmd)) {
      console.log(makeNudge(
        `[tokenlean] Consider using the Glob tool instead of ${cmd.trim().split(/\s/)[0]} via Bash — faster and better integrated.`
      ));
      return;
    }

    // curl on URLs (skip API calls with -X, -d, --data, -H with auth)
    if (/^\s*curl\s/.test(cmd) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(cmd)) {
      console.log(makeNudge(
        `[tokenlean] Consider: tl-browse <url> — fetches as clean markdown with far fewer tokens than raw curl output.`
      ));
      return;
    }
  }

  // --- WebFetch — nudge to tl-browse ---
  if (toolName === 'WebFetch') {
    const url = toolInput.url || '';
    if (url) {
      console.log(makeNudge(
        `[tokenlean] Consider: tl-browse "${url}" — returns clean markdown, typically 60-80% fewer tokens than WebFetch.`
      ));
    }
    return;
  }
}

// --- Claude Code installer ---

function getClaudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

const HOOK_MARKER = 'tokenlean';

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

async function installClaudeCode() {
  const settingsPath = getClaudeSettingsPath();
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
  console.log('Installed tokenlean hooks into Claude Code.');
  console.log(`  Config: ${settingsPath}`);
  console.log('  Hooks: PreToolUse (Read, Bash, WebFetch)');
  console.log('');
  console.log('The agent will now receive token-saving suggestions when:');
  console.log('  - Reading large code files (>300 lines) — use tl-symbols/tl-snippet');
  console.log('  - Running build/test commands — use tl-run');
  console.log('  - Using tail — use tl-tail');
  console.log('  - Using grep/rg via Bash — use Grep tool');
  console.log('  - Using cat/head via Bash — use Read tool');
  console.log('  - Using find/fd via Bash — use Glob tool');
  console.log('  - Using curl on URLs — use tl-browse');
  console.log('  - Using WebFetch — use tl-browse');
}

async function uninstallClaudeCode() {
  const settingsPath = getClaudeSettingsPath();
  const settings = await loadSettings(settingsPath);

  if (!settings.hooks) {
    console.log('No hooks configured in Claude Code.');
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
    console.log(`Removed ${removed} tokenlean hook(s) from Claude Code.`);
  } else {
    console.log('No tokenlean hooks found in Claude Code config.');
  }
}

async function statusClaudeCode() {
  const settingsPath = getClaudeSettingsPath();
  const settings = await loadSettings(settingsPath);

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
    console.log('No tokenlean hooks installed in Claude Code.');
    console.log('Run: tl-hook install claude-code');
  } else {
    console.log(`\n${found} tokenlean hook(s) active.`);
  }
}

// --- Main ---

const TOOL_HANDLERS = {
  'claude-code': { install: installClaudeCode, uninstall: uninstallClaudeCode, status: statusClaudeCode },
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

  if (command === 'install') await handler.install();
  else if (command === 'uninstall') await handler.uninstall();
  else if (command === 'status') await handler.status();
  else {
    console.error(`Unknown command: ${command}. Use install, uninstall, status, or run.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
