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
      // struct / interface (may have a body)
      symbols.types.push(trimmed.replace(/\s*\{.*$/, ''));
    } else if (trimmed.match(/^type\s+\w+\s+func\s*\(/)) {
      // func-typed type decl: type Handler func(...)
      symbols.types.push(trimmed.replace(/\s*\{.*$/, ''));
    } else if (trimmed.match(/^type\s+\w+\s*=\s*/)) {
      // type alias: type MyInt = int
      symbols.types.push(trimmed.replace(/\s*\{.*$/, ''));
    } else if (trimmed.match(/^type\s+\w+\s+map\[/)) {
      // map type: type StringMap map[K]V
      symbols.types.push(trimmed.replace(/\s*\{.*$/, ''));
    }

    if (trimmed.match(/^func\s+/)) {
      symbols.functions.push(trimmed.replace(/\s*\{.*$/, ''));
    }
  }

  return symbols;
}
