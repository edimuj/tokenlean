/**
 * Go symbol extraction for tl-symbols.
 *
 * Pure function: content string → symbols object.
 */

export function extractGoSymbols(content) {
  const symbols = { types: [], functions: [] };
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.match(/^type\s+\w+\s+(?:struct|interface)/)) {
      symbols.types.push(trimmed.replace(/\s*\{.*$/, ''));
    }

    if (trimmed.match(/^func\s+/)) {
      symbols.functions.push(trimmed.replace(/\s*\{.*$/, ''));
    }
  }

  return symbols;
}
