/**
 * Cached semantic facts for JavaScript/TypeScript files.
 *
 * JS/TS is the first semantic-index slice in tokenlean. We keep the stored
 * data intentionally small: symbol summaries for tl-symbols plus exact
 * definition ranges for tl-snippet.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, extname, join, resolve, relative } from 'path';
import ts from 'typescript';
import { getCacheConfig, getCacheDir } from './cache.mjs';
import { findProjectRoot } from './project.mjs';
import { listFiles } from './traverse.mjs';

const CACHE_NAMESPACE = 'semantic-js-v1';
const PARSER_VERSION = `typescript-${ts.version}`;
const JS_TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalisePath(filePath) {
  return resolve(filePath);
}

function getProjectRootForPath(filePath, projectRoot) {
  if (projectRoot) return projectRoot;
  const absPath = normalisePath(filePath);
  try {
    const stat = statSync(absPath);
    return findProjectRoot(stat.isDirectory() ? absPath : dirname(absPath));
  } catch {
    return findProjectRoot(dirname(absPath));
  }
}

function getLanguage(filePath) {
  const ext = extname(filePath).toLowerCase();
  return ['.ts', '.tsx', '.mts', '.cts'].includes(ext) ? 'ts' : 'js';
}

function getScriptKind(filePath) {
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

function getLineNumber(sourceFile, pos) {
  return ts.getLineAndCharacterOfPosition(sourceFile, pos).line + 1;
}

function trimSignature(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(/[;]\s*$/, '')
    .trim();
}

function sliceSignature(content, start, end) {
  if (end <= start) return '';
  return trimSignature(content.slice(start, end));
}

function findOpeningBrace(content, start, end) {
  const idx = content.indexOf('{', start);
  return idx !== -1 && idx < end ? idx : -1;
}

function hasModifier(node, kind) {
  return !!node.modifiers?.some(mod => mod.kind === kind);
}

function isExported(node) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function getNodeRange(node, sourceFile) {
  const start = node.getStart(sourceFile);
  const end = node.end;
  const endPos = Math.max(start, end - 1);
  return {
    start,
    end,
    line: getLineNumber(sourceFile, start),
    endLine: getLineNumber(sourceFile, endPos)
  };
}

function makeDefinition(node, sourceFile, info) {
  const range = getNodeRange(node, sourceFile);
  return {
    ...info,
    start: range.start,
    end: range.end,
    line: range.line,
    endLine: range.endLine
  };
}

function addExport(exportsList, signature) {
  if (signature) exportsList.push(signature);
}

function propertyNameText(nameNode, sourceFile) {
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  if (ts.isComputedPropertyName(nameNode)) {
    return null;
  }
  const text = nameNode.getText(sourceFile).trim();
  return text || null;
}

function buildFunctionSignature(node, sourceFile, content) {
  const start = node.getStart(sourceFile);
  const bodyStart = node.body ? node.body.getStart(sourceFile) : node.end;
  return sliceSignature(content, start, bodyStart);
}

function buildClassLikeSignature(node, sourceFile, content) {
  const start = node.getStart(sourceFile);
  const brace = findOpeningBrace(content, start, node.end);
  return sliceSignature(content, start, brace === -1 ? node.end : brace);
}

function buildVariableKindKeyword(statement) {
  const flags = statement.declarationList.flags;
  if (flags & ts.NodeFlags.Const) return 'const';
  if (flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function buildVariableConstantSignature(statement, decl, sourceFile) {
  const keyword = buildVariableKindKeyword(statement);
  const start = decl.getStart(sourceFile);
  const typeText = decl.type ? `: ${decl.type.getText(sourceFile)}` : '';
  const exportPrefix = isExported(statement) ? 'export ' : '';
  return `${exportPrefix}${keyword} ${decl.name.getText(sourceFile)}${typeText}`.trim();
}

function buildVariableFunctionSignature(statement, decl, sourceFile, content) {
  const start = statement.getStart(sourceFile);
  const init = decl.initializer;
  const bodyStart = init?.body ? init.body.getStart(sourceFile) : (init ? init.end : decl.end);
  return sliceSignature(content, start, bodyStart);
}

function buildVariableClassSignature(statement, decl, sourceFile, content) {
  const start = statement.getStart(sourceFile);
  const init = decl.initializer;
  const brace = init ? findOpeningBrace(content, init.getStart(sourceFile), init.end) : -1;
  return sliceSignature(content, start, brace === -1 ? decl.end : brace);
}

function buildEnumSignature(node, sourceFile, content) {
  const base = buildClassLikeSignature(node, sourceFile, content);
  const names = node.members
    .map(member => member.name?.getText(sourceFile))
    .filter(Boolean);

  if (names.length === 0) return base;

  const MAX_INLINE = 6;
  const shown = names.slice(0, MAX_INLINE).join(', ');
  const overflow = names.length > MAX_INLINE ? `, ... +${names.length - MAX_INLINE} more` : '';
  return `${base} { ${shown}${overflow} }`;
}

function buildTypeMembers(members, sourceFile, content) {
  return members
    .map(member => {
      const text = sliceSignature(content, member.getStart(sourceFile), member.end);
      return text || null;
    })
    .filter(Boolean);
}

function collectClassEntry(node, className, sourceFile, content, exported, symbols, definitions, options = {}) {
  const signature = options.signature || buildClassLikeSignature(node, sourceFile, content);
  const definitionNode = options.definitionNode || node;
  const methods = [];
  const classEntry = { signature, methods };

  symbols.classes.push(classEntry);
  if (exported) addExport(symbols.exports, signature);
  definitions.push(makeDefinition(definitionNode, sourceFile, {
    name: className,
    qualifiedName: className,
    owner: null,
    kind: 'class',
    exported,
    signature
  }));

  for (const member of node.members || []) {
    let memberName = null;
    let memberSignature = null;
    let memberNode = member;

    if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      memberName = propertyNameText(member.name, sourceFile);
      memberSignature = buildFunctionSignature(member, sourceFile, content);
    } else if (ts.isConstructorDeclaration(member)) {
      memberName = 'constructor';
      memberSignature = buildFunctionSignature(member, sourceFile, content);
    } else if (ts.isPropertyDeclaration(member) &&
               member.initializer &&
               (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
      memberName = propertyNameText(member.name, sourceFile);
      memberSignature = buildFunctionSignature(member.initializer, sourceFile, content)
        ? sliceSignature(content, member.getStart(sourceFile), member.initializer.body.getStart(sourceFile))
        : null;
    }

    if (!memberName || !memberSignature) continue;

    methods.push(memberSignature);
    definitions.push(makeDefinition(memberNode, sourceFile, {
      name: memberName,
      qualifiedName: `${className}.${memberName}`,
      owner: className,
      kind: 'method',
      exported,
      signature: memberSignature
    }));
  }
}

function extractFacts(filePath, content) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const symbols = {
    exports: [],
    classes: [],
    functions: [],
    types: [],
    constants: []
  };
  const definitions = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const signature = buildFunctionSignature(statement, sourceFile, content);
      const exported = isExported(statement);
      symbols.functions.push(signature);
      if (exported) addExport(symbols.exports, signature);
      definitions.push(makeDefinition(statement, sourceFile, {
        name: statement.name.text,
        qualifiedName: statement.name.text,
        owner: null,
        kind: 'function',
        exported,
        signature
      }));
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      collectClassEntry(
        statement,
        statement.name.text,
        sourceFile,
        content,
        isExported(statement),
        symbols,
        definitions
      );
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const signature = buildClassLikeSignature(statement, sourceFile, content);
      const members = buildTypeMembers(statement.members, sourceFile, content);
      const exported = isExported(statement);
      symbols.types.push({ signature, members });
      if (exported) addExport(symbols.exports, signature);
      definitions.push(makeDefinition(statement, sourceFile, {
        name: statement.name.text,
        qualifiedName: statement.name.text,
        owner: null,
        kind: 'type',
        exported,
        signature
      }));
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const exported = isExported(statement);
      let typeEntry;
      let signature;

      if (ts.isTypeLiteralNode(statement.type)) {
        signature = sliceSignature(content, statement.getStart(sourceFile), statement.type.getStart(sourceFile));
        typeEntry = {
          signature,
          members: buildTypeMembers(statement.type.members, sourceFile, content)
        };
      } else {
        signature = sliceSignature(content, statement.getStart(sourceFile), statement.end);
        typeEntry = signature;
      }

      symbols.types.push(typeEntry);
      if (exported) addExport(symbols.exports, signature);
      definitions.push(makeDefinition(statement, sourceFile, {
        name: statement.name.text,
        qualifiedName: statement.name.text,
        owner: null,
        kind: 'type',
        exported,
        signature
      }));
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      const signature = buildEnumSignature(statement, sourceFile, content);
      const exported = isExported(statement);
      symbols.types.push(signature);
      if (exported) addExport(symbols.exports, signature);
      definitions.push(makeDefinition(statement, sourceFile, {
        name: statement.name.text,
        qualifiedName: statement.name.text,
        owner: null,
        kind: 'type',
        exported,
        signature
      }));
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isExported(statement);

      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;

        const name = decl.name.text;
        const init = decl.initializer;

        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const signature = buildVariableFunctionSignature(statement, decl, sourceFile, content);
          symbols.functions.push(signature);
          if (exported) addExport(symbols.exports, signature);
          definitions.push(makeDefinition(statement, sourceFile, {
            name,
            qualifiedName: name,
            owner: null,
            kind: 'function',
            exported,
            signature
          }));
          continue;
        }

        if (init && ts.isClassExpression(init)) {
          collectClassEntry(init, name, sourceFile, content, exported, symbols, definitions, {
            signature: buildVariableClassSignature(statement, decl, sourceFile, content),
            definitionNode: statement
          });
          continue;
        }

        const signature = buildVariableConstantSignature(statement, decl, sourceFile);
        symbols.constants.push(signature);
        if (exported) addExport(symbols.exports, signature);
        definitions.push(makeDefinition(statement, sourceFile, {
          name,
          qualifiedName: name,
          owner: null,
          kind: 'constant',
          exported,
          signature
        }));
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      const signature = sliceSignature(content, statement.getStart(sourceFile), statement.end);
      addExport(symbols.exports, signature);
    }
  }

  return {
    parser: PARSER_VERSION,
    language: getLanguage(filePath),
    symbols,
    definitions
  };
}

function getCacheFilePath(filePath, projectRoot) {
  const baseDir = join(getCacheDir(projectRoot), CACHE_NAMESPACE);
  const rel = relative(projectRoot, filePath) || filePath;
  return join(baseDir, `${hash(rel)}.json`);
}

function getFingerprint(filePath) {
  const stat = statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    parser: PARSER_VERSION
  };
}

function fingerprintMatches(a, b) {
  return !!a && !!b &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.parser === b.parser;
}

function readCachedFacts(filePath, projectRoot, fingerprint) {
  const config = getCacheConfig();
  if (!config.enabled) return null;

  const cacheFile = getCacheFilePath(filePath, projectRoot);
  if (!existsSync(cacheFile)) return null;

  try {
    const entry = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (!fingerprintMatches(entry.fingerprint, fingerprint)) return null;
    return entry.data || null;
  } catch {
    return null;
  }
}

function writeCachedFacts(filePath, projectRoot, fingerprint, data) {
  const config = getCacheConfig();
  if (!config.enabled) return;

  const cacheFile = getCacheFilePath(filePath, projectRoot);
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify({
      fingerprint,
      file: relative(projectRoot, filePath),
      data
    }));
  } catch {
    // Best-effort cache only.
  }
}

export function isJsTsFile(filePath) {
  return JS_TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function getJsTsSemanticFacts(filePath, options = {}) {
  const absPath = normalisePath(filePath);
  if (!isJsTsFile(absPath) || !existsSync(absPath)) return null;

  const projectRoot = getProjectRootForPath(absPath, options.projectRoot);
  const fingerprint = getFingerprint(absPath);
  const cached = readCachedFacts(absPath, projectRoot, fingerprint);
  if (cached) return cached;

  try {
    const content = options.content ?? readFileSync(absPath, 'utf-8');
    const facts = extractFacts(absPath, content);
    writeCachedFacts(absPath, projectRoot, fingerprint, facts);
    return facts;
  } catch {
    return null;
  }
}

function collectJsTsFiles(searchPath) {
  const absPath = normalisePath(searchPath);
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    return isJsTsFile(absPath) ? [absPath] : [];
  }

  return listFiles(absPath)
    .map(file => file.path)
    .filter(isJsTsFile)
    .sort();
}

export function findJsTsDefinitions(name, searchPath, options = {}) {
  if (!name) return [];

  const projectRoot = getProjectRootForPath(searchPath, options.projectRoot);
  const className = options.className || null;
  const defs = [];

  for (const filePath of collectJsTsFiles(searchPath)) {
    const facts = getJsTsSemanticFacts(filePath, { projectRoot });
    if (!facts) continue;

    for (const def of facts.definitions || []) {
      if (def.name !== name) continue;
      if (className && def.owner !== className) continue;
      defs.push({
        ...def,
        file: filePath
      });
    }
  }

  return defs;
}

export function getJsTsSuggestionCandidates(filePath, options = {}) {
  const facts = getJsTsSemanticFacts(filePath, options);
  if (!facts) return [];

  const seen = new Set();
  const names = [];
  for (const def of facts.definitions || []) {
    if (!def.name || seen.has(def.name)) continue;
    seen.add(def.name);
    names.push(def.name);
  }
  return names;
}
