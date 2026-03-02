#!/usr/bin/env node

/**
 * tl-symbols - Extract function/class/type signatures without bodies
 *
 * Shows the API surface of a file in minimal tokens - signatures only,
 * no implementation details. Perfect for understanding what a file
 * provides without reading the whole thing.
 *
 * Usage: tl-symbols <file> [--exports-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-symbols',
    desc: 'Function/class signatures without bodies',
    when: 'before-read',
    example: 'tl-symbols src/utils.ts'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { extractGenericSymbols } from '../src/generic-lang.mjs';
import { shouldSkip } from '../src/project.mjs';

const HELP = `
tl-symbols - Extract function/class/type signatures without bodies

Usage: tl-symbols <file|dir...> [options]

Options:
  --exports-only, -e    Show only exported symbols
  --filter <type>       Show only: function, class, type, constant, export
${COMMON_OPTIONS_HELP}

Multi-file mode:
  Multiple files or a directory produce compact one-line-per-file output.
  Format: path: name1(), name2(), ClassName(3m), +N

Examples:
  tl-symbols src/api.ts              # All symbols (detailed)
  tl-symbols src/api.ts src/db.ts    # Multiple files (compact)
  tl-symbols src/                    # All files in directory
  tl-symbols src/ -e                 # Exports only, all files
  tl-symbols src/api.ts -e           # Exports only
  tl-symbols src/api.ts -j           # JSON output

Supported languages:
  JavaScript/TypeScript (.js, .ts, .jsx, .tsx, .mjs)
  Python (.py)
  Go (.go)
  Rust (.rs)
  Ruby (.rb)
  Other languages: generic regex-based extraction (best-effort)
`;

// ─────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────

const LANG_EXTENSIONS = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb']
};

function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// JavaScript/TypeScript Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Join multi-line signatures into single logical lines.
 * When a line has unbalanced parens, accumulate subsequent lines until balanced.
 */
function joinMultiLineSignatures(lines) {
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

function extractJsSymbols(content, exportsOnly = false) {
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

/**
 * Find the position of a character outside balanced parens.
 * Scans left-to-right. Returns -1 if not found.
 */
function findOutsideParens(str, char) {
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
function findLastArrowOutsideParens(str) {
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

function extractSignatureLine(line) {
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

// ─────────────────────────────────────────────────────────────
// Python Extraction
// ─────────────────────────────────────────────────────────────

function extractPythonSymbols(content) {
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

// ─────────────────────────────────────────────────────────────
// Go Extraction
// ─────────────────────────────────────────────────────────────

function extractGoSymbols(content) {
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

// ─────────────────────────────────────────────────────────────
// Rust Extraction
// ─────────────────────────────────────────────────────────────

function extractRustSymbols(content) {
  const symbols = {
    classes: [],   // structs + enums
    functions: [], // top-level fn + macro_rules!
    types: [],     // type aliases
    constants: [], // const + static
    modules: [],   // mod declarations
    impls: []      // trait impl summary lines
  };

  const lines = content.split('\n');
  let braceDepth = 0;
  let pendingDerive = null; // #[derive(...)] waiting for struct/enum

  // Current container: struct, enum, trait, or impl
  let container = null;
  // { kind: 'struct'|'enum'|'trait'|'impl', sig, items, derive, implFor, implType, containerDepth }

  // Map from type name -> class entry index (for attaching inherent impl methods)
  const structMap = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and line comments
    if (!trimmed || trimmed.startsWith('//')) continue;

    // Capture #[derive(...)]
    const deriveMatch = trimmed.match(/^#\[derive\(([^)]+)\)\]/);
    if (deriveMatch) {
      pendingDerive = deriveMatch[1].trim();
      continue;
    }
    // Skip other attributes
    if (trimmed.startsWith('#[')) continue;

    // Count braces
    let lineOpen = 0, lineClose = 0;
    let inStr = false, strChar = '';
    for (let j = 0; j < trimmed.length; j++) {
      const ch = trimmed[j];
      if (inStr) { if (ch === strChar && trimmed[j - 1] !== '\\') inStr = false; continue; }
      if (ch === '"' || ch === '\'') { inStr = true; strChar = ch; continue; }
      if (ch === '/' && trimmed[j + 1] === '/') break; // rest is comment
      if (ch === '{') lineOpen++;
      else if (ch === '}') lineClose++;
    }

    const prevDepth = braceDepth;
    braceDepth += lineOpen - lineClose;

    // Exiting a container
    if (container && braceDepth <= container.containerDepth) {
      finalizeRustContainer(container, symbols, structMap);
      container = null;
    }

    // Inside a container: collect items at depth containerDepth+1
    if (container && prevDepth >= container.containerDepth + 1) {
      if (prevDepth === container.containerDepth + 1) {
        collectRustContainerItem(trimmed, container);
      }
      continue;
    }

    // Top-level declarations (prevDepth === 0 or entering a new container)
    if (prevDepth === 0) {
      // struct
      const structMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?/);
      if (structMatch) {
        const vis = structMatch[1]?.trim() || '';
        const name = structMatch[2];
        const sig = (vis ? vis + ' ' : '') + 'struct ' + name;
        // Tuple struct or unit struct (no brace block)
        if (lineOpen === 0 || trimmed.endsWith(';')) {
          const entry = { signature: sig, methods: [], derive: pendingDerive };
          symbols.classes.push(entry);
          structMap.set(name, symbols.classes.length - 1);
          pendingDerive = null;
        } else {
          container = { kind: 'struct', sig, name, items: [], derive: pendingDerive, containerDepth: prevDepth };
          pendingDerive = null;
        }
        continue;
      }

      // enum
      const enumMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?/);
      if (enumMatch) {
        const vis = enumMatch[1]?.trim() || '';
        const name = enumMatch[2];
        const sig = (vis ? vis + ' ' : '') + 'enum ' + name;
        container = { kind: 'enum', sig, name, items: [], derive: pendingDerive, containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // trait
      const traitMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?/);
      if (traitMatch) {
        const vis = traitMatch[1]?.trim() || '';
        const sig = (vis ? vis + ' ' : '') + 'trait ' + traitMatch[2];
        container = { kind: 'trait', sig, items: [], containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // impl
      const implMatch = trimmed.match(/^impl(?:<[^>]*>)?\s+(?:([\w:]+(?:<[^>]*>)?)\s+for\s+)?([\w:]+)(?:<[^>]*>)?/);
      if (implMatch && !trimmed.match(/^(pub|fn|struct|enum|trait|type|const|static|mod|use|macro)/)) {
        const traitName = implMatch[1]?.replace(/<.*>/, '') || null;
        const typeName = implMatch[2];
        container = { kind: 'impl', implFor: traitName, implType: typeName, items: [], containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // fn
      const fnMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
      if (fnMatch) {
        const sig = trimmed.replace(/\s*\{.*$/, '').replace(/\s*where\s+.*$/, '').trim();
        symbols.functions.push(sig);
        pendingDerive = null;
        continue;
      }

      // type alias
      const typeMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?type\s+(\w+)/);
      if (typeMatch) {
        const sig = trimmed.replace(/;$/, '').trim();
        symbols.types.push(sig);
        pendingDerive = null;
        continue;
      }

      // const / static
      const constMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(const|static)\s+(\w+)/);
      if (constMatch) {
        const sig = trimmed.replace(/;$/, '').trim();
        symbols.constants.push(sig);
        pendingDerive = null;
        continue;
      }

      // mod
      const modMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?mod\s+(\w+)/);
      if (modMatch) {
        const vis = modMatch[1]?.trim() || '';
        symbols.modules.push((vis ? vis + ' ' : '') + 'mod ' + modMatch[2]);
        pendingDerive = null;
        continue;
      }

      // macro_rules!
      const macroMatch = trimmed.match(/^macro_rules!\s+(\w+)/);
      if (macroMatch) {
        symbols.functions.push('macro_rules! ' + macroMatch[1]);
        pendingDerive = null;
        continue;
      }
    }
  }

  // Flush last container
  if (container) {
    finalizeRustContainer(container, symbols, structMap);
  }

  return symbols;
}

function collectRustContainerItem(trimmed, container) {
  if (container.kind === 'struct') {
    // Collect field names: "pub name: Type," or "name: Type,"
    const fieldMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(\w+)\s*:/);
    if (fieldMatch) container.items.push(fieldMatch[1]);
  } else if (container.kind === 'enum') {
    // Collect variant names
    const varMatch = trimmed.match(/^(\w+)/);
    if (varMatch) {
      let variant = varMatch[1];
      // Annotate variant shape
      if (trimmed.includes('{')) variant += '{...}';
      else if (trimmed.includes('(')) variant += '(...)';
      container.items.push(variant);
    }
  } else if (container.kind === 'trait') {
    // Collect method signatures
    const fnMatch = trimmed.match(/^(?:async\s+)?fn\s+/);
    if (fnMatch) {
      const sig = trimmed.replace(/\s*\{.*$/, '').replace(/;$/, '').trim();
      container.items.push(sig);
    }
    // Collect associated types
    const typeMatch = trimmed.match(/^type\s+(\w+)/);
    if (typeMatch) {
      container.items.push(trimmed.replace(/;$/, '').trim());
    }
  } else if (container.kind === 'impl') {
    // Collect method signatures
    const fnMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+/);
    if (fnMatch) {
      const sig = trimmed.replace(/\s*\{.*$/, '').replace(/\s*where\s+.*$/, '').trim();
      container.items.push(sig);
    }
  }
}

function finalizeRustContainer(container, symbols, structMap) {
  if (container.kind === 'struct') {
    const entry = { signature: container.sig, methods: [], derive: container.derive };
    if (container.items.length > 0) entry.fields = container.items;
    symbols.classes.push(entry);
    structMap.set(container.name, symbols.classes.length - 1);
  } else if (container.kind === 'enum') {
    const entry = { signature: container.sig, methods: [], derive: container.derive };
    if (container.items.length > 0) entry.variants = container.items;
    symbols.classes.push(entry);
    structMap.set(container.name, symbols.classes.length - 1);
  } else if (container.kind === 'trait') {
    // Traits go to classes with isTrait flag
    symbols.classes.push({ signature: container.sig, methods: container.items, isTrait: true });
  } else if (container.kind === 'impl') {
    if (container.implFor) {
      // Trait impl: summary line under impls
      symbols.impls.push({
        trait: container.implFor,
        type: container.implType,
        methodCount: container.items.length
      });
    } else {
      // Inherent impl: attach methods to the struct/enum
      const idx = structMap.get(container.implType);
      if (idx !== undefined) {
        symbols.classes[idx].methods.push(...container.items);
      } else {
        // Struct defined elsewhere — create a placeholder
        symbols.impls.push({
          trait: null,
          type: container.implType,
          methods: container.items
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Ruby Extraction
// ─────────────────────────────────────────────────────────────

function extractRubySymbols(content) {
  const symbols = {
    classes: [],
    functions: [],
    modules: [],
    constants: []
  };

  const lines = content.split('\n');

  // Scope stack: each entry = { kind: 'class'|'module'|'def'|'block', name, ... }
  const scopeStack = [];
  // Current class/module context
  let currentClass = null; // { sig, methods, attrs, constants, mixins, visibility }
  let classStack = []; // for nested classes

  function pushClass(sig, name) {
    if (currentClass) classStack.push(currentClass);
    currentClass = {
      sig, name,
      methods: [],
      attrs: [],
      constants: [],
      mixins: [],
      visibility: 'public'
    };
  }

  function popClass() {
    if (currentClass) {
      symbols.classes.push(currentClass);
    }
    currentClass = classStack.pop() || null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Module
    const modMatch = trimmed.match(/^module\s+([\w:]+)/);
    if (modMatch) {
      symbols.modules.push('module ' + modMatch[1]);
      pushClass(null, modMatch[1]); // modules can contain methods too
      currentClass.isModule = true;
      currentClass.sig = 'module ' + modMatch[1];
      scopeStack.push({ kind: 'module' });
      continue;
    }

    // Class
    const classMatch = trimmed.match(/^class\s+([\w:]+)(?:\s*<\s*([\w:]+))?/);
    if (classMatch) {
      const name = classMatch[1];
      const parent = classMatch[2];
      const sig = parent ? `class ${name} < ${parent}` : `class ${name}`;
      pushClass(sig, name);
      scopeStack.push({ kind: 'class' });
      continue;
    }

    // def self.method (class method)
    const classMethodMatch = trimmed.match(/^def\s+self\.(\w+[?!=]?)(?:\s*\(([^)]*)\))?/);
    if (classMethodMatch) {
      const params = classMethodMatch[2] || '';
      const methodName = params ? `self.${classMethodMatch[1]}(${params})` : 'self.' + classMethodMatch[1];
      if (currentClass) {
        const vis = currentClass.visibility;
        currentClass.methods.push({ name: methodName, visibility: vis });
      } else {
        symbols.functions.push('def ' + methodName);
      }
      // Only push to scope if it has a body (not one-liner)
      if (!trimmed.includes('; end')) {
        scopeStack.push({ kind: 'def' });
      }
      continue;
    }

    // def method
    const defMatch = trimmed.match(/^def\s+(\w+[?!=]?)(?:\s*\(([^)]*)\))?/);
    if (defMatch) {
      const methodName = defMatch[1];
      const params = defMatch[2] || '';
      if (currentClass) {
        const vis = currentClass.visibility;
        const sig = params ? `${methodName}(${params})` : methodName;
        currentClass.methods.push({ name: sig, visibility: vis });
      } else {
        const sig = params ? `def ${methodName}(${params})` : `def ${methodName}`;
        symbols.functions.push(sig);
      }
      if (!trimmed.includes('; end')) {
        scopeStack.push({ kind: 'def' });
      }
      continue;
    }

    // attr_reader / attr_accessor / attr_writer
    const attrMatch = trimmed.match(/^(attr_reader|attr_accessor|attr_writer)\s+(.+)/);
    if (attrMatch && currentClass) {
      const kind = attrMatch[1];
      const attrs = attrMatch[2].split(',').map(a => a.trim().replace(/^:/, ''));
      currentClass.attrs.push({ kind, names: attrs });
      continue;
    }

    // include / extend
    const mixinMatch = trimmed.match(/^(include|extend)\s+(.+)/);
    if (mixinMatch && currentClass) {
      currentClass.mixins.push({ kind: mixinMatch[1], name: mixinMatch[2].trim() });
      continue;
    }

    // Visibility modifiers (section-style)
    if (currentClass) {
      if (trimmed === 'private' || trimmed === 'private:') { currentClass.visibility = 'private'; continue; }
      if (trimmed === 'protected' || trimmed === 'protected:') { currentClass.visibility = 'protected'; continue; }
      if (trimmed === 'public' || trimmed === 'public:') { currentClass.visibility = 'public'; continue; }
      // Single-method visibility: private :method_name
      const singleVisMatch = trimmed.match(/^(private|protected)\s+:(\w+)/);
      if (singleVisMatch) {
        const method = currentClass.methods.find(m => m.name === singleVisMatch[2] || m.name.startsWith(singleVisMatch[2] + '('));
        if (method) method.visibility = singleVisMatch[1];
        continue;
      }
    }

    // Constants inside class (UPPER_CASE = ...)
    if (currentClass && trimmed.match(/^[A-Z][A-Z_0-9]*\s*=/)) {
      const constName = trimmed.match(/^([A-Z][A-Z_0-9]*)/)[1];
      currentClass.constants.push(constName);
      continue;
    }

    // Top-level constants
    if (!currentClass && trimmed.match(/^[A-Z][A-Z_0-9]*\s*=/)) {
      const constName = trimmed.match(/^([A-Z][A-Z_0-9]*)/)[1];
      symbols.constants.push(constName);
      continue;
    }

    // end keyword — pop scope
    if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#')) {
      const top = scopeStack.pop();
      if (top?.kind === 'class' || top?.kind === 'module') {
        popClass();
      }
      continue;
    }

    // Other block openers that need end-matching: do..end, begin, if/unless/while/for/case at statement level
    // We only track these to correctly match 'end' keywords
    if (isRubyBlockOpener(trimmed)) {
      scopeStack.push({ kind: 'block' });
    }
  }

  // Flush remaining
  while (currentClass) popClass();

  return symbols;
}

function isRubyBlockOpener(trimmed) {
  // Block openers that require a matching 'end'
  // Skip if it's a one-liner (has end on same line)
  if (trimmed.includes('; end')) return false;

  // do..end blocks
  if (trimmed.endsWith(' do') || trimmed.endsWith('{') || trimmed === 'begin') return true;

  // Control structures at statement start (not inline modifiers)
  if (/^(if|unless|while|until|for|case)\s/.test(trimmed)) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

function formatSymbols(symbols, lang, out) {
  if (lang === 'js') {
    if (symbols.exports.length > 0) {
      out.add('Exports:');
      const unique = [...new Set(symbols.exports)];
      unique.forEach(e => out.add('  ' + e));
      out.blank();
    }

    if (symbols.classes.length > 0) {
      out.add('Classes:');
      for (const cls of symbols.classes) {
        out.add('  ' + cls.signature);
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    const nonExportedFuncs = symbols.functions.filter(f => !f.startsWith('export'));
    if (nonExportedFuncs.length > 0) {
      out.add('Functions:');
      nonExportedFuncs.forEach(f => out.add('  ' + f));
      out.blank();
    }

    const typesWithDetail = symbols.types.filter(t => {
      if (typeof t !== 'string') return true; // always show types with members
      return !t.startsWith('export'); // filter exported plain strings (already in Exports)
    });
    if (typesWithDetail.length > 0) {
      out.add('Types:');
      for (const t of typesWithDetail) {
        if (typeof t === 'string') {
          out.add('  ' + t);
        } else {
          out.add('  ' + t.signature);
          t.members.forEach(m => out.add('    ' + m));
        }
      }
      out.blank();
    }

    const nonExportedConsts = symbols.constants.filter(c => !c.startsWith('export'));
    if (nonExportedConsts.length > 0) {
      out.add('Constants:');
      nonExportedConsts.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'python') {
    if (symbols.classes.length > 0) {
      out.add('Classes:');
      for (const cls of symbols.classes) {
        out.add('  ' + cls.signature);
        if (cls.fields && cls.fields.length > 0) {
          if (cls.isEnum) {
            const MAX = 6;
            if (cls.fields.length <= MAX) {
              out.add('    ' + cls.fields.join(', '));
            } else {
              out.add('    ' + cls.fields.slice(0, MAX).join(', ') + `, ... +${cls.fields.length - MAX} more`);
            }
          } else {
            cls.fields.forEach(f => out.add('    ' + f));
          }
        }
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (symbols.functions.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }
  } else if (lang === 'rust') {
    // Modules
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    // Structs, Enums, Traits
    const structs = symbols.classes?.filter(c => !c.isTrait && c.signature.includes('struct')) || [];
    const enums = symbols.classes?.filter(c => !c.isTrait && c.signature.includes('enum')) || [];
    const traits = symbols.classes?.filter(c => c.isTrait) || [];

    if (structs.length > 0 || enums.length > 0) {
      out.add('Structs:');
      for (const s of structs) {
        let line = '  ' + s.signature;
        if (s.derive) line += '  #[derive(' + s.derive + ')]';
        if (s.fields?.length > 0) {
          const MAX = 8;
          const fieldStr = s.fields.length <= MAX
            ? s.fields.join(', ')
            : s.fields.slice(0, MAX).join(', ') + `, +${s.fields.length - MAX}`;
          line += '  { ' + fieldStr + ' }';
        }
        out.add(line);
        s.methods.forEach(m => out.add('    ' + m));
      }
      for (const e of enums) {
        let line = '  ' + e.signature;
        if (e.derive) line += '  #[derive(' + e.derive + ')]';
        if (e.variants?.length > 0) {
          const MAX = 6;
          const varStr = e.variants.length <= MAX
            ? e.variants.join(', ')
            : e.variants.slice(0, MAX).join(', ') + `, +${e.variants.length - MAX}`;
          line += ' { ' + varStr + ' }';
        }
        out.add(line);
        e.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (traits.length > 0) {
      out.add('Traits:');
      for (const t of traits) {
        out.add('  ' + t.signature);
        t.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    // Trait impls (summary)
    const traitImpls = symbols.impls?.filter(i => i.trait) || [];
    const orphanImpls = symbols.impls?.filter(i => !i.trait && i.methods) || [];
    if (traitImpls.length > 0 || orphanImpls.length > 0) {
      out.add('Impls:');
      for (const imp of traitImpls) {
        out.add(`  impl ${imp.trait} for ${imp.type}  (${imp.methodCount} method${imp.methodCount !== 1 ? 's' : ''})`);
      }
      for (const imp of orphanImpls) {
        out.add(`  impl ${imp.type}`);
        imp.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    // Functions
    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    // Types
    if (symbols.types?.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    // Constants
    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'ruby') {
    // Modules
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    // Classes (including module entries that have methods)
    const classEntries = symbols.classes?.filter(c => !c.isModule || c.methods.length > 0 || c.attrs.length > 0) || [];
    if (classEntries.length > 0) {
      out.add('Classes:');
      for (const cls of classEntries) {
        let header = '  ' + cls.sig;
        // Mixins
        const includes = cls.mixins?.filter(m => m.kind === 'include').map(m => m.name) || [];
        const extends_ = cls.mixins?.filter(m => m.kind === 'extend').map(m => m.name) || [];
        const mixinParts = [];
        if (includes.length > 0) mixinParts.push('include ' + includes.join(', '));
        if (extends_.length > 0) mixinParts.push('extend ' + extends_.join(', '));
        if (mixinParts.length > 0) header += '  [' + mixinParts.join(', ') + ']';
        out.add(header);

        // Attrs
        for (const attr of (cls.attrs || [])) {
          out.add('    ' + attr.kind + ' :' + attr.names.join(', :'));
        }

        // Constants
        if (cls.constants?.length > 0) {
          out.add('    ' + cls.constants.join(', '));
        }

        // Methods grouped by visibility
        const publicMethods = cls.methods.filter(m => m.visibility === 'public');
        const privateMethods = cls.methods.filter(m => m.visibility === 'private');
        const protectedMethods = cls.methods.filter(m => m.visibility === 'protected');

        for (const m of publicMethods) {
          out.add('    def ' + m.name);
        }
        if (privateMethods.length > 0) {
          out.add('    private:');
          for (const m of privateMethods) {
            out.add('      def ' + m.name);
          }
        }
        if (protectedMethods.length > 0) {
          out.add('    protected:');
          for (const m of protectedMethods) {
            out.add('      def ' + m.name);
          }
        }
      }
      out.blank();
    }

    // Top-level functions
    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    // Top-level constants
    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'go') {
    if (symbols.types.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    if (symbols.functions.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }
  } else {
    // Generic fallback format
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    if (symbols.classes?.length > 0) {
      out.add('Classes/Structs:');
      for (const cls of symbols.classes) {
        if (cls.fields && cls.fields.length > 0) {
          const MAX = 6;
          if (cls.fields.length <= MAX) {
            out.add('  ' + cls.signature + ' { ' + cls.fields.join(', ') + ' }');
          } else {
            out.add('  ' + cls.signature + ' { ' + cls.fields.slice(0, MAX).join(', ') + `, ... +${cls.fields.length - MAX} more }`);
          }
        } else {
          out.add('  ' + cls.signature);
        }
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    if (symbols.types?.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  }
}

function countSymbols(symbols) {
  let count = 0;
  if (symbols.exports) count += symbols.exports.length;
  if (symbols.classes) {
    count += symbols.classes.length;
    symbols.classes.forEach(c => {
      count += c.methods?.length || 0;
      count += c.fields?.length || 0;
      count += c.variants?.length || 0;
      count += c.attrs?.length || 0;
      count += c.constants?.length || 0;
    });
  }
  if (symbols.functions) count += symbols.functions.length;
  if (symbols.types) {
    count += symbols.types.length;
    symbols.types.forEach(t => count += t.members?.length || 0);
  }
  if (symbols.constants) count += symbols.constants.length;
  if (symbols.modules) count += symbols.modules.length;
  if (symbols.impls) count += symbols.impls.length;
  return count;
}

// ─────────────────────────────────────────────────────────────
// Directory Mode
// ─────────────────────────────────────────────────────────────

// All extensions tl-symbols can handle (dedicated + generic fallback)
const ALL_SUPPORTED_EXTS = new Set([
  ...LANG_EXTENSIONS.js, ...LANG_EXTENSIONS.python, ...LANG_EXTENSIONS.go,
  '.kt', '.kts', '.swift', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs', '.scala', '.zig', '.lua', '.r', '.R', '.ex', '.exs', '.erl', '.hrl',
  '.hs', '.ml', '.mli', '.php', '.dart', '.v', '.sv',
]);

function collectFiles(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        collectFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ALL_SUPPORTED_EXTS.has(ext) && !shouldSkip(entry.name, false)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function extractSymbolsForFile(filePath, exportsOnly) {
  const lang = detectLanguage(filePath);
  const content = readFileSync(filePath, 'utf-8');
  let symbols;
  switch (lang) {
    case 'js': symbols = extractJsSymbols(content, exportsOnly); break;
    case 'python': symbols = extractPythonSymbols(content); break;
    case 'go': symbols = extractGoSymbols(content); break;
    case 'rust': symbols = extractRustSymbols(content); break;
    case 'ruby': symbols = extractRubySymbols(content); break;
    default: symbols = extractGenericSymbols(content); break;
  }
  return { symbols, lang };
}

function applySymbolFilter(symbols, filterType) {
  if (!filterType) return symbols;

  const filterMap = {
    function: () => {
      symbols.classes = [];
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\bfunction\b/.test(e) || /=>\s*$/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    class: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e => /\bclass\b/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    type: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.classes = symbols.classes ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\b(type|interface|enum)\b/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    constant: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.classes = symbols.classes ? [] : undefined;
      symbols.types = symbols.types ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\bconst\b/.test(e) && !/=>/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    export: () => {
      symbols.functions = [];
      symbols.classes = [];
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    }
  };

  if (filterMap[filterType]) filterMap[filterType]();
  return symbols;
}

function extractSymbolNames(symbols, lang, exportsOnly) {
  const names = [];

  if (exportsOnly && symbols.exports) {
    for (const e of symbols.exports) {
      const name = extractName(typeof e === 'string' ? e : e.signature || e);
      if (name) names.push(name);
    }
    return names;
  }

  // Classes — show ClassName with method count
  if (symbols.classes) {
    for (const cls of symbols.classes) {
      const sig = typeof cls === 'string' ? cls : cls.signature;
      const name = extractName(sig);
      const methodCount = cls.methods?.length || 0;
      if (name) names.push(methodCount > 0 ? `${name}(${methodCount}m)` : name);
    }
  }

  // Functions
  if (symbols.functions) {
    for (const f of symbols.functions) {
      const name = extractName(typeof f === 'string' ? f : f);
      if (name) names.push(name + '()');
    }
  }

  // Types
  if (symbols.types) {
    for (const t of symbols.types) {
      const sig = typeof t === 'string' ? t : t.signature;
      const name = extractName(sig);
      if (name) names.push(name);
    }
  }

  // Constants
  if (symbols.constants) {
    for (const c of symbols.constants) {
      const name = extractName(typeof c === 'string' ? c : c);
      if (name) names.push(name);
    }
  }

  // Modules (generic)
  if (symbols.modules) {
    for (const m of symbols.modules) {
      const name = extractName(m);
      if (name) names.push(name);
    }
  }

  return names;
}

function extractName(sig) {
  if (!sig) return null;
  // Strip common prefixes: export, async, function, const, type, interface, class, etc.
  const cleaned = sig
    .replace(/^export\s+(default\s+)?/, '')
    .replace(/^(async\s+)?(function\s+|const\s+|let\s+|var\s+|class\s+|abstract\s+class\s+|interface\s+|type\s+|enum\s+)/, '')
    .replace(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn\s+|struct\s+|enum\s+|trait\s+|impl\s+|mod\s+|module\s+|type\s+|const\s+|static\s+|let\s+)/, '')
    .replace(/^(func\s+)/, '')
    .replace(/^def\s+(?:self\.)?/, '')
    .replace(/^macro_rules!\s+/, '')
    .trim();
  const match = cleaned.match(/^(\w+)/);
  return match ? match[1] : null;
}

const FAST_FUNCTION_FILTER_LANGS = new Set(['js', 'python', 'go', 'rust', 'ruby']);

function extractFunctionNamesFast(content, lang) {
  const names = [];
  const seen = new Set();

  function add(name) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(`${name}()`);
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    if (lang === 'js') {
      const fn = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/);
      if (fn) { add(fn[1]); continue; }

      const arrow = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (arrow) { add(arrow[1]); continue; }

      const fnExpr = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/);
      if (fnExpr) { add(fnExpr[1]); continue; }
    } else if (lang === 'python') {
      const py = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (py) { add(py[1]); continue; }
    } else if (lang === 'go') {
      const go = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<]/);
      if (go) { add(go[1]); continue; }
    } else if (lang === 'rust') {
      const rs = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*[(<]/);
      if (rs) { add(rs[1]); continue; }
    } else if (lang === 'ruby') {
      const rb = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/);
      if (rb) { add(rb[1]); continue; }
    }
  }

  return names;
}

function tryFastFunctionFilterNames(filePath, lang, exportsOnly, filterType) {
  if (exportsOnly || filterType !== 'function' || !FAST_FUNCTION_FILTER_LANGS.has(lang)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');
  const indicatorByLang = {
    js: /\bfunction\b|=>/,
    python: /\bdef\b/,
    go: /\bfunc\b/,
    rust: /\bfn\b/,
    ruby: /\bdef\b/
  };
  const hasIndicator = indicatorByLang[lang]?.test(content);
  if (!hasIndicator) return [];

  const names = extractFunctionNamesFast(content, lang);
  // If indicators exist but extraction found nothing, fallback to full parser for correctness.
  return names.length > 0 ? names : null;
}

function runMultiFileMode(files, baseDir, exportsOnly, filterType, options) {
  if (files.length === 0) {
    console.error(`No code files found`);
    process.exit(1);
  }

  const out = createOutput(options);
  let totalSymbols = 0;
  let totalFiles = 0;
  const jsonFiles = [];
  const MAX_INLINE = 8;

  for (const file of files) {
    try {
      const lang = detectLanguage(file);
      let names = tryFastFunctionFilterNames(file, lang, exportsOnly, filterType);
      if (!names) {
        const { symbols } = extractSymbolsForFile(file, exportsOnly);
        applySymbolFilter(symbols, filterType);
        names = extractSymbolNames(symbols, lang, exportsOnly || filterType === 'export');
      }
      if (names.length === 0) continue;

      totalFiles++;
      totalSymbols += names.length;
      const relPath = baseDir ? relative(baseDir, file) : basename(file);

      let line;
      if (names.length <= MAX_INLINE) {
        line = `${relPath}: ${names.join(', ')}`;
      } else {
        line = `${relPath}: ${names.slice(0, MAX_INLINE).join(', ')}, +${names.length - MAX_INLINE}`;
      }
      out.add(line);

      if (options.json) {
        jsonFiles.push({ file: relPath, language: lang || 'generic', symbols: names });
      }
    } catch {
      // Skip files that can't be read/parsed
    }
  }

  if (options.json) {
    out.setData('files', jsonFiles);
    out.setData('totalFiles', totalFiles);
    out.setData('totalSymbols', totalSymbols);
  } else {
    out.blank();
    out.add(`${totalFiles} files, ${totalSymbols} symbols`);
  }

  out.print();
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const exportsOnly = options.remaining.includes('--exports-only') || options.remaining.includes('-e');

let filterType = null;
for (let i = 0; i < options.remaining.length; i++) {
  if (options.remaining[i] === '--filter' && options.remaining[i + 1]) {
    filterType = options.remaining[++i].toLowerCase();
  }
}

const VALID_FILTERS = ['function', 'class', 'type', 'constant', 'export'];
if (filterType && !VALID_FILTERS.includes(filterType)) {
  console.error(`Invalid filter: "${filterType}". Must be one of: ${VALID_FILTERS.join(', ')}`);
  process.exit(1);
}

const paths = options.remaining.filter(a => !a.startsWith('-') && !VALID_FILTERS.includes(a.toLowerCase()));

if (options.help || paths.length === 0) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

for (const p of paths) {
  if (!existsSync(p)) {
    console.error(`Not found: ${p}`);
    process.exit(1);
  }
}

// Multi-path mode: directory or 2+ files -> compact output
if (paths.length > 1 || statSync(paths[0]).isDirectory()) {
  const allFiles = [];
  let baseDir = null;
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      baseDir = baseDir || p;
      allFiles.push(...collectFiles(p));
    } else {
      allFiles.push(p);
    }
  }
  allFiles.sort();
  runMultiFileMode(allFiles, baseDir, exportsOnly, filterType, options);
  process.exit(0);
}

// Single-file mode (detailed)
const filePath = paths[0];
const lang = detectLanguage(filePath);

const content = readFileSync(filePath, 'utf-8');
const fullFileTokens = estimateTokens(content);

let symbols;
let isGeneric = false;
switch (lang) {
  case 'js':
    symbols = extractJsSymbols(content, exportsOnly);
    break;
  case 'python':
    symbols = extractPythonSymbols(content);
    break;
  case 'go':
    symbols = extractGoSymbols(content);
    break;
  case 'rust':
    symbols = extractRustSymbols(content);
    break;
  case 'ruby':
    symbols = extractRubySymbols(content);
    break;
  default:
    symbols = extractGenericSymbols(content);
    isGeneric = true;
    break;
}

applySymbolFilter(symbols, filterType);

const symbolCount = countSymbols(symbols);
const out = createOutput(options);

// Set JSON data
out.setData('file', basename(filePath));
out.setData('language', lang || 'generic');
out.setData('symbolCount', symbolCount);
out.setData('fullFileTokens', fullFileTokens);
out.setData('symbols', symbols);
if (isGeneric) out.setData('generic', true);

// Build text output
if (isGeneric) {
  out.header(`\n! Generic extraction (no dedicated ${extname(filePath)} parser)`);
}
const allTag = symbols.all ? `, __all__: ${symbols.all.length} public` : '';
out.header(`\n${basename(filePath)} (${symbolCount} symbols${allTag})`);
out.header(`   Full file: ~${formatTokens(fullFileTokens)} tokens -> Symbols only: ~${formatTokens(Math.ceil(symbolCount * 15))} tokens`);
out.blank();

formatSymbols(symbols, isGeneric ? 'generic' : lang, out);

out.print();
