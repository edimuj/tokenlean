#!/usr/bin/env node

/**
 * tl-related - Find related files (tests, types, usages)
 *
 * Given a file, finds its tests, type definitions, and files that import it.
 * Helps understand what to read before modifying a file.
 *
 * Usage: tl-related <file>
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-related',
    desc: 'Find tests, types, and importers of a file',
    when: 'before-modify',
    example: 'tl-related src/Button.tsx'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, relative, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep } from '../src/traverse.mjs';
import { rgCommand } from '../src/shell.mjs';

ensureRipgrep();

const HELP = `
tl-related - Find related files (tests, types, usages)

Usage: tl-related <file> [options]
${COMMON_OPTIONS_HELP}

Examples:
  tl-related src/Button.tsx        # Find tests, types, importers
  tl-related src/api.ts -j         # JSON output
  tl-related src/utils.ts -q       # Quiet (file paths only)
`;

function findTestFiles(filePath) {
  const dir = dirname(filePath);
  const name = basename(filePath, extname(filePath));
  const tests = [];

  // Common test patterns
  const patterns = [
    join(dir, `${name}.test.ts`),
    join(dir, `${name}.test.tsx`),
    join(dir, `${name}.test.js`),
    join(dir, `${name}.test.jsx`),
    join(dir, `${name}.spec.ts`),
    join(dir, `${name}.spec.tsx`),
    join(dir, `${name}.spec.js`),
    join(dir, `${name}.spec.jsx`),
    join(dir, '__tests__', `${name}.test.ts`),
    join(dir, '__tests__', `${name}.test.tsx`),
    join(dir, '__tests__', `${name}.test.js`),
    join(dir, '__tests__', `${name}.spec.ts`),
    join(dir, '__tests__', `${name}.spec.tsx`),
  ];

  for (const p of patterns) {
    if (existsSync(p)) {
      tests.push(p);
    }
  }

  return tests;
}

function findTypeFiles(filePath, projectRoot) {
  const dir = dirname(filePath);
  const name = basename(filePath, extname(filePath));
  const types = [];

  // Check for adjacent type file
  const typePatterns = [
    join(dir, `${name}.types.ts`),
    join(dir, 'types.ts'),
    join(dir, 'types', `${name}.ts`),
  ];

  for (const p of typePatterns) {
    if (existsSync(p)) {
      types.push(p);
    }
  }

  // Check project-wide types directory
  const globalTypes = join(projectRoot, 'src', 'types');
  if (existsSync(globalTypes)) {
    try {
      const typeFiles = readdirSync(globalTypes).filter(f => f.endsWith('.ts'));
      for (const tf of typeFiles.slice(0, 5)) {
        types.push(join(globalTypes, tf));
      }
    } catch { /* permission error */ }
  }

  return types;
}

function findImporters(filePath, projectRoot) {
  const name = basename(filePath, extname(filePath));
  const importers = new Set();

  // Search for files that might import this module (with caching)
  try {
    const cacheKey = { op: 'rg-find-importers', module: name, glob: '*.{js,mjs,ts,tsx,jsx}' };
    const result = withCache(
      cacheKey,
      () => rgCommand(['-l', '--glob', '*.{js,mjs,ts,tsx,jsx}', '-e', name, projectRoot], { maxBuffer: 5 * 1024 * 1024 }) || '',
      { projectRoot }
    );

    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      if (line === filePath) continue;
      if (line.includes('.test.') || line.includes('.spec.')) continue;
      if (line.includes('node_modules')) continue;

      // Verify it's actually an import statement
      try {
        const content = readFileSync(line, 'utf-8');
        // Match: from '...name' or from "...name" or require('...name')
        const pattern = new RegExp(`(?:from|require)\\s*\\(?\\s*['"][^'"]*\\/${name}(?:\\.m?[jt]sx?)?['"]`);
        if (pattern.test(content)) {
          importers.add(line);
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* rg not found or no matches */ }

  return Array.from(importers);
}

function findSiblings(filePath) {
  const dir = dirname(filePath);
  const siblings = [];

  try {
    const files = readdirSync(dir).filter(f => {
      const fullPath = join(dir, f);
      try {
        return statSync(fullPath).isFile() &&
          f !== basename(filePath) &&
          !f.includes('.test.') &&
          !f.includes('.spec.') &&
          (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'));
      } catch {
        return false;
      }
    });

    for (const f of files.slice(0, 5)) {
      siblings.push(join(dir, f));
    }
  } catch { /* permission error */ }

  return siblings;
}

function getFileInfo(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return {
      tokens: estimateTokens(content),
      lines: content.split('\n').length
    };
  } catch {
    return { tokens: 0, lines: 0 };
  }
}

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const targetFile = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !targetFile) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const fullPath = targetFile.startsWith('/') ? targetFile : join(process.cwd(), targetFile);
if (!existsSync(fullPath)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, fullPath);
const out = createOutput(options);

const tests = findTestFiles(fullPath);
const types = findTypeFiles(fullPath, projectRoot);
const importers = findImporters(fullPath, projectRoot);
const siblings = findSiblings(fullPath);

// Collect file info for JSON
const testsInfo = tests.map(f => ({ path: relative(projectRoot, f), ...getFileInfo(f) }));
const typesInfo = types.map(f => ({ path: relative(projectRoot, f), ...getFileInfo(f) }));
const importersInfo = importers.slice(0, 10).map(f => ({ path: relative(projectRoot, f), ...getFileInfo(f) }));
const siblingsInfo = siblings.map(f => ({ path: relative(projectRoot, f), ...getFileInfo(f) }));

// Set JSON data
out.setData('file', relPath);
out.setData('tests', testsInfo);
out.setData('types', typesInfo);
out.setData('importers', importersInfo);
out.setData('siblings', siblingsInfo);
out.setData('totalImporters', importers.length);

// Header
out.header(`Related files for: ${relPath}`);
out.blank();

// Sections
function addSection(title, files) {
  if (files.length === 0) return;
  out.add(title);
  for (const f of files) {
    const rel = relative(projectRoot, f);
    const info = getFileInfo(f);
    out.add(`  ${rel} (~${formatTokens(info.tokens)})`);
  }
  out.blank();
}

addSection('Tests:', tests);
addSection('Types:', types);
addSection('Imported by:', importers.slice(0, 10));
addSection('Siblings:', siblings);

const totalFiles = tests.length + types.length + Math.min(importers.length, 10) + siblings.length;
if (totalFiles === 0) {
  out.add('  No related files found.');
  out.blank();
}

// Summary
const allFiles = [...tests, ...types, ...importers.slice(0, 10), ...siblings];
const totalTokens = allFiles.reduce((sum, f) => sum + getFileInfo(f).tokens, 0);

out.setData('totalFiles', totalFiles);
out.setData('totalTokens', totalTokens);

out.header(`Total: ${totalFiles} related files, ~${formatTokens(totalTokens)} tokens`);

if (importers.length > 10) {
  out.header(`(${importers.length - 10} more importers not shown)`);
}

out.print();
