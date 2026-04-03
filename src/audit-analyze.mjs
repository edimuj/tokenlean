/**
 * Token waste analysis engine for tl-audit.
 *
 * Contains: pattern matching constants, utility helpers,
 * per-tool analysis, and session JSONL parsing (Claude + Codex).
 */

// ─────────────────────────────────────────────────────────────
// Provider labels (shared across modules)
// ─────────────────────────────────────────────────────────────

export const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

// ─────────────────────────────────────────────────────────────
// Pattern constants
// ─────────────────────────────────────────────────────────────

export const BUILD_TEST_PATTERNS = [
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

const CAT_PATTERNS = [
  /(?:^|(?:&&|;)\s*)cat\s+[^|]/,
];

const TAIL_PATTERNS = [
  /(?:^|(?:&&|;)\s*)tail\s+/,
];

const GREP_PATTERNS = [
  /(?:^|(?:&&|;)\s*)(grep|rg|ag)\s+/,
];

const FIND_PATTERNS = [
  /(?:^|(?:&&|;)\s*)(find|fd)\s+/,
  /(?:^|(?:&&|;)\s*)ls\s+(-[a-zA-Z]*R|-[a-zA-Z]*l)/,
];

const CURL_PATTERNS = [
  /(?:^|(?:&&|;)\s*)curl\s/,
];

const HEAD_PATTERNS = [
  /(?:^|(?:&&|;)\s*)head\s+/,
];

const NON_CODE_EXTS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'lock',
  'svg', 'html', 'css', 'log', 'env', 'gitignore', 'dockerignore', 'editorconfig',
]);

// Compression ratios (estimated fraction of tokens retained with tokenlean)
export const RATIOS = {
  READ_LARGE_TO_SYMBOLS: 0.20,
  READ_LARGE_TO_SNIPPET: 0.10,
  BASH_BUILD_TO_RUN: 0.35,
  BASH_CAT_TO_SYMBOLS: 0.20,
  BASH_TAIL_TO_TLTAIL: 0.30,
  BASH_GREP_TO_GREP: 0.80,
  BASH_FIND_TO_GLOB: 0.70,
  BASH_CURL_TO_BROWSE: 0.30,
  BASH_HEAD_TO_READ: 0.80,
  WEBFETCH_TO_BROWSE: 0.30,
};

// Reverse ratios: given tokenlean output size, estimate what the raw output would have been
export const SAVINGS_RATIOS = {
  'tl-symbols': 0.20,
  'tl-snippet': 0.10,
  'tl-run': 0.35,
  'tl-browse': 0.30,
  'tl-tail': 0.30,
  'tl-diff': 0.40,
  'tl-impact': 0.25,
  'tl-structure': 0.15,
  'tl-deps': 0.20,
  'tl-exports': 0.20,
};

export const CHARS_PER_TOKEN = 4;
const LARGE_FILE_THRESHOLD = 150;
const SIGNIFICANT_RESULT = 500;

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────

function countLines(text) {
  if (!text) return 0;
  return text.split('\n').length;
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function mergeSessionMeta(existing, update) {
  const current = existing || {};
  return {
    provider: update.provider || current.provider || null,
    sessionId: update.sessionId || current.sessionId || null,
    timestamp: update.timestamp || current.timestamp || null,
    cwd: update.cwd || current.cwd || null,
    slug: update.slug || current.slug || null,
  };
}

function extractClaudeResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item?.text || '').join('\n');
  return JSON.stringify(content ?? '');
}

function extractCodexResultText(output) {
  if (typeof output !== 'string') return JSON.stringify(output ?? '');
  const marker = '\nOutput:\n';
  const index = output.indexOf(marker);
  if (index !== -1) {
    return output.slice(index + marker.length);
  }
  return output;
}

function parseToolArguments(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  const parsed = parseJson(argumentsValue);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function getShellCommand(call) {
  if (call.name === 'Bash') return call.input.command || '';
  if (call.name === 'exec_command') return call.input.cmd || '';
  return '';
}

function isBashLikeCall(call) {
  return call.name === 'Bash' || call.name === 'exec_command';
}

function getFileExtension(pathValue) {
  const parts = String(pathValue || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function extractShellFilePath(command) {
  const match = command.match(/(?:^|(?:&&|;)\s*)(?:cat|head)\s+(?:-[^\s]+\s+)*(\S+)/);
  return match?.[1] || '';
}

// ─────────────────────────────────────────────────────────────
// Per-tool analysis
// ─────────────────────────────────────────────────────────────

import { basename } from 'node:path';

function analyzeSavings(call, tokens, savings) {
  const command = getShellCommand(call);
  if (!command) return;

  const match = command.match(/\b(tl-\w+)\b/);
  if (!match) return;

  const tool = match[1];
  const ratio = SAVINGS_RATIOS[tool];
  if (!ratio) return;

  const rawTokens = Math.round(tokens / ratio);
  const saved = rawTokens - tokens;
  savings.push({
    tool,
    command: command.split('\n')[0].slice(0, 120),
    actualTokens: tokens,
    rawEstimate: rawTokens,
    savedTokens: saved,
  });
}

function analyzeRead(call, resultText, tokens, findings) {
  if (call.name !== 'Read') return;

  const lines = countLines(resultText);
  const file = call.input.file_path || 'unknown';
  const ext = getFileExtension(file);
  if (lines <= LARGE_FILE_THRESHOLD || NON_CODE_EXTS.has(ext)) return;

  const savedTokens = Math.round(tokens * (1 - RATIOS.READ_LARGE_TO_SYMBOLS));
  findings.push({
    category: 'read-large-file',
    tool: 'Read',
    suggestion: 'tl-symbols + tl-snippet',
    file: basename(file),
    filePath: file,
    lines,
    actualTokens: tokens,
    estimatedTokens: tokens - savedTokens,
    savedTokens,
    detail: `${lines} lines read - tl-symbols would show structure (~${RATIOS.READ_LARGE_TO_SYMBOLS * 100}%), then tl-snippet for specific functions`,
  });
}

function analyzeShell(call, resultText, tokens, findings) {
  if (!isBashLikeCall(call)) return;

  const command = getShellCommand(call);
  if (!command) return;
  const toolName = call.name === 'exec_command' ? 'exec_command' : 'Bash';

  if (BUILD_TEST_PATTERNS.some(pattern => pattern.test(command))) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_BUILD_TO_RUN));
    findings.push({
      category: 'build-test-output',
      tool: toolName,
      suggestion: 'tl-run',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `Build/test output (${tokens} tokens) - tl-run compresses ~${(1 - RATIOS.BASH_BUILD_TO_RUN) * 100}%`,
    });
    return;
  }

  if (TAIL_PATTERNS.some(pattern => pattern.test(command))) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_TAIL_TO_TLTAIL));
    findings.push({
      category: 'tail-command',
      tool: toolName,
      suggestion: 'tl-tail',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `tail via shell (${tokens} tokens) - tl-tail collapses repeats and summarizes ~70%`,
    });
    return;
  }

  if (CAT_PATTERNS.some(pattern => pattern.test(command))) {
    const lines = countLines(resultText);
    const file = extractShellFilePath(command);
    const ext = getFileExtension(file);
    if (lines > LARGE_FILE_THRESHOLD && !NON_CODE_EXTS.has(ext)) {
      const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_CAT_TO_SYMBOLS));
      findings.push({
        category: 'cat-large-file',
        tool: toolName,
        suggestion: 'tl-symbols + tl-snippet',
        command: command.slice(0, 120),
        actualTokens: tokens,
        estimatedTokens: tokens - savedTokens,
        savedTokens,
        detail: `cat/head on ${lines}-line output - use tl-symbols for structure`,
      });
    }
    return;
  }

  if (GREP_PATTERNS.some(pattern => pattern.test(command))) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_GREP_TO_GREP));
    findings.push({
      category: 'grep-command',
      tool: toolName,
      suggestion: 'Grep tool',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `grep/rg via shell (${tokens} tokens) - Grep tool has better integration`,
    });
    return;
  }

  if (FIND_PATTERNS.some(pattern => pattern.test(command))) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_FIND_TO_GLOB));
    findings.push({
      category: 'find-command',
      tool: toolName,
      suggestion: 'Glob tool',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `find/ls via shell (${tokens} tokens) - Glob tool is more efficient`,
    });
    return;
  }

  if (HEAD_PATTERNS.some(pattern => pattern.test(command))) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_HEAD_TO_READ));
    findings.push({
      category: 'head-command',
      tool: toolName,
      suggestion: 'Read tool (with limit)',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `head via shell (${tokens} tokens) - Read with offset/limit is better integrated`,
    });
    return;
  }

  if (CURL_PATTERNS.some(pattern => pattern.test(command)) && !/(-X\s|--data|--header.*auth|-d\s)/i.test(command)) {
    const savedTokens = Math.round(tokens * (1 - RATIOS.BASH_CURL_TO_BROWSE));
    findings.push({
      category: 'curl-command',
      tool: toolName,
      suggestion: 'tl-browse',
      command: command.slice(0, 120),
      actualTokens: tokens,
      estimatedTokens: tokens - savedTokens,
      savedTokens,
      detail: `curl via shell (${tokens} tokens) - tl-browse returns clean markdown, ~70% fewer tokens`,
    });
  }
}

function analyzeWebFetch(call, tokens, findings) {
  if (call.name !== 'WebFetch') return;

  const savedTokens = Math.round(tokens * (1 - RATIOS.WEBFETCH_TO_BROWSE));
  findings.push({
    category: 'webfetch',
    tool: 'WebFetch',
    suggestion: 'tl-browse',
    command: (call.input.url || '').slice(0, 120),
    actualTokens: tokens,
    estimatedTokens: tokens - savedTokens,
    savedTokens,
    detail: `WebFetch (${tokens} tokens) - tl-browse returns cleaner markdown, ~70% fewer tokens`,
  });
}

function analyzeToolResult(call, rawResultText, findings, savings) {
  const resultText = typeof rawResultText === 'string'
    ? rawResultText
    : JSON.stringify(rawResultText ?? '');
  const chars = resultText.length;
  if (chars < SIGNIFICANT_RESULT) return;

  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  analyzeSavings(call, tokens, savings);
  analyzeRead(call, resultText, tokens, findings);
  analyzeShell(call, resultText, tokens, findings);
  analyzeWebFetch(call, tokens, findings);
}

// ─────────────────────────────────────────────────────────────
// Session JSONL parsing
// ─────────────────────────────────────────────────────────────

function parseClaudeSession(jsonlContent) {
  const lines = jsonlContent.trim().split('\n');
  const toolCalls = new Map();
  const findings = [];
  const savings = [];
  let sessionMeta = null;

  for (const line of lines) {
    const obj = parseJson(line);
    if (!obj) continue;

    sessionMeta = mergeSessionMeta(sessionMeta, {
      provider: 'claude',
      sessionId: obj.sessionId,
      timestamp: obj.timestamp,
      cwd: obj.cwd,
      slug: obj.slug,
    });

    const content = obj.message?.content;
    if (!Array.isArray(content) && typeof content !== 'string') continue;

    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        toolCalls.set(block.id, {
          provider: 'claude',
          name: block.name,
          input: block.input || {},
        });
        continue;
      }

      if (block.type === 'tool_result') {
        const call = toolCalls.get(block.tool_use_id);
        if (!call) continue;
        analyzeToolResult(call, extractClaudeResultText(block.content), findings, savings);
      }
    }
  }

  return { findings, savings, meta: sessionMeta };
}

function parseCodexSession(jsonlContent) {
  const lines = jsonlContent.trim().split('\n');
  const toolCalls = new Map();
  const findings = [];
  const savings = [];
  let sessionMeta = null;

  for (const line of lines) {
    const obj = parseJson(line);
    if (!obj) continue;

    if (obj.type === 'session_meta') {
      const payload = obj.payload || {};
      sessionMeta = mergeSessionMeta(sessionMeta, {
        provider: 'codex',
        sessionId: payload.id,
        timestamp: payload.timestamp || obj.timestamp,
        cwd: payload.cwd,
        slug: payload.agent_nickname || payload.agent_role || null,
      });
      continue;
    }

    if (obj.type !== 'response_item') continue;

    const payload = obj.payload || {};
    if (payload.type === 'function_call') {
      toolCalls.set(payload.call_id, {
        provider: 'codex',
        name: payload.name,
        input: parseToolArguments(payload.arguments),
      });
      continue;
    }

    if (payload.type === 'function_call_output') {
      const call = toolCalls.get(payload.call_id);
      if (!call) continue;
      analyzeToolResult(call, extractCodexResultText(payload.output), findings, savings);
    }
  }

  return { findings, savings, meta: sessionMeta };
}

export function parseSession(jsonlContent, provider) {
  if (provider === 'claude') return parseClaudeSession(jsonlContent);
  if (provider === 'codex') return parseCodexSession(jsonlContent);
  throw new Error(`Unsupported provider: ${provider}`);
}
