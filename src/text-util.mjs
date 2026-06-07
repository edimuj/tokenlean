// Small generic text/formatting helpers shared across CLI tools.

// Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from a string.
export function stripAnsi(str) {
  return String(str).replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\|\x1b[^[\]]/g,
    ''
  );
}

// Format a duration in milliseconds as a compact human-readable string.
export function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

// Quote a value for safe display inside a shell command string.
export function shellQuote(value) {
  if (!value) return '""';
  if (/^[\w@./:=+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

// Parse a JSON string, returning null instead of throwing on invalid input.
export function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Count opening/closing braces on a single line of JS/TS source, ignoring
// braces inside string literals (single/double/template) and after a `//`
// line comment. Used to track block nesting when extracting function bodies.
export function countBraces(line) {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    // Skip escaped characters
    if (prev === '\\') continue;

    if (inLineComment) break;

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && line[i + 1] === '/') { inLineComment = true; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '`') { inTemplate = true; continue; }
      if (ch === '{') open++;
      if (ch === '}') close++;
    } else if (inSingle && ch === "'") {
      inSingle = false;
    } else if (inDouble && ch === '"') {
      inDouble = false;
    } else if (inTemplate && ch === '`') {
      inTemplate = false;
    }
  }

  return { open, close };
}
