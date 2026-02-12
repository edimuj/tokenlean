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

import { readFileSync, existsSync } from 'fs';
import { basename, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { extractGenericSymbols } from '../src/generic-lang.mjs';

const HELP = `
tl-symbols - Extract function/class/type signatures without bodies

Usage: tl-symbols <file> [options]

Options:
  --exports-only, -e    Show only exported symbols
${COMMON_OPTIONS_HELP}

Examples:
  tl-symbols src/api.ts              # All symbols
  tl-symbols src/api.ts -e           # Exports only
  tl-symbols src/api.ts -l 20        # Limit to 20 lines
  tl-symbols src/api.ts -j           # JSON output

Supported languages:
  JavaScript/TypeScript (.js, .ts, .jsx, .tsx, .mjs)
  Python (.py)
  Go (.go)
  Other languages: generic regex-based extraction (best-effort)
`;

// ─────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────

const LANG_EXTENSIONS = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts'],
  python: ['.py'],
  go: ['.go']
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

  const lines = content.split('\n');
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

function extractSignatureLine(line) {
  let sig = line
    .replace(/\s*\{[\s\S]*$/, '')
    .replace(/\s*=>\s*[^{].*$/, ' =>')
    .replace(/\s*=\s*[^=].*$/, '')
    .trim();

  sig = sig.replace(/[,;]$/, '').trim();
  return sig;
}

// ─────────────────────────────────────────────────────────────
// Python Extraction
// ─────────────────────────────────────────────────────────────

function extractPythonSymbols(content) {
  const symbols = { classes: [], functions: [] };
  const lines = content.split('\n');
  let inClass = null;
  let currentClassMethods = [];
  let currentClassFields = [];
  let isDataclass = false;
  let isEnumClass = false;
  let isNextDataclass = false;

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
        out.add('  ' + cls.signature);
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
    });
  }
  if (symbols.functions) count += symbols.functions.length;
  if (symbols.types) {
    count += symbols.types.length;
    symbols.types.forEach(t => count += t.members?.length || 0);
  }
  if (symbols.constants) count += symbols.constants.length;
  if (symbols.modules) count += symbols.modules.length;
  return count;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const exportsOnly = options.remaining.includes('--exports-only') || options.remaining.includes('-e');
const filePath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

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
  default:
    symbols = extractGenericSymbols(content);
    isGeneric = true;
    break;
}

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
out.header(`\n${basename(filePath)} (${symbolCount} symbols)`);
out.header(`   Full file: ~${formatTokens(fullFileTokens)} tokens -> Symbols only: ~${formatTokens(Math.ceil(symbolCount * 15))} tokens`);
out.blank();

formatSymbols(symbols, isGeneric ? 'generic' : lang, out);

out.print();
