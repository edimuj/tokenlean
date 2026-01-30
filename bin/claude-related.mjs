#!/usr/bin/env node

/**
 * Claude Related - Find related files (tests, types, usages)
 *
 * Given a file, finds its tests, type definitions, and files that import it.
 * Helps understand what to read before modifying a file.
 *
 * Usage: claude-related <file>
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, relative, extname } from 'path';
import { execSync } from 'child_process';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'android', 'ios', 'dist', 'build', '.expo', '.next'
]);

function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function estimateTokens(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return Math.ceil(content.length / 4);
  } catch {
    return 0;
  }
}

function formatTokens(tokens) {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function findTestFiles(filePath, projectRoot) {
  const dir = dirname(filePath);
  const name = basename(filePath, extname(filePath));
  const tests = [];

  // Common test patterns
  const patterns = [
    join(dir, `${name}.test.ts`),
    join(dir, `${name}.test.tsx`),
    join(dir, `${name}.spec.ts`),
    join(dir, `${name}.spec.tsx`),
    join(dir, '__tests__', `${name}.test.ts`),
    join(dir, '__tests__', `${name}.test.tsx`),
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
    const typeFiles = readdirSync(globalTypes).filter(f => f.endsWith('.ts'));
    for (const tf of typeFiles.slice(0, 5)) {
      types.push(join(globalTypes, tf));
    }
  }

  return types;
}

function findImporters(filePath, projectRoot) {
  const relPath = relative(projectRoot, filePath);
  const name = basename(filePath, extname(filePath));

  // Use ripgrep to find files that import this one
  const patterns = [
    `from.*['"].*${name}['"]`,
    `import.*['"].*${name}['"]`,
    `require\\(['"].*${name}['"]\\)`,
  ];

  const importers = new Set();

  for (const pattern of patterns) {
    try {
      const result = execSync(
        `rg -l "${pattern}" --type ts --type tsx ${projectRoot}/src 2>/dev/null || true`,
        { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
      );

      for (const line of result.trim().split('\n')) {
        if (line && line !== filePath && !line.includes('.test.') && !line.includes('.spec.')) {
          importers.add(line);
        }
      }
    } catch (e) { /* rg not found or no matches */ }
  }

  return Array.from(importers);
}

function findSiblings(filePath) {
  const dir = dirname(filePath);
  const siblings = [];

  try {
    const files = readdirSync(dir).filter(f => {
      const fullPath = join(dir, f);
      return statSync(fullPath).isFile() &&
        f !== basename(filePath) &&
        !f.includes('.test.') &&
        !f.includes('.spec.') &&
        (f.endsWith('.ts') || f.endsWith('.tsx'));
    });

    for (const f of files.slice(0, 5)) {
      siblings.push(join(dir, f));
    }
  } catch (e) { /* permission error */ }

  return siblings;
}

function printSection(title, files, projectRoot) {
  if (files.length === 0) return;

  console.log(`\n${title}`);
  for (const f of files) {
    const rel = relative(projectRoot, f);
    const tokens = estimateTokens(f);
    console.log(`  ${rel} (~${formatTokens(tokens)})`);
  }
}

// Main
const args = process.argv.slice(2);
const targetFile = args[0];

if (!targetFile) {
  console.log('\nUsage: claude-related <file>\n');
  console.log('Finds tests, types, and importers for a given file.');
  process.exit(1);
}

const fullPath = join(process.cwd(), targetFile);
if (!existsSync(fullPath)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, fullPath);

console.log(`\n📎 Related files for: ${relPath}`);

const tests = findTestFiles(fullPath, projectRoot);
const types = findTypeFiles(fullPath, projectRoot);
const importers = findImporters(fullPath, projectRoot);
const siblings = findSiblings(fullPath);

printSection('🧪 Tests', tests, projectRoot);
printSection('📝 Types', types, projectRoot);
printSection('📥 Imported by', importers.slice(0, 10), projectRoot);
printSection('👥 Siblings', siblings, projectRoot);

const totalFiles = tests.length + types.length + Math.min(importers.length, 10) + siblings.length;
if (totalFiles === 0) {
  console.log('\n  No related files found.');
}

// Summary
const totalTokens = [...tests, ...types, ...importers.slice(0, 10), ...siblings]
  .reduce((sum, f) => sum + estimateTokens(f), 0);

console.log(`\n📊 Total: ${totalFiles} related files, ~${formatTokens(totalTokens)} tokens`);

if (importers.length > 10) {
  console.log(`   (${importers.length - 10} more importers not shown)`);
}
console.log();
