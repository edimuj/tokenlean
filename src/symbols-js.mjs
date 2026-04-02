/**
 * JavaScript/TypeScript symbol extraction for tl-symbols.
 *
 * Pure functions: content string → symbols object.
 */

/**
 * Join multi-line signatures into single logical lines.
 * When a line has unbalanced parens, accumulate subsequent lines until balanced.
 */
export function joinMultiLineSignatures(lines) {
  const result = [];
  let accumulator = '';
  let parenDepth = 0;
  let angleDepth = 0;
  let accumLines = 0;
  const MAX_ACCUM = 10;

  for (const line of lines) {
    const trimmed = line.trim();

    // Don't join inside block comments or empty lines
    if (!accumulator && (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))) {
      result.push(line);
      continue;
    }

    if (accumulator) {
      accumulator += ' ' + trimmed;
      accumLines++;
    } else {
      // Only start accumulating on signature-like lines
      accumulator = line;
      accumLines = 1;
    }

    // Count parens and angle brackets (for generics) in this line
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '<') angleDepth++;
      else if (ch === '>') angleDepth--;
    }

    // Flush when both parens and generic angle brackets are balanced,
    // or when we've accumulated too many lines.
    if ((parenDepth <= 0 && angleDepth <= 0) || accumLines >= MAX_ACCUM) {
      result.push(accumulator);
      accumulator = '';
      parenDepth = 0;
      angleDepth = 0;
      accumLines = 0;
    }
  }

  // Flush any remaining
  if (accumulator) result.push(accumulator);
  return result;
}

function finalizeJsContainer(container, symbols) {
  if (container.type === 'class') {
    symbols.classes.push({ signature: container.signature, methods: container.items });
  } else if (container.type === 'enum') {
    const values = container.items;
    const MAX_INLINE = 6;
    let enumStr = container.signature;
    if (values.length > 0) {
      if (values.length <= MAX_INLINE) {
        enumStr += ' { ' + values.join(', ') + ' }';
      } else {
        enumStr += ' { ' + values.slice(0, MAX_INLINE).join(', ') + `, ... +${values.length - MAX_INLINE} more }`;
      }
    }
    symbols.types.push(enumStr);
    if (container.exported) symbols.exports.push(enumStr);
  } else {
    // interface or type literal
    symbols.types.push({ signature: container.signature, members: container.items });
    if (container.exported) symbols.exports.push(container.signature);
  }
}

/**
 * Find the position of a character outside balanced parens.
 * Scans left-to-right. Returns -1 if not found.
 */
export function findOutsideParens(str, char) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    // Skip > that's part of => (arrow, not generic closer)
    if (ch === '=' && i + 1 < str.length && str[i + 1] === '>') {
      if (depth === 0 && char === '=') return i; // looking for = and found =>
      i++; // skip the >
      continue;
    }
    if (ch === '(' || ch === '<') depth++;
    else if (ch === ')' || ch === '>') depth--;
    else if (ch === char && depth === 0) return i;
  }
  return -1;
}

/**
 * Find the last `=>` that's outside balanced parens (scanning right-to-left).
 * Returns the index of `=` in `=>`, or -1.
 */
export function findLastArrowOutsideParens(str) {
  let depth = 0;
  for (let i = str.length - 1; i >= 1; i--) {
    const ch = str[i];
    // Check => before depth tracking (> is part of => not a generic closer)
    if (ch === '>' && str[i - 1] === '=' && depth === 0) {
      return i - 1;
    }
    if (ch === ')' || ch === '>') depth++;
    else if (ch === '(' || ch === '<') depth--;
  }
  return -1;
}

export function extractSignatureLine(line) {
  let sig = line.trim();

  // 1. Strip block body: everything from { onwards (outside parens)
  const bracePos = findOutsideParens(sig, '{');
  if (bracePos !== -1) {
    sig = sig.slice(0, bracePos).trim();
  }

  // 2. Strip arrow body: keep `=>` stub but drop the expression/block body
  const arrowPos = findLastArrowOutsideParens(sig);
  if (arrowPos !== -1) {
    sig = sig.slice(0, arrowPos).trim() + ' =>';
  }

  // 3. Strip top-level value assignment (not inside parens, not arrow functions)
  if (!sig.includes('=>')) {
    const eqPos = findOutsideParens(sig, '=');
    if (eqPos !== -1 && sig[eqPos + 1] !== '=') {
      sig = sig.slice(0, eqPos).trim();
    }
  }

  sig = sig.replace(/[,;]$/, '').replace(/\s{2,}/g, ' ').trim();
  return sig;
}

export function extractJsSymbols(content, exportsOnly = false) {
  const symbols = {
    exports: [],
    classes: [],
    functions: [],
    types: [],
    constants: []
  };

  const rawLines = content.split('\n');
  const lines = joinMultiLineSignatures(rawLines);
  let container = null; // { type: 'class'|'interface'|'type'|'enum', signature, items: [], exported }
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || !trimmed) {
      continue;
    }

    // Track brace depth for scope
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check if we're exiting a container
    if (container && braceDepth === 1 && closeBraces > openBraces) {
      finalizeJsContainer(container, symbols);
      container = null;
    }

    const prevBraceDepth = braceDepth;
    braceDepth += openBraces - closeBraces;

    // Inside a container: collect items at first level, skip deeper
    if (container && prevBraceDepth >= 1) {
      if (prevBraceDepth === 1) {
        if (container.type === 'class') {
          // Arrow function class properties (before method regex)
          if (trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?\w+\s*=\s*(?:async\s+)?\(/)) {
            const sig = trimmed.replace(/=>\s*\{?\s*$/, '=>').replace(/=>.*$/, '=>').trim();
            if (sig.includes('=>')) {
              container.items.push(sig);
            }
          }
          // Constructor
          else if (trimmed.match(/^constructor\s*\(/)) {
            container.items.push(extractSignatureLine(trimmed));
          }
          // Regular methods
          else if (trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*[(<]/)) {
            const methodName = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)/)?.[1];
            if (methodName && !['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'typeof', 'delete', 'void', 'yield', 'await'].includes(methodName)) {
              if (!trimmed.includes('=') || trimmed.includes('=>')) {
                container.items.push(extractSignatureLine(trimmed));
              }
            }
          }
        } else if (container.type === 'enum') {
          const cleaned = trimmed.replace(/\/\/.*$/, '').replace(/,\s*$/, '').trim();
          if (cleaned && cleaned !== '}') {
            container.items.push(cleaned);
          }
        } else {
          // interface or type literal: collect members
          const cleaned = trimmed.replace(/[;,]\s*$/, '').trim();
          if (cleaned) {
            container.items.push(cleaned);
          }
        }
      }
      continue;
    }

    // Export statements
    if (trimmed.startsWith('export ')) {
      if (trimmed.includes('export default')) {
        const match = trimmed.match(/export\s+default\s+(?:class|function|async\s+function)?\s*(\w+)?/);
        if (match) {
          symbols.exports.push(trimmed.replace(/\s*\{.*$/, '').trim());
        }
      }
      else if (trimmed.match(/export\s+\{[^}]+\}\s+from/)) {
        symbols.exports.push(trimmed);
      }
      else if (trimmed.match(/export\s+\*\s+from/)) {
        symbols.exports.push(trimmed);
      }
      else if (trimmed.match(/export\s+interface\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (braceDepth > 0) {
          container = { type: 'interface', signature: sig, items: [], exported: true };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
          symbols.exports.push(sig);
        }
      }
      else if (trimmed.match(/export\s+type\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (trimmed.match(/=\s*\{/) && braceDepth > 0) {
          container = { type: 'type', signature: sig, items: [], exported: true };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
          symbols.exports.push(sig);
        }
      }
      else if (trimmed.match(/export\s+(?:abstract\s+)?class\s+/)) {
        const sig = extractSignatureLine(trimmed);
        container = { type: 'class', signature: sig, items: [], exported: true };
        braceDepth = openBraces - closeBraces;
      }
      else if (trimmed.match(/export\s+(?:async\s+)?function\s+/)) {
        const sig = extractSignatureLine(trimmed);
        symbols.functions.push(sig);
        symbols.exports.push(sig);
      }
      else if (trimmed.match(/export\s+const\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (trimmed.includes('=>') || trimmed.match(/:\s*\([^)]*\)\s*=>/)) {
          symbols.functions.push(sig);
        } else {
          symbols.constants.push(sig);
        }
        symbols.exports.push(sig);
      }
      else if (trimmed.match(/export\s+(?:const\s+)?enum\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (braceDepth > 0) {
          container = { type: 'enum', signature: sig, items: [], exported: true };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
          symbols.exports.push(sig);
        }
      }
    }
    // Non-exported symbols
    else if (!exportsOnly) {
      if (trimmed.match(/^interface\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (braceDepth > 0) {
          container = { type: 'interface', signature: sig, items: [], exported: false };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
        }
      }
      else if (trimmed.match(/^type\s+\w+/)) {
        const sig = extractSignatureLine(trimmed);
        if (trimmed.match(/=\s*\{/) && braceDepth > 0) {
          container = { type: 'type', signature: sig, items: [], exported: false };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
        }
      }
      else if (trimmed.match(/^(?:const\s+)?enum\s+/)) {
        const sig = extractSignatureLine(trimmed);
        if (braceDepth > 0) {
          container = { type: 'enum', signature: sig, items: [], exported: false };
          braceDepth = openBraces - closeBraces;
        } else {
          symbols.types.push(sig);
        }
      }
      else if (trimmed.match(/^(?:abstract\s+)?class\s+/)) {
        const sig = extractSignatureLine(trimmed);
        container = { type: 'class', signature: sig, items: [], exported: false };
        braceDepth = openBraces - closeBraces;
      }
      else if (trimmed.match(/^(?:async\s+)?function\s+/)) {
        symbols.functions.push(extractSignatureLine(trimmed));
      }
      else if (braceDepth === 0 && trimmed.match(/^const\s+\w+.*=.*=>/)) {
        symbols.functions.push(extractSignatureLine(trimmed));
      }
    }
  }

  // Handle last container if file ends inside one
  if (container) {
    finalizeJsContainer(container, symbols);
  }

  return symbols;
}

export function filterExportsOnlySymbols(symbols) {
  return {
    ...symbols,
    classes: (symbols.classes || []).filter(cls => cls.signature.startsWith('export')),
    functions: (symbols.functions || []).filter(sig => sig.startsWith('export')),
    types: (symbols.types || []).filter(entry => {
      const sig = typeof entry === 'string' ? entry : entry.signature;
      return typeof sig === 'string' && sig.startsWith('export');
    }),
    constants: (symbols.constants || []).filter(sig => sig.startsWith('export'))
  };
}
