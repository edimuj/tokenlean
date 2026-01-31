#!/usr/bin/env node

/**
 * tl-types - Extract TypeScript types, interfaces, and enums with full definitions
 *
 * Unlike tl-symbols (which shows signatures only), this extracts complete type
 * definitions including all properties. Perfect for understanding data shapes
 * without reading implementation code.
 *
 * Usage: tl-types <file-or-dir> [--exports-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-types',
    desc: 'Extract full TypeScript type definitions',
    when: 'before-read',
    example: 'tl-types src/types/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip } from '../src/project.mjs';

const HELP = `
tl-types - Extract TypeScript types, interfaces, and enums with full definitions

Usage: tl-types <file-or-dir> [options]

Options:
  --exports-only, -e    Show only exported types
  --no-comments         Strip comments from type definitions
  --flat                Don't show file headers (for single output)
${COMMON_OPTIONS_HELP}

Examples:
  tl-types src/types.ts           # All types from file
  tl-types src/types/             # All types from directory
  tl-types src/ -e                # Exported types only
  tl-types src/api.ts -l 50       # Limit to 50 lines
  tl-types src/ -j                # JSON output

Extracts:
  - interface definitions (with all properties)
  - type aliases (full definition)
  - enum definitions (with all values)
  - Generic type parameters
`;

// ─────────────────────────────────────────────────────────────
// TypeScript Type Extraction
// ─────────────────────────────────────────────────────────────

function extractTypes(content, options = {}) {
  const { exportsOnly = false, stripComments = false } = options;
  const types = {
    interfaces: [],
    typeAliases: [],
    enums: []
  };

  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip if exports only and not exported
    const isExported = trimmed.startsWith('export ');
    if (exportsOnly && !isExported) {
      i++;
      continue;
    }

    // Interface
    const interfaceMatch = trimmed.match(/^(export\s+)?(interface)\s+(\w+)(\s*<[^>]+>)?(\s+extends\s+[^{]+)?/);
    if (interfaceMatch) {
      const extracted = extractBlock(lines, i, stripComments);
      types.interfaces.push({
        name: interfaceMatch[3],
        exported: !!interfaceMatch[1],
        definition: extracted.content
      });
      i = extracted.endLine + 1;
      continue;
    }

    // Type alias
    const typeMatch = trimmed.match(/^(export\s+)?type\s+(\w+)(\s*<[^>]+>)?\s*=/);
    if (typeMatch) {
      const extracted = extractTypeAlias(lines, i, stripComments);
      types.typeAliases.push({
        name: typeMatch[2],
        exported: !!typeMatch[1],
        definition: extracted.content
      });
      i = extracted.endLine + 1;
      continue;
    }

    // Enum
    const enumMatch = trimmed.match(/^(export\s+)?(const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      const extracted = extractBlock(lines, i, stripComments);
      types.enums.push({
        name: enumMatch[3],
        exported: !!enumMatch[1],
        isConst: !!enumMatch[2],
        definition: extracted.content
      });
      i = extracted.endLine + 1;
      continue;
    }

    i++;
  }

  return types;
}

function extractBlock(lines, startLine, stripComments) {
  let content = [];
  let braceDepth = 0;
  let started = false;
  let i = startLine;

  // Collect leading comments if not stripping
  if (!stripComments) {
    let commentStart = startLine;
    while (commentStart > 0) {
      const prevLine = lines[commentStart - 1].trim();
      if (prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/*') || prevLine === '*/') {
        commentStart--;
      } else if (prevLine === '') {
        // Check if there's a comment block above the empty line
        if (commentStart > 1 && lines[commentStart - 2].trim().startsWith('*/')) {
          commentStart--;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    // Add comments
    for (let j = commentStart; j < startLine; j++) {
      content.push(lines[j]);
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments if stripping
    if (stripComments && (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))) {
      i++;
      continue;
    }

    content.push(line);

    // Count braces
    for (const char of line) {
      if (char === '{') {
        braceDepth++;
        started = true;
      } else if (char === '}') {
        braceDepth--;
      }
    }

    // End when we close the opening brace
    if (started && braceDepth === 0) {
      break;
    }

    i++;
  }

  return {
    content: content.join('\n'),
    endLine: i
  };
}

function extractTypeAlias(lines, startLine, stripComments) {
  let content = [];
  let i = startLine;
  let braceDepth = 0;
  let parenDepth = 0;
  let angleBracketDepth = 0;

  // Collect leading comments if not stripping
  if (!stripComments) {
    let commentStart = startLine;
    while (commentStart > 0) {
      const prevLine = lines[commentStart - 1].trim();
      if (prevLine.startsWith('//') || prevLine.startsWith('*') || prevLine.startsWith('/*') || prevLine === '*/') {
        commentStart--;
      } else if (prevLine === '') {
        if (commentStart > 1 && lines[commentStart - 2].trim().startsWith('*/')) {
          commentStart--;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    for (let j = commentStart; j < startLine; j++) {
      content.push(lines[j]);
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments if stripping
    if (stripComments && (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))) {
      i++;
      continue;
    }

    content.push(line);

    // Track nesting
    for (const char of line) {
      if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;
      else if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;
      else if (char === '<') angleBracketDepth++;
      else if (char === '>') angleBracketDepth--;
    }

    // Type alias ends with semicolon or newline when all brackets closed
    if (braceDepth === 0 && parenDepth === 0 && angleBracketDepth <= 0) {
      if (trimmed.endsWith(';') || trimmed.endsWith('}') || trimmed.endsWith(')') || trimmed.endsWith('>')) {
        break;
      }
      // Check if next line is a new statement
      if (i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        if (nextTrimmed.startsWith('export ') || nextTrimmed.startsWith('interface ') ||
            nextTrimmed.startsWith('type ') || nextTrimmed.startsWith('enum ') ||
            nextTrimmed.startsWith('const ') || nextTrimmed.startsWith('function ') ||
            nextTrimmed.startsWith('class ') || nextTrimmed === '') {
          break;
        }
      }
    }

    i++;
  }

  return {
    content: content.join('\n'),
    endLine: i
  };
}

// ─────────────────────────────────────────────────────────────
// File Discovery
// ─────────────────────────────────────────────────────────────

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

function isTypeScriptFile(filePath) {
  return TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function findTypeScriptFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        findTypeScriptFiles(fullPath, files);
      }
    } else if (entry.isFile() && isTypeScriptFile(entry.name)) {
      if (!shouldSkip(entry.name, false)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

function formatTypes(types, out, showFileHeader = true, filePath = '') {
  const hasContent = types.interfaces.length > 0 ||
                     types.typeAliases.length > 0 ||
                     types.enums.length > 0;

  if (!hasContent) return 0;

  let count = 0;

  if (types.interfaces.length > 0) {
    if (!showFileHeader) out.add('// Interfaces');
    for (const iface of types.interfaces) {
      out.add(iface.definition);
      out.blank();
      count++;
    }
  }

  if (types.typeAliases.length > 0) {
    if (!showFileHeader) out.add('// Type Aliases');
    for (const alias of types.typeAliases) {
      out.add(alias.definition);
      out.blank();
      count++;
    }
  }

  if (types.enums.length > 0) {
    if (!showFileHeader) out.add('// Enums');
    for (const enumDef of types.enums) {
      out.add(enumDef.definition);
      out.blank();
      count++;
    }
  }

  return count;
}

function countTypes(types) {
  return types.interfaces.length + types.typeAliases.length + types.enums.length;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const exportsOnly = options.remaining.includes('--exports-only') || options.remaining.includes('-e');
const stripComments = options.remaining.includes('--no-comments');
const flat = options.remaining.includes('--flat');
const targetPath = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !targetPath) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

if (!existsSync(targetPath)) {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);
const allTypes = [];
let totalTypes = 0;
let totalTokens = 0;

const stat = statSync(targetPath);
const files = stat.isDirectory()
  ? findTypeScriptFiles(targetPath)
  : isTypeScriptFile(targetPath) ? [targetPath] : [];

if (files.length === 0) {
  console.error('No TypeScript files found');
  process.exit(1);
}

const showFileHeaders = files.length > 1 && !flat;

for (const filePath of files) {
  const content = readFileSync(filePath, 'utf-8');
  const types = extractTypes(content, { exportsOnly, stripComments });
  const count = countTypes(types);

  if (count === 0) continue;

  const relPath = relative(projectRoot, filePath);
  totalTypes += count;

  // Add file header
  if (showFileHeaders) {
    out.add(`// ═══════════════════════════════════════════════════════════`);
    out.add(`// ${relPath} (${count} types)`);
    out.add(`// ═══════════════════════════════════════════════════════════`);
    out.blank();
  }

  formatTypes(types, out, showFileHeaders, filePath);

  // Collect for JSON
  allTypes.push({
    file: relPath,
    ...types
  });
}

// Calculate token savings
const outputText = out.render();
totalTokens = estimateTokens(outputText);

// For comparison, estimate full file tokens
let fullFileTokens = 0;
for (const filePath of files) {
  fullFileTokens += estimateTokens(readFileSync(filePath, 'utf-8'));
}

// Set JSON data
out.setData('files', allTypes);
out.setData('totalTypes', totalTypes);
out.setData('totalTokens', totalTokens);
out.setData('fullFileTokens', fullFileTokens);

// Add summary
if (!options.quiet && totalTypes > 0) {
  out.add(`// ───────────────────────────────────────────────────────────`);
  out.add(`// Summary: ${totalTypes} types from ${files.length} file(s)`);
  out.add(`// Tokens: ~${formatTokens(totalTokens)} (full files: ~${formatTokens(fullFileTokens)})`);
}

out.print();
