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
import { join, relative, dirname, basename, extname, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep, batchRipgrep } from '../src/traverse.mjs';

ensureRipgrep();

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

function extractExports(content) {
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

// ─────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────

function analyzeUnusedExports(files, projectRoot, targetFiles = null) {
  const checkFiles = targetFiles || files;
  const allImports = {
    named: new Set(),
    files: new Set()
  };

  // Phase 1: collect all imports
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const imports = extractImports(content);

    imports.named.forEach(n => allImports.named.add(n));
    imports.files.forEach(f => allImports.files.add(f));
  }

  const hasWildcardImport = allImports.named.has('*');

  // Phase 2: collect candidates that need grep verification vs directly unused
  const candidates = [];  // Need grep confirmation
  const directUnused = []; // Definitely unused

  for (const file of checkFiles) {
    const content = readFileSync(file, 'utf-8');
    const exports = extractExports(content);
    const relPath = relative(projectRoot, file);

    for (const exp of exports) {
      if (exp.name === 'default') continue;

      if (hasWildcardImport) {
        // All exports need grep verification when wildcard imports exist
        candidates.push({ name: exp.name, file, relPath, exp });
      } else if (!allImports.named.has(exp.name)) {
        // Not in static imports — short/capitalized names need grep confirmation
        if (exp.name.length <= 3 || /^[A-Z]/.test(exp.name)) {
          candidates.push({ name: exp.name, file, relPath, exp });
        } else {
          directUnused.push({
            file: relPath,
            name: exp.name,
            line: exp.line,
            isType: exp.isType
          });
        }
      }
    }
  }

  // Phase 3: single batch search for all candidate names
  const unused = [...directUnused];

  if (candidates.length > 0) {
    const uniqueNames = [...new Set(candidates.map(c => c.name))];
    const sortedNames = uniqueNames.slice().sort();

    const batchResult = withCache(
      { op: 'rg-ref-batch', names: sortedNames },
      () => batchRipgrep(uniqueNames, '.', {
        cwd: projectRoot,
        types: ['js', 'ts'],
        wordBoundary: true,
        filesOnly: true
      }),
      { projectRoot }
    );

    // Phase 4: resolve candidates using batch results
    for (const cand of candidates) {
      const matches = batchResult[cand.name] || [];
      const relExclude = relative(projectRoot, cand.file);
      const otherFiles = matches.filter(m =>
        m.file !== relExclude && !m.file.includes(relExclude)
      );

      if (otherFiles.length === 0) {
        unused.push({
          file: cand.relPath,
          name: cand.name,
          line: cand.exp.line,
          isType: cand.exp.isType
        });
      }
    }
  }

  return unused;
}

function analyzeUnreferencedFiles(files, projectRoot, targetFiles = null) {
  const checkFiles = targetFiles || files;
  const importedPaths = new Set();

  // Phase 1: collect all imported paths
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const imports = extractImports(content);

    for (const importPath of imports.files) {
      if (importPath.startsWith('.')) {
        const resolved = join(dirname(file), importPath);
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
        for (const ext of extensions) {
          importedPaths.add(resolved + ext);
        }
      }
    }
  }

  // Phase 2: collect basenames of files not in imported paths
  const entryPatterns = ['index.', 'main.', 'app.', 'server.', 'cli.', 'bin/'];
  const candidateFiles = []; // {file, relPath, name}

  for (const file of checkFiles) {
    const relPath = relative(projectRoot, file);

    if (entryPatterns.some(p => relPath.includes(p))) continue;

    const isImported = [...importedPaths].some(p =>
      file.startsWith(p) || file === p
    );

    if (!isImported) {
      const name = basename(file, extname(file));
      candidateFiles.push({ file, relPath, name });
    }
  }

  if (candidateFiles.length === 0) return [];

  // Phase 3: single batch search for all candidate basenames
  const uniqueNames = [...new Set(candidateFiles.map(c => c.name))];
  const sortedNames = uniqueNames.slice().sort();

  const batchResult = withCache(
    { op: 'rg-unref-batch', names: sortedNames },
    () => batchRipgrep(uniqueNames, '.', {
      cwd: projectRoot,
      types: ['js', 'ts'],
      wordBoundary: true,
      filesOnly: true
    }),
    { projectRoot }
  );

  // Phase 4: filter truly unreferenced
  const unreferenced = [];

  for (const cand of candidateFiles) {
    const matches = batchResult[cand.name] || [];
    const relExclude = relative(projectRoot, cand.file);
    const otherFiles = matches.filter(m =>
      m.file !== relExclude && !m.file.includes(relExclude)
    );

    if (otherFiles.length === 0) {
      unreferenced.push(cand.relPath);
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
  console.error(`Not found: ${targetDir}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Handle single file vs directory
const targetStat = statSync(targetDir);
let files;
let allProjectFiles;

if (targetStat.isFile()) {
  if (!isCodeExtension(targetDir)) {
    console.error(`Not a code file: ${targetDir}`);
    process.exit(1);
  }
  files = [resolve(targetDir)];
  allProjectFiles = findCodeFiles(projectRoot, [], { includeTests, ignorePatterns });
  out.header(`🔍 Analyzing exports of ${relative(projectRoot, files[0])} against ${allProjectFiles.length} project files...`);
} else {
  files = findCodeFiles(targetDir, [], { includeTests, ignorePatterns });
  allProjectFiles = files;
  if (files.length === 0) {
    console.error('No code files found');
    process.exit(1);
  }
  out.header(`🔍 Analyzing ${files.length} files for unused code...`);
}
out.blank();

const results = {
  unusedExports: [],
  unreferencedFiles: []
};

// Analyze unused exports
if (!filesOnly) {
  results.unusedExports = analyzeUnusedExports(allProjectFiles, projectRoot, files);

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
  results.unreferencedFiles = analyzeUnreferencedFiles(allProjectFiles, projectRoot, files);

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
