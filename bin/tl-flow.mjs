#!/usr/bin/env node

/**
 * tl-flow - Show call graph for a function
 *
 * Traces what calls a function and what it calls.
 * Helps understand code paths without reading entire files.
 *
 * Usage: tl-flow <function-name> [file]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-flow',
    desc: 'Call graph: what calls this, what it calls',
    when: 'before-read',
    example: 'tl-flow handleSubmit'
  }));
  process.exit(0);
}

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, relative, resolve, extname } from 'path';
import {
  createOutput,
  parseCommonArgs,
  shellEscape,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-flow - Show call graph for a function

Usage: tl-flow <function-name> [options]

Options:
  --file, -f <file>     Limit search to specific file
  --depth N, -d N       Max depth for call tree (default: 2)
  --callers             Show only what calls this function
  --callees             Show only what this function calls
${COMMON_OPTIONS_HELP}

Examples:
  tl-flow handleSubmit           # Find handleSubmit and trace calls
  tl-flow loadConfig -f src/     # Search only in src/
  tl-flow parseArgs --callers    # Only show what calls parseArgs
  tl-flow render --depth 3       # Deeper call tree
`;

// ─────────────────────────────────────────────────────────────
// Function Finding
// ─────────────────────────────────────────────────────────────

function findFunctionDefinitions(name, projectRoot, limitPath) {
  const searchPath = limitPath || projectRoot;
  const definitions = [];

  try {
    // Pattern to find function definitions
    const patterns = [
      `function ${name}\\s*\\(`,           // function name(
      `(const|let|var)\\s+${name}\\s*=`,   // const name =
      `${name}\\s*:\\s*\\(`,               // name: ( (object method)
      `${name}\\s*\\([^)]*\\)\\s*\\{`,     // name() { (class method)
      `async\\s+${name}\\s*\\(`,           // async name(
    ];

    const pattern = `(${patterns.join('|')})`;
    const cmd = `rg -n -g "*.{ts,tsx,js,jsx,mjs}" --no-heading -e "${shellEscape(pattern)}" "${shellEscape(searchPath)}" 2>/dev/null || true`;

    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [, file, lineNum, content] = match;
      if (file.includes('node_modules')) continue;
      if (file.includes('.test.') || file.includes('.spec.')) continue;

      definitions.push({
        file,
        line: parseInt(lineNum, 10),
        content: content.trim()
      });
    }
  } catch (e) {
    // rg error
  }

  return definitions;
}

function findCallers(name, projectRoot, excludeFile) {
  const callers = [];

  try {
    // Find calls to the function
    const pattern = `${name}\\s*\\(`;
    const cmd = `rg -n -g "*.{ts,tsx,js,jsx,mjs}" --no-heading -e "${shellEscape(pattern)}" "${shellEscape(projectRoot)}" 2>/dev/null || true`;

    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });

    for (const line of result.trim().split('\n')) {
      if (!line) continue;
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [, file, lineNum, content] = match;
      if (file.includes('node_modules')) continue;

      // Skip the definition itself
      if (content.includes(`function ${name}`) ||
          content.includes(`const ${name}`) ||
          content.includes(`let ${name}`) ||
          content.includes(`var ${name}`)) {
        continue;
      }

      // Find which function contains this call
      const containingFn = findContainingFunction(file, parseInt(lineNum, 10));

      callers.push({
        file,
        line: parseInt(lineNum, 10),
        content: content.trim(),
        caller: containingFn
      });
    }
  } catch (e) {
    // rg error
  }

  // Dedupe by file+caller
  const seen = new Set();
  return callers.filter(c => {
    const key = `${c.file}:${c.caller || 'top'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findContainingFunction(file, lineNum) {
  try {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    // Look backwards for function definition
    for (let i = lineNum - 1; i >= 0; i--) {
      const line = lines[i];

      // Match function definitions
      const fnMatch = line.match(/(?:function|async function)\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*\([^)]*\)\s*\{/);
      if (fnMatch) {
        return fnMatch[1] || fnMatch[2] || fnMatch[3];
      }

      // Match class method
      const methodMatch = line.match(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
      if (methodMatch && !line.includes('if') && !line.includes('while') && !line.includes('for')) {
        return methodMatch[1];
      }
    }
  } catch (e) {
    // Can't read file
  }

  return null;
}

function findCallees(file, fnName, lineNum) {
  const callees = [];

  try {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    // Find the function body
    let braceCount = 0;
    let inFunction = false;
    let startLine = lineNum - 1;

    // Find start of function
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      if (!inFunction && line.includes('{')) {
        inFunction = true;
      }

      if (inFunction) {
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;

        // Find function calls in this line
        const callMatches = line.matchAll(/(\w+)\s*\(/g);
        for (const match of callMatches) {
          const callee = match[1];
          // Skip common keywords
          if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new'].includes(callee)) {
            continue;
          }
          // Skip the function's own name (recursion is fine but don't list as primary callee)
          if (callee === fnName) continue;

          if (!callees.includes(callee)) {
            callees.push(callee);
          }
        }

        if (braceCount === 0) break;
      }
    }
  } catch (e) {
    // Can't read file
  }

  return callees;
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

// Parse tool-specific options
let targetFile = null;
let depth = 2;
let showCallers = true;
let showCallees = true;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];
  if ((arg === '--file' || arg === '-f') && options.remaining[i + 1]) {
    targetFile = options.remaining[++i];
  } else if ((arg === '--depth' || arg === '-d') && options.remaining[i + 1]) {
    depth = parseInt(options.remaining[++i], 10);
  } else if (arg === '--callers') {
    showCallees = false;
  } else if (arg === '--callees') {
    showCallers = false;
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const fnName = remaining[0];

if (!fnName) {
  console.log(HELP);
  process.exit(1);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

out.header(`\n🔀 Call flow: ${fnName}`);

// Find function definitions
const definitions = findFunctionDefinitions(fnName, projectRoot, targetFile);

if (definitions.length === 0) {
  out.add(`\n  No definition found for "${fnName}"`);
  out.print();
  process.exit(0);
}

// Show definitions
out.add('\n📍 Defined in:');
for (const def of definitions.slice(0, 5)) {
  const rel = relative(projectRoot, def.file);
  out.add(`   ${rel}:${def.line}`);
}

// Show callers
if (showCallers) {
  const callers = findCallers(fnName, projectRoot);

  if (callers.length > 0) {
    out.add('\n⬅️  Called by:');
    for (const caller of callers.slice(0, 10)) {
      const rel = relative(projectRoot, caller.file);
      const from = caller.caller ? ` (in ${caller.caller})` : '';
      out.add(`   ${rel}:${caller.line}${from}`);
    }
    if (callers.length > 10) {
      out.add(`   ... and ${callers.length - 10} more`);
    }
  } else {
    out.add('\n⬅️  Called by: (no callers found)');
  }
}

// Show callees
if (showCallees && definitions.length > 0) {
  const def = definitions[0];
  const callees = findCallees(def.file, fnName, def.line);

  if (callees.length > 0) {
    out.add('\n➡️  Calls:');
    out.add(`   ${callees.slice(0, 15).join(', ')}`);
    if (callees.length > 15) {
      out.add(`   ... and ${callees.length - 15} more`);
    }
  } else {
    out.add('\n➡️  Calls: (no function calls found)');
  }
}

out.add('');
out.print();
