#!/usr/bin/env node

/**
 * tl-unused - Find potentially unused exports and files
 *
 * Scans the codebase to find exports that aren't imported anywhere
 * and files that aren't referenced by other files.
 *
 * Usage: tl-unused [dir] [--exports-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-unused',
    desc: 'Find unused exports and unreferenced files',
    when: 'before-modify',
    example: 'tl-unused src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, basename, extname } from 'path';
import { spawnSync } from 'child_process';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip, isCodeFile } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';

const HELP = `
tl-unused - Find potentially unused exports and unreferenced files

Usage: tl-unused [dir] [options]

Options:
  --exports-only, -e    Only check for unused exports
  --files-only, -f      Only check for unreferenced files
  --ignore <pattern>    Ignore files matching pattern (can use multiple times)
  --include-tests       Include test files in analysis (default: excluded)
${COMMON_OPTIONS_HELP}

Examples:
  tl-unused                       # Full analysis
  tl-unused src/                  # Analyze src/ only
  tl-unused -e                    # Unused exports only
  tl-unused --ignore "*.d.ts"     # Ignore type definitions

Note: This is a heuristic analysis. Some "unused" exports might be:
  - Used dynamically (require(), dynamic imports)
  - Public API exports
  - Entry points
  - Used by external packages
`;

// ─────────────────────────────────────────────────────────────
// File Discovery
// ─────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts']);

function isCodeExtension(filePath) {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function findCodeFiles(dir, files = [], options = {}) {
  const { includeTests = false, ignorePatterns = [] } = options;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Check ignore patterns
    if (ignorePatterns.some(p => entry.name.includes(p) || fullPath.includes(p))) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        findCodeFiles(fullPath, files, options);
      }
    } else if (entry.isFile() && isCodeExtension(fullPath)) {
      if (!shouldSkip(entry.name, false)) {
        // Skip test files unless includeTests
        if (!includeTests) {
          const lower = entry.name.toLowerCase();
          if (lower.includes('.test.') || lower.includes('.spec.') ||
              lower.includes('__tests__') || lower.includes('__mocks__')) {
            continue;
          }
        }
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────
// Export Extraction
// ─────────────────────────────────────────────────────────────

function extractExports(content, filePath) {
  const exports = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed.startsWith('export ')) continue;

    // Skip re-exports (these are pass-through)
    if (trimmed.includes(' from ')) continue;

    // Named exports: export { a, b }
    const namedMatch = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();  // Use alias if present
      });
      names.forEach(name => exports.push({ name, line: i + 1 }));
      continue;
    }

    // Default export
    if (trimmed.startsWith('export default ')) {
      exports.push({ name: 'default', line: i + 1 });
      continue;
    }

    // export interface/type/enum
    const typeMatch = trimmed.match(/^export\s+(?:interface|type|enum|const\s+enum)\s+(\w+)/);
    if (typeMatch) {
      exports.push({ name: typeMatch[1], line: i + 1, isType: true });
      continue;
    }

    // export function/class/const
    const valueMatch = trimmed.match(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/);
    if (valueMatch) {
      exports.push({ name: valueMatch[1], line: i + 1 });
      continue;
    }

    // export abstract class
    const abstractMatch = trimmed.match(/^export\s+abstract\s+class\s+(\w+)/);
    if (abstractMatch) {
      exports.push({ name: abstractMatch[1], line: i + 1 });
      continue;
    }
  }

  return exports;
}

// ─────────────────────────────────────────────────────────────
// Import/Reference Detection
// ─────────────────────────────────────────────────────────────

function extractImports(content) {
  const imports = {
    named: new Set(),      // Named imports
    files: new Set()       // Import paths (for file reference checking)
  };

  // Named imports: import { a, b } from './x'
  const namedRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = namedRegex.exec(content)) !== null) {
    const names = match[1].split(',').map(n => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[0].trim();  // Use original name, not alias
    });
    names.forEach(name => imports.named.add(name));
    imports.files.add(match[2]);
  }

  // Default imports: import X from './x'
  const defaultRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = defaultRegex.exec(content)) !== null) {
    imports.named.add('default');
    imports.files.add(match[2]);
  }

  // Namespace imports: import * as X from './x'
  const namespaceRegex = /import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namespaceRegex.exec(content)) !== null) {
    imports.files.add(match[1]);
    // Namespace import means all exports are potentially used
    imports.named.add('*');
  }

  // Dynamic imports: import('./x')
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRegex.exec(content)) !== null) {
    imports.files.add(match[1]);
    imports.named.add('*');  // Dynamic import might use anything
  }

  // require(): require('./x')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.files.add(match[1]);
    imports.named.add('*');
  }

  // Type imports: import type { X } from './x'
  const typeRegex = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = typeRegex.exec(content)) !== null) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    names.forEach(name => imports.named.add(name));
    imports.files.add(match[2]);
  }

  return imports;
}

function findReferencesWithGrep(name, projectRoot, excludeFile) {
  // Use ripgrep for fast reference counting (with caching)
  const cacheKey = { op: 'rg-ref-count', name, types: 'js,ts' };

  const files = withCache(
    cacheKey,
    () => {
      const args = [
        '-l',  // Files only
        '--type', 'js',
        '--type', 'ts',
        '-w',  // Word boundary
        name,
        '.'
      ];

      const result = spawnSync('rg', args, {
        cwd: projectRoot,
        encoding: 'utf-8'
      });

      if (result.error || result.status !== 0) {
        return [];
      }

      return result.stdout.trim().split('\n').filter(Boolean);
    },
    { projectRoot }
  );

  // Exclude the file that exports it
  const relExclude = relative(projectRoot, excludeFile);
  const otherFiles = files.filter(f => f !== relExclude && !f.includes(relExclude));

  return otherFiles.length;
}

// ─────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────

function analyzeUnusedExports(files, projectRoot) {
  const allImports = {
    named: new Set(),
    files: new Set()
  };

  // First pass: collect all imports
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const imports = extractImports(content);

    imports.named.forEach(n => allImports.named.add(n));
    imports.files.forEach(f => allImports.files.add(f));
  }

  // Check if namespace imports are used (means everything is potentially used)
  const hasWildcardImport = allImports.named.has('*');

  // Second pass: find unused exports
  const unused = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const exports = extractExports(content, file);
    const relPath = relative(projectRoot, file);

    for (const exp of exports) {
      // Skip default exports (often intentionally exported)
      if (exp.name === 'default') continue;

      // If there's a wildcard import somewhere, we can't be sure it's unused
      if (hasWildcardImport) {
        // Do a more thorough grep-based check
        const refs = findReferencesWithGrep(exp.name, projectRoot, file);
        if (refs === 0) {
          unused.push({
            file: relPath,
            name: exp.name,
            line: exp.line,
            isType: exp.isType
          });
        }
      } else {
        // Simple check: is the name in our imports set?
        if (!allImports.named.has(exp.name)) {
          // Double-check with grep for common names
          if (exp.name.length <= 3 || /^[A-Z]/.test(exp.name)) {
            const refs = findReferencesWithGrep(exp.name, projectRoot, file);
            if (refs > 0) continue;
          }

          unused.push({
            file: relPath,
            name: exp.name,
            line: exp.line,
            isType: exp.isType
          });
        }
      }
    }
  }

  return unused;
}

function analyzeUnreferencedFiles(files, projectRoot) {
  const importedPaths = new Set();

  // Collect all imported paths
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const imports = extractImports(content);

    for (const importPath of imports.files) {
      // Resolve relative imports
      if (importPath.startsWith('.')) {
        const resolved = join(dirname(file), importPath);
        // Try with various extensions
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
        for (const ext of extensions) {
          importedPaths.add(resolved + ext);
        }
      }
    }
  }

  // Find unreferenced files
  const unreferenced = [];
  const entryPatterns = ['index.', 'main.', 'app.', 'server.', 'cli.', 'bin/'];

  for (const file of files) {
    const relPath = relative(projectRoot, file);

    // Skip likely entry points
    if (entryPatterns.some(p => relPath.includes(p))) {
      continue;
    }

    // Check if this file is imported
    const isImported = [...importedPaths].some(p => {
      return file.startsWith(p) || file === p;
    });

    if (!isImported) {
      // Double-check: look for any reference to the file basename
      const name = basename(file, extname(file));
      const refs = findReferencesWithGrep(name, projectRoot, file);

      if (refs === 0) {
        unreferenced.push(relPath);
      }
    }
  }

  return unreferenced;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let exportsOnly = false;
let filesOnly = false;
let includeTests = false;
const ignorePatterns = [];

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--exports-only' || arg === '-e') {
    exportsOnly = true;
  } else if (arg === '--files-only' || arg === '-f') {
    filesOnly = true;
  } else if (arg === '--include-tests') {
    includeTests = true;
  } else if (arg === '--ignore') {
    ignorePatterns.push(options.remaining[++i]);
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const targetDir = remaining[0] || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Find all code files
const files = findCodeFiles(targetDir, [], { includeTests, ignorePatterns });

if (files.length === 0) {
  console.error('No code files found');
  process.exit(1);
}

out.header(`🔍 Analyzing ${files.length} files for unused code...`);
out.blank();

const results = {
  unusedExports: [],
  unreferencedFiles: []
};

// Analyze unused exports
if (!filesOnly) {
  results.unusedExports = analyzeUnusedExports(files, projectRoot);

  if (results.unusedExports.length > 0) {
    out.add(`Potentially unused exports (${results.unusedExports.length}):`);
    out.blank();

    // Group by file
    const byFile = new Map();
    for (const exp of results.unusedExports) {
      if (!byFile.has(exp.file)) {
        byFile.set(exp.file, []);
      }
      byFile.get(exp.file).push(exp);
    }

    for (const [file, exports] of byFile) {
      out.add(`  ${file}`);
      for (const exp of exports) {
        const typeIndicator = exp.isType ? ' (type)' : '';
        out.add(`    L${exp.line}: ${exp.name}${typeIndicator}`);
      }
    }
    out.blank();
  }
}

// Analyze unreferenced files
if (!exportsOnly) {
  results.unreferencedFiles = analyzeUnreferencedFiles(files, projectRoot);

  if (results.unreferencedFiles.length > 0) {
    out.add(`Potentially unreferenced files (${results.unreferencedFiles.length}):`);
    out.blank();

    for (const file of results.unreferencedFiles) {
      out.add(`  ${file}`);
    }
    out.blank();
  }
}

// Set JSON data
out.setData('unusedExports', results.unusedExports);
out.setData('unreferencedFiles', results.unreferencedFiles);

// Summary
if (!options.quiet) {
  const totalIssues = results.unusedExports.length + results.unreferencedFiles.length;

  if (totalIssues === 0) {
    out.add('✓ No obviously unused code found');
  } else {
    out.add(`Found ${results.unusedExports.length} potentially unused exports, ${results.unreferencedFiles.length} unreferenced files`);
  }

  out.blank();
  out.add('Note: Review carefully - some exports may be public API or dynamically used');
}

out.print();
