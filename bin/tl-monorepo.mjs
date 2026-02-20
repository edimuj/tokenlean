#!/usr/bin/env node

/**
 * tl-monorepo - Package structure overview for monorepos
 *
 * Detects monorepo patterns (npm/yarn/pnpm workspaces, lerna),
 * lists packages with internal cross-dependencies.
 *
 * Usage: tl-monorepo [path]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-monorepo',
    desc: 'Show monorepo package structure and cross-deps',
    when: 'before-read',
    example: 'tl-monorepo'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-monorepo - Package structure overview for monorepos

Usage: tl-monorepo [path] [options]

Options:
${COMMON_OPTIONS_HELP}

Detects:
  npm/yarn workspaces (package.json "workspaces")
  pnpm workspaces (pnpm-workspace.yaml)
  lerna (lerna.json)

Examples:
  tl-monorepo                  # Analyze current project
  tl-monorepo /path/to/repo    # Analyze specific repo
  tl-monorepo -j               # JSON output
`;

// ─────────────────────────────────────────────────────────────
// Monorepo Detection
// ─────────────────────────────────────────────────────────────

function detectMonorepoType(projectRoot) {
  const pkgPath = join(projectRoot, 'package.json');

  // npm/yarn workspaces
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces) {
        const patterns = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : pkg.workspaces.packages || [];
        return { type: 'workspaces', patterns };
      }
    } catch { /* ignore parse errors */ }
  }

  // pnpm workspaces
  const pnpmPath = join(projectRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmPath)) {
    try {
      const content = readFileSync(pnpmPath, 'utf-8');
      const patterns = [];
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*-\s+['"]?([^'"]+)['"]?\s*$/);
        if (match) patterns.push(match[1]);
      }
      if (patterns.length > 0) return { type: 'pnpm', patterns };
    } catch { /* ignore */ }
  }

  // lerna
  const lernaPath = join(projectRoot, 'lerna.json');
  if (existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(readFileSync(lernaPath, 'utf-8'));
      const patterns = lerna.packages || ['packages/*'];
      return { type: 'lerna', patterns };
    } catch { /* ignore */ }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Package Discovery
// ─────────────────────────────────────────────────────────────

function expandGlob(projectRoot, pattern) {
  // Simple glob expansion: handles "packages/*" and "apps/*" patterns
  // Doesn't handle ** or complex globs — covers 95% of monorepos
  const dirs = [];

  if (pattern.endsWith('/*') || pattern.endsWith('\\*')) {
    const base = pattern.slice(0, -2);
    const baseDir = join(projectRoot, base);
    if (!existsSync(baseDir)) return dirs;

    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        dirs.push(join(baseDir, entry.name));
      }
    }
  } else {
    // Direct path
    const dir = join(projectRoot, pattern);
    if (existsSync(dir)) dirs.push(dir);
  }

  return dirs;
}

function discoverPackages(projectRoot, patterns) {
  const packages = [];

  for (const pattern of patterns) {
    const dirs = expandGlob(projectRoot, pattern);

    for (const dir of dirs) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;

      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        packages.push({
          name: pkg.name || basename(dir),
          version: pkg.version || '0.0.0',
          path: relative(projectRoot, dir),
          private: pkg.private || false,
          dependencies: { ...pkg.dependencies },
          devDependencies: { ...pkg.devDependencies },
          peerDependencies: { ...pkg.peerDependencies }
        });
      } catch { /* skip unparseable */ }
    }
  }

  return packages;
}

// ─────────────────────────────────────────────────────────────
// Cross-dependency Analysis
// ─────────────────────────────────────────────────────────────

function analyzeInternalDeps(packages) {
  const packageNames = new Set(packages.map(p => p.name));

  return packages.map(pkg => {
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies
    };

    const internalDeps = Object.keys(allDeps).filter(d => packageNames.has(d));
    const externalCount = Object.keys(allDeps).length - internalDeps.length;

    return {
      name: pkg.name,
      version: pkg.version,
      path: pkg.path,
      private: pkg.private,
      internalDeps,
      externalDeps: externalCount,
      dependedOnBy: []
    };
  });
}

function addReverseDeps(analyzed) {
  const byName = new Map(analyzed.map(p => [p.name, p]));

  for (const pkg of analyzed) {
    for (const dep of pkg.internalDeps) {
      const target = byName.get(dep);
      if (target) {
        target.dependedOnBy.push(pkg.name);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const targetDir = options.remaining.find(a => !a.startsWith('-')) || '.';
const projectRoot = findProjectRoot(targetDir);

const mono = detectMonorepoType(projectRoot);

if (!mono) {
  console.error('Not a monorepo (no workspaces, pnpm-workspace.yaml, or lerna.json found)');
  process.exit(1);
}

const packages = discoverPackages(projectRoot, mono.patterns);

if (packages.length === 0) {
  console.error(`Monorepo detected (${mono.type}) but no packages found in: ${mono.patterns.join(', ')}`);
  process.exit(1);
}

const analyzed = analyzeInternalDeps(packages);
addReverseDeps(analyzed);

// Sort: most depended-on first
analyzed.sort((a, b) => b.dependedOnBy.length - a.dependedOnBy.length);

const out = createOutput(options);

if (!options.quiet) {
  out.header(`Monorepo: ${packages.length} packages (${mono.type})`);
  out.blank();
}

for (const pkg of analyzed) {
  const parts = [`${pkg.path}`];
  if (pkg.version !== '0.0.0') parts.push(`v${pkg.version}`);
  if (pkg.private) parts.push('private');

  let depsStr;
  if (pkg.internalDeps.length === 0) {
    depsStr = 'no internal deps';
  } else {
    depsStr = `depends on: ${pkg.internalDeps.join(', ')}`;
  }

  const usedBy = pkg.dependedOnBy.length > 0
    ? ` | used by: ${pkg.dependedOnBy.join(', ')}`
    : '';

  out.add(`  ${parts.join(' | ')} - ${depsStr}${usedBy}`);
}

out.blank();

if (!options.quiet) {
  const leafs = analyzed.filter(p => p.internalDeps.length === 0).length;
  const roots = analyzed.filter(p => p.dependedOnBy.length === 0).length;
  out.add(`${leafs} leaf packages, ${roots} root packages, ${packages.length - leafs - roots + Math.min(leafs, roots)} shared`);
}

// JSON data
out.setData('type', mono.type);
out.setData('patterns', mono.patterns);
out.setData('packages', analyzed.map(p => ({
  name: p.name,
  version: p.version,
  path: p.path,
  private: p.private,
  internalDeps: p.internalDeps,
  externalDeps: p.externalDeps,
  dependedOnBy: p.dependedOnBy
})));

out.print();
