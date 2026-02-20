#!/usr/bin/env node

/**
 * tl-lint-config - Summarize project lint/format/type rules
 *
 * Scans for ESLint, Prettier, TypeScript, Biome, and EditorConfig
 * files. Extracts key rules into a compact, token-efficient summary.
 *
 * Usage: tl-lint-config [path]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-lint-config',
    desc: 'Summarize lint/format/type config rules',
    when: 'before-modify',
    example: 'tl-lint-config'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-lint-config - Summarize project lint/format/type config rules

Usage: tl-lint-config [path] [options]

Options:
${COMMON_OPTIONS_HELP}

Detects:
  ESLint (.eslintrc*, eslint.config.*)
  Prettier (.prettierrc*, prettier.config.*)
  TypeScript (tsconfig.json)
  Biome (biome.json, biome.jsonc)
  EditorConfig (.editorconfig)

Examples:
  tl-lint-config                # Current project
  tl-lint-config /path/to/repo  # Specific repo
  tl-lint-config -j             # JSON output
`;

// ─────────────────────────────────────────────────────────────
// Config File Detection
// ─────────────────────────────────────────────────────────────

const CONFIG_FILES = {
  eslint: [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
    '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintrc.yaml', '.eslintrc'
  ],
  prettier: [
    '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
    '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs',
    'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'
  ],
  typescript: ['tsconfig.json'],
  biome: ['biome.json', 'biome.jsonc'],
  editorconfig: ['.editorconfig']
};

function findConfigFiles(projectRoot) {
  const found = {};

  for (const [tool, files] of Object.entries(CONFIG_FILES)) {
    for (const file of files) {
      const fullPath = join(projectRoot, file);
      if (existsSync(fullPath)) {
        found[tool] = { path: fullPath, file };
        break;
      }
    }
  }

  // Also check package.json for inline config
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.eslintConfig && !found.eslint) {
        found.eslint = { path: pkgPath, file: 'package.json (eslintConfig)', inline: pkg.eslintConfig };
      }
      if (pkg.prettier && !found.prettier) {
        found.prettier = { path: pkgPath, file: 'package.json (prettier)', inline: pkg.prettier };
      }
    } catch { /* ignore */ }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Config Parsers
// ─────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    let content = readFileSync(filePath, 'utf-8');
    // Strip JSONC comments
    if (filePath.endsWith('.jsonc') || filePath.endsWith('.json')) {
      content = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    }
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function summarizeEslint(config) {
  const lines = [];

  if (config.inline) {
    return summarizeEslintObj(config.inline);
  }

  const ext = config.file;

  // For JS/MJS config files (flat config), we can only read and extract string patterns
  if (ext.endsWith('.js') || ext.endsWith('.mjs') || ext.endsWith('.cjs')) {
    try {
      const content = readFileSync(config.path, 'utf-8');
      // Extract extends/plugins from source
      const extendsMatch = content.match(/extends\s*:\s*\[([^\]]+)\]/);
      if (extendsMatch) {
        lines.push(`extends: ${extendsMatch[1].replace(/['"\s]/g, '')}`);
      }
      const pluginMatches = [...content.matchAll(/['"](@?\w[\w/-]*)['"]/g)]
        .map(m => m[1])
        .filter(p => p.includes('plugin') || p.includes('eslint'));
      if (pluginMatches.length > 0) {
        const unique = [...new Set(pluginMatches)];
        lines.push(`plugins: ${unique.slice(0, 8).join(', ')}`);
      }
      // Extract rule overrides
      const ruleMatches = [...content.matchAll(/['"](@?[\w/-]+)['"]\s*:\s*['"](error|warn|off)['"]/g)];
      for (const m of ruleMatches.slice(0, 15)) {
        lines.push(`  ${m[1]}: ${m[2]}`);
      }
      if (ruleMatches.length > 15) {
        lines.push(`  ... and ${ruleMatches.length - 15} more rules`);
      }
    } catch { /* unreadable */ }
    return lines;
  }

  // JSON config
  const data = readJson(config.path);
  if (!data) return ['(unreadable)'];
  return summarizeEslintObj(data);
}

function summarizeEslintObj(data) {
  const lines = [];

  if (data.extends) {
    const ext = Array.isArray(data.extends) ? data.extends : [data.extends];
    lines.push(`extends: ${ext.join(', ')}`);
  }
  if (data.plugins) {
    lines.push(`plugins: ${data.plugins.join(', ')}`);
  }
  if (data.parser) {
    lines.push(`parser: ${data.parser}`);
  }
  if (data.rules) {
    const entries = Object.entries(data.rules);
    for (const [rule, value] of entries.slice(0, 15)) {
      const level = Array.isArray(value) ? value[0] : value;
      const opts = Array.isArray(value) && value.length > 1 ? ` (${JSON.stringify(value[1])})` : '';
      lines.push(`  ${rule}: ${level}${opts}`);
    }
    if (entries.length > 15) {
      lines.push(`  ... and ${entries.length - 15} more rules`);
    }
  }

  return lines;
}

function summarizePrettier(config) {
  const lines = [];

  let data;
  if (config.inline) {
    data = config.inline;
  } else if (config.file.endsWith('.json') || config.file === '.prettierrc') {
    data = readJson(config.path);
  } else {
    // JS config — extract what we can
    try {
      const content = readFileSync(config.path, 'utf-8');
      const matches = [...content.matchAll(/([\w]+)\s*:\s*(['"]?\w+['"]?|true|false|\d+)/g)];
      for (const m of matches.slice(0, 10)) {
        lines.push(`${m[1]}: ${m[2].replace(/['"]/g, '')}`);
      }
    } catch { /* unreadable */ }
    return lines;
  }

  if (!data) return ['(unreadable)'];

  const NOTABLE_KEYS = [
    'printWidth', 'tabWidth', 'useTabs', 'semi', 'singleQuote',
    'trailingComma', 'bracketSpacing', 'arrowParens', 'endOfLine',
    'proseWrap', 'quoteProps'
  ];

  for (const key of NOTABLE_KEYS) {
    if (key in data) {
      lines.push(`${key}: ${data[key]}`);
    }
  }

  if (data.overrides) {
    lines.push(`overrides: ${data.overrides.length} file-specific rules`);
  }

  return lines;
}

function summarizeTypescript(config) {
  const data = readJson(config.path);
  if (!data) return ['(unreadable)'];

  const lines = [];
  const co = data.compilerOptions || {};

  // Key options agents care about
  const NOTABLE = {
    target: co.target,
    module: co.module,
    moduleResolution: co.moduleResolution,
    strict: co.strict,
    jsx: co.jsx,
    lib: co.lib ? co.lib.join(', ') : undefined,
    outDir: co.outDir,
    rootDir: co.rootDir,
    baseUrl: co.baseUrl,
    paths: co.paths ? `${Object.keys(co.paths).length} aliases` : undefined,
    esModuleInterop: co.esModuleInterop,
    skipLibCheck: co.skipLibCheck,
    declaration: co.declaration,
    noEmit: co.noEmit
  };

  for (const [key, value] of Object.entries(NOTABLE)) {
    if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (data.extends) lines.push(`extends: ${data.extends}`);
  if (data.include) lines.push(`include: ${data.include.join(', ')}`);
  if (data.exclude) lines.push(`exclude: ${data.exclude.join(', ')}`);

  return lines;
}

function summarizeBiome(config) {
  const data = readJson(config.path);
  if (!data) return ['(unreadable)'];

  const lines = [];

  if (data.formatter) {
    const f = data.formatter;
    if (f.indentStyle) lines.push(`indent: ${f.indentStyle} (${f.indentWidth || 2})`);
    if (f.lineWidth) lines.push(`lineWidth: ${f.lineWidth}`);
  }

  if (data.linter?.rules) {
    const ruleGroups = Object.entries(data.linter.rules);
    for (const [group, rules] of ruleGroups) {
      if (group === 'recommended' || group === 'all') {
        lines.push(`${group}: ${rules}`);
        continue;
      }
      if (typeof rules === 'object') {
        const entries = Object.entries(rules);
        for (const [rule, value] of entries.slice(0, 5)) {
          lines.push(`  ${group}/${rule}: ${typeof value === 'object' ? value.level || 'on' : value}`);
        }
        if (entries.length > 5) lines.push(`  ... and ${entries.length - 5} more`);
      }
    }
  }

  if (data.javascript?.formatter) {
    const jf = data.javascript.formatter;
    if (jf.quoteStyle) lines.push(`quotes: ${jf.quoteStyle}`);
    if (jf.semicolons) lines.push(`semicolons: ${jf.semicolons}`);
  }

  return lines;
}

function summarizeEditorconfig(config) {
  const lines = [];
  try {
    const content = readFileSync(config.path, 'utf-8');
    let currentSection = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const sectionMatch = trimmed.match(/^\[(.+)\]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        lines.push(`[${currentSection}]`);
        continue;
      }

      const kvMatch = trimmed.match(/^([\w_]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        lines.push(`  ${kvMatch[1]}: ${kvMatch[2]}`);
      }
    }
  } catch { /* unreadable */ }
  return lines;
}

const SUMMARIZERS = {
  eslint: { label: 'ESLint', fn: summarizeEslint },
  prettier: { label: 'Prettier', fn: summarizePrettier },
  typescript: { label: 'TypeScript', fn: summarizeTypescript },
  biome: { label: 'Biome', fn: summarizeBiome },
  editorconfig: { label: 'EditorConfig', fn: summarizeEditorconfig }
};

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
const configs = findConfigFiles(projectRoot);

if (Object.keys(configs).length === 0) {
  console.error('No lint/format config files found');
  process.exit(1);
}

const out = createOutput(options);
const jsonData = {};

for (const [tool, config] of Object.entries(configs)) {
  const { label, fn } = SUMMARIZERS[tool];
  const lines = fn(config);

  if (!options.quiet) {
    out.add(`${label} (${config.file}):`);
  } else {
    out.add(`${label}:`);
  }

  for (const line of lines) {
    out.add(`  ${line}`);
  }
  out.blank();

  jsonData[tool] = {
    file: config.file,
    rules: lines
  };
}

out.setData('configs', jsonData);
out.setData('configCount', Object.keys(configs).length);

out.print();
