#!/usr/bin/env node

/**
 * tl-audit - Analyze Claude Code and Codex sessions and estimate token savings.
 *
 * Parses session JSONL files, identifies patterns where tokenlean tools could have
 * reduced token usage (large file reads, verbose command output, etc.), and reports
 * estimated savings.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseCommonArgs, createOutput, formatTokens } from '../src/output.mjs';

const HELP = `Usage: tl-audit [options] [session.jsonl | project-dir | session-dir]

Analyze Claude Code and Codex sessions and estimate how many tokens
could have been saved using tokenlean tools.

Arguments:
  session.jsonl         Path to a specific session JSONL file
  project-dir           Project directory to match sessions for
  session-dir           Provider session directory
  (none)                Auto-detect from current working directory

Options:
  --latest              Analyze the most recent matching session (default)
  --all                 Analyze all matching sessions
  -n <count>            Analyze the N most recent matching sessions
  --provider <name>     Session provider: auto | claude | codex (default: auto)
  --claude-code         Shortcut for --provider claude
  --claudecode          Alias for --claude-code
  --codex               Shortcut for --provider codex
  --project <dir>       Override project path used for session discovery
  --verbose             Show per-session breakdown and detailed findings
  --savings             Also show tokens saved by existing tokenlean usage
  -j, --json            JSON output
  -h, --help            Show help`;

const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
};

// --- Patterns that indicate saveable token waste ---

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
const RATIOS = {
  READ_LARGE_TO_SYMBOLS: 0.20,      // tl-symbols returns ~20% of full file
  READ_LARGE_TO_SNIPPET: 0.10,      // tl-snippet returns ~10% of full file (when you need 1 function)
  BASH_BUILD_TO_RUN: 0.35,          // tl-run compresses build/test output ~65%
  BASH_CAT_TO_SYMBOLS: 0.20,        // cat whole file -> tl-symbols
  BASH_TAIL_TO_TLTAIL: 0.30,        // tl-tail collapses repeats, summarizes ~70%
  BASH_GREP_TO_GREP: 0.80,          // minor savings from Grep tool
  BASH_FIND_TO_GLOB: 0.70,          // minor savings from Glob tool
  BASH_CURL_TO_BROWSE: 0.30,        // tl-browse returns clean markdown ~70% savings
  BASH_HEAD_TO_READ: 0.80,          // Read with limit is slightly more efficient
  WEBFETCH_TO_BROWSE: 0.30,         // tl-browse returns cleaner markdown ~70% savings
};

// Reverse ratios: given tokenlean output size, estimate what the raw output would have been
// e.g. tl-symbols returns 20% of file -> raw would be output / 0.20 = 5x
const SAVINGS_RATIOS = {
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

const CHARS_PER_TOKEN = 4;
const LARGE_FILE_THRESHOLD = 150;
const SIGNIFICANT_RESULT = 500;

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

function mergeSessionMeta(existing, update) {
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

function parseSession(jsonlContent, provider) {
  if (provider === 'claude') return parseClaudeSession(jsonlContent);
  if (provider === 'codex') return parseCodexSession(jsonlContent);
  throw new Error(`Unsupported provider: ${provider}`);
}

function summarizeFindings(findings) {
  const byCategory = {};
  let totalActual = 0;
  let totalSaved = 0;

  for (const finding of findings) {
    if (!byCategory[finding.category]) {
      byCategory[finding.category] = {
        count: 0,
        actualTokens: 0,
        savedTokens: 0,
        suggestion: finding.suggestion,
      };
    }

    byCategory[finding.category].count++;
    byCategory[finding.category].actualTokens += finding.actualTokens;
    byCategory[finding.category].savedTokens += finding.savedTokens;
    totalActual += finding.actualTokens;
    totalSaved += finding.savedTokens;
  }

  return { byCategory, totalActual, totalSaved, totalFindings: findings.length };
}

function summarizeSavings(savings) {
  const byTool = {};
  let totalActual = 0;
  let totalSaved = 0;

  for (const saving of savings) {
    if (!byTool[saving.tool]) {
      byTool[saving.tool] = {
        count: 0,
        actualTokens: 0,
        rawEstimate: 0,
        savedTokens: 0,
      };
    }

    byTool[saving.tool].count++;
    byTool[saving.tool].actualTokens += saving.actualTokens;
    byTool[saving.tool].rawEstimate += saving.rawEstimate;
    byTool[saving.tool].savedTokens += saving.savedTokens;
    totalActual += saving.actualTokens;
    totalSaved += saving.savedTokens;
  }

  return { byTool, totalActual, totalSaved, totalUses: savings.length };
}

function summarizeProviders(results) {
  const counts = {};
  for (const result of results) {
    const provider = result.meta?.provider || result.provider || 'unknown';
    counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

function buildAggregateResults(results, showSavings) {
  const findings = results.flatMap(result => result.findings);
  const savings = showSavings ? results.flatMap(result => result.savings) : [];
  return {
    summary: summarizeFindings(findings),
    savingsSummary: showSavings ? summarizeSavings(savings) : null,
    providerCounts: summarizeProviders(results),
    findings,
    savings,
  };
}

function buildProviderBreakdowns(results, showSavings) {
  const groups = new Map();
  for (const result of results) {
    const provider = result.meta?.provider || result.provider || 'unknown';
    if (!groups.has(provider)) {
      groups.set(provider, []);
    }
    groups.get(provider).push(result);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, providerResults]) => ({
      provider,
      sessionsAnalyzed: providerResults.length,
      ...buildAggregateResults(providerResults, showSavings),
    }));
}

function getSavingsPercent(summary) {
  return summary.totalActual > 0
    ? Math.round((summary.totalSaved / summary.totalActual) * 100)
    : 0;
}

function getCaptureRate(summary, savingsSummary) {
  if (!summary || !savingsSummary) return 0;
  const total = summary.totalSaved + savingsSummary.totalSaved;
  if (total <= 0) return 0;
  return Math.round((savingsSummary.totalSaved / total) * 100);
}

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

function formatProviderCounts(providerCounts) {
  return Object.entries(providerCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, count]) => `${count} ${providerLabel(provider)}`)
    .join(', ');
}

function buildSummaryLabel(results, providerCounts) {
  const sessions = `${results.length} session${results.length === 1 ? '' : 's'}`;
  const providers = formatProviderCounts(providerCounts);
  return providers ? `Summary (${sessions}: ${providers})` : `Summary (${sessions})`;
}

function sessionLabel(result) {
  return result.meta?.slug
    || result.meta?.sessionId
    || basename(result.file, '.jsonl');
}

function formatSessionHeader(result) {
  const label = sessionLabel(result);
  const provider = providerLabel(result.meta?.provider || result.provider);
  const date = result.meta?.timestamp
    ? new Date(result.meta.timestamp).toLocaleDateString('en-US')
    : '';
  return `Session: ${label} [${provider}]${date ? ` (${date})` : ''}`;
}

function renderSummaryBlock(out, label, summary, savingsSummary, options = {}) {
  const {
    showDetailLists = false,
    findings = [],
    savings = [],
    providerBreakdowns = [],
  } = options;

  const hasWaste = summary.totalFindings > 0;
  const hasSavings = savingsSummary && savingsSummary.totalUses > 0;

  out.header(label);

  if (!hasWaste && !hasSavings) {
    out.add('  No significant findings.');
    out.blank();
    return;
  }

  if (hasWaste) {
    const categories = Object.entries(summary.byCategory)
      .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

    if (hasSavings) out.add('  Opportunities:');
    out.add('  Category                Count  Actual     Saveable   Suggestion');
    out.add('  ' + '-'.repeat(76));
    for (const [category, data] of categories) {
      out.add(`  ${category.padEnd(22)} ${(data.count + 'x').padStart(5)}  ${formatTokens(data.actualTokens).padStart(8)}  ${formatTokens(data.savedTokens).padStart(10)}   -> ${data.suggestion}`);
    }
    out.blank();
    out.add(`  Still saveable:     ${formatTokens(summary.totalSaved)} of ${formatTokens(summary.totalActual)} (${getSavingsPercent(summary)}%)`);
    out.blank();

    if (showDetailLists) {
      out.add('  Findings:');
      const sorted = [...findings].sort((a, b) => b.savedTokens - a.savedTokens);
      for (const finding of sorted.slice(0, 20)) {
        const detailLabel = finding.file || finding.command || '';
        out.add(`    [${formatTokens(finding.savedTokens).trim()} saveable] ${detailLabel}`);
        out.add(`      ${finding.detail}`);
      }
      if (sorted.length > 20) {
        out.add(`    ... and ${sorted.length - 20} more`);
      }
      out.blank();
    }
  }

  if (providerBreakdowns.length > 1) {
    out.add('  By provider:');
    for (const breakdown of providerBreakdowns) {
      let line = `  ${providerLabel(breakdown.provider).padEnd(12)} ${String(breakdown.sessionsAnalyzed).padStart(3)} session${breakdown.sessionsAnalyzed === 1 ? ' ' : 's'}  ${formatTokens(breakdown.summary.totalSaved).padStart(8)} saveable`;
      if (breakdown.savingsSummary) {
        line += `  ${formatTokens(breakdown.savingsSummary.totalSaved).padStart(8)} saved`;
      }
      out.add(line);
    }
    out.blank();
  }

  if (hasSavings) {
    out.add('  Already saved by tokenlean:');
    const tools = Object.entries(savingsSummary.byTool)
      .sort((a, b) => b[1].savedTokens - a[1].savedTokens);

    out.add('  Tool              Count  Compressed   Raw estimate   Saved');
    out.add('  ' + '-'.repeat(66));
    for (const [tool, data] of tools) {
      out.add(`  ${tool.padEnd(18)} ${(data.count + 'x').padStart(5)}  ${formatTokens(data.actualTokens).padStart(10)}  ${formatTokens(data.rawEstimate).padStart(14)}   ${formatTokens(data.savedTokens)}`);
    }
    out.blank();
    out.add(`  Tokens saved:       ${formatTokens(savingsSummary.totalSaved)} (${savingsSummary.totalUses} uses)`);

    const captureRate = getCaptureRate(summary, savingsSummary);
    if (captureRate > 0 && summary.totalSaved > 0) {
      out.add(`  Capture rate:       ${captureRate}% of potential savings realized`);
    }
    out.blank();

    if (showDetailLists) {
      out.add('  Savings detail:');
      const sorted = [...savings].sort((a, b) => b.savedTokens - a.savedTokens);
      for (const saving of sorted.slice(0, 20)) {
        out.add(`    [${formatTokens(saving.savedTokens).trim()} saved] ${saving.command}`);
      }
      if (sorted.length > 20) {
        out.add(`    ... and ${sorted.length - 20} more`);
      }
      out.blank();
    }
  }
}

function buildSummaryJson(summary) {
  return {
    totalFindings: summary.totalFindings,
    totalActualTokens: summary.totalActual,
    totalSavedTokens: summary.totalSaved,
    savingsPercent: getSavingsPercent(summary),
    categories: summary.byCategory,
  };
}

function buildSavingsJson(summary, savingsSummary) {
  return {
    totalUses: savingsSummary.totalUses,
    compressedTokens: savingsSummary.totalActual,
    rawEstimateTokens: savingsSummary.totalActual + savingsSummary.totalSaved,
    totalSavedTokens: savingsSummary.totalSaved,
    captureRate: getCaptureRate(summary, savingsSummary),
    byTool: savingsSummary.byTool,
  };
}

function buildSessionJson(result, verbose) {
  return {
    provider: result.meta?.provider || result.provider,
    session: sessionLabel(result),
    timestamp: result.meta?.timestamp || null,
    cwd: result.meta?.cwd || null,
    summary: buildSummaryJson(result.summary),
    ...(result.savingsSummary ? { savings: buildSavingsJson(result.summary, result.savingsSummary) } : {}),
    ...(verbose ? {
      findings: result.findings,
      ...(result.savingsSummary ? { savingsDetail: result.savings } : {}),
    } : {}),
  };
}

function normalizeProvider(provider) {
  if (provider === 'claude-code' || provider === 'claudecode') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'auto' || !provider) return 'auto';
  throw new Error(`Unsupported provider: ${provider}`);
}

function normalizeClaudeProjectPath(projectPath) {
  return resolve(projectPath).replace(/[\\/]/g, '-');
}

function isSameOrWithinPath(childPath, parentPath) {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

function claudeSessionsRoot() {
  return join(homedir(), '.claude', 'projects');
}

function codexSessionsRoot() {
  return join(homedir(), '.codex', 'sessions');
}

async function listFlatJsonlFiles(dir, provider) {
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files = await Promise.all(entries
    .filter(entry => entry.endsWith('.jsonl'))
    .map(async entry => {
      const path = join(dir, entry);
      const info = await stat(path);
      return { path, mtime: info.mtimeMs, size: info.size, provider };
    }));

  return files;
}

async function listRecursiveJsonlFiles(dir, provider) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listRecursiveJsonlFiles(path, provider);
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await stat(path);
      return [{ path, mtime: info.mtimeMs, size: info.size, provider }];
    }
    return [];
  }));

  return nested.flat();
}

async function findClaudeSessionsForProject(projectPath) {
  const root = claudeSessionsRoot();
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const normalized = normalizeClaudeProjectPath(projectPath);
  const matches = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name === normalized || name.startsWith(`${normalized}-`));

  const files = await Promise.all(matches.map(name => listFlatJsonlFiles(join(root, name), 'claude')));
  return files.flat();
}

async function readCodexSessionMeta(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const firstLine = content.split('\n').find(line => line.trim());
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj || obj.type !== 'session_meta') return null;
  return obj.payload || null;
}

async function findCodexSessionsForProject(projectPath) {
  const root = codexSessionsRoot();
  const files = await listRecursiveJsonlFiles(root, 'codex');
  const resolvedProject = resolve(projectPath);

  const matches = await Promise.all(files.map(async file => {
    const meta = await readCodexSessionMeta(file.path);
    if (!meta?.cwd) return null;
    return isSameOrWithinPath(meta.cwd, resolvedProject) ? file : null;
  }));

  return matches.filter(Boolean);
}

function detectSessionDirProvider(target) {
  const resolved = resolve(target);
  if (isSameOrWithinPath(resolved, claudeSessionsRoot())) return 'claude';
  if (isSameOrWithinPath(resolved, codexSessionsRoot())) return 'codex';
  return null;
}

async function detectSessionFileProvider(filePath) {
  const content = await readFile(filePath, 'utf8');
  const firstLine = content.split('\n').find(line => line.trim());
  if (!firstLine) return null;

  const obj = parseJson(firstLine);
  if (!obj) return null;
  if (obj.type === 'session_meta') return 'codex';
  if (obj.sessionId || obj.message || obj.cwd) return 'claude';
  return null;
}

function sortSessionsByNewest(sessions) {
  return [...sessions].sort((a, b) => b.mtime - a.mtime);
}

function limitSessions(sessions, count) {
  if (!Number.isFinite(count)) return sessions;
  return sessions.slice(0, count);
}

async function findProjectSessions(projectPath, provider, count) {
  const files = [];
  if (provider === 'auto' || provider === 'claude') {
    files.push(...await findClaudeSessionsForProject(projectPath));
  }
  if (provider === 'auto' || provider === 'codex') {
    files.push(...await findCodexSessionsForProject(projectPath));
  }
  return limitSessions(sortSessionsByNewest(files), count);
}

async function resolveSessionFiles(targetPath, provider, count) {
  const target = resolve(targetPath);
  let targetStat;
  try {
    targetStat = await stat(target);
  } catch {
    throw new Error(`Path not found: ${target}`);
  }

  if (targetStat.isFile()) {
    if (!target.endsWith('.jsonl')) {
      throw new Error(`Session file must be a .jsonl file: ${target}`);
    }

    const detected = await detectSessionFileProvider(target);
    if (!detected) {
      throw new Error(`Could not detect session provider for ${target}`);
    }
    if (provider !== 'auto' && provider !== detected) {
      throw new Error(`${target} is a ${providerLabel(detected)} session, not ${providerLabel(provider)}`);
    }
    return [{ path: target, mtime: targetStat.mtimeMs, size: targetStat.size, provider: detected }];
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Unsupported target: ${target}`);
  }

  const sessionDirProvider = detectSessionDirProvider(target);
  if (sessionDirProvider) {
    if (provider !== 'auto' && provider !== sessionDirProvider) {
      throw new Error(`${target} is a ${providerLabel(sessionDirProvider)} session directory, not ${providerLabel(provider)}`);
    }

    const files = sessionDirProvider === 'claude'
      ? await listFlatJsonlFiles(target, 'claude')
      : await listRecursiveJsonlFiles(target, 'codex');
    return limitSessions(sortSessionsByNewest(files), count);
  }

  return findProjectSessions(target, provider, count);
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const args = options.remaining;

  let provider = 'auto';
  let verbose = false;
  let showSavings = false;
  let projectOverride = null;
  let count = 1;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      count = Infinity;
    } else if (arg === '--latest') {
      count = 1;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--savings') {
      showSavings = true;
    } else if (arg === '-n') {
      count = parseInt(args[++i], 10) || 1;
    } else if (arg === '--project') {
      projectOverride = args[++i];
    } else if (arg === '--provider') {
      provider = normalizeProvider(args[++i]);
    } else if (arg === '--claude-code' || arg === '--claudecode') {
      provider = 'claude';
    } else if (arg === '--codex') {
      provider = 'codex';
    } else {
      positional.push(arg);
    }
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const target = positional[0] || projectOverride || process.cwd();
  const sessionFiles = await resolveSessionFiles(target, provider, count);

  if (sessionFiles.length === 0) {
    console.error(`No matching ${provider === 'auto' ? '' : providerLabel(provider) + ' '}session files found.`);
    process.exit(1);
  }

  const allResults = [];
  for (const sessionFile of sessionFiles) {
    const content = await readFile(sessionFile.path, 'utf8');
    const { findings, savings, meta } = parseSession(content, sessionFile.provider);
    const summary = summarizeFindings(findings);
    const savingsSummary = showSavings ? summarizeSavings(savings) : null;
    allResults.push({
      file: sessionFile.path,
      provider: sessionFile.provider,
      meta: mergeSessionMeta(meta, { provider: sessionFile.provider }),
      findings,
      savings,
      summary,
      savingsSummary,
    });
  }

  const aggregate = buildAggregateResults(allResults, showSavings);
  const providerBreakdowns = buildProviderBreakdowns(allResults, showSavings);
  const summaryLabel = buildSummaryLabel(allResults, aggregate.providerCounts);

  if (options.json) {
    const data = {
      requestedProvider: provider,
      sessionsAnalyzed: allResults.length,
      providers: aggregate.providerCounts,
      summary: buildSummaryJson(aggregate.summary),
      byProvider: Object.fromEntries(providerBreakdowns.map(breakdown => [
        breakdown.provider,
        {
          sessionsAnalyzed: breakdown.sessionsAnalyzed,
          summary: buildSummaryJson(breakdown.summary),
          ...(breakdown.savingsSummary ? { savings: buildSavingsJson(breakdown.summary, breakdown.savingsSummary) } : {}),
        },
      ])),
      ...(aggregate.savingsSummary ? { savings: buildSavingsJson(aggregate.summary, aggregate.savingsSummary) } : {}),
      ...(verbose ? { sessions: allResults.map(result => buildSessionJson(result, true)) } : {}),
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const out = createOutput(options);
  renderSummaryBlock(out, summaryLabel, aggregate.summary, aggregate.savingsSummary, {
    showDetailLists: false,
    providerBreakdowns,
  });

  if (verbose) {
    for (const result of allResults) {
      renderSummaryBlock(out, formatSessionHeader(result), result.summary, result.savingsSummary, {
        showDetailLists: true,
        findings: result.findings,
        savings: result.savings,
      });
    }
  }

  out.print();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
