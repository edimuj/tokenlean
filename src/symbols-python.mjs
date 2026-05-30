/**
 * Python symbol extraction for tl-symbols.
 *
 * Pure function: content string → symbols object.
 */

/**
 * Count net paren depth contributed by a Python source line, ignoring parens
 * inside string literals and comments.
 */
function pythonLineParenDelta(text) {
  let delta = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Line comment
    if (ch === '#') break;

    // Triple-quoted strings (both ''' and """)
    const triple = text.slice(i, i + 3);
    if (triple === '"""' || triple === "'''") {
      const q = triple;
      i += 3;
      while (i < text.length && text.slice(i, i + 3) !== q) i++;
      i += 3;
      continue;
    }

    // Single-quoted strings
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    if (ch === '(') delta++;
    else if (ch === ')') delta--;
    i++;
  }

  return delta;
}

/**
 * Join multi-line Python def/class signatures into single lines.
 * E.g. `def f(\n  x,\n  y,\n):` becomes `def f(  x,  y,):`.
 */
function joinPythonMultiLineSignatures(lines) {
  const result = [];
  let accumulator = null;
  let parenDepth = 0;
  const MAX_ACCUM = 15;
  let accumLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (accumulator === null) {
      // Only start joining on def/class/async def lines
      if (!trimmed.startsWith('def ') && !trimmed.startsWith('async def ') && !trimmed.startsWith('class ')) {
        result.push(line);
        continue;
      }
      accumulator = line;
      parenDepth = pythonLineParenDelta(trimmed);
      accumLines = 1;
    } else {
      accumulator += ' ' + trimmed;
      parenDepth += pythonLineParenDelta(trimmed);
      accumLines++;
    }

    if (parenDepth <= 0 || accumLines >= MAX_ACCUM) {
      result.push(accumulator);
      accumulator = null;
      parenDepth = 0;
      accumLines = 0;
    }
  }

  if (accumulator !== null) result.push(accumulator);
  return result;
}

export function extractPythonSymbols(content) {
  const symbols = { classes: [], functions: [], all: null };
  const lines = joinPythonMultiLineSignatures(content.split('\n'));
  let inClass = null;
  let currentClassMethods = [];
  let currentClassFields = [];
  let isDataclass = false;
  let isEnumClass = false;
  let isNextDataclass = false;

  // Parse __all__ (single-line or multi-line)
  const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (allMatch) {
    symbols.all = allMatch[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }

  function pushCurrentClass() {
    if (!inClass) return;
    const cls = { signature: inClass, methods: currentClassMethods };
    if (currentClassFields.length > 0) {
      cls.fields = currentClassFields;
      cls.isEnum = isEnumClass;
    }
    symbols.classes.push(cls);
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Track @dataclass decorator
    if (trimmed === '@dataclass' || trimmed.startsWith('@dataclass(') || trimmed.startsWith('@dataclasses.dataclass')) {
      isNextDataclass = true;
      continue;
    }
    // Skip other decorators (preserve isNextDataclass flag)
    if (trimmed.startsWith('@')) continue;

    const classMatch = trimmed.match(/^class\s+(\w+)(?:\([^)]*\))?:/);
    if (classMatch) {
      pushCurrentClass();
      inClass = trimmed.replace(/:$/, '').replace(/\s{2,}/g, ' ');
      isDataclass = isNextDataclass;
      isEnumClass = /\((?:\w+\.)?(Enum|IntEnum|StrEnum|Flag|IntFlag)\)/.test(trimmed);
      isNextDataclass = false;
      currentClassMethods = [];
      currentClassFields = [];
      continue;
    }

    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/);
    if (funcMatch) {
      const sig = trimmed.replace(/:$/, '').replace(/\s{2,}/g, ' ');
      if (inClass && line.startsWith('    ')) {
        currentClassMethods.push(sig);
      } else {
        pushCurrentClass();
        inClass = null;
        currentClassMethods = [];
        currentClassFields = [];
        symbols.functions.push(sig);
      }
      continue;
    }

    // Inside a class: collect fields (dataclass fields or enum values)
    if (inClass && line.startsWith('    ') && !line.startsWith('        ')) {
      if (isDataclass && trimmed.match(/^\w+\s*:/)) {
        currentClassFields.push(trimmed);
      } else if (isEnumClass && trimmed.match(/^\w+\s*=/)) {
        currentClassFields.push(trimmed);
      }
    }
  }

  pushCurrentClass();

  // When __all__ is defined, filter to only public API symbols
  if (symbols.all) {
    const allowed = new Set(symbols.all);
    symbols.classes = symbols.classes.filter(c => {
      const name = c.signature.match(/^class\s+(\w+)/)?.[1];
      return name && allowed.has(name);
    });
    symbols.functions = symbols.functions.filter(f => {
      const name = f.match(/^(?:async\s+)?def\s+(\w+)/)?.[1];
      return name && allowed.has(name);
    });
  }

  return symbols;
}
