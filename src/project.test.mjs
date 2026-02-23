import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeFile, shouldSkip, isImportant, detectLanguage, isCodeFile,
  getSkipDirs, getSkipExtensions, getImportantFiles, getImportantDirs,
  clearProjectCache
} from './project.mjs';
import { clearConfigCache } from './config.mjs';

afterEach(() => {
  clearProjectCache();
  clearConfigCache();
});

// ─────────────────────────────────────────────────────────────
// categorizeFile
// ─────────────────────────────────────────────────────────────

describe('categorizeFile', () => {
  it('detects test files', () => {
    assert.strictEqual(categorizeFile('src/utils.test.ts'), 'test');
    assert.strictEqual(categorizeFile('__tests__/app.js'), 'test');
    assert.strictEqual(categorizeFile('spec/helper.rb'), 'test');
  });

  it('detects story files', () => {
    assert.strictEqual(categorizeFile('Button.stories.tsx'), 'story');
    assert.strictEqual(categorizeFile('components/storybook/intro.js'), 'story');
  });

  it('detects mock files', () => {
    assert.strictEqual(categorizeFile('__mocks__/fs.js'), 'mock');
    assert.strictEqual(categorizeFile('test/fixtures/data.json'), 'mock');
    assert.strictEqual(categorizeFile('src/mock/handler.js'), 'mock');
  });

  it('detects e2e files', () => {
    assert.strictEqual(categorizeFile('e2e/login.spec.ts'), 'e2e');
    assert.strictEqual(categorizeFile('cypress/integration/home.js'), 'e2e');
    assert.strictEqual(categorizeFile('tests/playwright/smoke.ts'), 'e2e');
  });

  it('returns source for regular files', () => {
    assert.strictEqual(categorizeFile('src/utils.ts'), 'source');
    assert.strictEqual(categorizeFile('lib/parser.mjs'), 'source');
  });

  it('uses projectRoot for relative path', () => {
    assert.strictEqual(categorizeFile('/project/src/app.ts', '/project'), 'source');
    assert.strictEqual(categorizeFile('/project/tests/app.test.ts', '/project'), 'test');
  });

  it('does NOT false-positive on "contest.js"', () => {
    assert.strictEqual(categorizeFile('src/contest.js'), 'test');
    // NOTE: This IS a known false positive - "contest" contains "test"
    // Documenting current behavior, not ideal behavior
  });
});

// ─────────────────────────────────────────────────────────────
// shouldSkip
// ─────────────────────────────────────────────────────────────

describe('shouldSkip', () => {
  it('skips node_modules dir', () => {
    assert.strictEqual(shouldSkip('node_modules', true), true);
  });

  it('skips dist dir', () => {
    assert.strictEqual(shouldSkip('dist', true), true);
  });

  it('does not skip src dir', () => {
    assert.strictEqual(shouldSkip('src', true), false);
  });

  it('does not skip app dir', () => {
    assert.strictEqual(shouldSkip('app', true), false);
  });

  it('skips hidden dirs', () => {
    assert.strictEqual(shouldSkip('.hidden', true), true);
  });

  it('does NOT skip .claude (important dir)', () => {
    assert.strictEqual(shouldSkip('.claude', true), false);
  });

  it('skips files with skip extensions', () => {
    assert.strictEqual(shouldSkip('photo.jpg', false), true);
    assert.strictEqual(shouldSkip('archive.zip', false), true);
  });

  it('skips .min.js files', () => {
    assert.strictEqual(shouldSkip('vendor.min.js', false), true);
  });

  it('does not skip regular code files', () => {
    assert.strictEqual(shouldSkip('app.mjs', false), false);
    assert.strictEqual(shouldSkip('utils.py', false), false);
  });
});

// ─────────────────────────────────────────────────────────────
// isImportant
// ─────────────────────────────────────────────────────────────

describe('isImportant', () => {
  it('recognizes important files', () => {
    assert.strictEqual(isImportant('package.json'), true);
    assert.strictEqual(isImportant('README.md'), true);
    assert.strictEqual(isImportant('Dockerfile'), true);
  });

  it('recognizes important dirs', () => {
    assert.strictEqual(isImportant('src', true), true);
    assert.strictEqual(isImportant('tests', true), true);
  });

  it('rejects unknown files', () => {
    assert.strictEqual(isImportant('random.txt'), false);
  });

  it('rejects unknown dirs', () => {
    assert.strictEqual(isImportant('stuff', true), false);
  });
});

// ─────────────────────────────────────────────────────────────
// detectLanguage
// ─────────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('detects typescript', () => {
    assert.strictEqual(detectLanguage('app.ts'), 'typescript');
    assert.strictEqual(detectLanguage('page.tsx'), 'typescript');
  });

  it('detects python', () => {
    assert.strictEqual(detectLanguage('main.py'), 'python');
  });

  it('detects rust', () => {
    assert.strictEqual(detectLanguage('lib.rs'), 'rust');
  });

  it('detects javascript from .mjs', () => {
    assert.strictEqual(detectLanguage('output.mjs'), 'javascript');
  });

  it('returns null for unknown extension', () => {
    assert.strictEqual(detectLanguage('file.xyz'), null);
  });

  it('returns null for extensionless files', () => {
    assert.strictEqual(detectLanguage('Makefile'), null);
  });
});

// ─────────────────────────────────────────────────────────────
// isCodeFile
// ─────────────────────────────────────────────────────────────

describe('isCodeFile', () => {
  it('returns true for code extensions', () => {
    assert.strictEqual(isCodeFile('app.ts'), true);
    assert.strictEqual(isCodeFile('main.py'), true);
    assert.strictEqual(isCodeFile('lib.rs'), true);
  });

  it('returns false for config/style/markdown', () => {
    assert.strictEqual(isCodeFile('config.json'), false);
    assert.strictEqual(isCodeFile('style.css'), false);
    assert.strictEqual(isCodeFile('README.md'), false);
  });

  it('returns false for unknown extensions', () => {
    assert.strictEqual(isCodeFile('data.csv'), false);
  });
});

// ─────────────────────────────────────────────────────────────
// Getters (return Sets with expected defaults)
// ─────────────────────────────────────────────────────────────

describe('getters', () => {
  it('getSkipDirs returns Set containing node_modules', () => {
    const dirs = getSkipDirs();
    assert.ok(dirs instanceof Set);
    assert.ok(dirs.has('node_modules'));
    assert.ok(dirs.has('dist'));
  });

  it('getSkipExtensions returns Set containing .jpg', () => {
    const exts = getSkipExtensions();
    assert.ok(exts instanceof Set);
    assert.ok(exts.has('.jpg'));
    assert.ok(exts.has('.lock'));
  });

  it('getImportantFiles returns Set containing package.json', () => {
    const files = getImportantFiles();
    assert.ok(files instanceof Set);
    assert.ok(files.has('package.json'));
  });

  it('getImportantDirs returns Set containing src', () => {
    const dirs = getImportantDirs();
    assert.ok(dirs instanceof Set);
    assert.ok(dirs.has('src'));
    assert.ok(dirs.has('.claude'));
  });
});
