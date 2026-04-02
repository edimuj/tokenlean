/**
 * Python symbol extraction for tl-symbols.
 *
 * Pure function: content string → symbols object.
 */

export function extractPythonSymbols(content) {
  const symbols = { classes: [], functions: [], all: null };
  const lines = content.split('\n');
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
      inClass = trimmed.replace(/:$/, '');
      isDataclass = isNextDataclass;
      isEnumClass = /\((?:\w+\.)?(Enum|IntEnum|StrEnum|Flag|IntFlag)\)/.test(trimmed);
      isNextDataclass = false;
      currentClassMethods = [];
      currentClassFields = [];
      continue;
    }

    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/);
    if (funcMatch) {
      const sig = trimmed.replace(/:$/, '');
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
