#!/usr/bin/env node

/**
 * tl-entry - Find entry points in a codebase
 *
 * Locates main functions, route handlers, event listeners,
 * and exported APIs - the "starting points" of the code.
 *
 * Usage: tl-entry [path]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-entry',
    desc: 'Find entry points (main, routes, handlers)',
    when: 'before-read',
    example: 'tl-entry src/'
  }));
  process.exit(0);
}

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  shellEscape,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { withCache } from '../src/cache.mjs';
import { ensureRipgrep } from '../src/traverse.mjs';

ensureRipgrep();

const HELP = `
tl-entry - Find entry points in a codebase

Usage: tl-entry [path] [options]

Options:
  --type T, -t T        Filter by type: main, routes, handlers, exports, cli
${COMMON_OPTIONS_HELP}

Entry point types:
  main      - Main functions, index files, app entry
  routes    - HTTP route handlers (Express, Fastify, etc.)
  handlers  - Event handlers, callbacks, listeners
  exports   - Public API (export default, module.exports)
  cli       - CLI entry points (bin scripts, commander)

Examples:
  tl-entry                    # All entry points in project
  tl-entry src/               # Entry points in src/
  tl-entry --type routes      # Only route handlers
`;

// ─────────────────────────────────────────────────────────────
// Entry Point Patterns
// ─────────────────────────────────────────────────────────────

const PATTERNS = {
  main: {
    label: 'Main / App Entry',
    patterns: [
      { pattern: 'createApp\\(|new App\\(|express\\(\\)', desc: 'App initialization' },
      { pattern: '^\\s*app\\.listen\\(', desc: 'Server start' },
      { pattern: 'ReactDOM\\.render|createRoot|hydrateRoot', desc: 'React entry' },
      { pattern: 'main\\s*\\(|async function main', desc: 'Main function' },
    ],
    files: ['index.ts', 'index.tsx', 'index.js', 'main.ts', 'main.tsx', 'app.ts', 'app.tsx', 'server.ts', 'server.js']
  },
  routes: {
    label: 'Route Handlers',
    patterns: [
      { pattern: 'app\\.(get|post|put|delete|patch)\\s*\\(', desc: 'Express routes' },
      { pattern: 'router\\.(get|post|put|delete|patch)\\s*\\(', desc: 'Router routes' },
      { pattern: 'fastify\\.(get|post|put|delete|patch)', desc: 'Fastify routes' },
      { pattern: '@(Get|Post|Put|Delete|Patch)\\(', desc: 'Decorator routes' },
      { pattern: 'export (async )?function (GET|POST|PUT|DELETE|PATCH)', desc: 'Next.js API routes' },
    ]
  },
  handlers: {
    label: 'Event Handlers',
    patterns: [
      { pattern: '\\.on\\([\'"]\\w+[\'"]', desc: 'Event listeners' },
      { pattern: '\\.addEventListener\\(', desc: 'DOM events' },
      { pattern: 'onClick|onChange|onSubmit|onLoad|onError', desc: 'React handlers' },
      { pattern: 'useEffect\\s*\\(', desc: 'React effects' },
      { pattern: '@Subscribe|@EventHandler|@Listener', desc: 'Event decorators' },
    ]
  },
  exports: {
    label: 'Public API',
    patterns: [
      { pattern: '^export default', desc: 'Default export' },
      { pattern: '^export (async )?(function|class|const) \\w+', desc: 'Named export' },
      { pattern: 'module\\.exports\\s*=', desc: 'CommonJS export' },
      { pattern: 'exports\\.\\w+\\s*=', desc: 'Named CommonJS' },
    ]
  },
  cli: {
    label: 'CLI Entry Points',
    patterns: [
      { pattern: '#!/usr/bin/env node', desc: 'Node CLI shebang' },
      { pattern: 'commander|yargs|meow|arg\\s*\\(', desc: 'CLI framework' },
      { pattern: 'process\\.argv', desc: 'Argument parsing' },
      { pattern: '\\.command\\(', desc: 'Command definition' },
    ]
  }
};

// ─────────────────────────────────────────────────────────────
// Entry Point Finding
// ─────────────────────────────────────────────────────────────

function findEntryPoints(searchPath, projectRoot, filterType) {
  const results = {};

  const types = filterType ? [filterType] : Object.keys(PATTERNS);

  for (const type of types) {
    const config = PATTERNS[type];
    if (!config) continue;

    results[type] = {
      label: config.label,
      entries: []
    };

    // Search by patterns
    for (const { pattern, desc } of config.patterns) {
      try {
        const cmd = `rg -n -g "*.{ts,tsx,js,jsx,mjs}" --no-heading -e "${shellEscape(pattern)}" "${shellEscape(searchPath)}" 2>/dev/null || true`;
        const cacheKey = { op: 'rg-entry-pattern', pattern, path: searchPath };
        const output = withCache(
          cacheKey,
          () => execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }),
          { projectRoot }
        );

        for (const line of output.trim().split('\n')) {
          if (!line) continue;
          const match = line.match(/^([^:]+):(\d+):(.*)$/);
          if (!match) continue;

          const [, file, lineNum, content] = match;
          if (file.includes('node_modules')) continue;
          if (file.includes('.test.') || file.includes('.spec.')) continue;

          results[type].entries.push({
            file: relative(projectRoot, file),
            line: parseInt(lineNum, 10),
            desc,
            content: content.trim().slice(0, 60)
          });
        }
      } catch (e) {
        // rg error
      }
    }

    // Search for special files
    if (config.files) {
      for (const fileName of config.files) {
        try {
          const cmd = `find "${shellEscape(searchPath)}" -name "${fileName}" -not -path "*/node_modules/*" 2>/dev/null || true`;
          const output = execSync(cmd, { encoding: 'utf-8' });

          for (const file of output.trim().split('\n')) {
            if (!file) continue;
            results[type].entries.push({
              file: relative(projectRoot, file),
              line: 1,
              desc: 'Entry file',
              content: fileName
            });
          }
        } catch (e) {
          // find error
        }
      }
    }

    // Dedupe entries by file+line
    const seen = new Set();
    results[type].entries = results[type].entries.filter(e => {
      const key = `${e.file}:${e.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return results;
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

// Parse tool-specific options
let filterType = null;
let searchPath = '.';

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--type' || arg === '-t') && options.remaining[i + 1]) {
    filterType = options.remaining[++i];
  } else if (!arg.startsWith('-')) {
    searchPath = arg;
  }
}

const projectRoot = findProjectRoot();
const resolvedPath = resolve(searchPath);

if (!existsSync(resolvedPath)) {
  console.error(`Path not found: ${searchPath}`);
  process.exit(1);
}

const out = createOutput(options);

out.header(`\n🚪 Entry points: ${searchPath === '.' ? 'project' : searchPath}`);

const results = findEntryPoints(resolvedPath, projectRoot, filterType);

let totalEntries = 0;

for (const [type, { label, entries }] of Object.entries(results)) {
  if (entries.length === 0) continue;

  totalEntries += entries.length;

  out.add(`\n${label}:`);

  for (const entry of entries.slice(0, 10)) {
    out.add(`  ${entry.file}:${entry.line} (${entry.desc})`);
  }

  if (entries.length > 10) {
    out.add(`  ... and ${entries.length - 10} more`);
  }
}

if (totalEntries === 0) {
  out.add('\n  No entry points found.');
}

out.add('');
out.stats(`📊 Found ${totalEntries} entry points`);
out.add('');

out.print();
