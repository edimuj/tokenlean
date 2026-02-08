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

function extractJsSymbols(content, exportsOnly = false) {
  const symbols = {
    exports: [],
    classes: [],
    functions: [],
    types: [],
    constants: []
  };

  const lines = content.split('\n');
  let inClass = null;
  let braceDepth = 0;
  let currentClassMethods = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || !trimmed) {
      continue;
    }

    // Track brace depth for class scope
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check if we're exiting a class
    if (inClass && braceDepth === 1 && closeBraces > openBraces) {
      symbols.classes.push({
        signature: inClass,
        methods: currentClassMethods
      });
      inClass = null;
      currentClassMethods = [];
    }

    braceDepth += openBraces - closeBraces;

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
      else if (trimmed.match(/export\s+(interface|type)\s+/)) {
        const sig = extractSignatureLine(trimmed);
        symbols.types.push(sig);
        symbols.exports.push(sig);
      }
      else if (trimmed.match(/export\s+(?:abstract\s+)?class\s+/)) {
        const sig = extractSignatureLine(trimmed);
        inClass = sig;
        currentClassMethods = [];
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
        symbols.types.push(sig);
        symbols.exports.push(sig);
      }
    }
    // Non-exported symbols
    else if (!exportsOnly) {
      if (trimmed.match(/^interface\s+/)) {
        symbols.types.push(extractSignatureLine(trimmed));
      }
      else if (trimmed.match(/^type\s+\w+/)) {
        symbols.types.push(extractSignatureLine(trimmed));
      }
      else if (trimmed.match(/^(?:abstract\s+)?class\s+/)) {
        const sig = extractSignatureLine(trimmed);
        inClass = sig;
        currentClassMethods = [];
        braceDepth = openBraces - closeBraces;
      }
      else if (trimmed.match(/^(?:async\s+)?function\s+/)) {
        symbols.functions.push(extractSignatureLine(trimmed));
      }
      else if (braceDepth === 0 && trimmed.match(/^const\s+\w+.*=.*=>/)) {
        symbols.functions.push(extractSignatureLine(trimmed));
      }
      // Class methods
      else if (inClass && braceDepth >= 1) {
        if (trimmed.match(/^constructor\s*\(/)) {
          currentClassMethods.push(extractSignatureLine(trimmed));
        }
        else if (trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*[(<]/)) {
          const methodName = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)/)?.[1];
          if (methodName && !['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'typeof', 'delete', 'void', 'yield', 'await'].includes(methodName)) {
            if (!trimmed.includes('=') || trimmed.includes('=>')) {
              currentClassMethods.push(extractSignatureLine(trimmed));
            }
          }
        }
      }
    }
  }

  // Handle last class if file ends inside one
  if (inClass) {
    symbols.classes.push({
      signature: inClass,
      methods: currentClassMethods
    });
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

  for (const line of lines) {
    const trimmed = line.trim();

    const classMatch = trimmed.match(/^class\s+(\w+)(?:\([^)]*\))?:/);
    if (classMatch) {
      if (inClass) {
        symbols.classes.push({ signature: inClass, methods: currentClassMethods });
      }
      inClass = trimmed.replace(/:$/, '');
      currentClassMethods = [];
      continue;
    }

    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)(?:\s*->\s*[^:]+)?:/);
    if (funcMatch) {
      const sig = trimmed.replace(/:$/, '');
      if (inClass && line.startsWith('    ')) {
        currentClassMethods.push(sig);
      } else {
        if (inClass) {
          symbols.classes.push({ signature: inClass, methods: currentClassMethods });
          inClass = null;
          currentClassMethods = [];
        }
        symbols.functions.push(sig);
      }
    }
  }

  if (inClass) {
    symbols.classes.push({ signature: inClass, methods: currentClassMethods });
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

    const nonExportedTypes = symbols.types.filter(t => !t.startsWith('export'));
    if (nonExportedTypes.length > 0) {
      out.add('Types:');
      nonExportedTypes.forEach(t => out.add('  ' + t));
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
    symbols.classes.forEach(c => count += c.methods?.length || 0);
  }
  if (symbols.functions) count += symbols.functions.length;
  if (symbols.types) count += symbols.types.length;
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
