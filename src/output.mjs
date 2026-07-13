/**
 * Shared output utilities for tokenlean CLI tools
 *
 * Centralizes output formatting, truncation, and common options.
 */

import { getConfig } from './config.mjs';
import { inferMcpResultState } from './mcp-result.mjs';

// ─────────────────────────────────────────────────────────────
// Shell Escaping
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Token Estimation
// ─────────────────────────────────────────────────────────────

export function estimateTokens(content) {
  if (typeof content !== 'string') return 0;
  return Math.ceil(content.length / 4);
}

export function formatTokens(tokens) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

// Structured output must have a hard ceiling even when callers do not pass an
// explicit token budget. MCP clients commonly request JSON and the old JSON
// path ignored maxLines/maxTokens entirely, allowing a single response to grow
// to tens of megabytes before the subprocess buffer stopped it.
export const DEFAULT_MAX_STRUCTURED_CHARS = 250_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const STRUCTURED_SAFETY_KEYS = [
  'resultState', 'error', 'errorDetails', 'failed', 'partialFailure',
  'partial', 'unsupported', 'truncated'
];
const STRUCTURED_SAFETY_PRIORITY = new Map(STRUCTURED_SAFETY_KEYS.map((key, index) => [key, index]));

function consume(state, chars) {
  if (chars > state.remainingChars) return false;
  state.remainingChars -= chars;
  return true;
}

function recordPage(state, path, totalItems, returnedItems) {
  const start = Math.min(state.offset, totalItems);
  const hasPrevious = start > 0;
  const hasMore = start + returnedItems < totalItems;
  if (!hasPrevious && !hasMore) return;
  state.truncated = true;
  state.pages.push({
    path,
    offset: start,
    limit: state.maxItems,
    returnedItems,
    totalItems,
    hasPrevious,
    hasMore,
    nextOffset: hasMore ? start + returnedItems : null
  });
}

function lineCount(value) {
  let count = 1;
  let cursor = 0;
  while ((cursor = value.indexOf('\n', cursor)) !== -1) {
    count++;
    cursor++;
  }
  return count;
}

// Select one stable, primary collection for item pagination. Nested arrays
// inside returned rows are deliberately not offset: page 2 must not erase a
// row's metadata/members. Among peer collections, the largest is usually the
// command's actual result list (files, symbols, matches, importers, ...).
function findPrimaryCollection(value, path = '$', seen = new Set()) {
  if (typeof value === 'string') {
    return value.includes('\n') ? { path, size: lineCount(value) } : null;
  }
  if (Array.isArray(value)) {
    let best = { path, size: value.length };
    // A one-item wrapper array commonly represents the project root while its
    // child collection carries the real page (e.g. structure.tree[0].children).
    // Do not descend into multi-row arrays: nested members belong to each row
    // and must remain intact across pages.
    if (value.length === 1 && isPlainObject(value[0])) {
      const nested = findPrimaryCollection(value[0], `${path}[0]`, seen);
      if (nested && nested.size > best.size) best = nested;
    }
    return best;
  }
  if (!isPlainObject(value) || seen.has(value)) return null;
  seen.add(value);

  let best = null;
  for (const [key, item] of Object.entries(value)) {
    const candidate = findPrimaryCollection(item, `${path}.${key}`, seen);
    if (candidate && (!best || candidate.size > best.size)) best = candidate;
  }
  return best;
}

function pageMultilineString(value, state, path) {
  if (!Number.isFinite(state.maxItems) || path !== state.pagePath || !value.includes('\n')) return value;

  const startLine = state.offset;
  const endLine = startLine + state.maxItems;
  let line = 0;
  let cursor = 0;
  let selectedStart = startLine === 0 ? 0 : null;
  let selectedEnd = state.maxItems === 0 ? 0 : value.length;

  while (cursor < value.length) {
    const newline = value.indexOf('\n', cursor);
    if (newline === -1) break;
    line++;
    cursor = newline + 1;
    if (line === startLine) selectedStart = cursor;
    if (line === endLine) selectedEnd = cursor;
  }

  const totalLines = line + 1;
  const start = selectedStart ?? value.length;
  const returned = Math.min(state.maxItems, Math.max(0, totalLines - startLine));
  recordPage(state, path, totalLines, returned);
  return value.slice(start, selectedEnd);
}

function boundedString(value, state, path) {
  let candidate = pageMultilineString(value, state, path);

  const suffix = '\n... [truncated]';
  // Avoid stringifying an unbounded original value just to learn that it is
  // too large. Start with a raw prefix no larger than the remaining budget,
  // then account for JSON escaping exactly.
  if (candidate.length > state.remainingChars) {
    candidate = `${candidate.slice(0, Math.max(0, state.remainingChars - suffix.length - 2))}${suffix}`;
    state.truncated = true;
  }

  let encoded = JSON.stringify(candidate);
  while (encoded.length > state.remainingChars && candidate.length > suffix.length) {
    const excess = encoded.length - state.remainingChars;
    const keep = Math.max(0, candidate.length - suffix.length - excess - 1);
    candidate = `${candidate.slice(0, keep)}${suffix}`;
    state.truncated = true;
    encoded = JSON.stringify(candidate);
  }

  if (!consume(state, encoded.length)) {
    state.truncated = true;
    return undefined;
  }
  return candidate;
}

function boundValue(value, state, path = '$') {
  if (typeof value === 'string') return boundedString(value, state, path);

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const encoded = JSON.stringify(value);
    if (!consume(state, encoded.length)) {
      state.truncated = true;
      return undefined;
    }
    return value;
  }

  if (typeof value === 'bigint') {
    return boundedString(String(value), state, path);
  }

  if (Array.isArray(value)) {
    if (!consume(state, 2)) {
      state.truncated = true;
      return undefined;
    }
    const result = [];
    const paginate = Number.isFinite(state.maxItems) && path === state.pagePath;
    const start = paginate ? Math.min(state.offset, value.length) : 0;
    const end = paginate ? Math.min(value.length, start + state.maxItems) : value.length;
    if (paginate) recordPage(state, path, value.length, end - start);
    for (let index = start; index < end; index++) {
      if (result.length > 0 && !consume(state, 1)) {
        state.truncated = true;
        break;
      }
      const bounded = boundValue(value[index], state, `${path}[${index}]`);
      if (bounded === undefined) {
        state.truncated = true;
        break;
      }
      result.push(bounded);
    }
    if (result.length < end - start) state.truncated = true;
    return result;
  }

  if (isPlainObject(value)) {
    if (!consume(state, 2)) {
      state.truncated = true;
      return undefined;
    }
    const result = {};
    const entries = Object.entries(value).sort(([left], [right]) => {
      const leftPriority = STRUCTURED_SAFETY_PRIORITY.get(left) ?? STRUCTURED_SAFETY_KEYS.length;
      const rightPriority = STRUCTURED_SAFETY_PRIORITY.get(right) ?? STRUCTURED_SAFETY_KEYS.length;
      return leftPriority - rightPriority;
    });
    let resultSize = 0;
    for (const [key, item] of entries) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      const prefixSize = (resultSize > 0 ? 1 : 0) + JSON.stringify(key).length + 1;
      if (!consume(state, prefixSize)) {
        state.truncated = true;
        break;
      }
      const bounded = boundValue(item, state, `${path}.${key}`);
      if (bounded === undefined) {
        state.truncated = true;
        break;
      }
      result[key] = bounded;
      resultSize++;
    }
    if (resultSize < entries.filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol').length) {
      state.truncated = true;
    }
    return result;
  }

  // Match JSON.stringify's treatment of unsupported top-level values without
  // retaining arbitrary class instances or invoking a large custom toJSON.
  state.truncated = true;
  return null;
}

/**
 * Serialize a structured value under an aggregate character/item budget.
 * The value is bounded first, so the final JSON.stringify never receives an
 * unbounded clone. When possible a top-level object gets `truncated: true`.
 */
export function stringifyBoundedJson(value, {
  maxChars = DEFAULT_MAX_STRUCTURED_CHARS,
  maxItems = Infinity,
  offset = 0,
  continuationTool = null,
  continuationArguments = null,
  pretty = true
} = {}) {
  const normalizedMaxChars = Number.isFinite(maxChars)
    ? Math.max(64, Math.floor(maxChars))
    : DEFAULT_MAX_STRUCTURED_CHARS;
  let continuationReserve = 1024;
  if (continuationArguments) {
    try {
      continuationReserve = Math.max(continuationReserve, JSON.stringify(continuationArguments).length + 512);
    } catch { /* non-serializable request metadata is omitted below */ }
  }
  const state = {
    // Reserve room for the truncation marker and container punctuation without
    // consuming the entire budget when callers intentionally request a very
    // small structured response.
    remainingChars: Math.max(0, normalizedMaxChars - Math.min(continuationReserve, Math.floor(normalizedMaxChars / 4))),
    maxItems: Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity,
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
    truncated: false,
    pages: []
  };
  state.pagePath = Number.isFinite(state.maxItems) ? findPrimaryCollection(value)?.path ?? null : null;

  let bounded = boundValue(value, state);
  if (bounded === undefined) bounded = isPlainObject(value) ? {} : null;
  if (state.truncated && isPlainObject(bounded)) {
    bounded.truncated = true;
    if (state.pages.length > 0) {
      const pages = state.pages.slice(0, 8);
      bounded.pagination = {
        offset: state.offset,
        limit: state.maxItems,
        collections: pages,
        ...(state.pages.length > pages.length && { omittedCollections: state.pages.length - pages.length })
      };
      const nextOffsets = pages.filter(page => page.hasMore).map(page => page.nextOffset);
      if (nextOffsets.length > 0) {
        const nextOffset = Math.min(...nextOffsets);
        bounded.continuation = {
          hasMore: true,
          ...(continuationTool && { tool: continuationTool }),
          nextOffset,
          arguments: {
            ...(continuationArguments || {}),
            offset: nextOffset,
            maxItems: state.maxItems,
            maxTokens: continuationArguments?.maxTokens ?? Math.floor(normalizedMaxChars / 4)
          },
          cliArguments: [
            '--offset', String(nextOffset),
            '--max-lines', String(state.maxItems),
            '--max-tokens', String(Math.floor(normalizedMaxChars / 4))
          ],
          hint: 'Call the same tool with continuation.arguments (or rerun the CLI with continuation.cliArguments).'
        };
      }
    } else {
      bounded.continuation = {
        hasMore: true,
        nextOffset: null,
        hint: 'The token budget was exhausted. Narrow the query or request a larger maxTokens budget.'
      };
    }
  }

  let compact = JSON.stringify(bounded);
  // Very small explicit budgets may not have room for full continuation
  // guidance. Preserve valid JSON and the essential truncation signal first.
  if (compact.length > normalizedMaxChars && isPlainObject(bounded)) {
    delete bounded.continuation;
    delete bounded.pagination;
    compact = JSON.stringify(bounded);
  }
  const formatted = pretty ? JSON.stringify(bounded, null, 2) : compact;
  return {
    text: formatted.length <= normalizedMaxChars ? formatted : compact,
    value: bounded,
    truncated: state.truncated
  };
}

// ─────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────

function configuredLimit(value) {
  // Configured limits are defaults/ceilings, so null/zero/negative disables
  // them. Explicit CLI `-l 0` remains supported as a one-off empty result.
  return Number.isInteger(value) && value > 0 ? value : Infinity;
}

export function parseCommonArgs(args, { outputConfig = getConfig('output') || {} } = {}) {
  if (process.env.TOKENLEAN_MCP_RESPONSE_BUDGET === '1') outputConfig = {};
  const options = {
    maxLines: configuredLimit(outputConfig.maxLines),
    maxTokens: configuredLimit(outputConfig.maxTokens),
    offset: 0,
    maxLinesExplicit: false,
    maxTokensExplicit: false,
    json: outputConfig.format === 'json',
    quiet: false,
    help: false,
    remaining: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--max-lines' || arg === '-l') {
      const n = parseInt(args[++i], 10);
      options.maxLines = Number.isInteger(n) ? n : Infinity;
      options.maxLinesExplicit = true;
    } else if (arg === '--max-tokens' || arg === '-t') {
      const n = parseInt(args[++i], 10);
      options.maxTokens = Number.isInteger(n) ? n : Infinity;
      options.maxTokensExplicit = true;
    } else if (arg === '--offset') {
      const n = parseInt(args[++i], 10);
      options.offset = Number.isInteger(n) && n >= 0 ? n : 0;
    } else if (arg === '--json' || arg === '-j') {
      options.json = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.remaining.push(arg);
    }
  }

  return options;
}

export const COMMON_OPTIONS_HELP = `
Common options:
  --max-lines N, -l N   Limit output to N lines
  --max-tokens N, -t N  Limit output to ~N tokens
  --offset N             Skip N structured items/lines (JSON pagination)
  --json, -j            Output as JSON (for piping)
  --quiet, -q           Minimal output (no headers/stats)
  --help, -h            Show help`;

// ─────────────────────────────────────────────────────────────
// Output Builder
// ─────────────────────────────────────────────────────────────

export class Output {
  constructor(options = {}) {
    this.options = {
      maxLines: options.maxLines ?? Infinity,
      maxTokens: options.maxTokens ?? Infinity,
      offset: options.offset ?? 0,
      json: options.json ?? false,
      quiet: options.quiet ?? false
    };

    this.lines = [];
    this.data = {};        // For JSON output
    this.truncated = false;
    this.totalLines = 0;
    this._charLen = 0;     // Running length of lines.join('\n') — avoids O(n²) re-join on every add
  }

  // Push a line and keep the running char-length in sync (incl. the '\n' separator)
  _pushLine(text) {
    this._charLen += (this.lines.length ? 1 : 0) + text.length;
    this.lines.push(text);
  }

  // Add a header line (skipped in quiet mode)
  header(text) {
    if (!this.options.quiet) {
      this._pushLine(text);
    }
    return this;
  }

  // Add a blank line (skipped in quiet mode)
  blank() {
    if (!this.options.quiet) {
      this._pushLine('');
    }
    return this;
  }

  // Add content lines (respects limits)
  add(text) {
    this.totalLines++;

    if (this.truncated) return this;

    // Check token limit (running counter, not a full re-join)
    const currentTokens = Math.ceil(this._charLen / 4);
    const newTokens = estimateTokens(text);

    if (currentTokens + newTokens > this.options.maxTokens) {
      this.truncated = true;
      return this;
    }

    // Check line limit
    if (this.lines.length >= this.options.maxLines) {
      this.truncated = true;
      return this;
    }

    this._pushLine(text);
    return this;
  }

  // Add multiple lines at once
  addLines(textArray) {
    for (const line of textArray) {
      this.add(line);
      if (this.truncated) break;
    }
    return this;
  }

  // Add a section with title and items
  section(title, items, formatter = (x) => x) {
    if (items.length === 0) return this;

    this.add(title);
    for (const item of items) {
      this.add(formatter(item));
      if (this.truncated) break;
    }
    this.blank();
    return this;
  }

  // Set data for JSON output
  setData(key, value) {
    this.data[key] = value;
    return this;
  }

  // Add stats footer (skipped in quiet mode)
  stats(text) {
    if (!this.options.quiet && !this.truncated) {
      this._pushLine(text);
    }
    return this;
  }

  // Render the output
  render() {
    if (this.options.json) {
      const maxChars = Math.min(
        DEFAULT_MAX_STRUCTURED_CHARS,
        Number.isFinite(this.options.maxTokens) ? Math.max(64, this.options.maxTokens * 4) : Infinity
      );
      const structuredData = {
        ...this.data,
        truncated: this.truncated,
        totalItems: this.totalLines
      };
      if (!structuredData.resultState) {
        structuredData.resultState = inferMcpResultState(structuredData);
      }
      const bounded = stringifyBoundedJson(structuredData, {
        maxChars,
        maxItems: this.options.maxLines,
        offset: this.options.offset
      });

      return bounded.text;
    }

    let output = this.lines.join('\n');

    if (this.truncated) {
      const remaining = this.totalLines - this.lines.length;
      if (remaining > 0) {
        output += `\n\n... truncated (${remaining} more lines)`;
      } else {
        output += '\n\n... truncated';
      }
    }

    return output;
  }

  // Print to stdout
  print() {
    console.log(this.render());
  }
}

// ─────────────────────────────────────────────────────────────
// Convenience function for simple outputs
// ─────────────────────────────────────────────────────────────

export function createOutput(options) {
  return new Output(options);
}

// ─────────────────────────────────────────────────────────────
// Table formatting
// ─────────────────────────────────────────────────────────────

export function formatTable(rows, options = {}) {
  if (rows.length === 0) return [];

  const { indent = '', separator = '  ' } = options;

  // Calculate column widths
  const colWidths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = String(cell).length;
      colWidths[i] = Math.max(colWidths[i] || 0, len);
    });
  }

  // Format rows
  return rows.map(row => {
    const cells = row.map((cell, i) => {
      const str = String(cell);
      // Right-align numbers, left-align text
      if (typeof cell === 'number' || /^[\d,.]+[kMG]?$/.test(str)) {
        return str.padStart(colWidths[i]);
      }
      return str.padEnd(colWidths[i]);
    });
    return indent + cells.join(separator);
  });
}
