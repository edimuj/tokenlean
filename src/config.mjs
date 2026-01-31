/**
 * Shared configuration system for tokenlean CLI tools
 *
 * Config files (in order of priority, higher overrides lower):
 *   1. .tokenleanrc.json in project root (or parent directories)
 *   2. ~/.tokenleanrc.json (global defaults)
 *
 * Example config:
 * {
 *   "output": { "maxLines": 100, "format": "text" },
 *   "ignore": ["node_modules", "dist"],
 *   "searchPatterns": { ... },
 *   "hotspots": { "days": 90 },
 *   "structure": { "depth": 3 }
 * }
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const CONFIG_FILENAME = '.tokenleanrc.json';
const GLOBAL_CONFIG_PATH = join(homedir(), CONFIG_FILENAME);

// Default configuration values
const DEFAULT_CONFIG = {
  output: {
    maxLines: null,
    maxTokens: null,
    format: 'text'  // 'text' | 'json'
  },
  // Extensions to built-in skip/important lists (always extend, never replace)
  skipDirs: [],
  skipExtensions: [],
  importantDirs: [],
  importantFiles: [],
  searchPatterns: {
    hooks: {
      description: 'React hooks usage',
      pattern: 'use[A-Z]\\w+\\(',
      glob: '**/*.{ts,tsx,js,jsx}'
    },
    errors: {
      description: 'Error handling (throw, catch, Error)',
      pattern: '(throw |catch\\s*\\(|new Error)',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    },
    env: {
      description: 'Environment variables',
      pattern: 'process\\.env\\.|import\\.meta\\.env',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    },
    routes: {
      description: 'Route definitions',
      pattern: '(app|router)\\.(get|post|put|delete|patch|use)\\(|path:\\s*[\'"]/',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    },
    exports: {
      description: 'Exported functions and classes',
      pattern: '^export (function|class|const|default)',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    },
    async: {
      description: 'Async patterns (async/await, Promise)',
      pattern: '(async |await |Promise\\.|\\. then\\()',
      glob: '**/*.{ts,tsx,js,jsx,mjs}'
    }
  },
  hotspots: {
    days: 90
  },
  structure: {
    depth: 3
  },
  symbols: {
    includePrivate: false
  },
  impact: {
    depth: 2
  },
  cache: {
    enabled: true,           // Enable/disable caching
    ttl: 300,                // Max age in seconds (fallback for non-git)
    maxSize: '100MB',        // Max cache directory size
    location: null           // Override ~/.tokenlean/cache
  }
};

// ─────────────────────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────────────────────

/**
 * Deep merge two objects (source into target)
 * Arrays are replaced, not merged
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Load and parse a JSON config file
 * Returns null if file doesn't exist or is invalid
 */
function loadConfigFile(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    // Silently ignore invalid JSON - tools can warn if needed
    return null;
  }
}

/**
 * Find project config by walking up directory tree
 * Returns { config, path, root } or null if not found
 */
function findProjectConfig(startDir = process.cwd()) {
  let dir = startDir;

  while (dir !== '/') {
    const configPath = join(dir, CONFIG_FILENAME);

    if (existsSync(configPath)) {
      const config = loadConfigFile(configPath);
      if (config) {
        return { config, path: configPath, root: dir };
      }
    }

    dir = dirname(dir);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Main API
// ─────────────────────────────────────────────────────────────

// Cached merged config
let cachedConfig = null;
let cachedProjectRoot = null;

/**
 * Load and merge all config sources
 * Returns the merged configuration object
 */
export function loadConfig(options = {}) {
  const { reload = false, startDir = process.cwd() } = options;

  // Return cached config if available
  if (cachedConfig && !reload) {
    return { config: cachedConfig, projectRoot: cachedProjectRoot };
  }

  // Start with defaults
  let merged = { ...DEFAULT_CONFIG };
  let projectRoot = startDir;

  // Load global config
  const globalConfig = loadConfigFile(GLOBAL_CONFIG_PATH);
  if (globalConfig) {
    merged = deepMerge(merged, globalConfig);
  }

  // Load project config (overrides global)
  const projectResult = findProjectConfig(startDir);
  if (projectResult) {
    merged = deepMerge(merged, projectResult.config);
    projectRoot = projectResult.root;
  }

  // Cache the result
  cachedConfig = merged;
  cachedProjectRoot = projectRoot;

  return { config: merged, projectRoot };
}

/**
 * Get a specific config section
 */
export function getConfig(section) {
  const { config } = loadConfig();
  return section ? config[section] : config;
}

/**
 * Get search patterns from config
 */
export function getSearchPatterns() {
  const { config } = loadConfig();
  return config.searchPatterns || {};
}

/**
 * Get output defaults from config
 */
export function getOutputDefaults() {
  const { config } = loadConfig();
  return config.output || {};
}

/**
 * Get ignore patterns from config
 */
export function getIgnorePatterns() {
  const { config } = loadConfig();
  return config.ignore || [];
}

/**
 * Check if config file exists (either global or project)
 */
export function hasConfig() {
  if (existsSync(GLOBAL_CONFIG_PATH)) return true;
  return findProjectConfig() !== null;
}

/**
 * Get paths to config files that would be loaded
 */
export function getConfigPaths() {
  const paths = [];

  if (existsSync(GLOBAL_CONFIG_PATH)) {
    paths.push({ type: 'global', path: GLOBAL_CONFIG_PATH });
  }

  const projectResult = findProjectConfig();
  if (projectResult) {
    paths.push({ type: 'project', path: projectResult.path });
  }

  return paths;
}

/**
 * Clear the config cache (useful for testing)
 */
export function clearConfigCache() {
  cachedConfig = null;
  cachedProjectRoot = null;
}

// ─────────────────────────────────────────────────────────────
// Exports for direct access
// ─────────────────────────────────────────────────────────────

export { CONFIG_FILENAME, GLOBAL_CONFIG_PATH, DEFAULT_CONFIG };
