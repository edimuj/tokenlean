#!/usr/bin/env node

/**
 * tl-deps - Show what a file imports/depends on
 *
 * Displays all imports and requires in a file, categorized by type
 * (npm packages, local files, Node built-ins). Helps understand
 * dependencies without reading the full file.
 *
 * Usage: tl-deps <file>
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-deps',
    desc: 'Show file imports and dependency tree',
    when: 'before-read',
    example: 'tl-deps src/index.ts --tree'
  }));
  process.exit(0);
}

import { existsSync, readFileSync } from 'fs';
import { basename, dirname, extname, resolve, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, detectLanguage } from '../src/project.mjs';
import { extractGenericImports } from '../src/generic-lang.mjs';

const HELP = `
tl-deps - Show what a file imports/depends on

Usage: tl-deps <file> [options]

Options:
  --resolve, -r         Show resolved paths for local imports
  --tree, -t            Show as dependency tree (follows local imports)
  --depth N             Max depth for tree mode (default: 2)
${COMMON_OPTIONS_HELP}

Examples:
  tl-deps src/app.ts              # List all imports
  tl-deps src/app.ts -r           # Show resolved paths
  tl-deps src/app.ts -t           # Dependency tree
  tl-deps src/app.ts -j           # JSON output

Categories:
  npm       - node_modules packages
  local     - relative imports (./file, ../file)
  builtin   - Node.js built-in modules
  assets    - CSS, images, etc.

Other languages: generic regex-based import extraction (flat list, no categorization)
`;

// Node.js built-in modules
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib'
]);

// ─────────────────────────────────────────────────────────────
// Import Extraction
// ─────────────────────────────────────────────────────────────

function extractImports(content, lang) {
  const imports = {
    npm: [],
    local: [],
    builtin: [],
    assets: [],
    dynamic: []
  };

  if (lang === 'javascript' || lang === 'typescript') {
    extractJsImports(content, imports);
  } else if (lang === 'python') {
    extractPythonImports(content, imports);
  } else if (lang === 'go') {
    extractGoImports(content, imports);
  }

  return imports;
}

function extractJsImports(content, imports) {
  const lines = content.split('\n');
  const seen = new Set(); // Avoid duplicates

  // Track multi-line import state
  let inMultiLineImport = false;
  let multiLineBuffer = '';
  let multiLineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Handle multi-line imports
    if (inMultiLineImport) {
      multiLineBuffer += ' ' + trimmed;
      if (trimmed.includes("'") || trimmed.includes('"')) {
        // Try to extract the from clause
        const fromMatch = multiLineBuffer.match(/from\s*['"]([^'"]+)['"]/);
        if (fromMatch) {
          const spec = fromMatch[1];
          if (!seen.has(spec)) {
            seen.add(spec);
            const isTypeOnly = multiLineBuffer.includes('import type');
            categorizeJsImport(spec, multiLineBuffer.substring(0, 100), multiLineStart, imports, isTypeOnly);
          }
          inMultiLineImport = false;
          multiLineBuffer = '';
        }
      }
      continue;
    }

    // Start of import statement
    if (trimmed.startsWith('import ')) {
      // Check if it's complete on one line
      const singleLineMatch = trimmed.match(/^import\s+(?:type\s+)?(?:.*?\s+from\s+)?['"]([^'"]+)['"]/);
      if (singleLineMatch) {
        const spec = singleLineMatch[1];
        if (!seen.has(spec)) {
          seen.add(spec);
          categorizeJsImport(spec, trimmed, lineNum, imports, trimmed.includes('import type'));
        }
        continue;
      }

      // Check for from clause on same line
      const fromMatch = trimmed.match(/from\s*['"]([^'"]+)['"]/);
      if (fromMatch) {
        const spec = fromMatch[1];
        if (!seen.has(spec)) {
          seen.add(spec);
          categorizeJsImport(spec, trimmed, lineNum, imports, trimmed.includes('import type'));
        }
        continue;
      }

      // Multi-line import starting
      inMultiLineImport = true;
      multiLineBuffer = trimmed;
      multiLineStart = lineNum;
      continue;
    }

    // CommonJS: require('X')
    const requireMatches = [...line.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const match of requireMatches) {
      const spec = match[1];
      if (!seen.has(spec)) {
        seen.add(spec);
        categorizeJsImport(spec, trimmed, lineNum, imports, false);
      }
    }

    // Dynamic imports: import('X') - but not at start of line (that's regular import)
    if (!trimmed.startsWith('import ')) {
      const dynamicMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (dynamicMatch) {
        const spec = dynamicMatch[1];
        if (!seen.has('dynamic:' + spec)) {
          seen.add('dynamic:' + spec);
          imports.dynamic.push({
            spec,
            line: lineNum,
            statement: trimmed
          });
        }
      }
    }
  }
}

function categorizeJsImport(spec, line, lineNum, imports, isTypeOnly) {
  const entry = {
    spec,
    line: lineNum,
    statement: line.trim().substring(0, 100),
    isTypeOnly
  };

  // Asset imports
  if (/\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp|json)$/.test(spec)) {
    imports.assets.push(entry);
    return;
  }

  // Local imports
  if (spec.startsWith('.') || spec.startsWith('/')) {
    imports.local.push(entry);
    return;
  }

  // Node built-ins (including node: prefix)
  const modName = spec.replace(/^node:/, '').split('/')[0];
  if (NODE_BUILTINS.has(modName)) {
    imports.builtin.push(entry);
    return;
  }

  // npm packages
  imports.npm.push(entry);
}

function extractPythonImports(content, imports) {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // import X, from X import Y
    const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)$/);
    if (importMatch) {
      const module = importMatch[1] || importMatch[2].split(',')[0].split(' as ')[0].trim();

      const entry = {
        spec: module,
        line: lineNum,
        statement: trimmed.substring(0, 100)
      };

      // Relative imports
      if (module.startsWith('.')) {
        imports.local.push(entry);
      } else {
        imports.npm.push(entry); // Python doesn't distinguish npm/builtin easily
      }
    }
  }
}

function extractGoImports(content, imports) {
  // Match import block or single imports
  const importBlockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
  const singleImports = content.matchAll(/import\s+"([^"]+)"/g);

  const processImport = (spec, lineNum = 0) => {
    const entry = {
      spec,
      line: lineNum,
      statement: `import "${spec}"`
    };

    // Standard library (no dots in path)
    if (!spec.includes('.')) {
      imports.builtin.push(entry);
    } else {
      imports.npm.push(entry);
    }
  };

  if (importBlockMatch) {
    const lines = importBlockMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/"([^"]+)"/);
      if (match) {
        processImport(match[1]);
      }
    }
  }

  for (const match of singleImports) {
    processImport(match[1]);
  }
}

// ─────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────

function resolveLocalImport(spec, fileDir, projectRoot) {
  const extensions = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '/index.js', '/index.ts', '/index.tsx'];

  for (const ext of extensions) {
    const tryPath = resolve(fileDir, spec + ext);
    if (existsSync(tryPath)) {
      return relative(projectRoot, tryPath);
    }
  }

  return spec; // Return original if can't resolve
}

// ─────────────────────────────────────────────────────────────
// Tree Mode
// ─────────────────────────────────────────────────────────────

function buildDependencyTree(filePath, projectRoot, maxDepth = 2, visited = new Set()) {
  if (visited.has(filePath) || visited.size > 50) {
    return { file: relative(projectRoot, filePath), circular: true };
  }

  visited.add(filePath);

  const content = readFileSync(filePath, 'utf-8');
  const lang = detectLanguage(filePath);
  const imports = extractImports(content, lang);
  const fileDir = dirname(filePath);

  const tree = {
    file: relative(projectRoot, filePath),
    tokens: estimateTokens(content),
    npm: imports.npm.map(i => i.spec),
    builtin: imports.builtin.map(i => i.spec),
    local: []
  };

  if (maxDepth > 0) {
    for (const imp of imports.local) {
      const resolved = resolveLocalImport(imp.spec, fileDir, projectRoot);
      const fullPath = resolve(projectRoot, resolved);

      if (existsSync(fullPath) && !visited.has(fullPath)) {
        try {
          const subtree = buildDependencyTree(fullPath, projectRoot, maxDepth - 1, visited);
          tree.local.push(subtree);
        } catch {
          tree.local.push({ file: resolved, error: true });
        }
      } else {
        tree.local.push({ file: resolved, circular: visited.has(fullPath) });
      }
    }
  } else {
    tree.local = imports.local.map(i => ({ file: i.spec }));
  }

  return tree;
}

function printTree(tree, out, prefix = '', isLast = true) {
  const connector = isLast ? '└── ' : '├── ';
  const tokens = tree.tokens ? ` (~${formatTokens(tree.tokens)})` : '';
  const marker = tree.circular ? ' (circular)' : tree.error ? ' ! ' : '';

  out.add(`${prefix}${connector}${tree.file}${tokens}${marker}`);

  const newPrefix = prefix + (isLast ? '    ' : '│   ');

  // Print npm deps compactly
  if (tree.npm && tree.npm.length > 0) {
    out.add(`${newPrefix}${tree.npm.join(', ')}`);
  }

  // Print local deps recursively
  if (tree.local && tree.local.length > 0) {
    tree.local.forEach((child, i) => {
      printTree(child, out, newPrefix, i === tree.local.length - 1);
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────

function printCategory(out, title, items, emoji, showResolved, fileDir, projectRoot) {
  if (items.length === 0) return;

  out.add(`${emoji ? emoji + ' ' : ''}${title} (${items.length}):`);

  for (const item of items) {
    let line = `   ${item.spec}`;

    if (showResolved && item.spec.startsWith('.')) {
      const resolved = resolveLocalImport(item.spec, fileDir, projectRoot);
      line += ` -> ${resolved}`;
    }

    if (item.isTypeOnly) {
      line += ' [type]';
    }

    line += ` :${item.line}`;
    out.add(line);
  }
  out.blank();
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse tool-specific options
const showResolved = options.remaining.includes('--resolve') || options.remaining.includes('-r');
const treeMode = options.remaining.includes('--tree') || options.remaining.includes('-t');
let maxDepth = 2;

for (let i = 0; i < options.remaining.length; i++) {
  if (options.remaining[i] === '--depth' && options.remaining[i + 1]) {
    maxDepth = parseInt(options.remaining[i + 1], 10);
  }
}

const filePath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !filePath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const resolvedPath = resolve(filePath);

if (!existsSync(resolvedPath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, resolvedPath);
const content = readFileSync(resolvedPath, 'utf-8');
const lang = detectLanguage(resolvedPath);
const isGeneric = !lang || !['javascript', 'typescript', 'python', 'go'].includes(lang);

const out = createOutput(options);

if (isGeneric) {
  // Generic fallback — flat import list, no categorization, no tree
  const { imports } = extractGenericImports(content);

  if (treeMode) {
    out.add('Tree mode not available for generic extraction.');
    out.blank();
  }

  out.header(`\n! Generic extraction (no dedicated ${extname(resolvedPath)} parser)`);
  out.header(`\nDependencies: ${relPath}`);
  out.header(`   ${imports.length} imports found`);
  out.blank();

  if (imports.length > 0) {
    out.add(`Imports (${imports.length}):`);
    for (const imp of imports) {
      out.add(`   ${imp.spec} :${imp.line}`);
    }
    out.blank();
  }

  out.setData('file', relPath);
  out.setData('imports', imports);
  out.setData('totalImports', imports.length);
  out.setData('generic', true);
} else if (treeMode) {
  // Tree mode
  out.header(`\nDependency tree: ${relPath}`);
  out.header(`   Max depth: ${maxDepth}`);
  out.blank();

  const tree = buildDependencyTree(resolvedPath, projectRoot, maxDepth);
  printTree(tree, out, '', true);
  out.blank();

  out.setData('tree', tree);
} else {
  // List mode
  const imports = extractImports(content, lang);
  const fileDir = dirname(resolvedPath);
  const totalImports = imports.npm.length + imports.local.length + imports.builtin.length + imports.assets.length + imports.dynamic.length;

  out.header(`\nDependencies: ${relPath}`);
  out.header(`   ${totalImports} imports found`);
  out.blank();

  printCategory(out, 'npm packages', imports.npm, '', false, fileDir, projectRoot);
  printCategory(out, 'Local files', imports.local, '', showResolved, fileDir, projectRoot);
  printCategory(out, 'Node built-ins', imports.builtin, '', false, fileDir, projectRoot);
  printCategory(out, 'Assets', imports.assets, '', false, fileDir, projectRoot);
  printCategory(out, 'Dynamic imports', imports.dynamic, '', false, fileDir, projectRoot);

  out.setData('file', relPath);
  out.setData('imports', imports);
  out.setData('totalImports', totalImports);
}

out.print();
