/**
 * Shared source-file discovery + function indexing.
 *
 * Used by tl-dupes and tl-lookup so the file-walk and extraction loop live in
 * one place (not, ironically, duplicated).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { shouldSkip, isCodeFile, detectLanguage, findProjectRoot } from './project.mjs';
import { extractFunctions } from './dupes.mjs';

const TEST_MARKERS = ['.test.', '.spec.', '__tests__', '__mocks__'];

function isTestFile(name) {
  const lower = name.toLowerCase();
  return TEST_MARKERS.some(m => lower.includes(m));
}

/**
 * Collect code files under a path (recursively), honoring skip dirs and tests.
 * @returns {{files:string[], isDir:boolean, exists:boolean}}
 */
function collectSourceFiles(targetPath, opts = {}) {
  const { includeTests = false } = opts;
  let stat;
  try { stat = statSync(targetPath); } catch { return { files: [], isDir: false, exists: false }; }

  const files = [];
  if (stat.isDirectory()) {
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!shouldSkip(e.name, true)) walk(full);
        } else if (e.isFile()) {
          if (shouldSkip(e.name, false)) continue;
          if (!includeTests && isTestFile(e.name)) continue;
          if (isCodeFile(full)) files.push(full);
        }
      }
    };
    walk(targetPath);
  } else if (isCodeFile(targetPath)) {
    files.push(targetPath);
  }
  return { files, isDir: stat.isDirectory(), exists: true };
}

/**
 * Build a flat index of all functions under a path.
 * @returns {{functions:object[], fileCount:number, projectRoot:string, exists:boolean}}
 */
export function buildFunctionIndex(targetPath, opts = {}) {
  const abs = resolve(targetPath);
  const { files, isDir, exists } = collectSourceFiles(abs, opts);
  const projectRoot = findProjectRoot(isDir ? abs : resolve(abs, '..'));

  const functions = [];
  for (const file of files) {
    const lang = detectLanguage(file);
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(projectRoot, file) || file;
    for (const fn of extractFunctions(source, lang)) {
      functions.push({ ...fn, file: rel, lang });
    }
  }
  return { functions, fileCount: files.length, projectRoot, exists };
}
