#!/usr/bin/env node

/**
 * tl-config - Show and manage tokenlean configuration
 *
 * Usage:
 *   tl-config              Show current merged config
 *   tl-config --paths      Show config file locations
 *   tl-config --init       Create a sample config file
 */

// Prompt info for tl-prompt (tl-config is a utility, not for AI agents)
if (process.argv.includes('--prompt')) {
  process.exit(0);  // No output - utility command
}

import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  loadConfig,
  getConfigPaths,
  CONFIG_FILENAME,
  GLOBAL_CONFIG_PATH
} from '../src/config.mjs';

const SAMPLE_CONFIG = {
  output: {
    maxLines: 100,
    maxTokens: null,
    format: 'text'
  },
  skipDirs: [],
  skipExtensions: [],
  importantDirs: [],
  importantFiles: [],
  searchPatterns: {
    hooks: {
      description: 'Find React hooks',
      pattern: 'use[A-Z]\\w+',
      glob: '**/*.{ts,tsx,js,jsx}'
    },
    todos: {
      description: 'Find TODO comments',
      pattern: 'TODO|FIXME|HACK',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    }
  },
  hotspots: {
    days: 90,
    top: 20
  },
  structure: {
    depth: 3
  }
};

const HELP = `
tl-config - Show and manage tokenlean configuration

Usage:
  tl-config              Show current merged config
  tl-config --paths      Show config file locations
  tl-config --init       Create a sample project config
  tl-config --init-global Create a sample global config

Config file locations:
  Project:  ${CONFIG_FILENAME} (in project root or parent directories)
  Global:   ${GLOBAL_CONFIG_PATH}

Project config overrides global config.
`;

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (args.includes('--paths')) {
  const paths = getConfigPaths();
  console.log('\nConfig file locations:\n');

  if (paths.length === 0) {
    console.log('  No config files found.');
    console.log(`\n  Create one with: tl-config --init`);
  } else {
    for (const { type, path } of paths) {
      console.log(`  ${type.padEnd(8)} ${path}`);
    }
  }
  console.log();
  process.exit(0);
}

if (args.includes('--init')) {
  const configPath = join(process.cwd(), CONFIG_FILENAME);

  if (existsSync(configPath)) {
    console.error(`Config already exists: ${configPath}`);
    process.exit(1);
  }

  writeFileSync(configPath, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n');
  console.log(`Created: ${configPath}`);
  process.exit(0);
}

if (args.includes('--init-global')) {
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    console.error(`Global config already exists: ${GLOBAL_CONFIG_PATH}`);
    process.exit(1);
  }

  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n');
  console.log(`Created: ${GLOBAL_CONFIG_PATH}`);
  process.exit(0);
}

// Default: show merged config
const { config, projectRoot } = loadConfig();
const paths = getConfigPaths();

console.log('\nCurrent configuration:\n');

if (paths.length > 0) {
  console.log('Loaded from:');
  for (const { type, path } of paths) {
    console.log(`  ${type}: ${path}`);
  }
  console.log();
}

console.log(JSON.stringify(config, null, 2));
console.log();
