#!/usr/bin/env node

/**
 * tl-env - Find environment variables and config used in the codebase
 *
 * Scans source files for process.env, import.meta.env, getenv(), os.environ,
 * and similar patterns. Also finds .env files and config references.
 *
 * Usage: tl-env [dir] [--show-files]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-env',
    desc: 'Find environment variables used in codebase',
    when: 'before-read',
    example: 'tl-env src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  formatTable,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip, isCodeFile, detectLanguage } from '../src/project.mjs';

const HELP = `
tl-env - Find environment variables and config used in the codebase

Usage: tl-env [dir] [options]

Options:
  --show-files, -f      Show which files use each variable
  --show-values         Show values from .env files (careful with secrets!)
  --required-only, -r   Show only required/non-optional env vars
${COMMON_OPTIONS_HELP}

Examples:
  tl-env                     # Scan current directory
  tl-env src/                # Scan specific directory
  tl-env -f                  # Show which files use each var
  tl-env -j                  # JSON output

Detects:
  JavaScript/TypeScript: process.env.*, import.meta.env.*
  Python: os.environ, os.getenv(), environ.get()
  Ruby: ENV['*'], ENV.fetch()
  Go: os.Getenv(), viper.Get*()
  Config files: .env, .env.*, config/*.json
`;

// ─────────────────────────────────────────────────────────────
// Environment Variable Patterns
// ─────────────────────────────────────────────────────────────

const ENV_PATTERNS = {
  javascript: [
    // process.env.VAR_NAME or process.env['VAR_NAME']
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    // import.meta.env.VITE_VAR
    /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    // Destructuring: const { VAR } = process.env
    /const\s*\{\s*([A-Z][A-Z0-9_,\s]*)\s*\}\s*=\s*process\.env/g
  ],
  typescript: [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /const\s*\{\s*([A-Z][A-Z0-9_,\s]*)\s*\}\s*=\s*process\.env/g
  ],
  python: [
    // os.environ['VAR'] or os.environ.get('VAR')
    /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /os\.environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]/g,
    /os\.getenv\(['"]([A-Z][A-Z0-9_]*)['"]/g,
    // environ.get('VAR') after from os import environ
    /environ\.get\(['"]([A-Z][A-Z0-9_]*)['"]/g,
    /environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g
  ],
  ruby: [
    /ENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /ENV\.fetch\(['"]([A-Z][A-Z0-9_]*)['"]/g
  ],
  go: [
    /os\.Getenv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /os\.LookupEnv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    /viper\.Get(?:String|Int|Bool|Float64)?\(['"]([A-Za-z][A-Za-z0-9_.]*)['"]\)/g
  ]
};

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
      if (!shouldSkip(entry.name, false) && isCodeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function findEnvFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory() && !shouldSkip(entry.name, true)) {
      findEnvFiles(fullPath, files);
    } else if (entry.isFile()) {
      // .env, .env.local, .env.development, .env.example, .env.sample, etc.
      if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────

function extractEnvVars(content, language) {
  const vars = new Set();
  const patterns = ENV_PATTERNS[language];

  if (!patterns) return vars;

  for (const pattern of patterns) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const captured = match[1];

      // Handle destructuring pattern: { VAR1, VAR2 }
      if (captured.includes(',')) {
        const names = captured.split(',').map(n => n.trim()).filter(n => /^[A-Z]/.test(n));
        names.forEach(n => vars.add(n));
      } else {
        vars.add(captured);
      }
    }
  }

  return vars;
}

function parseEnvFile(content) {
  const vars = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse KEY=value
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      // Remove quotes if present
      vars[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return vars;
}

function detectRequired(content, varName, language) {
  // Heuristics for detecting if a var is required
  const patterns = [];

  if (language === 'javascript' || language === 'typescript') {
    // Patterns that suggest the var is required (no fallback)
    patterns.push(
      new RegExp(`process\\.env\\.${varName}(?![\\s]*\\|\\|)(?![\\s]*\\?\\?)`, 'g'),
      new RegExp(`throw.*${varName}`, 'gi'),
      new RegExp(`required.*${varName}`, 'gi')
    );
  }

  // If we find patterns suggesting it's required without fallback
  for (const pattern of patterns) {
    if (pattern.test(content)) return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const showFiles = options.remaining.includes('--show-files') || options.remaining.includes('-f');
const showValues = options.remaining.includes('--show-values');
const requiredOnly = options.remaining.includes('--required-only') || options.remaining.includes('-r');
const targetDir = options.remaining.find(a => !a.startsWith('-')) || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const projectRoot = findProjectRoot(targetDir);
const out = createOutput(options);

// Track vars with their usage info
const envVars = new Map(); // varName -> { files: Set, values: Map, required: bool }

// 1. Scan source files
const sourceFiles = findSourceFiles(targetDir);

for (const filePath of sourceFiles) {
  const content = readFileSync(filePath, 'utf-8');
  const lang = detectLanguage(filePath);
  if (!lang) continue;

  const vars = extractEnvVars(content, lang);
  const relPath = relative(projectRoot, filePath);

  for (const varName of vars) {
    if (!envVars.has(varName)) {
      envVars.set(varName, { files: new Set(), values: new Map(), required: false });
    }

    const info = envVars.get(varName);
    info.files.add(relPath);

    // Check if this usage suggests it's required
    if (detectRequired(content, varName, lang)) {
      info.required = true;
    }
  }
}

// 2. Parse .env files for values
const envFiles = findEnvFiles(projectRoot);
const envFileVars = new Map(); // Track vars defined in env files

for (const envFile of envFiles) {
  const content = readFileSync(envFile, 'utf-8');
  const vars = parseEnvFile(content);
  const relPath = relative(projectRoot, envFile);

  for (const [varName, value] of Object.entries(vars)) {
    envFileVars.set(varName, true);

    if (!envVars.has(varName)) {
      envVars.set(varName, { files: new Set(), values: new Map(), required: false });
    }

    const info = envVars.get(varName);
    info.values.set(relPath, value);
  }
}

// Filter if required only
let varsToShow = [...envVars.entries()];
if (requiredOnly) {
  varsToShow = varsToShow.filter(([, info]) => info.required);
}

// Sort by name
varsToShow.sort((a, b) => a[0].localeCompare(b[0]));

// Build output
const usedInCode = varsToShow.filter(([, info]) => info.files.size > 0);
const definedOnly = varsToShow.filter(([, info]) => info.files.size === 0);

// Set JSON data
out.setData('variables', varsToShow.map(([name, info]) => ({
  name,
  usedIn: [...info.files],
  definedIn: [...info.values.keys()],
  required: info.required,
  hasValue: info.values.size > 0
})));
out.setData('envFiles', envFiles.map(f => relative(projectRoot, f)));
out.setData('totalVars', varsToShow.length);

// Text output
if (usedInCode.length > 0) {
  out.header('Environment Variables (used in code):');
  out.blank();

  const rows = [];
  for (const [varName, info] of usedInCode) {
    const status = [];
    if (info.required) status.push('required');
    if (info.values.size === 0) status.push('no default');

    const statusStr = status.length > 0 ? ` (${status.join(', ')})` : '';

    rows.push([`  ${varName}`, statusStr]);

    if (showFiles && info.files.size > 0) {
      for (const file of info.files) {
        rows.push(['    ', `-> ${file}`]);
      }
    }

    if (showValues && info.values.size > 0) {
      for (const [file, value] of info.values) {
        const displayValue = value.length > 30 ? value.slice(0, 27) + '...' : value;
        rows.push(['    ', `= ${displayValue} (${basename(file)})`]);
      }
    }
  }

  formatTable(rows).forEach(line => out.add(line));
  out.blank();
}

if (definedOnly.length > 0 && !requiredOnly) {
  out.header('Defined in .env but not used in code:');
  out.blank();
  for (const [varName] of definedOnly) {
    out.add(`  ${varName}`);
  }
  out.blank();
}

// Show env files found
if (envFiles.length > 0 && !options.quiet) {
  out.add('Env files found:');
  for (const file of envFiles) {
    out.add(`  ${relative(projectRoot, file)}`);
  }
  out.blank();
}

// Summary
if (!options.quiet) {
  const usedCount = usedInCode.length;
  const definedCount = definedOnly.length;
  const requiredCount = varsToShow.filter(([, info]) => info.required).length;

  out.add(`Found ${usedCount} env vars used in code${requiredCount > 0 ? ` (${requiredCount} required)` : ''}`);
  if (definedCount > 0 && !requiredOnly) {
    out.add(`Found ${definedCount} env vars defined but not used`);
  }
}

out.print();
