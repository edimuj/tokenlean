#!/usr/bin/env node

/**
 * Claude Search - Generic pre-defined search patterns
 *
 * Looks for .claude/search-patterns.json in the current project.
 * Usage: claude-search <pattern-name>
 */

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const CONFIG_PATH = '.claude/search-patterns.json';

function findConfig() {
  let dir = process.cwd();
  while (dir !== '/') {
    const configPath = join(dir, CONFIG_PATH);
    if (existsSync(configPath)) {
      return { path: configPath, root: dir };
    }
    dir = join(dir, '..');
  }
  return null;
}

function loadPatterns(configPath) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.patterns;
  } catch (e) {
    console.error('Error loading search patterns:', e.message);
    process.exit(1);
  }
}

function showHelp(patterns) {
  console.log('\n📍 Available search patterns:\n');

  const maxLen = Math.max(...Object.keys(patterns).map(k => k.length));

  for (const [name, config] of Object.entries(patterns)) {
    const paddedName = name.padEnd(maxLen);
    console.log(`  ${paddedName}  ${config.description}`);
  }

  console.log('\nUsage: claude-search <pattern-name>');
  console.log('Example: claude-search hooks\n');
}

function runSearch(name, config, rootDir) {
  console.log(`\n🔍 Searching: ${config.description}`);
  console.log(`   Pattern: ${config.pattern}\n`);

  if (config.type === 'glob-only') {
    const args = ['--files', '-g', config.pattern];
    if (config.exclude) {
      for (const ex of config.exclude) {
        args.push('-g', `!${ex}`);
      }
    }
    args.push(rootDir);
    const proc = spawn('rg', args, { stdio: 'inherit' });
    proc.on('close', code => process.exit(code === 1 ? 0 : code));
    return;
  }

  const args = ['--color=always', '-n', '-E', config.pattern];

  if (config.glob) {
    args.push('-g', config.glob);
  }

  if (config.exclude) {
    for (const ex of config.exclude) {
      args.push('-g', `!${ex}`);
    }
  }

  args.push(rootDir);

  const proc = spawn('rg', args, { stdio: 'inherit' });
  proc.on('close', code => {
    if (code === 1) {
      console.log('No matches found.');
    }
    process.exit(code === 1 ? 0 : code);
  });
}

// Main
const found = findConfig();
if (!found) {
  console.error('No .claude/search-patterns.json found in this project or parent directories.');
  console.error('Create one with pattern definitions to use this tool.');
  process.exit(1);
}

const patterns = loadPatterns(found.path);
const patternName = process.argv[2];

if (!patternName || patternName === '--help' || patternName === '-h') {
  showHelp(patterns);
  process.exit(0);
}

if (!patterns[patternName]) {
  console.error(`\nUnknown pattern: "${patternName}"`);
  showHelp(patterns);
  process.exit(1);
}

runSearch(patternName, patterns[patternName], found.root);
