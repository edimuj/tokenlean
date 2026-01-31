#!/usr/bin/env node

/**
 * tl-search - Run pre-defined search patterns
 *
 * Looks for searchPatterns in:
 *   1. .tokenleanrc.json in project root
 *   2. ~/.tokenleanrc.json (global)
 *
 * Usage: tl-search <pattern-name>
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-search',
    desc: 'Run pre-defined search patterns',
    when: 'search',
    example: 'tl-search'
  }));
  process.exit(0);
}

import { spawn, execSync } from 'child_process';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { loadConfig, CONFIG_FILENAME } from '../src/config.mjs';

const HELP = `
tl-search - Run pre-defined search patterns

Usage: tl-search <pattern-name> [options]
${COMMON_OPTIONS_HELP}

Configure patterns in ${CONFIG_FILENAME}:
{
  "searchPatterns": {
    "hooks": {
      "description": "Find lifecycle hooks",
      "pattern": "use(Effect|State|Callback)",
      "glob": "**/*.{ts,tsx}"
    }
  }
}

Examples:
  tl-search                  # List available patterns
  tl-search hooks            # Run the "hooks" pattern
  tl-search todos -j         # JSON output
`;

// Check for ripgrep
try {
  execSync('which rg', { stdio: 'ignore' });
} catch {
  console.error('ripgrep (rg) not found. Install: brew install ripgrep');
  process.exit(1);
}

function showPatterns(patterns, out) {
  const names = Object.keys(patterns);

  if (names.length === 0) {
    out.header('No search patterns defined.');
    out.blank();
    out.add(`Add patterns to ${CONFIG_FILENAME}:`);
    out.add(`
{
  "searchPatterns": {
    "hooks": {
      "description": "Find lifecycle hooks",
      "pattern": "use(Effect|State|Callback)",
      "glob": "**/*.{ts,tsx}"
    }
  }
}`);
    return;
  }

  out.header('Available search patterns:');
  out.blank();

  const maxLen = Math.max(...names.map(k => k.length));

  // For JSON output, set data
  out.setData('patterns', Object.entries(patterns).map(([name, config]) => ({
    name,
    description: config.description || '',
    pattern: config.pattern,
    glob: config.glob
  })));

  for (const [name, config] of Object.entries(patterns)) {
    const paddedName = name.padEnd(maxLen);
    out.add(`  ${paddedName}  ${config.description || '(no description)'}`);
  }

  out.blank();
  out.add('Usage: tl-search <pattern-name>');
  out.add('Example: tl-search hooks');
}

function runSearch(name, config, rootDir, jsonMode) {
  if (!jsonMode) {
    console.log(`\nSearching: ${config.description || name}`);
    console.log(`Pattern: ${config.pattern}\n`);
  }

  if (config.type === 'glob-only') {
    const args = ['--files', '-g', config.pattern];
    if (config.exclude) {
      for (const ex of config.exclude) {
        args.push('-g', `!${ex}`);
      }
    }
    args.push(rootDir);

    if (jsonMode) {
      // Capture output for JSON
      try {
        const result = execSync(`rg ${args.map(a => `"${a}"`).join(' ')}`, {
          encoding: 'utf-8',
          cwd: rootDir
        });
        const files = result.trim().split('\n').filter(Boolean);
        console.log(JSON.stringify({
          pattern: name,
          description: config.description,
          type: 'glob-only',
          files,
          count: files.length
        }, null, 2));
      } catch {
        console.log(JSON.stringify({
          pattern: name,
          files: [],
          count: 0
        }, null, 2));
      }
    } else {
      const proc = spawn('rg', args, { stdio: 'inherit' });
      proc.on('close', code => process.exit(code === 1 ? 0 : code));
    }
    return;
  }

  const args = jsonMode
    ? ['-n', '--json', '-e', config.pattern]
    : ['--color=always', '-n', '-e', config.pattern];

  if (config.glob) {
    args.push('-g', config.glob);
  }

  if (config.exclude) {
    for (const ex of config.exclude) {
      args.push('-g', `!${ex}`);
    }
  }

  args.push(rootDir);

  if (jsonMode) {
    try {
      const result = execSync(`rg ${args.map(a => `"${a}"`).join(' ')} 2>/dev/null || true`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });
      const matches = result.trim().split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .filter(m => m.type === 'match')
        .map(m => ({
          file: m.data.path.text,
          line: m.data.line_number,
          text: m.data.lines.text.trim()
        }));

      console.log(JSON.stringify({
        pattern: name,
        description: config.description,
        searchPattern: config.pattern,
        matches,
        count: matches.length
      }, null, 2));
    } catch {
      console.log(JSON.stringify({
        pattern: name,
        matches: [],
        count: 0
      }, null, 2));
    }
  } else {
    const proc = spawn('rg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 1) {
        console.log('No matches found.');
      }
      process.exit(code === 1 ? 0 : code);
    });
  }
}

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const { config, projectRoot } = loadConfig();
const patterns = config.searchPatterns || {};
const patternName = options.remaining.find(a => !a.startsWith('-'));

if (!patternName) {
  const out = createOutput(options);
  showPatterns(patterns, out);
  out.print();
  process.exit(0);
}

if (!patterns[patternName]) {
  console.error(`\nUnknown pattern: "${patternName}"`);
  const out = createOutput({ ...options, json: false });
  showPatterns(patterns, out);
  out.print();
  process.exit(1);
}

runSearch(patternName, patterns[patternName], projectRoot, options.json);
