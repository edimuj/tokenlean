#!/usr/bin/env node

/**
 * tl-docs - Extract documentation from code files
 *
 * Pulls JSDoc/TSDoc comments to understand APIs without reading implementations.
 * Perfect for AI agents that need function context with minimal tokens.
 *
 * Usage: tl-docs [path] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-docs',
    desc: 'Extract JSDoc/TSDoc documentation',
    when: 'before-read',
    example: 'tl-docs src/utils/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';
import { listFiles } from '../src/traverse.mjs';

const HELP = `
tl-docs - Extract documentation from code files

Usage: tl-docs [path] [options]

Options:
  --exports-only        Only show exported/public items
  --with-examples       Include @example blocks
  --with-signature      Include full function signatures
  --no-private          Exclude @private/@internal items
  --format <fmt>        Output format: compact, detailed (default: compact)
  --lang <language>     Force language: ts, js, py (default: auto-detect)
${COMMON_OPTIONS_HELP}

Examples:
  tl-docs src/utils/              # All docs in directory
  tl-docs src/api.ts              # Single file
  tl-docs src/ --exports-only     # Only exported items
  tl-docs src/ --with-examples    # Include code examples
  tl-docs src/ --format detailed  # Full documentation

Extracts:
  JSDoc/TSDoc:  @param, @returns, @throws, @example, @deprecated
  TypeScript:   Function signatures, interfaces, types
  Python:       Docstrings (Google/NumPy/Sphinx style)
`;

// ─────────────────────────────────────────────────────────────
// Documentation Structures
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DocParam
 * @property {string} name
 * @property {string} [type]
 * @property {string} [description]
 * @property {boolean} [optional]
 */

/**
 * @typedef {Object} DocEntry
 * @property {string} name
 * @property {string} kind - 'function' | 'class' | 'method' | 'interface' | 'type' | 'const'
 * @property {string} [description]
 * @property {DocParam[]} [params]
 * @property {string} [returns]
 * @property {string} [returnType]
 * @property {string[]} [throws]
 * @property {string[]} [examples]
 * @property {boolean} [deprecated]
 * @property {string} [deprecatedMsg]
 * @property {boolean} [isPrivate]
 * @property {boolean} [isExported]
 * @property {string} [signature]
 * @property {number} line
 */

// ─────────────────────────────────────────────────────────────
// JSDoc/TSDoc Parser
// ─────────────────────────────────────────────────────────────

function parseJSDoc(comment) {
  const doc = {
    description: '',
    params: [],
    returns: null,
    returnType: null,
    throws: [],
    examples: [],
    deprecated: false,
    deprecatedMsg: null,
    isPrivate: false,
    see: [],
    since: null,
  };

  // Remove comment markers
  const lines = comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, '').trim());

  let currentTag = null;
  let currentContent = [];
  let descriptionLines = [];

  for (const line of lines) {
    // Check for tag
    const tagMatch = line.match(/^@(\w+)(?:\s+(.*))?$/);

    if (tagMatch) {
      // Save previous tag content
      if (currentTag) {
        processTag(doc, currentTag, currentContent.join('\n').trim());
      } else if (descriptionLines.length > 0) {
        doc.description = descriptionLines.join(' ').trim();
      }

      currentTag = tagMatch[1];
      currentContent = tagMatch[2] ? [tagMatch[2]] : [];
    } else if (currentTag) {
      currentContent.push(line);
    } else {
      descriptionLines.push(line);
    }
  }

  // Process last tag
  if (currentTag) {
    processTag(doc, currentTag, currentContent.join('\n').trim());
  } else if (descriptionLines.length > 0 && !doc.description) {
    doc.description = descriptionLines.join(' ').trim();
  }

  return doc;
}

function processTag(doc, tag, content) {
  switch (tag) {
    case 'param':
    case 'arg':
    case 'argument': {
      // @param {type} name - description
      // @param name - description
      const paramMatch = content.match(/^(?:\{([^}]+)\}\s+)?(\[)?(\w+)\]?(?:\s*-?\s*(.*))?$/);
      if (paramMatch) {
        doc.params.push({
          name: paramMatch[3],
          type: paramMatch[1] || null,
          description: paramMatch[4] || null,
          optional: !!paramMatch[2]
        });
      }
      break;
    }

    case 'returns':
    case 'return': {
      // @returns {type} description
      const returnMatch = content.match(/^(?:\{([^}]+)\}\s*)?(.*)$/);
      if (returnMatch) {
        doc.returnType = returnMatch[1] || null;
        doc.returns = returnMatch[2] || null;
      }
      break;
    }

    case 'throws':
    case 'exception': {
      doc.throws.push(content);
      break;
    }

    case 'example': {
      doc.examples.push(content);
      break;
    }

    case 'deprecated': {
      doc.deprecated = true;
      doc.deprecatedMsg = content || null;
      break;
    }

    case 'private':
    case 'internal': {
      doc.isPrivate = true;
      break;
    }

    case 'see': {
      doc.see.push(content);
      break;
    }

    case 'since': {
      doc.since = content;
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TypeScript/JavaScript Extractor
// ─────────────────────────────────────────────────────────────

function extractTSDocs(content, filePath) {
  const entries = [];
  const lines = content.split('\n');

  // Find all JSDoc comments followed by declarations
  const docPattern = /\/\*\*[\s\S]*?\*\//g;
  let match;

  while ((match = docPattern.exec(content)) !== null) {
    const docComment = match[0];
    const docEnd = match.index + docComment.length;

    // Find the declaration after the comment
    const afterDoc = content.slice(docEnd);
    const declarationMatch = afterDoc.match(/^\s*(export\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\s+(\w+)/);

    if (declarationMatch) {
      const [fullMatch, exportKw, asyncKw, kind, name] = declarationMatch;
      const isExported = !!exportKw;

      // Find line number
      const beforeDoc = content.slice(0, match.index);
      const lineNum = beforeDoc.split('\n').length;

      // Parse the JSDoc
      const doc = parseJSDoc(docComment);

      // Extract signature for functions
      let signature = null;
      if (kind === 'function' || (kind === 'const' && afterDoc.includes('=>'))) {
        signature = extractSignature(afterDoc, kind);
      }

      entries.push({
        name,
        kind: normalizeKind(kind),
        description: doc.description,
        params: doc.params,
        returns: doc.returns,
        returnType: doc.returnType,
        throws: doc.throws,
        examples: doc.examples,
        deprecated: doc.deprecated,
        deprecatedMsg: doc.deprecatedMsg,
        isPrivate: doc.isPrivate,
        isExported,
        signature,
        line: lineNum
      });
    }
  }

  // Also find exported functions/classes without JSDoc (just signature)
  const exportPattern = /^(export\s+)?(async\s+)?(function|class|interface|type)\s+(\w+)/gm;
  while ((match = exportPattern.exec(content)) !== null) {
    const [, exportKw, , kind, name] = match;

    // Skip if we already have docs for this
    if (entries.some(e => e.name === name)) continue;

    const lineNum = content.slice(0, match.index).split('\n').length;

    entries.push({
      name,
      kind: normalizeKind(kind),
      description: null,
      params: [],
      returns: null,
      isExported: !!exportKw,
      signature: null,
      line: lineNum
    });
  }

  return entries;
}

function extractSignature(code, kind) {
  // Extract function signature (params and return type)
  if (kind === 'function') {
    const sigMatch = code.match(/function\s+\w+\s*(<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/);
    if (sigMatch) {
      const generics = sigMatch[1] || '';
      const params = sigMatch[2].trim();
      const returnType = sigMatch[3] || 'void';
      return `${generics}(${params}): ${returnType}`;
    }
  } else if (kind === 'const') {
    // Arrow function: const foo = (params): Type =>
    const arrowMatch = code.match(/const\s+\w+\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([^\s=]+))?\s*=>/);
    if (arrowMatch) {
      const generics = arrowMatch[1] || '';
      const params = arrowMatch[2].trim();
      const returnType = arrowMatch[3] || 'void';
      return `${generics}(${params}): ${returnType}`;
    }
  }
  return null;
}

function normalizeKind(kind) {
  const map = {
    'function': 'function',
    'const': 'function',
    'let': 'variable',
    'var': 'variable',
    'class': 'class',
    'interface': 'interface',
    'type': 'type',
    'enum': 'enum'
  };
  return map[kind] || kind;
}

// ─────────────────────────────────────────────────────────────
// Python Docstring Extractor
// ─────────────────────────────────────────────────────────────

function extractPythonDocs(content, filePath) {
  const entries = [];

  // Match function/class definitions with docstrings
  const defPattern = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\s:]+))?\s*:\s*\n\s*("""[\s\S]*?"""|'''[\s\S]*?''')/gm;

  let match;
  while ((match = defPattern.exec(content)) !== null) {
    const [, isAsync, name, params, returnType, docstring] = match;
    const lineNum = content.slice(0, match.index).split('\n').length;

    const doc = parsePythonDocstring(docstring);

    entries.push({
      name,
      kind: 'function',
      description: doc.description,
      params: doc.params,
      returns: doc.returns,
      returnType: returnType || null,
      throws: doc.raises,
      examples: doc.examples,
      isExported: !name.startsWith('_'),
      isPrivate: name.startsWith('_'),
      signature: `(${params})${returnType ? ' -> ' + returnType : ''}`,
      line: lineNum
    });
  }

  // Match class definitions
  const classPattern = /^class\s+(\w+)(?:\([^)]*\))?\s*:\s*\n\s*("""[\s\S]*?"""|'''[\s\S]*?''')/gm;

  while ((match = classPattern.exec(content)) !== null) {
    const [, name, docstring] = match;
    const lineNum = content.slice(0, match.index).split('\n').length;

    const doc = parsePythonDocstring(docstring);

    entries.push({
      name,
      kind: 'class',
      description: doc.description,
      params: doc.params, // For __init__ params documented in class docstring
      isExported: !name.startsWith('_'),
      isPrivate: name.startsWith('_'),
      line: lineNum
    });
  }

  return entries;
}

function parsePythonDocstring(docstring) {
  const doc = {
    description: '',
    params: [],
    returns: null,
    raises: [],
    examples: []
  };

  // Remove quotes
  const content = docstring.slice(3, -3).trim();
  const lines = content.split('\n');

  let section = 'description';
  let descLines = [];
  let currentParam = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for section headers (Google style)
    if (/^(Args|Arguments|Parameters):$/i.test(trimmed)) {
      if (descLines.length) doc.description = descLines.join(' ').trim();
      section = 'params';
      continue;
    }
    if (/^(Returns?|Yields?):$/i.test(trimmed)) {
      section = 'returns';
      continue;
    }
    if (/^(Raises?|Throws?|Exceptions?):$/i.test(trimmed)) {
      section = 'raises';
      continue;
    }
    if (/^(Examples?):$/i.test(trimmed)) {
      section = 'examples';
      continue;
    }

    // Process based on section
    if (section === 'description') {
      descLines.push(trimmed);
    } else if (section === 'params') {
      // param_name (type): description
      const paramMatch = trimmed.match(/^(\w+)(?:\s*\(([^)]+)\))?\s*:\s*(.*)$/);
      if (paramMatch) {
        doc.params.push({
          name: paramMatch[1],
          type: paramMatch[2] || null,
          description: paramMatch[3]
        });
      }
    } else if (section === 'returns') {
      if (trimmed) doc.returns = (doc.returns ? doc.returns + ' ' : '') + trimmed;
    } else if (section === 'raises') {
      if (trimmed) doc.raises.push(trimmed);
    } else if (section === 'examples') {
      doc.examples.push(trimmed);
    }
  }

  if (descLines.length && !doc.description) {
    doc.description = descLines.join(' ').trim();
  }

  return doc;
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function formatCompact(entries, options = {}) {
  const lines = [];

  for (const entry of entries) {
    // Skip if no description and no params
    if (!entry.description && entry.params?.length === 0 && !options.withSignature) {
      continue;
    }

    let header = `  ${entry.name}`;
    if (entry.signature && options.withSignature) {
      header += entry.signature;
    } else if (entry.params?.length > 0) {
      header += `(${entry.params.map(p => p.name).join(', ')})`;
    } else if (entry.kind === 'function') {
      header += '()';
    }

    if (entry.deprecated) {
      header += ' ⚠️ DEPRECATED';
    }

    lines.push(header);

    if (entry.description) {
      // Truncate long descriptions
      const desc = entry.description.length > 100
        ? entry.description.slice(0, 100) + '...'
        : entry.description;
      lines.push(`    ${desc}`);
    }

    // Show params briefly
    if (entry.params?.length > 0) {
      for (const param of entry.params) {
        let paramLine = `    @param ${param.name}`;
        if (param.type) paramLine += `: ${param.type}`;
        if (param.description) paramLine += ` - ${param.description.slice(0, 60)}`;
        if (param.optional) paramLine += ' (optional)';
        lines.push(paramLine);
      }
    }

    // Show returns
    if (entry.returns || entry.returnType) {
      let returnLine = '    @returns';
      if (entry.returnType) returnLine += ` ${entry.returnType}`;
      if (entry.returns) returnLine += ` - ${entry.returns.slice(0, 60)}`;
      lines.push(returnLine);
    }

    // Show throws
    if (entry.throws?.length > 0) {
      for (const t of entry.throws.slice(0, 2)) {
        lines.push(`    @throws ${t.slice(0, 60)}`);
      }
    }

    lines.push('');
  }

  return lines;
}

function formatDetailed(entries, options = {}) {
  const lines = [];

  for (const entry of entries) {
    const kindIcon = {
      'function': '𝑓',
      'class': '𝐶',
      'interface': '𝐼',
      'type': '𝑇',
      'method': '𝑚',
      'enum': '𝐸'
    }[entry.kind] || '•';

    lines.push(`┌─ ${kindIcon} ${entry.name}`);

    if (entry.signature) {
      lines.push(`│  Signature: ${entry.signature}`);
    }

    if (entry.deprecated) {
      lines.push(`│  ⚠️ DEPRECATED${entry.deprecatedMsg ? ': ' + entry.deprecatedMsg : ''}`);
    }

    if (entry.description) {
      lines.push('│');
      // Wrap long descriptions
      const words = entry.description.split(' ');
      let line = '│  ';
      for (const word of words) {
        if (line.length + word.length > 80) {
          lines.push(line);
          line = '│  ' + word + ' ';
        } else {
          line += word + ' ';
        }
      }
      if (line.trim() !== '│') lines.push(line.trimEnd());
    }

    if (entry.params?.length > 0) {
      lines.push('│');
      lines.push('│  Parameters:');
      for (const param of entry.params) {
        let paramLine = `│    ${param.name}`;
        if (param.type) paramLine += ` (${param.type})`;
        if (param.optional) paramLine += ' [optional]';
        lines.push(paramLine);
        if (param.description) {
          lines.push(`│      ${param.description}`);
        }
      }
    }

    if (entry.returns || entry.returnType) {
      lines.push('│');
      lines.push(`│  Returns: ${entry.returnType || 'unknown'}`);
      if (entry.returns) {
        lines.push(`│    ${entry.returns}`);
      }
    }

    if (entry.throws?.length > 0) {
      lines.push('│');
      lines.push('│  Throws:');
      for (const t of entry.throws) {
        lines.push(`│    - ${t}`);
      }
    }

    if (options.withExamples && entry.examples?.length > 0) {
      lines.push('│');
      lines.push('│  Example:');
      for (const ex of entry.examples) {
        for (const exLine of ex.split('\n')) {
          lines.push(`│    ${exLine}`);
        }
      }
    }

    lines.push('└─');
    lines.push('');
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let targetPath = '.';
let exportsOnly = false;
let withExamples = false;
let withSignature = false;
let noPrivate = false;
let format = 'compact';
let forceLang = null;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--exports-only') {
    exportsOnly = true;
  } else if (arg === '--with-examples') {
    withExamples = true;
  } else if (arg === '--with-signature') {
    withSignature = true;
  } else if (arg === '--no-private') {
    noPrivate = true;
  } else if (arg === '--format' && options.remaining[i + 1]) {
    format = options.remaining[++i];
  } else if (arg === '--lang' && options.remaining[i + 1]) {
    forceLang = options.remaining[++i];
  } else if (!arg.startsWith('-')) {
    targetPath = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Get files to process
let files = [];
if (statSync(targetPath).isFile()) {
  files = [{ path: targetPath }];
} else {
  const allFiles = listFiles(targetPath);
  files = allFiles.filter(f => {
    const ext = extname(f.path);
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py'].includes(ext);
  });
}

if (files.length === 0) {
  console.error('No supported files found');
  process.exit(1);
}

// Process files
const allDocs = [];
let totalEntries = 0;

for (const file of files) {
  const ext = extname(file.path);
  const content = readFileSync(file.path, 'utf-8');

  let entries = [];
  const lang = forceLang || (ext === '.py' ? 'py' : 'ts');

  if (lang === 'py') {
    entries = extractPythonDocs(content, file.path);
  } else {
    entries = extractTSDocs(content, file.path);
  }

  // Filter
  if (exportsOnly) {
    entries = entries.filter(e => e.isExported);
  }
  if (noPrivate) {
    entries = entries.filter(e => !e.isPrivate);
  }

  if (entries.length > 0) {
    allDocs.push({
      file: relative(projectRoot, file.path),
      entries
    });
    totalEntries += entries.length;
  }
}

// Output
if (totalEntries === 0) {
  out.header('No documented items found');
  out.print();
  process.exit(0);
}

out.header(`📖 Documentation (${totalEntries} items)`);
out.blank();

const formatOptions = { withExamples, withSignature };

for (const doc of allDocs) {
  out.add(`📄 ${doc.file}`);
  out.blank();

  const formatted = format === 'detailed'
    ? formatDetailed(doc.entries, formatOptions)
    : formatCompact(doc.entries, formatOptions);

  out.addLines(formatted);
}

// JSON data
out.setData('files', allDocs.map(d => d.file));
out.setData('entries', allDocs.flatMap(d => d.entries.map(e => ({ ...e, file: d.file }))));
out.setData('summary', {
  files: allDocs.length,
  entries: totalEntries,
  byKind: allDocs.flatMap(d => d.entries).reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] || 0) + 1;
    return acc;
  }, {})
});

out.print();
