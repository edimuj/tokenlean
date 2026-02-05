/**
 * Shared output utilities for tokenlean CLI tools
 *
 * Centralizes output formatting, truncation, and common options.
 */

// ─────────────────────────────────────────────────────────────
// Shell Escaping
// ─────────────────────────────────────────────────────────────

/**
 * Escape a string for safe use in shell double-quoted strings
 * Handles: $ ` \ " !
 */
export function shellEscape(str) {
  return str.replace(/[`$"\\!]/g, '\\$&');
}

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
      options.maxLines = parseInt(args[++i], 10) || Infinity;
    } else if (arg === '--max-tokens' || arg === '-t') {
      options.maxTokens = parseInt(args[++i], 10) || Infinity;
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
  }

  // Add a header line (skipped in quiet mode)
  header(text) {
    if (!this.options.quiet) {
      this.lines.push(text);
    }
    return this;
  }

  // Add a blank line (skipped in quiet mode)
  blank() {
    if (!this.options.quiet) {
      this.lines.push('');
    }
    return this;
  }

  // Add content lines (respects limits)
  add(text) {
    this.totalLines++;

    if (this.truncated) return this;

    // Check token limit
    const currentTokens = estimateTokens(this.lines.join('\n'));
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

    this.lines.push(text);
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
      this.lines.push(text);
    }
    return this;
  }

  // Render the output
  render() {
    if (this.options.json) {
      return JSON.stringify({
        ...this.data,
        truncated: this.truncated,
        totalItems: this.totalLines
      }, null, 2);
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
