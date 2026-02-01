#!/usr/bin/env node

/**
 * tl-cache - Manage tokenlean cache
 *
 * View cache statistics and clear cached data.
 *
 * Usage: tl-cache [command]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-cache',
    desc: 'Manage tokenlean cache (stats, clear)',
    when: 'maintenance',
    example: 'tl-cache stats'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import {
  getCacheConfig,
  getCacheStats,
  clearCache,
  getCacheDir
} from '../src/cache.mjs';

const HELP = `
tl-cache - Manage tokenlean cache

Usage: tl-cache <command> [options]

Commands:
  stats       Show cache statistics (default)
  clear       Clear cache for current project
  clear-all   Clear cache for all projects

${COMMON_OPTIONS_HELP}

Examples:
  tl-cache                   # Show stats for current project
  tl-cache stats             # Same as above
  tl-cache clear             # Clear cache for this project
  tl-cache clear-all         # Clear all cached data

Configuration:
  Cache can be configured in .tokenleanrc.json:
  {
    "cache": {
      "enabled": true,       // Enable/disable caching
      "ttl": 300,            // Max age in seconds (for non-git repos)
      "maxSize": "100MB",    // Max cache size per project
      "location": null       // Override ~/.tokenlean/cache
    }
  }

Environment:
  TOKENLEAN_CACHE=0          Disable caching for this run
`;

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

function showStats(out, projectRoot) {
  const config = getCacheConfig();
  const projectStats = getCacheStats(projectRoot);
  const globalStats = getCacheStats(null);

  out.header('Cache Configuration:');
  out.add(`  Enabled:    ${config.enabled ? 'yes' : 'no'}`);
  out.add(`  Location:   ${config.location}`);
  out.add(`  Max size:   ${projectStats.maxSizeFormatted}`);
  out.add(`  TTL:        ${config.ttl}s (fallback for non-git repos)`);
  out.blank();

  out.header('Current Project Cache:');
  out.add(`  Directory:  ${projectStats.location}`);
  out.add(`  Entries:    ${projectStats.entries}`);
  out.add(`  Size:       ${projectStats.sizeFormatted}`);
  out.blank();

  out.header('Global Cache:');
  out.add(`  Projects:   ${globalStats.projects}`);
  out.add(`  Entries:    ${globalStats.totalEntries}`);
  out.add(`  Total size: ${globalStats.totalSizeFormatted}`);
  out.blank();

  // Set JSON data
  out.setData('config', config);
  out.setData('project', projectStats);
  out.setData('global', globalStats);
}

function doClear(out, projectRoot) {
  const before = getCacheStats(projectRoot);
  clearCache(projectRoot);
  const after = getCacheStats(projectRoot);

  out.add(`Cleared ${before.entries} cache entries (${before.sizeFormatted})`);
  out.blank();

  out.setData('cleared', {
    entries: before.entries,
    size: before.size,
    sizeFormatted: before.sizeFormatted
  });
}

function doClearAll(out) {
  const before = getCacheStats(null);
  clearCache(null);
  const after = getCacheStats(null);

  out.add(`Cleared ${before.totalEntries} cache entries across ${before.projects} projects (${before.totalSizeFormatted})`);
  out.blank();

  out.setData('cleared', {
    projects: before.projects,
    entries: before.totalEntries,
    size: before.totalSize,
    sizeFormatted: before.totalSizeFormatted
  });
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

const command = options.remaining.find(a => !a.startsWith('-')) || 'stats';
const projectRoot = findProjectRoot();
const out = createOutput(options);

switch (command) {
  case 'stats':
    showStats(out, projectRoot);
    break;

  case 'clear':
    doClear(out, projectRoot);
    break;

  case 'clear-all':
    doClearAll(out);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.log('Use: stats, clear, or clear-all');
    process.exit(1);
}

out.print();
