/**
 * Shared helpers for semantic-js.mjs and semantic-js-graph.mjs.
 * Extracted to avoid duplication; must stay logic-identical in both consumers.
 */

import { statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import ts from 'typescript';
import { findProjectRoot } from './project.mjs';

export function normalisePath(filePath) {
  return resolve(filePath);
}

export function getScriptKind(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case '.js': return ts.ScriptKind.JS;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.mjs': return ts.ScriptKind.JS;
    case '.cjs': return ts.ScriptKind.JS;
    case '.ts': return ts.ScriptKind.TS;
    case '.tsx': return ts.ScriptKind.TSX;
    case '.mts': return ts.ScriptKind.TS;
    case '.cts': return ts.ScriptKind.TS;
    default: return ts.ScriptKind.Unknown;
  }
}

export function getLineNumber(sourceFile, pos) {
  return ts.getLineAndCharacterOfPosition(sourceFile, pos).line + 1;
}

export function getProjectRootForPath(targetPath, projectRoot) {
  if (projectRoot) return projectRoot;
  const absPath = normalisePath(targetPath);
  try {
    const stat = statSync(absPath);
    return findProjectRoot(stat.isDirectory() ? absPath : dirname(absPath));
  } catch {
    return findProjectRoot(dirname(absPath));
  }
}
