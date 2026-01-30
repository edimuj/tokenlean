#!/usr/bin/env node

/**
 * Claude Diff - Token-efficient git diff summary
 *
 * Summarizes git changes without outputting full diff content.
 * Great for understanding what changed before diving into details.
 *
 * Usage: claude-diff [ref] [--staged] [--stat-only]
 */

import { execSync } from 'child_process';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

function formatTokens(tokens) {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function parseDiffStat(stat) {
  const lines = stat.trim().split('\n');
  const files = [];

  for (const line of lines) {
    // Match: " src/file.ts | 42 +++---"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*(\+*)(-*)/);
    if (match) {
      files.push({
        path: match[1].trim(),
        changes: parseInt(match[2]),
        additions: match[3].length,
        deletions: match[4].length
      });
    }
  }

  return files;
}

function categorizeChanges(files) {
  const categories = {
    components: [],
    hooks: [],
    store: [],
    types: [],
    tests: [],
    config: [],
    manuscripts: [],
    other: []
  };

  for (const file of files) {
    const path = file.path.toLowerCase();

    if (path.includes('.test.') || path.includes('.spec.') || path.includes('__tests__')) {
      categories.tests.push(file);
    } else if (path.includes('/components/') || path.endsWith('.tsx')) {
      categories.components.push(file);
    } else if (path.includes('/hooks/') || path.includes('use')) {
      categories.hooks.push(file);
    } else if (path.includes('/store/') || path.includes('slice') || path.includes('reducer')) {
      categories.store.push(file);
    } else if (path.includes('/types/') || path.endsWith('.d.ts')) {
      categories.types.push(file);
    } else if (path.includes('manuscripts') || path.endsWith('.json')) {
      categories.manuscripts.push(file);
    } else if (path.includes('config') || path.includes('package.json') || path.includes('tsconfig')) {
      categories.config.push(file);
    } else {
      categories.other.push(file);
    }
  }

  return categories;
}

function printSummary(files, categories, options) {
  const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  console.log(`\n📊 Diff Summary`);
  console.log(`   ${files.length} files changed, ~${formatTokens(totalChanges * 4)} tokens of changes`);
  console.log(`   +${totalAdditions} additions, -${totalDeletions} deletions\n`);

  const order = ['components', 'hooks', 'store', 'types', 'manuscripts', 'tests', 'config', 'other'];
  const labels = {
    components: '🧩 Components',
    hooks: '🪝 Hooks',
    store: '📦 Store',
    types: '📝 Types',
    manuscripts: '📖 Manuscripts',
    tests: '🧪 Tests',
    config: '⚙️  Config',
    other: '📄 Other'
  };

  for (const cat of order) {
    const catFiles = categories[cat];
    if (catFiles.length === 0) continue;

    console.log(`${labels[cat]} (${catFiles.length})`);

    // Sort by changes descending
    catFiles.sort((a, b) => b.changes - a.changes);

    for (const f of catFiles.slice(0, 10)) {
      const bar = '+'.repeat(Math.min(f.additions, 20)) + '-'.repeat(Math.min(f.deletions, 20));
      console.log(`  ${f.path}`);
      console.log(`    ${f.changes} changes ${bar}`);
    }

    if (catFiles.length > 10) {
      console.log(`  ... and ${catFiles.length - 10} more`);
    }

    console.log();
  }
}

// Main
const args = process.argv.slice(2);
let ref = '';
let staged = false;
let statOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--staged') {
    staged = true;
  } else if (args[i] === '--stat-only') {
    statOnly = true;
  } else if (!args[i].startsWith('-')) {
    ref = args[i];
  }
}

// Build git diff command
let diffCmd = 'git diff';
if (staged) {
  diffCmd += ' --cached';
} else if (ref) {
  diffCmd += ` ${ref}`;
}
diffCmd += ' --stat=200';

const stat = run(diffCmd);

if (!stat.trim()) {
  console.log('\n✨ No changes detected\n');
  process.exit(0);
}

const files = parseDiffStat(stat);
const categories = categorizeChanges(files);

printSummary(files, categories, { statOnly });

if (!statOnly) {
  console.log('💡 Tip: Use --stat-only for just the summary, or check specific files with:');
  console.log('   git diff [ref] -- path/to/file.ts\n');
}
