#!/usr/bin/env node

/**
 * tl-scope - Show what's in scope at a given line
 *
 * Walks the file top-down, tracking nested scopes (module, class, function,
 * block). At the target line, reports every symbol visible: imports, enclosing
 * function params, local declarations, and class members.
 *
 * Usage: tl-scope <file:line> [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-scope',
    desc: 'Show what symbols are in scope at a given line',
    when: 'before-read',
    example: 'tl-scope src/cache.mjs:52'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import { resolve, relative, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-scope - Show what's in scope at a given line

Usage: tl-scope <file:line> [options]

Shows all symbols visible at a specific line: imports, parameters, local
variables, and class members. Helps understand context without reading
the entire file.

${COMMON_OPTIONS_HELP}

Examples:
  tl-scope src/cache.mjs:52          # What's in scope at line 52
  tl-scope src/output.mjs:118        # Inside a class method
  tl-scope src/output.mjs:1 -j       # JSON output
  tl-scope src/cache.mjs:52 -q       # Just symbol names
`;

const JS_TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts']);

// ─────────────────────────────────────────────────────────────
// Brace Counting (adapted from tl-snippet.mjs)
// ─────────────────────────────────────────────────────────────

/**
 * Count net braces in a line, ignoring those inside strings, template
 * literals, regex, and comments.
 */
function countBraces(line) {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    // Skip escaped characters
    if (prev === '\\') continue;

    if (inLineComment) break;

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && line[i + 1] === '/') { inLineComment = true; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '`') { inTemplate = true; continue; }
      if (ch === '{') open++;
      if (ch === '}') close++;
    } else if (inSingle && ch === "'") {
      inSingle = false;
    } else if (inDouble && ch === '"') {
      inDouble = false;
    } else if (inTemplate && ch === '`') {
      inTemplate = false;
    }
  }

  return { open, close };
}

// ─────────────────────────────────────────────────────────────
// Import Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Extract import statements and the bound names they introduce into scope.
 */
function extractImports(lines, targetLine) {
  const imports = [];
  let inMultiLine = false;
  let multiLineBuffer = '';
  let multiLineStart = 0;

  for (let i = 0; i < lines.length && i < targetLine; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    if (inMultiLine) {
      multiLineBuffer += ' ' + trimmed;
      if (trimmed.includes("'") || trimmed.includes('"')) {
        const fromMatch = multiLineBuffer.match(/from\s*['"]([^'"]+)['"]/);
        if (fromMatch) {
          const names = extractBoundNames(multiLineBuffer);
          if (names.length > 0) {
            imports.push({ names, source: fromMatch[1], line: multiLineStart + 1 });
          }
          inMultiLine = false;
          multiLineBuffer = '';
        }
      }
      continue;
    }

    // ES import
    if (trimmed.startsWith('import ')) {
      // Check if complete on one line
      const fromMatch = trimmed.match(/from\s*['"]([^'"]+)['"]/);
      if (fromMatch) {
        const names = extractBoundNames(trimmed);
        if (names.length > 0) {
          imports.push({ names, source: fromMatch[1], line: i + 1 });
        }
        continue;
      }

      // Side-effect import: import 'x'
      const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
      if (sideEffect) continue;

      // Multi-line import starting
      inMultiLine = true;
      multiLineBuffer = trimmed;
      multiLineStart = i;
      continue;
    }

    // CommonJS: const { a, b } = require('x')
    const requireMatch = trimmed.match(/(?:const|let|var)\s+(.+?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      const binding = requireMatch[1].trim();
      const source = requireMatch[2];
      const names = extractDestructuredNames(binding);
      if (names.length > 0) {
        imports.push({ names, source, line: i + 1 });
      }
    }
  }

  return imports;
}

/**
 * Extract bound names from an import statement.
 * import { a, b as c } from 'x'  → ['a', 'c']
 * import d from 'x'              → ['d']
 * import * as e from 'x'         → ['e']
 * import d, { a, b } from 'x'   → ['d', 'a', 'b']
 */
function extractBoundNames(stmt) {
  const names = [];

  // Remove 'import type' prefix (TS type-only imports don't enter runtime scope
  // but are still useful for scope understanding)
  let s = stmt.replace(/^import\s+type\s+/, 'import ');
  // Remove everything from 'from' onward
  s = s.replace(/\s+from\s+.*$/, '');
  // Remove 'import' keyword
  s = s.replace(/^import\s+/, '');

  if (!s) return names;

  // Handle * as name
  const starMatch = s.match(/\*\s+as\s+(\w+)/);
  if (starMatch) {
    names.push(starMatch[1]);
    s = s.replace(/\*\s+as\s+\w+\s*,?\s*/, '');
  }

  // Handle default import (identifier before {)
  const defaultMatch = s.match(/^(\w+)\s*[,{]/);
  if (defaultMatch) {
    names.push(defaultMatch[1]);
    s = s.replace(/^\w+\s*,?\s*/, '');
  } else if (/^\w+$/.test(s.trim())) {
    // Sole default import
    names.push(s.trim());
    return names;
  }

  // Handle destructured names { a, b as c, type d }
  const braceMatch = s.match(/\{([^}]*)\}/);
  if (braceMatch) {
    const inner = braceMatch[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Skip type-only imports inside braces: type Foo
      if (trimmed.startsWith('type ')) continue;
      // 'a as b' → use 'b'
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      if (asMatch) {
        names.push(asMatch[1]);
      } else {
        const word = trimmed.match(/^(\w+)/);
        if (word) names.push(word[1]);
      }
    }
  }

  return names;
}

/**
 * Extract names from a destructured require binding.
 * '{ a, b }' → ['a', 'b']
 * 'name'     → ['name']
 */
function extractDestructuredNames(binding) {
  const braceMatch = binding.match(/\{([^}]*)\}/);
  if (braceMatch) {
    return braceMatch[1].split(',')
      .map(s => s.trim().split(':')[0].trim())
      .filter(Boolean);
  }
  const word = binding.match(/^(\w+)/);
  return word ? [word[1]] : [];
}

// ─────────────────────────────────────────────────────────────
// Parameter Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Extract parameters from a function/method signature.
 * Handles destructured params, defaults with nested parens.
 */
function extractParams(signatureLines) {
  const sig = signatureLines.join(' ');

  // Find the parameter list between ( and )
  const startIdx = sig.indexOf('(');
  if (startIdx === -1) return [];

  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  if (endIdx === -1) return [];

  const paramStr = sig.substring(startIdx + 1, endIdx).trim();
  if (!paramStr) return [];

  // Split on commas, respecting nesting
  const params = [];
  let current = '';
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;

  for (let i = 0; i < paramStr.length; i++) {
    const ch = paramStr[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') angleDepth--;

    if (ch === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      const p = current.trim();
      if (p) params.push(p);
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) params.push(last);

  // Clean each param: remove type annotations, defaults → keep the name/pattern
  return params.map(p => {
    // Strip TS type annotation (but not from destructured)
    // For simple params: 'name: Type = default' → 'name'
    // For destructured: '{ a, b }: Type' → '{ a, b }'
    // For rest: '...rest: Type[]' → '...rest'
    if (p.startsWith('{') || p.startsWith('[')) {
      // Destructured — find matching brace, strip the rest
      const open = p[0];
      const closeChar = open === '{' ? '}' : ']';
      let d = 0;
      let end = 0;
      for (let i = 0; i < p.length; i++) {
        if (p[i] === open) d++;
        else if (p[i] === closeChar) { d--; if (d === 0) { end = i; break; } }
      }
      return p.substring(0, end + 1);
    }
    if (p.startsWith('...')) {
      const name = p.substring(3).split(/[:\s=]/)[0];
      return '...' + name;
    }
    // Simple param — take just the name
    return p.split(/[:\s=]/)[0];
  });
}

// ─────────────────────────────────────────────────────────────
// Scope Chain Builder
// ─────────────────────────────────────────────────────────────

/**
 * Build scope chain at a target line.
 * Returns the scope stack with all enclosing scopes.
 */
function buildScopeChain(lines, targetLine) {
  const scopeStack = [{
    type: 'module',
    name: null,
    startLine: 1,
    braceDepth: 0,
    params: [],
    locals: [],
    members: []
  }];

  let braceDepth = 0;

  // Scope-opener patterns (adapted from tl-complexity.mjs)
  const funcPatterns = [
    // function name() or async function name()
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/,
    // const name = function() or const name = async function()
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/,
    // const name = () => or const name = async () =>
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/,
    // const name = async param =>
    /^(?:export\s+)?const\s+(\w+)\s*=\s*async\s+\w+\s*=>/,
    // Class method: name() { or async name() { or public name() {
    /^(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,
  ];

  const classPattern = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;
  const blockPatterns = /^(?:if|else if|else|for|while|switch|try|catch)\b/;
  const catchPattern = /^catch\s*\(\s*(\w+)/;

  for (let i = 0; i < targetLine && i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and full-comment lines for scope detection
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      // Still count braces in case of inline code
      const { open, close } = countBraces(line);
      braceDepth += open - close;

      // Pop scopes on close braces
      while (close > 0 && scopeStack.length > 1) {
        const top = scopeStack[scopeStack.length - 1];
        if (braceDepth <= top.braceDepth) {
          scopeStack.pop();
        } else {
          break;
        }
      }
      continue;
    }

    // Detect scope openers before counting braces on this line
    let scopePushed = false;

    // Check class
    const classMatch = trimmed.match(classPattern);
    if (classMatch) {
      scopeStack.push({
        type: 'class',
        name: classMatch[1],
        startLine: lineNum,
        braceDepth,
        params: [],
        locals: [],
        members: []
      });
      scopePushed = true;
    }

    // Check function/method (only if not a class)
    if (!scopePushed) {
      for (const pattern of funcPatterns) {
        const match = trimmed.match(pattern);
        if (match) {
          const funcName = match[1];
          // Skip keywords that look like functions
          if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(funcName)) {
            // Still treat constructor as a method scope
            if (funcName === 'constructor') {
              // Collect signature lines for multi-line params
              const sigLines = collectSignatureLines(lines, i);
              scopeStack.push({
                type: 'method',
                name: 'constructor',
                startLine: lineNum,
                braceDepth,
                params: extractParams(sigLines),
                locals: [],
                members: []
              });
              scopePushed = true;
            }
            break;
          }

          // Determine if method (inside class scope) or function
          const enclosing = scopeStack[scopeStack.length - 1];
          const type = enclosing.type === 'class' ? 'method' : 'function';

          // Collect signature lines for multi-line params
          const sigLines = collectSignatureLines(lines, i);

          scopeStack.push({
            type,
            name: funcName,
            startLine: lineNum,
            braceDepth,
            params: extractParams(sigLines),
            locals: [],
            members: []
          });
          scopePushed = true;
          break;
        }
      }
    }

    // Check block scope openers (if/for/while/etc.)
    if (!scopePushed && blockPatterns.test(trimmed)) {
      const { open } = countBraces(line);
      if (open > 0) {
        // Check for catch parameter
        const catchMatch = trimmed.match(catchPattern);
        const blockLocals = [];
        if (catchMatch) {
          blockLocals.push({ name: catchMatch[1], line: lineNum });
        }

        // Check for for-loop variable: for (const x of/in ...) or for (let i = ...)
        const forVarMatch = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+(\w+)/);
        if (forVarMatch) {
          blockLocals.push({ name: forVarMatch[1], line: lineNum });
        }
        // for-of/in with destructuring: for (const { a, b } of ...)
        const forDestructMatch = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+\{([^}]+)\}/);
        if (forDestructMatch) {
          for (const part of forDestructMatch[1].split(',')) {
            const name = part.trim().split(':')[0].trim();
            if (name) blockLocals.push({ name, line: lineNum });
          }
        }

        scopeStack.push({
          type: 'block',
          name: null,
          startLine: lineNum,
          braceDepth,
          params: [],
          locals: blockLocals,
          members: []
        });
        scopePushed = true;
      }
    }

    // Count braces
    const { open, close } = countBraces(line);
    braceDepth += open - close;

    // Pop scopes when braces close back to scope level
    for (let s = scopeStack.length - 1; s > 0; s--) {
      if (braceDepth <= scopeStack[s].braceDepth) {
        scopeStack.splice(s, 1);
      }
    }

    // Track declarations in current scope (only above targetLine)
    if (lineNum < targetLine) {
      trackDeclarations(trimmed, lineNum, scopeStack);
    }
  }

  return scopeStack;
}

/**
 * Collect up to 5 lines starting from startIdx for multi-line signatures.
 */
function collectSignatureLines(lines, startIdx) {
  const result = [];
  for (let i = startIdx; i < Math.min(startIdx + 5, lines.length); i++) {
    result.push(lines[i]);
    if (lines[i].includes('{')) break;
  }
  return result;
}

/**
 * Track const/let/var declarations and class members.
 */
function trackDeclarations(trimmed, lineNum, scopeStack) {
  const currentScope = scopeStack[scopeStack.length - 1];

  // Class members (when inside a class scope)
  const classScope = scopeStack.find(s => s.type === 'class');
  if (classScope) {
    // Only track members at class body level (not inside methods)
    const directClassChild = scopeStack[scopeStack.length - 1].type === 'class';
    if (directClassChild) {
      // Property: public/private/protected/static/readonly name;/:/=
      const memberMatch = trimmed.match(
        /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?(?:declare\s+)?(\w+)\s*[;:=]/
      );
      if (memberMatch) {
        const name = memberMatch[1];
        // Skip keywords and method-like things
        if (!['constructor', 'get', 'set', 'static', 'async', 'return', 'if', 'for', 'while', 'const', 'let', 'var'].includes(name)) {
          if (!classScope.members.includes(name)) {
            classScope.members.push(name);
          }
        }
      }
    }
  }

  // Variable declarations: const/let/var
  const declMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(.+?)(?:\s*[:=;])/);
  if (declMatch) {
    const binding = declMatch[1].trim();

    // Destructured: const { a, b } = ... or const [a, b] = ...
    if (binding.startsWith('{') || binding.startsWith('[')) {
      const names = extractDestructuredVarNames(binding);
      for (const name of names) {
        currentScope.locals.push({ name, line: lineNum });
      }
    } else {
      // Simple: const name = ...
      const name = binding.match(/^(\w+)/);
      if (name) {
        currentScope.locals.push({ name: name[1], line: lineNum });
      }
    }
  }
}

/**
 * Extract variable names from destructured bindings.
 * { a, b: c, ...rest } → ['a', 'c', 'rest']
 * [a, , b] → ['a', 'b']
 */
function extractDestructuredVarNames(binding) {
  const names = [];
  // Remove outer braces/brackets
  const inner = binding.replace(/^[{[\s]+|[}\]\s]+$/g, '');
  for (const part of inner.split(',')) {
    let trimmed = part.trim();
    if (!trimmed) continue;
    // Rest pattern: ...name
    if (trimmed.startsWith('...')) {
      const name = trimmed.substring(3).split(/[:\s=]/)[0];
      if (name) names.push(name);
      continue;
    }
    // Renamed: original: renamed
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const after = trimmed.substring(colonIdx + 1).trim();
      // Could be nested destructuring: { a: { b } } — skip those
      if (after.startsWith('{') || after.startsWith('[')) continue;
      const name = after.split(/[\s=]/)[0];
      if (name) names.push(name);
    } else {
      const name = trimmed.split(/[\s=]/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function formatContextChain(scopeStack) {
  return scopeStack.map(s => {
    if (s.type === 'module') return 'module';
    if (s.type === 'class') return `class ${s.name}`;
    if (s.type === 'function') return `${s.name}()`;
    if (s.type === 'method') return `${s.name}()`;
    return null; // skip blocks
  }).filter(Boolean).join(' > ');
}

function findInnermostName(scopeStack) {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    if (scopeStack[i].name) return scopeStack[i].name;
  }
  return null;
}

function formatImports(imports, out, quiet) {
  if (imports.length === 0) return;

  const totalNames = imports.reduce((sum, imp) => sum + imp.names.length, 0);

  if (quiet) {
    for (const imp of imports) {
      for (const name of imp.names) {
        out.add(name);
      }
    }
    return;
  }

  out.add(`Imports (${totalNames}):`);
  for (const imp of imports) {
    const namesStr = imp.names.join(', ');
    out.add(`  ${namesStr}  <- ${imp.source}`);
  }
}

function formatParams(params, out, quiet) {
  if (params.length === 0) return;

  if (quiet) {
    for (const p of params) {
      out.add(p);
    }
    return;
  }

  out.add(`Params:`);
  out.add(`  ${params.join(', ')}`);
}

function formatLocals(allLocals, out, quiet) {
  if (allLocals.length === 0) return;

  if (quiet) {
    for (const loc of allLocals) {
      out.add(loc.name);
    }
    return;
  }

  out.add(`Locals:`);
  for (const loc of allLocals) {
    out.add(`  ${loc.name}  (line ${loc.line})`);
  }
}

function formatMembers(members, className, out, quiet) {
  if (members.length === 0) return;

  if (quiet) {
    for (const m of members) {
      out.add(m);
    }
    return;
  }

  out.add(`Members (${className}):`);
  out.add(`  ${members.join(', ')}`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const remaining = options.remaining.filter(a => !a.startsWith('-'));
const input = remaining[0];

if (!input) {
  console.log(HELP);
  process.exit(1);
}

// Parse file:line
const colonIdx = input.lastIndexOf(':');
if (colonIdx <= 0) {
  console.error('Usage: tl-scope <file:line>');
  console.error('Example: tl-scope src/cache.mjs:52');
  process.exit(1);
}

const filePath = input.substring(0, colonIdx);
const targetLine = parseInt(input.substring(colonIdx + 1), 10);

if (isNaN(targetLine) || targetLine < 1) {
  console.error(`Invalid line number: ${input.substring(colonIdx + 1)}`);
  process.exit(1);
}

const resolvedPath = resolve(filePath);

if (!existsSync(resolvedPath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

// Check extension
const ext = extname(resolvedPath).toLowerCase();
if (!JS_TS_EXTENSIONS.has(ext)) {
  console.error('Scope analysis is currently supported for JavaScript/TypeScript files.');
  process.exit(1);
}

// Read file
let content;
try {
  content = readFileSync(resolvedPath, 'utf-8');
} catch (err) {
  console.error(`Cannot read file: ${err.message}`);
  process.exit(1);
}

const lines = content.split('\n');

if (targetLine > lines.length) {
  console.error(`Line ${targetLine} is out of range (file has ${lines.length} lines)`);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, resolvedPath);
const out = createOutput(options);

// Build scope chain
const scopeStack = buildScopeChain(lines, targetLine);

// Extract imports
const imports = extractImports(lines, targetLine);

// Collect all params from innermost function/method
let params = [];
for (let i = scopeStack.length - 1; i >= 0; i--) {
  if (scopeStack[i].type === 'function' || scopeStack[i].type === 'method') {
    params = scopeStack[i].params;
    break;
  }
}

// Collect all locals from all scopes on the chain (above target line)
const allLocals = [];
const seenLocalNames = new Set();
for (const scope of scopeStack) {
  for (const loc of scope.locals) {
    if (loc.line < targetLine && !seenLocalNames.has(loc.name)) {
      seenLocalNames.add(loc.name);
      allLocals.push(loc);
    }
  }
}

// Collect class members
let members = [];
let className = null;
for (const scope of scopeStack) {
  if (scope.type === 'class') {
    members = scope.members;
    className = scope.name;
    break;
  }
}

// Build context chain
const contextChain = formatContextChain(scopeStack);
const innermostName = findInnermostName(scopeStack);

// Output
if (!options.quiet) {
  const inPart = innermostName ? ` (in ${innermostName})` : '';
  out.add(`Scope at ${relPath}:${targetLine}${inPart}`);
  out.blank();
  out.add(`Context: ${contextChain}`);
  out.blank();
}

formatImports(imports, out, options.quiet);
if (imports.length > 0 && !options.quiet) out.blank();

formatParams(params, out, options.quiet);
if (params.length > 0 && !options.quiet) out.blank();

if (members.length > 0) {
  formatMembers(members, className, out, options.quiet);
  if (!options.quiet) out.blank();
}

formatLocals(allLocals, out, options.quiet);

// JSON data
out.setData('file', relPath);
out.setData('line', targetLine);
out.setData('context', scopeStack.map(s => {
  if (s.type === 'module') return 'module';
  if (s.type === 'class') return `class ${s.name}`;
  if (s.type === 'function') return `${s.name}()`;
  if (s.type === 'method') return `${s.name}()`;
  return `block`;
}).filter(s => s !== 'block'));
out.setData('imports', imports);
out.setData('params', params);
out.setData('locals', allLocals);
out.setData('members', members.length > 0 ? members : null);

out.print();
