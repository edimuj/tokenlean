/** Shared MCP result-state and error-envelope normalization. */

import { resolve } from 'node:path';

export const MCP_RESULT_STATES = Object.freeze([
  'success', 'empty', 'failed', 'partial', 'unsupported'
]);

const STATE_SET = new Set(MCP_RESULT_STATES);
const EMPTY_COUNT_KEYS = [
  'totalDefinitions', 'totalFiles', 'totalEntries', 'totalMatches',
  'totalChanges', 'matchCount', 'resultCount', 'symbolCount', 'totalImports',
  'totalFunctions'
];
const EMPTY_ARRAY_KEYS = ['matches', 'results', 'files', 'issues', 'entries', 'suggestions'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PRIORITY_KEYS = [
  'resultState', 'error', 'errorDetails',
  'code', 'effectiveCwd', 'recoveryCall', 'message',
  'truncated', 'continuation'
];

// The bounded serializer consumes object keys in insertion order. Put state,
// errors, and continuation/truncation signals before potentially huge payload
// fields (including inside tl_run's nested result object).
function prioritizeMetadata(value, depth = 0) {
  if (!isObject(value) || depth > 4) return value;
  const result = {};
  for (const key of PRIORITY_KEYS) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  for (const [key, item] of Object.entries(value)) {
    if (PRIORITY_KEYS.includes(key)) continue;
    result[key] = isObject(item) ? prioritizeMetadata(item, depth + 1) : item;
  }
  return result;
}

function explicitState(payload) {
  const state = payload?.resultState;
  return STATE_SET.has(state) ? state : null;
}

export function inferMcpResultState(payload, { isError = false, context = null } = {}) {
  const stated = explicitState(payload);
  if (isError) return 'failed';
  if (stated) return stated;
  if (payload?.ok === false) return 'failed';
  if (Number.isInteger(payload?.exitCode) && payload.exitCode !== 0) return 'failed';
  if (payload?.partialFailure === true || payload?.partial === true) return 'partial';
  if (payload?.unsupported === true) return 'unsupported';
  if (payload?.failed === true) {
    const succeeded = payload.succeededCount ?? payload.successCount
      ?? (Array.isArray(payload.issues) ? payload.issues.length : 0);
    return succeeded > 0 ? 'partial' : 'failed';
  }
  for (const key of EMPTY_COUNT_KEYS) {
    if (Object.hasOwn(payload || {}, key) && payload[key] === 0) return 'empty';
  }
  for (const key of EMPTY_ARRAY_KEYS) {
    if (Array.isArray(payload?.[key]) && payload[key].length === 0) return 'empty';
  }
  if (payload?.totals && Object.hasOwn(payload.totals, 'lines') && payload.totals.lines === 0) return 'empty';
  if (payload?.functions === 0 || context?.toolName === 'tl_dupes') {
    if (payload?.functions === 0) return 'empty';
    const groups = ['exact', 'structural', 'near', 'names']
      .filter(key => Array.isArray(payload?.[key]));
    if (groups.length > 0 && groups.every(key => payload[key].length === 0)) return 'empty';
  }
  return 'success';
}

function firstFailureMessage(payload) {
  const candidates = [payload?.errors, payload?.failed, payload?.results];
  for (const items of candidates) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item === 'string' && item) return item;
      if (typeof item?.message === 'string' && item.message) return item.message;
      if (typeof item?.error === 'string' && item.error) return item.error;
      if (typeof item?.error?.message === 'string' && item.error.message) return item.error.message;
    }
  }
  return null;
}

function stableErrorCode(message, state, existingCode) {
  if (typeof existingCode === 'string' && /^[A-Z][A-Z0-9_]+$/.test(existingCode)) return existingCode;
  if (state === 'partial') return 'TL_MCP_PARTIAL_FAILURE';
  if (state === 'unsupported') return 'TL_MCP_UNSUPPORTED';
  if (/working directory/i.test(message)) return 'TL_MCP_INVALID_CWD';
  if (/\b(?:timed out|timeout)\b/i.test(message)) return 'TL_MCP_TIMEOUT';
  if (/invalid .*json|invalid .*output/i.test(message)) return 'TL_MCP_INVALID_OUTPUT';
  if (/\bNot found:|no such file|\bENOENT\b/i.test(message)) return 'TL_MCP_PATH_NOT_FOUND';
  return 'TL_MCP_TOOL_FAILED';
}

function errorMessage(payload, diagnostics, text, state) {
  if (typeof payload?.error?.message === 'string') return payload.error.message;
  if (typeof payload?.error === 'string') return payload.error;
  const nested = firstFailureMessage(payload);
  if (nested) return nested;
  if (!isObject(payload) && text) return String(text).trim();
  if (diagnostics) return String(diagnostics).trim();
  if (state === 'partial') return 'The tool returned usable data, but one or more operations failed.';
  if (state === 'unsupported') return 'The requested operation is not supported for this input.';
  return 'The tool failed without a more specific diagnostic.';
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function failedIssueIds(payload) {
  const ids = [];
  for (const collection of [payload?.failed, payload?.results]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (item?.status && !['failed', 'error'].includes(item.status)) continue;
      const value = item?.number ?? item?.issue ?? item?.issueNumber;
      if (Number.isInteger(value) && !ids.includes(value)) ids.push(value);
    }
  }
  return ids;
}

function safeMutationRecovery(context, effectiveCwd, payload) {
  const tool = context?.toolName || '';
  const args = isObject(context?.arguments) ? context.arguments : {};
  const repo = args.owner && typeof args.repo === 'string' && !args.repo.includes('/')
    ? `${args.owner}/${args.repo}`
    : args.repo;
  const issueMutation = /^tl_gh_issue_(?:close(?:_batch)?|label_batch|add_sub)$/.test(tool);
  if (issueMutation) {
    const ids = failedIssueIds(payload);
    if (repo && ids.length > 0) {
      return {
        tool: 'tl_gh_issue_read',
        arguments: {
          repo,
          ...(args.owner ? { owner: args.owner } : {}),
          issue: ids.length === 1 ? ids[0] : ids,
          noBody: true,
          cwd: effectiveCwd,
        }
      };
    }
  }

  if (tool === 'tl_gh_project_add_batch' && typeof args.project === 'string') {
    const slash = args.project.lastIndexOf('/');
    if (slash > 0 && slash < args.project.length - 1) {
      const owner = args.project.slice(0, slash);
      const number = args.project.slice(slash + 1);
      return {
        tool: 'tl_run',
        arguments: {
          command: `gh project item-list ${shellArg(number)} --owner ${shellArg(owner)} --format json`,
          raw: true,
          cwd: effectiveCwd,
        }
      };
    }
  }

  if (/^tl_gh_/.test(tool) && repo) {
    return {
      tool: 'tl_run',
      arguments: {
        command: `gh issue list -R ${shellArg(repo)} --limit 20 --json number,title,state`,
        raw: true,
        cwd: effectiveCwd,
      }
    };
  }

  // tl_run can execute arbitrary mutations; tl_push always mutates Git. A
  // retry must verify state, never replay their original command/arguments.
  if (tool === 'tl_run' || tool === 'tl_push' || (tool === 'tl_pack' && args.command)) {
    return {
      tool: 'tl_run',
      arguments: { command: 'git status --short', raw: true, cwd: effectiveCwd }
    };
  }
  return null;
}

function recoveryCall(context, effectiveCwd, payload) {
  const safeRecovery = safeMutationRecovery(context, effectiveCwd, payload);
  if (safeRecovery) return safeRecovery;
  const tool = context?.toolName || 'tokenlean';
  const args = isObject(context?.arguments) ? { ...context.arguments } : {};
  args.cwd = effectiveCwd;
  return { tool, arguments: args };
}

export function normalizeMcpResult(text, {
  isError = false,
  diagnostics = '',
  context = null,
} = {}) {
  let parsed = null;
  try { parsed = JSON.parse(String(text)); } catch { /* plain text remains compatible */ }

  const payload = isObject(parsed) ? parsed : null;
  const resultState = inferMcpResultState(payload, { isError, context });
  const effectiveCwd = resolve(context?.cwd || process.cwd());
  let error = null;

  if (resultState === 'failed' || resultState === 'partial' || resultState === 'unsupported') {
    const message = errorMessage(payload, diagnostics, text, resultState);
    error = {
      ...(isObject(payload?.error) ? payload.error : {}),
      code: stableErrorCode(message, resultState, payload?.error?.code),
      message,
      effectiveCwd,
      recoveryCall: safeMutationRecovery(context, effectiveCwd, payload)
        || payload?.error?.recoveryCall
        || recoveryCall(context, effectiveCwd, payload),
    };
  }

  let contentValue;
  if (payload) {
    const { resultState: _oldState, error: originalError, ...payloadRest } = payload;
    contentValue = { resultState, ...payloadRest };
    if (error) {
      if (typeof originalError === 'string') {
        contentValue = { resultState, error, legacyError: originalError, ...payloadRest };
      } else {
        contentValue = { resultState, error, ...payloadRest };
      }
    } else if (originalError !== undefined) {
      contentValue = { resultState, error: originalError, ...payloadRest };
    }
    contentValue = prioritizeMetadata(contentValue);
  } else if (error) {
    // Runtime failures with no CLI JSON still need a machine-readable primary
    // content block; do not force clients to understand structuredContent only.
    contentValue = prioritizeMetadata({
      resultState,
      error,
      ...(text ? { output: String(text) } : {}),
    });
  }

  const structuredContent = contentValue || {
    resultState,
    ...(text ? { output: String(text) } : {}),
    ...(error ? { error } : {}),
  };

  return {
    resultState,
    contentText: contentValue ? JSON.stringify(contentValue, null, 2) : String(text),
    structuredContent,
    isError: resultState === 'failed',
  };
}
