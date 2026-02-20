/**
 * Shared project utilities for tokenlean CLI tools
 *
 * Project detection, file categorization, and skip lists.
 *
 * Built-in defaults can be extended via .tokenleanrc.json:
 *   skipDirs: ["my-custom-dir"]
 *   skipExtensions: [".custom"]
 *   importantDirs: ["domain"]
 *   importantFiles: ["ARCHITECTURE.md"]
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, relative, extname } from 'path';
import { getConfig } from './config.mjs';

// ─────────────────────────────────────────────────────────────
// Built-in Defaults (users can extend via config)
// ─────────────────────────────────────────────────────────────

const DEFAULT_SKIP_DIRS = [
  'node_modules', '.git', 'android', 'ios', 'dist', 'build',
  '.expo', '.next', 'coverage', '__pycache__', '.cache', '.turbo',
  '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', 'target', 'out', '.gradle', '.idea', '.vscode'
];

const DEFAULT_SKIP_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.webm', '.ogg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.rar',
  '.pdf', '.doc', '.docx',
  '.lock', '.log',
  '.min.js', '.min.css',
  '.map'
];

const DEFAULT_IMPORTANT_FILES = [
  'package.json', 'tsconfig.json', 'CLAUDE.md', 'README.md',
  'app.json', '.env.example', 'index.ts', 'index.tsx', 'index.js',
  'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'Makefile', 'Dockerfile', 'docker-compose.yml'
];

const DEFAULT_IMPORTANT_DIRS = [
  'src', 'app', 'components', 'lib', 'utils', 'hooks', 'store',
  'api', 'services', 'types', '.claude', 'scripts', 'tests',
  'test', '__tests__', 'spec', 'cmd', 'pkg', 'internal'
];

// ─────────────────────────────────────────────────────────────
// Combined Sets (defaults + user config extensions)
// ─────────────────────────────────────────────────────────────

let _cachedSets = null;

function getCombinedSets() {
  if (_cachedSets) return _cachedSets;

  const config = getConfig();

  _cachedSets = {
    skipDirs: new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs || [])]),
    skipExtensions: new Set([...DEFAULT_SKIP_EXTENSIONS, ...(config.skipExtensions || [])]),
    importantFiles: new Set([...DEFAULT_IMPORTANT_FILES, ...(config.importantFiles || [])]),
    importantDirs: new Set([...DEFAULT_IMPORTANT_DIRS, ...(config.importantDirs || [])])
  };

  return _cachedSets;
}

// Export getters that return combined sets
export function getSkipDirs() { return getCombinedSets().skipDirs; }
export function getSkipExtensions() { return getCombinedSets().skipExtensions; }
export function getImportantFiles() { return getCombinedSets().importantFiles; }
export function getImportantDirs() { return getCombinedSets().importantDirs; }

// Legacy exports for backwards compatibility (return combined sets)
export const SKIP_DIRS = new Set(DEFAULT_SKIP_DIRS);
export const SKIP_EXTENSIONS = new Set(DEFAULT_SKIP_EXTENSIONS);
export const IMPORTANT_FILES = new Set(DEFAULT_IMPORTANT_FILES);
export const IMPORTANT_DIRS = new Set(DEFAULT_IMPORTANT_DIRS);

// Clear cache (useful when config changes)
export function clearProjectCache() { _cachedSets = null; }

// ─────────────────────────────────────────────────────────────
// Project Detection
// ─────────────────────────────────────────────────────────────

/**
 * Find the project root by looking for package.json or .git
 */
export function findProjectRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

/**
 * Get project info from package.json if available
 */
export function getProjectInfo(projectRoot) {
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return {
        name: pkg.name,
        version: pkg.version,
        type: 'node',
        hasTypeScript: existsSync(join(projectRoot, 'tsconfig.json'))
      };
    } catch {
      // Invalid JSON
    }
  }

  // Check for other project types
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return { type: 'rust' };
  }
  if (existsSync(join(projectRoot, 'go.mod'))) {
    return { type: 'go' };
  }
  if (existsSync(join(projectRoot, 'pyproject.toml')) || existsSync(join(projectRoot, 'setup.py'))) {
    return { type: 'python' };
  }

  return { type: 'unknown' };
}

// ─────────────────────────────────────────────────────────────
// File Categorization
// ─────────────────────────────────────────────────────────────

/**
 * Categorize a file path as source, test, story, or mock
 */
export function categorizeFile(filePath, projectRoot = '') {
  const rel = projectRoot ? relative(projectRoot, filePath) : filePath;
  const lower = rel.toLowerCase();

  if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) {
    return 'test';
  }
  if (lower.includes('stories') || lower.includes('storybook') || lower.endsWith('.stories.tsx') || lower.endsWith('.stories.jsx')) {
    return 'story';
  }
  if (lower.includes('mock') || lower.includes('fixture') || lower.includes('__mocks__')) {
    return 'mock';
  }
  if (lower.includes('e2e') || lower.includes('cypress') || lower.includes('playwright')) {
    return 'e2e';
  }
  return 'source';
}

/**
 * Check if a path should be skipped during traversal
 */
export function shouldSkip(name, isDir = false) {
  const { skipDirs, skipExtensions, importantDirs } = getCombinedSets();

  // Skip hidden files/dirs (except important ones)
  if (name.startsWith('.') && !importantDirs.has(name)) {
    return true;
  }

  if (isDir) {
    return skipDirs.has(name);
  }

  // Check extension
  const ext = extname(name).toLowerCase();
  if (skipExtensions.has(ext)) {
    return true;
  }

  // Check for minified files
  if (name.endsWith('.min.js') || name.endsWith('.min.css')) {
    return true;
  }

  return false;
}

/**
 * Check if a file/dir is considered important
 */
export function isImportant(name, isDir = false) {
  const { importantDirs, importantFiles } = getCombinedSets();

  if (isDir) {
    return importantDirs.has(name);
  }
  return importantFiles.has(name);
}

// ─────────────────────────────────────────────────────────────
// Language Detection
// ─────────────────────────────────────────────────────────────

const LANG_MAP = {
  // JavaScript/TypeScript
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',

  // Other languages
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',

  // Config/data
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.mdx': 'markdown',

  // Styles
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',

  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
};

/**
 * Detect the language of a file by extension
 */
export function detectLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  return LANG_MAP[ext] || null;
}

/**
 * Check if a file is a code file (not config, data, or assets)
 */
export function isCodeFile(filePath) {
  const lang = detectLanguage(filePath);
  if (!lang) return false;

  const codeLanguages = new Set([
    'javascript', 'typescript', 'python', 'go', 'rust', 'ruby',
    'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php'
  ]);

  return codeLanguages.has(lang);
}

// ─────────────────────────────────────────────────────────────
// JS/TS Code File Discovery
// ─────────────────────────────────────────────────────────────

export const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts']);

/**
 * Recursively find JS/TS code files in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} [files=[]] - Accumulator (for recursion)
 * @param {Object} [options={}]
 * @param {boolean} [options.includeTests=false] - Include .test./.spec. files
 * @param {string[]} [options.ignorePatterns=[]] - Additional patterns to skip
 */
export function findCodeFiles(dir, files = [], options = {}) {
  const { includeTests = false, ignorePatterns = [] } = options;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (ignorePatterns.length > 0 &&
        ignorePatterns.some(p => entry.name.includes(p) || fullPath.includes(p))) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        findCodeFiles(fullPath, files, options);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext) && !shouldSkip(entry.name, false)) {
        if (!includeTests) {
          const lower = entry.name.toLowerCase();
          if (lower.includes('.test.') || lower.includes('.spec.') ||
              lower.includes('__tests__') || lower.includes('__mocks__')) {
            continue;
          }
        }
        files.push(fullPath);
      }
    }
  }

  return files;
}
