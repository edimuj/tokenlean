/**
 * Cached JS/TS project graph built from the TypeScript AST and module resolver.
 *
 * This graph complements the per-file semantic facts cache. It focuses on
 * import/export edges that power tools such as tl-deps and tl-impact.
 */

import { builtinModules } from 'module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import ts from 'typescript';
import { getCacheConfig, getCacheDir, getGitState, withCache } from './cache.mjs';
import { findProjectRoot } from './project.mjs';
import { isJsTsFile } from './semantic-js.mjs';
import { listFiles } from './traverse.mjs';

const CACHE_NAMESPACE = 'semantic-js-graph-v1';
const GRAPH_PARSER_VERSION = `typescript-graph-${ts.version}`;
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map(name => name.replace(/^node:/, ''))
]);
const ASSET_SPEC_RE = /\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|bmp|avif|mp3|mp4|woff2?|ttf|eot|json)$/i;
const DEFAULT_COMPILER_OPTIONS = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  resolveJsonModule: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ESNext
};

const compilerOptionsCache = new Map();

function normalisePath(filePath) {
  return resolve(filePath);
}

function trimText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function getProjectRootForPath(targetPath, projectRoot) {
  if (projectRoot) return projectRoot;
  const absPath = normalisePath(targetPath);
  try {
    const stat = statSync(absPath);
    return findProjectRoot(stat.isDirectory() ? absPath : dirname(absPath));
  } catch {
    return findProjectRoot(dirname(absPath));
  }
}

function getLineNumber(sourceFile, pos) {
  return ts.getLineAndCharacterOfPosition(sourceFile, pos).line + 1;
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

function getStatementText(node, sourceFile, content, maxLength = 200) {
  const text = trimText(content.slice(node.getStart(sourceFile), node.end));
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function sameMetadata(a, b) {
  return !!a && !!b &&
    a.relPath === b.relPath &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs;
}

function metadataMatches(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameMetadata(a[i], b[i])) return false;
  }
  return true;
}

function gitStateMatches(a, b) {
  if (!a || !b) return false;
  if (a.head !== b.head) return false;
  const aDirty = Array.isArray(a.dirtyFiles) ? a.dirtyFiles : [];
  const bDirty = Array.isArray(b.dirtyFiles) ? b.dirtyFiles : [];
  if (aDirty.length !== bDirty.length) return false;
  for (let i = 0; i < aDirty.length; i++) {
    if (aDirty[i] !== bDirty[i]) return false;
  }
  return true;
}

function getGraphCacheFile(projectRoot) {
  return join(getCacheDir(projectRoot), CACHE_NAMESPACE, 'graph.json');
}

function getProjectCompilerConfig(projectRoot) {
  const configPath =
    ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json') ||
    ts.findConfigFile(projectRoot, ts.sys.fileExists, 'jsconfig.json');

  let configKey = 'default';
  if (configPath) {
    configKey = relative(projectRoot, configPath);
    try {
      const stat = statSync(configPath);
      configKey = `${relative(projectRoot, configPath)}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // Best-effort config fingerprint only.
    }
  }

  const cached = compilerOptionsCache.get(projectRoot);
  if (cached && cached.configKey === configKey) return cached;

  if (!configPath) {
    const fallback = { options: DEFAULT_COMPILER_OPTIONS, configKey: 'default' };
    compilerOptionsCache.set(projectRoot, fallback);
    return fallback;
  }

  try {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      const fallback = { options: DEFAULT_COMPILER_OPTIONS, configKey };
      compilerOptionsCache.set(projectRoot, fallback);
      return fallback;
    }

    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      dirname(configPath),
      DEFAULT_COMPILER_OPTIONS,
      configPath
    );

    const options = {
      ...DEFAULT_COMPILER_OPTIONS,
      ...parsed.options
    };

    const result = { options, configKey };
    compilerOptionsCache.set(projectRoot, result);
    return result;
  } catch {
    const fallback = { options: DEFAULT_COMPILER_OPTIONS, configKey };
    compilerOptionsCache.set(projectRoot, fallback);
    return fallback;
  }
}

function resolveLocalPath(spec, containingFile) {
  const importerDir = dirname(containingFile);
  const direct = resolve(importerDir, spec);
  const candidates = [
    direct,
    `${direct}.js`,
    `${direct}.jsx`,
    `${direct}.ts`,
    `${direct}.tsx`,
    `${direct}.mjs`,
    `${direct}.mts`,
    `${direct}.cjs`,
    `${direct}.cts`,
    join(direct, 'index.js'),
    join(direct, 'index.jsx'),
    join(direct, 'index.ts'),
    join(direct, 'index.tsx'),
    join(direct, 'index.mjs'),
    join(direct, 'index.mts'),
    join(direct, 'index.cjs'),
    join(direct, 'index.cts')
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function classifyImport(spec, containingFile, projectRoot) {
  const bareName = spec.replace(/^node:/, '').split('/')[0];
  if (BUILTIN_MODULES.has(spec) || BUILTIN_MODULES.has(bareName)) {
    return { moduleType: 'builtin', resolvedPath: null };
  }

  const isRelativeLike = spec.startsWith('.') || spec.startsWith('/');
  if (ASSET_SPEC_RE.test(spec)) {
    const resolved = isRelativeLike ? resolveLocalPath(spec, containingFile) : null;
    return {
      moduleType: 'asset',
      resolvedPath: resolved ? relative(projectRoot, resolved) : null
    };
  }

  const { options } = getProjectCompilerConfig(projectRoot);
  const resolved = ts.resolveModuleName(spec, containingFile, options, ts.sys).resolvedModule;
  const resolvedFile = resolved?.resolvedFileName ? normalisePath(resolved.resolvedFileName) : null;

  if (!resolvedFile) {
    if (isRelativeLike) {
      return {
        moduleType: 'unresolved',
        resolvedPath: null
      };
    }

    return {
      moduleType: 'package',
      resolvedPath: null
    };
  }

  if (resolvedFile.includes(`${sep}node_modules${sep}`)) {
    return {
      moduleType: 'package',
      resolvedPath: null
    };
  }

  if (ASSET_SPEC_RE.test(resolvedFile)) {
    return {
      moduleType: 'asset',
      resolvedPath: relative(projectRoot, resolvedFile)
    };
  }

  if (isJsTsFile(resolvedFile) || resolvedFile.endsWith('.d.ts')) {
    return {
      moduleType: 'local',
      resolvedPath: relative(projectRoot, resolvedFile)
    };
  }

  return {
    moduleType: isRelativeLike ? 'local' : 'package',
    resolvedPath: relative(projectRoot, resolvedFile)
  };
}

function pushImport(imports, seen, entry) {
  const key = JSON.stringify([
    entry.line,
    entry.spec,
    entry.importType,
    entry.moduleType,
    entry.resolvedPath,
    entry.statement,
    entry.bindings
  ]);

  if (seen.has(key)) return;
  seen.add(key);
  imports.push(entry);
}

function pushExport(exportsList, entry) {
  exportsList.push(entry);
}

function binding(imported, local, kind, extra = {}) {
  return {
    imported,
    local,
    kind,
    ...extra
  };
}

function memberName(nameNode) {
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) return nameNode.text;
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) return nameNode.text;
  return null;
}

function isExportsObject(node) {
  return ts.isIdentifier(node) && node.text === 'exports';
}

function isModuleExportsObject(node) {
  return ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports';
}

function getCommonJsNamedExport(left) {
  if (ts.isPropertyAccessExpression(left) && isExportsObject(left.expression)) {
    return left.name.text;
  }

  if (ts.isElementAccessExpression(left) &&
      isExportsObject(left.expression) &&
      left.argumentExpression &&
      ts.isStringLiteralLike(left.argumentExpression)) {
    return left.argumentExpression.text;
  }

  if (ts.isPropertyAccessExpression(left) && isModuleExportsObject(left.expression)) {
    return left.name.text;
  }

  if (ts.isElementAccessExpression(left) &&
      isModuleExportsObject(left.expression) &&
      left.argumentExpression &&
      ts.isStringLiteralLike(left.argumentExpression)) {
    return left.argumentExpression.text;
  }

  return null;
}

function bindingsFromImportClause(clause) {
  const bindings = [];
  if (!clause) return bindings;

  if (clause.name) {
    bindings.push(binding('default', clause.name.text, 'default', { isTypeOnly: !!clause.isTypeOnly }));
  }

  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push(binding('*', clause.namedBindings.name.text, 'namespace', { isTypeOnly: !!clause.isTypeOnly }));
    } else if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName ? element.propertyName.text : element.name.text;
        bindings.push(binding(imported, element.name.text, 'named', {
          isTypeOnly: !!clause.isTypeOnly || !!element.isTypeOnly
        }));
      }
    }
  }

  return bindings;
}

function bindingsFromRequireName(nameNode) {
  if (!nameNode) return [];

  if (ts.isIdentifier(nameNode)) {
    return [binding('default', nameNode.text, 'default')];
  }

  if (ts.isObjectBindingPattern(nameNode)) {
    const bindings = [];
    for (const element of nameNode.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const local = ts.isIdentifier(element.name) ? element.name.text : null;
      const imported = element.propertyName
        ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
          ? element.propertyName.text
          : null)
        : local;
      if (!local || !imported) continue;
      bindings.push(binding(imported, local, 'named'));
    }
    return bindings;
  }

  return [];
}

function extractImportFromCall(call, statement, sourceFile, content, filePath, projectRoot) {
  if (!call.arguments?.length) return null;
  const firstArg = call.arguments[0];
  if (!firstArg || !ts.isStringLiteralLike(firstArg)) return null;

  const spec = firstArg.text;
  const importType = call.expression.kind === ts.SyntaxKind.ImportKeyword
    ? 'dynamic-import'
    : 'require';

  let bindings = [];
  if (statement && ts.isVariableStatement(statement)) {
    bindings = statement.declarationList.declarations.flatMap(decl => {
      if (decl.initializer !== call) return [];
      return bindingsFromRequireName(decl.name);
    });
  }

  if (bindings.length === 0 && importType === 'dynamic-import') {
    bindings = [binding('dynamic', null, 'dynamic')];
  }

  const resolved = classifyImport(spec, filePath, projectRoot);
  return {
    spec,
    importType,
    line: getLineNumber(sourceFile, call.getStart(sourceFile)),
    statement: getStatementText(statement || call, sourceFile, content),
    moduleType: resolved.moduleType,
    resolvedPath: resolved.resolvedPath,
    isTypeOnly: false,
    bindings
  };
}

function collectCallImports(sourceFile, content, filePath, projectRoot, imports, seen) {
  function visit(node, currentStatement = null) {
    const statement = ts.isStatement(node) ? node : currentStatement;

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const entry = extractImportFromCall(node, statement, sourceFile, content, filePath, projectRoot);
        if (entry) pushImport(imports, seen, entry);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const entry = extractImportFromCall(node, statement, sourceFile, content, filePath, projectRoot);
        if (entry) pushImport(imports, seen, entry);
      }
    }

    ts.forEachChild(node, child => visit(child, statement));
  }

  visit(sourceFile, null);
}

function collectTopLevelExports(statement, sourceFile, content, exportsList) {
  const line = getLineNumber(sourceFile, statement.getStart(sourceFile));
  const statementText = getStatementText(statement, sourceFile, content);

  if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    pushExport(exportsList, {
      name: statement.name.text,
      localName: statement.name.text,
      exportType: statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : 'named',
      line,
      statement: statementText
    });
    return;
  }

  if (ts.isClassDeclaration(statement) && statement.name && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    pushExport(exportsList, {
      name: statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name.text,
      localName: statement.name.text,
      exportType: statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : 'named',
      line,
      statement: statementText
    });
    return;
  }

  if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    pushExport(exportsList, {
      name: statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name.text,
      localName: statement.name.text,
      exportType: statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : 'named',
      line,
      statement: statementText
    });
    return;
  }

  if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    const isDefault = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      pushExport(exportsList, {
        name: isDefault ? 'default' : decl.name.text,
        localName: decl.name.text,
        exportType: isDefault ? 'default' : 'named',
        line,
        statement: statementText
      });
    }
    return;
  }

  if (ts.isExportAssignment(statement)) {
    const localName = ts.isIdentifier(statement.expression) ? statement.expression.text : null;
    pushExport(exportsList, {
      name: 'default',
      localName,
      exportType: 'default',
      line,
      statement: statementText
    });
  }
}

function addCommonJsObjectExports(right, line, statementText, exportsList) {
  if (!ts.isObjectLiteralExpression(right)) return false;

  for (const prop of right.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const exportName = memberName(prop.name);
      const localName = ts.isIdentifier(prop.initializer) ? prop.initializer.text : exportName;
      if (!exportName) continue;
      pushExport(exportsList, {
        name: exportName,
        localName,
        exportType: 'named',
        line,
        statement: statementText
      });
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      pushExport(exportsList, {
        name: prop.name.text,
        localName: prop.name.text,
        exportType: 'named',
        line,
        statement: statementText
      });
    } else if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      const exportName = memberName(prop.name);
      if (!exportName) continue;
      pushExport(exportsList, {
        name: exportName,
        localName: exportName,
        exportType: 'named',
        line,
        statement: statementText
      });
    }
  }

  return true;
}

function collectCommonJsExports(statement, sourceFile, content, exportsList) {
  if (!ts.isExpressionStatement(statement)) return;

  const line = getLineNumber(sourceFile, statement.getStart(sourceFile));
  const statementText = getStatementText(statement, sourceFile, content);

  if (ts.isBinaryExpression(statement.expression)) {
    const expr = statement.expression;
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;

    const namedExport = getCommonJsNamedExport(expr.left);
    if (namedExport) {
      pushExport(exportsList, {
        name: namedExport,
        localName: ts.isIdentifier(expr.right) ? expr.right.text : null,
        exportType: 'named',
        line,
        statement: statementText
      });
      return;
    }

    if (isModuleExportsObject(expr.left)) {
      if (addCommonJsObjectExports(expr.right, line, statementText, exportsList)) {
        return;
      }

      pushExport(exportsList, {
        name: 'default',
        localName: ts.isIdentifier(expr.right) ? expr.right.text : null,
        exportType: 'default',
        line,
        statement: statementText
      });
    }

    return;
  }

  if (!ts.isCallExpression(statement.expression)) return;

  const call = statement.expression;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'Object') return;
  if (call.expression.name.text !== 'assign') return;
  if (call.arguments.length < 2) return;

  const [target, source] = call.arguments;
  if (!isExportsObject(target) && !isModuleExportsObject(target)) return;
  addCommonJsObjectExports(source, line, statementText, exportsList);
}

function dedupeExports(exportsList) {
  const seen = new Set();
  return exportsList.filter(item => {
    const key = JSON.stringify([item.name, item.localName, item.exportType, item.from || null, item.line]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFileGraph(filePath, projectRoot) {
  const content = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const imports = [];
  const seenImports = new Set();
  const exportsList = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const bindings = bindingsFromImportClause(statement.importClause);
      const resolved = classifyImport(spec, filePath, projectRoot);
      pushImport(imports, seenImports, {
        spec,
        importType: 'import',
        line: getLineNumber(sourceFile, statement.getStart(sourceFile)),
        statement: getStatementText(statement, sourceFile, content),
        moduleType: resolved.moduleType,
        resolvedPath: resolved.resolvedPath,
        isTypeOnly: !!statement.importClause?.isTypeOnly,
        bindings
      });
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLike(statement.moduleReference.expression)) {
      const spec = statement.moduleReference.expression.text;
      const resolved = classifyImport(spec, filePath, projectRoot);
      pushImport(imports, seenImports, {
        spec,
        importType: 'import-equals',
        line: getLineNumber(sourceFile, statement.getStart(sourceFile)),
        statement: getStatementText(statement, sourceFile, content),
        moduleType: resolved.moduleType,
        resolvedPath: resolved.resolvedPath,
        isTypeOnly: false,
        bindings: statement.name ? [binding('default', statement.name.text, 'default')] : []
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const line = getLineNumber(sourceFile, statement.getStart(sourceFile));
      const statementText = getStatementText(statement, sourceFile, content);
      const spec = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;

      if (spec) {
        const resolved = classifyImport(spec, filePath, projectRoot);
        let bindings = [];

        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          bindings = statement.exportClause.elements.map(element => binding(
            element.propertyName ? element.propertyName.text : element.name.text,
            element.name.text,
            'reexport-named',
            { isTypeOnly: !!element.isTypeOnly || !!statement.isTypeOnly }
          ));
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          bindings = [binding('*', statement.exportClause.name.text, 'reexport-namespace')];
        } else {
          bindings = [binding('*', null, 'reexport-star')];
        }

        pushImport(imports, seenImports, {
          spec,
          importType: 'reexport',
          line,
          statement: statementText,
          moduleType: resolved.moduleType,
          resolvedPath: resolved.resolvedPath,
          isTypeOnly: !!statement.isTypeOnly,
          bindings
        });

        for (const item of bindings) {
          pushExport(exportsList, {
            name: item.local || item.imported,
            localName: item.imported === '*' ? null : item.imported,
            exportType: item.kind,
            from: spec,
            line,
            statement: statementText
          });
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          pushExport(exportsList, {
            name: element.name.text,
            localName: element.propertyName ? element.propertyName.text : element.name.text,
            exportType: 'named',
            line,
            statement: statementText
          });
        }
      }

      continue;
    }

    collectTopLevelExports(statement, sourceFile, content, exportsList);
    collectCommonJsExports(statement, sourceFile, content, exportsList);
  }

  collectCallImports(sourceFile, content, filePath, projectRoot, imports, seenImports);

  return {
    path: relative(projectRoot, filePath),
    imports: imports.sort((a, b) => a.line - b.line || a.spec.localeCompare(b.spec)),
    exports: dedupeExports(exportsList).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
  };
}

function collectProjectFileMetadata(projectRoot) {
  return listFiles(projectRoot)
    .filter(file => isJsTsFile(file.path))
    .map(file => {
      const fullPath = normalisePath(file.path);
      const stat = statSync(fullPath);
      return {
        path: fullPath,
        relPath: relative(projectRoot, fullPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function getProjectFileMetadata(projectRoot) {
  return withCache(
    { op: 'semantic-js-graph-metadata', parser: GRAPH_PARSER_VERSION },
    () => collectProjectFileMetadata(projectRoot),
    { projectRoot }
  );
}

function buildGraph(projectRoot, metadata) {
  const files = {};
  const reverseImports = {};

  for (const file of metadata) {
    const node = buildFileGraph(file.path, projectRoot);
    files[node.path] = node;

    for (const imp of node.imports) {
      if (!imp.resolvedPath) continue;
      if (!reverseImports[imp.resolvedPath]) reverseImports[imp.resolvedPath] = [];
      reverseImports[imp.resolvedPath].push({
        importer: node.path,
        spec: imp.spec,
        line: imp.line,
        importType: imp.importType,
        isTypeOnly: !!imp.isTypeOnly,
        statement: imp.statement,
        bindings: imp.bindings,
        moduleType: imp.moduleType,
        resolvedPath: imp.resolvedPath
      });
    }
  }

  for (const edges of Object.values(reverseImports)) {
    edges.sort((a, b) => a.line - b.line || a.importer.localeCompare(b.importer));
  }

  return {
    parser: GRAPH_PARSER_VERSION,
    files,
    reverseImports
  };
}

function readCachedGraph(projectRoot, configKey, gitState, metadata = null) {
  const config = getCacheConfig();
  if (!config.enabled) return null;

  const cacheFile = getGraphCacheFile(projectRoot);
  if (!existsSync(cacheFile)) return null;

  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (cached.parser !== GRAPH_PARSER_VERSION) return null;
    if ((cached.configKey || 'default') !== configKey) return null;
    if (gitState && cached.gitState && gitStateMatches(cached.gitState, gitState)) {
      return cached.data || null;
    }
    if (metadata) {
      if (!metadataMatches(cached.metadata || [], metadata.map(({ relPath, size, mtimeMs }) => ({ relPath, size, mtimeMs })))) {
        return null;
      }
      return cached.data || null;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedGraph(projectRoot, metadata, data, configKey, gitState) {
  const config = getCacheConfig();
  if (!config.enabled) return;

  const cacheFile = getGraphCacheFile(projectRoot);
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
    writeFileSync(cacheFile, JSON.stringify({
      parser: GRAPH_PARSER_VERSION,
      configKey,
      gitState: gitState || null,
      metadata: metadata.map(({ relPath, size, mtimeMs }) => ({ relPath, size, mtimeMs })),
      data
    }));
  } catch {
    // Best-effort cache only.
  }
}

export function getJsTsProjectGraph(targetPath, options = {}) {
  const projectRoot = getProjectRootForPath(targetPath, options.projectRoot);
  const { configKey } = getProjectCompilerConfig(projectRoot);
  const gitState = getGitState(projectRoot);
  const cached = readCachedGraph(projectRoot, configKey, gitState);
  if (cached) return { projectRoot, ...cached };

  const metadata = getProjectFileMetadata(projectRoot);
  const cachedWithMetadata = readCachedGraph(projectRoot, configKey, gitState, metadata);
  if (cachedWithMetadata) return { projectRoot, ...cachedWithMetadata };

  const data = buildGraph(projectRoot, metadata);
  writeCachedGraph(projectRoot, metadata, data, configKey, gitState);
  return { projectRoot, ...data };
}

export function getJsTsGraphFile(targetFile, options = {}) {
  const absPath = normalisePath(targetFile);
  if (!isJsTsFile(absPath)) return null;

  const { projectRoot, files } = getJsTsProjectGraph(absPath, options);
  const relPath = relative(projectRoot, absPath);
  return files[relPath] ? { projectRoot, ...files[relPath] } : null;
}

export function getJsTsGraphImporters(targetFile, options = {}) {
  const absPath = normalisePath(targetFile);
  if (!isJsTsFile(absPath)) return { projectRoot: getProjectRootForPath(absPath, options.projectRoot), edges: [] };

  const { projectRoot, reverseImports } = getJsTsProjectGraph(absPath, options);
  const relPath = relative(projectRoot, absPath);
  return {
    projectRoot,
    edges: reverseImports[relPath] || []
  };
}

export function formatImportBindings(bindings = []) {
  if (!bindings || bindings.length === 0) return [];

  return bindings.map(item => {
    if (item.kind === 'namespace' || item.kind === 'reexport-namespace') {
      return item.local ? `* (${item.local})` : '*';
    }
    if (item.kind === 'dynamic') return 'dynamic';
    if (item.kind === 'default') return item.local ? `default (${item.local})` : 'default';
    if (item.kind === 'reexport-star') return '*';
    return item.imported || item.local;
  });
}
