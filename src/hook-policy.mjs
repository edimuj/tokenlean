import { statSync } from 'node:fs';

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

function normalizeToolCall(data = {}) {
  const toolName = data.tool_name || data.tool || data.name || '';
  const toolInput = data.tool_input || data.input || data.arguments || data.args || {};
  return { toolName, toolInput };
}

function isTokenleanCommand(command) {
  return /\btl(?:-[\w-]+|\s+\w+)/.test(command);
}

export function evaluateToolCall(data = {}, options = {}) {
  const { stat = statSync } = options;
  const { toolName, toolInput } = normalizeToolCall(data);

  if (toolName === 'Read') {
    const filePath = toolInput.file_path || toolInput.path;
    if (!filePath) return null;

    const ext = filePath.split('.').pop().toLowerCase();
    if (NON_CODE_EXTS.has(ext)) return null;

    let size;
    try { size = stat(filePath).size; } catch { return null; }

    if (size > LARGE_FILE_BYTES) {
      return {
        id: 'read-large',
        severity: 'nudge',
        action: 'suggest',
        message: `[tl] ${Math.round(size / 1024)}KB - use tl-symbols + tl-snippet`,
        alternative: 'tl symbols <file> && tl snippet <symbol> <file>',
        toolName,
      };
    }
    return null;
  }

  if (toolName === 'Bash' || toolName === 'Shell' || toolName === 'exec_command') {
    const cmd = toolInput.command || toolInput.cmd || '';
    if (!cmd || isTokenleanCommand(cmd)) return null;

    if (BUILD_TEST_PATTERNS.some(p => p.test(cmd))) {
      return {
        id: 'bash-test',
        severity: 'nudge',
        action: 'wrap',
        message: '[tl] wrap with tl-run',
        alternative: `tl run ${JSON.stringify(cmd)}`,
        toolName,
      };
    }

    if (TAIL_PATTERNS.some(p => p.test(cmd))) {
      return {
        id: 'bash-tail',
        severity: 'nudge',
        action: 'replace',
        message: '[tl] use tl-tail instead',
        alternative: 'tl tail <file>',
        toolName,
      };
    }

    if (/^\s*cat\s+[^|]/.test(cmd)) {
      return {
        id: 'bash-cat',
        severity: 'nudge',
        action: 'replace',
        message: '[tl] use Read tool, not cat',
        alternative: 'Read tool or tl symbols/tl snippet for large code',
        toolName,
      };
    }

    if (/^\s*head\s/.test(cmd)) {
      return {
        id: 'bash-head',
        severity: 'nudge',
        action: 'replace',
        message: '[tl] use Read with offset/limit',
        alternative: 'Read tool with limit',
        toolName,
      };
    }

    if (/^\s*curl\s/.test(cmd) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(cmd)) {
      const url = cmd.match(/https?:\/\/\S+/)?.[0];
      return {
        id: 'bash-curl',
        severity: 'nudge',
        action: 'replace',
        message: '[tl] use tl-browse instead',
        alternative: url ? `tl browse ${JSON.stringify(url)}` : 'tl browse <url>',
        toolName,
      };
    }
  }

  if (toolName === 'WebFetch') {
    const url = toolInput.url || '';
    if (url) {
      return {
        id: 'webfetch',
        severity: 'nudge',
        action: 'replace',
        message: '[tl] use tl-browse instead',
        alternative: `tl browse ${JSON.stringify(url)}`,
        toolName,
      };
    }
  }

  return null;
}

export function rewriteShellCommand(command) {
  if (!command || isTokenleanCommand(command)) return null;

  if (BUILD_TEST_PATTERNS.some(p => p.test(command))) {
    return `tl-run ${JSON.stringify(command)}`;
  }

  if (/^\s*curl\s/.test(command) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(command)) {
    const url = command.match(/https?:\/\/\S+/)?.[0];
    if (url) return `tl-browse ${JSON.stringify(url)}`;
  }

  return null;
}
