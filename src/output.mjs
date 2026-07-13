/**
 * Shared output utilities for tokenlean CLI tools
 *
 * Centralizes output formatting, truncation, and common options.
 */

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

function consume(state, chars) {
  if (chars > state.remainingChars) return false;
  state.remainingChars -= chars;
  return true;
}

function boundedString(value, state) {
  let candidate = value;

  if (Number.isFinite(state.remainingItems) && candidate.includes('\n')) {
    const keep = Math.max(0, state.remainingItems);
    let end = 0;
    let linesSeen = 1;
    while (linesSeen <= keep) {
      const newline = candidate.indexOf('\n', end);
      if (newline === -1) break;
      end = newline + 1;
      linesSeen++;
    }
    if (linesSeen > keep || (keep === 0 && candidate.length > 0)) {
      candidate = `${candidate.slice(0, keep === 0 ? 0 : end)}... [truncated]`;
      state.remainingItems = 0;
      state.truncated = true;
    } else {
      state.remainingItems -= linesSeen;
    }
  }

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

function boundValue(value, state) {
  if (typeof value === 'string') return boundedString(value, state);

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const encoded = JSON.stringify(value);
    if (!consume(state, encoded.length)) {
      state.truncated = true;
      return undefined;
    }
    return value;
  }

  if (typeof value === 'bigint') {
    return boundedString(String(value), state);
  }

  if (Array.isArray(value)) {
    if (!consume(state, 2)) {
      state.truncated = true;
      return undefined;
    }
    const result = [];
    for (const item of value) {
      if (Number.isFinite(state.remainingItems)) {
        if (state.remainingItems <= 0) {
          state.truncated = true;
          break;
        }
        state.remainingItems--;
      }
      if (result.length > 0 && !consume(state, 1)) {
        state.truncated = true;
        break;
      }
      const bounded = boundValue(item, state);
      if (bounded === undefined) {
        state.truncated = true;
        break;
      }
      result.push(bounded);
    }
    if (result.length < value.length) state.truncated = true;
    return result;
  }

  if (isPlainObject(value)) {
    if (!consume(state, 2)) {
      state.truncated = true;
      return undefined;
    }
    const result = {};
    const entries = Object.entries(value);
    let resultSize = 0;
    for (const [key, item] of entries) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      const prefixSize = (resultSize > 0 ? 1 : 0) + JSON.stringify(key).length + 1;
      if (!consume(state, prefixSize)) {
        state.truncated = true;
        break;
      }
      const bounded = boundValue(item, state);
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
  pretty = true
} = {}) {
  const normalizedMaxChars = Number.isFinite(maxChars)
    ? Math.max(64, Math.floor(maxChars))
    : DEFAULT_MAX_STRUCTURED_CHARS;
  const state = {
    // Reserve room for the truncation marker and container punctuation without
    // consuming the entire budget when callers intentionally request a very
    // small structured response.
    remainingChars: Math.max(0, normalizedMaxChars - Math.min(128, Math.floor(normalizedMaxChars / 3))),
    remainingItems: Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity,
    truncated: false
  };

  let bounded = boundValue(value, state);
  if (bounded === undefined) bounded = isPlainObject(value) ? {} : null;
  if (state.truncated && isPlainObject(bounded)) bounded.truncated = true;

  const compact = JSON.stringify(bounded);
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

export function parseCommonArgs(args) {
  const options = {
    maxLines: Infinity,
    maxTokens: Infinity,
    json: false,
    quiet: false,
    help: false,
    remaining: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--max-lines' || arg === '-l') {
      const n = parseInt(args[++i], 10);
      options.maxLines = Number.isInteger(n) ? n : Infinity;
    } else if (arg === '--max-tokens' || arg === '-t') {
      const n = parseInt(args[++i], 10);
      options.maxTokens = Number.isInteger(n) ? n : Infinity;
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
      const bounded = stringifyBoundedJson({
        ...this.data,
        truncated: this.truncated,
        totalItems: this.totalLines
      }, {
        maxChars,
        maxItems: this.options.maxLines
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
