#!/usr/bin/env node

/**
 * tl-exports - Show public API surface of a module
 *
 * Lists what a file or package exports - functions, classes, types, constants.
 * Perfect for understanding what a module provides without reading implementation.
 *
 * Usage: tl-exports <file-or-dir> [--types-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-exports',
    desc: 'Show public API surface of a module',
    when: 'before-read',
    example: 'tl-exports src/utils/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, extname, join, relative, dirname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip } from '../src/project.mjs';
import { extractGenericSymbols } from '../src/generic-lang.mjs';

const HELP = `
tl-exports - Show public API surface of a module

Usage: tl-exports <file-or-dir> [options]

Options:
  --types-only, -t      Show only type exports (interfaces, types, enums)
  --values-only, -v     Show only value exports (functions, classes, constants)
  --with-signatures     Include function signatures (more detail)
  --tree                Show as import tree (what to import from where)
${COMMON_OPTIONS_HELP}

Examples:
  tl-exports src/utils.ts          # Exports from single file
  tl-exports src/utils/            # Exports from directory (finds index)
  tl-exports src/ --tree           # Show as import tree
  tl-exports src/api.ts -t         # Types only
  tl-exports src/ -j               # JSON output

Supported: JavaScript, TypeScript, Python, Go
Other languages: generic extraction of pub/export/public symbols (best-effort)
`;

// ─────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts']);
const PY_EXTENSIONS = new Set(['.py']);
const GO_EXTENSIONS = new Set(['.go']);

function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) return 'js';
  if (PY_EXTENSIONS.has(ext)) return 'python';
  if (GO_EXTENSIONS.has(ext)) return 'go';
  return null;
}

function isSourceFile(filePath) {
  return detectLanguage(filePath) !== null;
}

// ─────────────────────────────────────────────────────────────
// JavaScript/TypeScript Export Extraction
// ─────────────────────────────────────────────────────────────

function extractJsExports(content, withSignatures = false) {
  const exports = {
    types: [],      // interfaces, type aliases, enums
    functions: [],  // functions, arrow functions
    classes: [],    // classes
    constants: [],  // const exports
    reexports: [],  // export { x } from './y' or export * from './z'
    default: null   // default export
  };

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip non-export lines
    if (!trimmed.startsWith('export ')) continue;

    // Re-exports: export { x, y } from './module'
    const reexportMatch = trimmed.match(/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (reexportMatch) {
      const names = reexportMatch[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts.length > 1 ? `${parts[0].trim()} as ${parts[1].trim()}` : parts[0].trim();
      });
      exports.reexports.push({ names, from: reexportMatch[2] });
      continue;
    }

    // Star re-export: export * from './module'
    const starReexportMatch = trimmed.match(/^export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/);
    if (starReexportMatch) {
      exports.reexports.push({
        names: [starReexportMatch[1] ? `* as ${starReexportMatch[1]}` : '*'],
        from: starReexportMatch[2]
      });
      continue;
    }

    // Default export
    if (trimmed.startsWith('export default ')) {
      const defaultMatch = trimmed.match(/^export\s+default\s+(?:(class|function|async\s+function)\s+)?(\w+)?/);
      if (defaultMatch) {
        exports.default = defaultMatch[2] || defaultMatch[1] || 'default';
      }
      continue;
    }

    // Type exports: interface, type, enum
    const typeMatch = trimmed.match(/^export\s+(interface|type|enum|const\s+enum)\s+(\w+)/);
    if (typeMatch) {
      const kind = typeMatch[1].replace('const ', '');
      const name = typeMatch[2];

      if (withSignatures && kind === 'type') {
        // Get full type definition for type aliases
        const fullDef = extractTypeDefinition(lines, i);
        exports.types.push({ name, kind, signature: fullDef });
      } else {
        exports.types.push({ name, kind });
      }
      continue;
    }

    // Function exports
    const funcMatch = trimmed.match(/^export\s+(async\s+)?function\s+(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?/);
    if (funcMatch) {
      const name = funcMatch[2];
      const isAsync = !!funcMatch[1];
      const generics = funcMatch[3] || '';
      const params = funcMatch[4] || '';
      const returnType = funcMatch[5]?.trim() || '';

      if (withSignatures) {
        let sig = `${isAsync ? 'async ' : ''}function ${name}${generics}(${params})`;
        if (returnType) sig += `: ${returnType}`;
        exports.functions.push({ name, signature: sig });
      } else {
        exports.functions.push({ name });
      }
      continue;
    }

    // Class exports
    const classMatch = trimmed.match(/^export\s+(abstract\s+)?class\s+(\w+)(\s*<[^>]+>)?(\s+extends\s+\w+)?(\s+implements\s+[^{]+)?/);
    if (classMatch) {
      const name = classMatch[2];
      const isAbstract = !!classMatch[1];
      const generics = classMatch[3]?.trim() || '';
      const extendsClause = classMatch[4]?.trim() || '';
      const implementsClause = classMatch[5]?.trim() || '';

      if (withSignatures) {
        let sig = `${isAbstract ? 'abstract ' : ''}class ${name}${generics}`;
        if (extendsClause) sig += ` ${extendsClause}`;
        if (implementsClause) sig += ` ${implementsClause}`;
        exports.classes.push({ name, signature: sig });
      } else {
        exports.classes.push({ name });
      }
      continue;
    }

    // Const exports (including arrow functions)
    const constMatch = trimmed.match(/^export\s+const\s+(\w+)(?:\s*:\s*([^=]+))?\s*=/);
    if (constMatch) {
      const name = constMatch[1];
      const typeAnnotation = constMatch[2]?.trim();

      // Check if it's an arrow function
      const isArrowFunc = trimmed.includes('=>') || (typeAnnotation && typeAnnotation.includes('=>'));

      if (isArrowFunc) {
        if (withSignatures && typeAnnotation) {
          exports.functions.push({ name, signature: `const ${name}: ${typeAnnotation}` });
        } else {
          exports.functions.push({ name });
        }
      } else {
        if (withSignatures && typeAnnotation) {
          exports.constants.push({ name, type: typeAnnotation });
        } else {
          exports.constants.push({ name });
        }
      }
      continue;
    }
  }

  return exports;
}

function extractTypeDefinition(lines, startLine) {
  const line = lines[startLine].trim();
  // Simple one-line type
  if (line.endsWith(';')) {
    return line.replace(/^export\s+/, '');
  }
  // Multi-line - just return first line for brevity
  return line.replace(/^export\s+/, '').replace(/\s*=\s*$/, ' = ...');
}

// ─────────────────────────────────────────────────────────────
// Python Export Extraction
// ─────────────────────────────────────────────────────────────

function extractPythonExports(content) {
  const exports = {
    functions: [],
    classes: [],
    constants: [],
    all: null  // __all__ list
  };

  const lines = content.split('\n');

  // Check for __all__
  const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
  if (allMatch) {
    exports.all = allMatch[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Top-level functions (not indented)
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
      if (funcMatch && !funcMatch[1].startsWith('_')) {
        exports.functions.push({ name: funcMatch[1] });
      }

      const classMatch = trimmed.match(/^class\s+(\w+)/);
      if (classMatch && !classMatch[1].startsWith('_')) {
        exports.classes.push({ name: classMatch[1] });
      }

      // Constants (UPPER_CASE at module level)
      const constMatch = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=/);
      if (constMatch) {
        exports.constants.push({ name: constMatch[1] });
      }
    }
  }

  return exports;
}

// ─────────────────────────────────────────────────────────────
// Go Export Extraction
// ─────────────────────────────────────────────────────────────

function extractGoExports(content) {
  const exports = {
    functions: [],
    types: [],
    constants: [],
    variables: []
  };

  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Exported functions (start with uppercase)
    const funcMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)\s*\(/);
    if (funcMatch) {
      exports.functions.push({ name: funcMatch[1] });
    }

    // Exported types
    const typeMatch = trimmed.match(/^type\s+([A-Z]\w*)\s+(struct|interface)/);
    if (typeMatch) {
      exports.types.push({ name: typeMatch[1], kind: typeMatch[2] });
    }

    // Exported constants
    const constMatch = trimmed.match(/^const\s+([A-Z]\w*)/);
    if (constMatch) {
      exports.constants.push({ name: constMatch[1] });
    }

    // Exported variables
    const varMatch = trimmed.match(/^var\s+([A-Z]\w*)/);
    if (varMatch) {
      exports.variables.push({ name: varMatch[1] });
    }
  }

  return exports;
}

// ─────────────────────────────────────────────────────────────
// Generic Export Extraction (from generic symbols)
// ─────────────────────────────────────────────────────────────

function extractGenericExports(symbols) {
  const EXPORT_RE = /^(?:pub(?:\([^)]*\))?\s+|export\s+|public\s+)/;

  const exports = {
    types: [],
    functions: [],
    classes: [],
    constants: []
  };

  for (const cls of symbols.classes || []) {
    if (EXPORT_RE.test(cls.signature)) {
      const name = cls.signature.match(/(?:class|struct|interface|trait|enum|union|impl)\s+(\w+)/)?.[1] || cls.signature;
      exports.classes.push({ name, signature: cls.signature });
    }
  }

  for (const fn of symbols.functions || []) {
    if (EXPORT_RE.test(fn)) {
      const name = fn.match(/(?:fn|func|function|def|fun)\s+(\w+)/)?.[1] || fn;
      exports.functions.push({ name, signature: fn });
    }
  }

  for (const t of symbols.types || []) {
    if (EXPORT_RE.test(t)) {
      const name = t.match(/(?:type|typedef|using|newtype|typealias)\s+(\w+)/)?.[1] || t;
      exports.types.push({ name, kind: 'type', signature: t });
    }
  }

  for (const c of symbols.constants || []) {
    if (EXPORT_RE.test(c)) {
      const name = c.match(/(?:const|static|val)\s+(\w+)/)?.[1] || c;
      exports.constants.push({ name });
    }
  }

  return exports;
}

// ─────────────────────────────────────────────────────────────
// File Discovery
// ─────────────────────────────────────────────────────────────

function findSourceFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        findSourceFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      if (!shouldSkip(entry.name, false) && isSourceFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function findIndexFile(dir) {
  const indexNames = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'mod.ts', '__init__.py'];

  for (const name of indexNames) {
    const indexPath = join(dir, name);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

function formatExports(exports, out, options = {}) {
  const { typesOnly, valuesOnly, withSignatures, relPath } = options;

  let count = 0;

  // Default export
  if (exports.default && !typesOnly) {
    out.add(`  default → ${exports.default}`);
    count++;
  }

  // Types
  if (!valuesOnly && exports.types?.length > 0) {
    for (const t of exports.types) {
      if (withSignatures && t.signature) {
        out.add(`  ${t.kind} ${t.name}`);
        out.add(`    ${t.signature}`);
      } else {
        out.add(`  ${t.kind} ${t.name}`);
      }
      count++;
    }
  }

  // Functions
  if (!typesOnly && exports.functions?.length > 0) {
    for (const f of exports.functions) {
      if (withSignatures && f.signature) {
        out.add(`  fn ${f.name}`);
        out.add(`    ${f.signature}`);
      } else {
        out.add(`  fn ${f.name}`);
      }
      count++;
    }
  }

  // Classes
  if (!typesOnly && exports.classes?.length > 0) {
    for (const c of exports.classes) {
      if (withSignatures && c.signature) {
        out.add(`  class ${c.name}`);
        out.add(`    ${c.signature}`);
      } else {
        out.add(`  class ${c.name}`);
      }
      count++;
    }
  }

  // Constants
  if (!typesOnly && exports.constants?.length > 0) {
    for (const c of exports.constants) {
      if (withSignatures && c.type) {
        out.add(`  const ${c.name}: ${c.type}`);
      } else {
        out.add(`  const ${c.name}`);
      }
      count++;
    }
  }

  // Variables (Go)
  if (!typesOnly && exports.variables?.length > 0) {
    for (const v of exports.variables) {
      out.add(`  var ${v.name}`);
      count++;
    }
  }

  // Re-exports
  if (exports.reexports?.length > 0) {
    for (const r of exports.reexports) {
      out.add(`  ↳ { ${r.names.join(', ')} } from '${r.from}'`);
      count += r.names.length;
    }
  }

  return count;
}

function formatAsTree(fileExports, out, projectRoot) {
  // Group by directory
  const byDir = new Map();

  for (const { file, exports } of fileExports) {
    const dir = dirname(file);
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
    }
    byDir.get(dir).push({ file: basename(file), exports });
  }

  for (const [dir, files] of byDir) {
    out.add(`📁 ${dir || '.'}/`);

    for (const { file, exports } of files) {
      const allExports = [];

      if (exports.default) allExports.push(`default`);
      exports.types?.forEach(t => allExports.push(t.name));
      exports.functions?.forEach(f => allExports.push(f.name));
      exports.classes?.forEach(c => allExports.push(c.name));
      exports.constants?.forEach(c => allExports.push(c.name));

      if (allExports.length > 0) {
        out.add(`  ${file}: { ${allExports.join(', ')} }`);
      }
    }
    out.blank();
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const typesOnly = options.remaining.includes('--types-only') || options.remaining.includes('-t');
const valuesOnly = options.remaining.includes('--values-only') || options.remaining.includes('-v');
const withSignatures = options.remaining.includes('--with-signatures');
const treeMode = options.remaining.includes('--tree');
const targetPath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !targetPath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

const stat = statSync(targetPath);
let files = [];

if (stat.isDirectory()) {
  // Check for index file first
  const indexFile = findIndexFile(targetPath);
  if (indexFile && !treeMode) {
    files = [indexFile];
  } else {
    files = findSourceFiles(targetPath);
  }
} else {
  files = [targetPath];
}

if (files.length === 0) {
  console.error('No source files found');
  process.exit(1);
}

const allFileExports = [];
let totalExports = 0;

for (const filePath of files) {
  const content = readFileSync(filePath, 'utf-8');
  const lang = detectLanguage(filePath);
  const relPath = relative(projectRoot, filePath);

  let exports;
  let isGeneric = false;
  switch (lang) {
    case 'js':
      exports = extractJsExports(content, withSignatures);
      break;
    case 'python':
      exports = extractPythonExports(content);
      break;
    case 'go':
      exports = extractGoExports(content);
      break;
    default: {
      // For directories, silently skip unsupported files
      if (files.length > 1) continue;
      // For single-file mode, fall back to generic extraction
      const syms = extractGenericSymbols(content);
      exports = extractGenericExports(syms);
      isGeneric = true;
      break;
    }
  }

  // Count exports
  let count = 0;
  if (exports.default) count++;
  count += exports.types?.length || 0;
  count += exports.functions?.length || 0;
  count += exports.classes?.length || 0;
  count += exports.constants?.length || 0;
  count += exports.variables?.length || 0;
  exports.reexports?.forEach(r => count += r.names.length);

  if (count === 0 && !isGeneric) continue;

  totalExports += count;
  allFileExports.push({ file: relPath, exports, count, isGeneric });
}

// Set JSON data
out.setData('files', allFileExports.map(({ file, exports }) => ({ file, exports })));
out.setData('totalExports', totalExports);

// Output
if (treeMode) {
  out.header('Export Tree:');
  out.blank();
  formatAsTree(allFileExports, out, projectRoot);
} else {
  for (const { file, exports, count, isGeneric: gen } of allFileExports) {
    if (gen) {
      out.header(`⚠ Generic extraction (no dedicated ${extname(file)} parser) — showing pub/export/public symbols`);
      out.blank();
    }
    if (allFileExports.length > 1) {
      out.add(`📦 ${file} (${count} exports)`);
    } else {
      out.header(`📦 ${file} (${count} exports)`);
      out.blank();
    }

    formatExports(exports, out, { typesOnly, valuesOnly, withSignatures, relPath: file });
    out.blank();
  }
}

// Summary
if (!options.quiet && allFileExports.length > 0) {
  out.add(`Total: ${totalExports} exports from ${allFileExports.length} file(s)`);
}

out.print();
