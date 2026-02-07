/**
 * Generic language extraction for unsupported file types.
 *
 * Provides "better than nothing" regex-based extraction of symbols
 * and imports for languages that don't have dedicated parsers.
 * Covers Rust, C/C++, Java, Kotlin, Swift, Ruby, C#, PHP, Scala,
 * Elixir, Lua, Zig, Nim, and most brace-based languages.
 */

// ─────────────────────────────────────────────────────────────
// Comment Stripping
// ─────────────────────────────────────────────────────────────

/**
 * Strip comments from source, replacing them with whitespace
 * to preserve line numbers. Handles //, #, --, and /* ... *​/
 */
function stripComments(content) {
  const lines = content.split('\n');
  let inBlock = false;

  return lines.map(line => {
    let result = '';
    let i = 0;

    while (i < line.length) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inBlock = false;
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      // Line comments: //, #, --
      if (line[i] === '/' && line[i + 1] === '/') break;
      if (line[i] === '#' && i === firstNonSpace(line)) break;
      if (line[i] === '-' && line[i + 1] === '-' && i === firstNonSpace(line)) break;

      // Block comment start
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }

      // Skip string contents
      if (line[i] === '"' || line[i] === "'") {
        const quote = line[i];
        result += line[i++];
        while (i < line.length && line[i] !== quote) {
          if (line[i] === '\\') { result += line[i++]; }
          if (i < line.length) result += line[i++];
        }
        if (i < line.length) result += line[i++];
        continue;
      }

      result += line[i++];
    }

    return result;
  }).join('\n');
}

function firstNonSpace(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return i;
  }
  return line.length;
}

// ─────────────────────────────────────────────────────────────
// Generic Symbol Extraction
// ─────────────────────────────────────────────────────────────

// Prefixes that may appear before function/struct/class keywords
const VISIBILITY = '(?:pub(?:\\([^)]*\\))?\\s+|export\\s+|public\\s+|private\\s+|protected\\s+|internal\\s+)?';
const MODIFIERS = '(?:(?:static|async|unsafe|virtual|override|abstract|final|inline|extern|const)\\s+)*';

const FUNC_KW = '(?:fn|func|function|def|sub|proc|fun)';
const CLASS_KW = '(?:class|struct|interface|trait|enum|protocol|record|union)';
const TYPE_KW = '(?:type|typedef|using|newtype|typealias)';
const CONST_KW = '(?:const|static|val|let)';
const MOD_KW = '(?:mod|module|namespace|package)';

/**
 * Extract symbols generically from source code.
 *
 * Returns: { classes: [], functions: [], types: [], constants: [], modules: [] }
 * Classes have shape: { signature, methods: [] }
 * Everything else: string (the signature line)
 */
export function extractGenericSymbols(content) {
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const rawLines = content.split('\n');

  const symbols = {
    classes: [],
    functions: [],
    types: [],
    constants: [],
    modules: []
  };

  let inBlock = null;       // { signature, methods: [], depth: N }
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Count braces on this line
    const openBraces = (trimmed.match(/\{/g) || []).length;
    const closeBraces = (trimmed.match(/\}/g) || []).length;
    const prevDepth = braceDepth;
    braceDepth += openBraces - closeBraces;

    // Check if we're exiting a class/struct/impl block
    if (inBlock && braceDepth <= inBlock.depth && prevDepth > inBlock.depth) {
      symbols.classes.push({
        signature: inBlock.signature,
        methods: inBlock.methods
      });
      inBlock = null;
    }

    // Impl blocks: impl Foo / impl Trait for Foo
    const implMatch = trimmed.match(new RegExp(`^${VISIBILITY}impl\\s+(.+?)\\s*\\{?$`));
    if (implMatch && !inBlock) {
      const sig = sigLine(rawLines[i]);
      inBlock = { signature: sig, methods: [], depth: braceDepth > prevDepth ? prevDepth : braceDepth };
      continue;
    }

    // Class/struct/interface/trait/enum/union
    const classRe = new RegExp(`^${VISIBILITY}${MODIFIERS}${CLASS_KW}\\s+(\\w+)`);
    const classMatch = trimmed.match(classRe);
    if (classMatch && !inBlock) {
      const sig = sigLine(rawLines[i]);
      if (openBraces > 0) {
        inBlock = { signature: sig, methods: [], depth: braceDepth > prevDepth ? prevDepth : braceDepth };
      } else {
        // Could be a forward decl or single-line — add as class with no methods
        symbols.classes.push({ signature: sig, methods: [] });
      }
      continue;
    }

    // Functions / methods
    const funcRe = new RegExp(`^${VISIBILITY}${MODIFIERS}${FUNC_KW}\\s+(\\w+)`);
    const funcMatch = trimmed.match(funcRe);
    if (funcMatch) {
      const sig = sigLine(rawLines[i]);
      if (inBlock && braceDepth > inBlock.depth) {
        inBlock.methods.push(sig);
      } else {
        symbols.functions.push(sig);
      }
      continue;
    }

    // Methods inside a class/impl block (non-keyword methods like Ruby `def`)
    if (inBlock && braceDepth > inBlock.depth) {
      // Check for method-like patterns that weren't caught above
      const methodRe = new RegExp(`^${VISIBILITY}${MODIFIERS}(\\w+)\\s*\\(`);
      const methodMatch = trimmed.match(methodRe);
      if (methodMatch) {
        const name = methodMatch[1];
        // Skip control flow keywords
        const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'typeof', 'delete', 'void', 'yield', 'await', 'match', 'loop', 'else']);
        if (!skip.has(name)) {
          inBlock.methods.push(sigLine(rawLines[i]));
        }
      }
      continue;
    }

    // Type aliases
    const typeRe = new RegExp(`^${VISIBILITY}${TYPE_KW}\\s+(\\w+)`);
    if (trimmed.match(typeRe)) {
      symbols.types.push(sigLine(rawLines[i]));
      continue;
    }

    // Constants / statics (module-level only)
    if (braceDepth === 0 || (inBlock && braceDepth === inBlock.depth)) {
      const constRe = new RegExp(`^${VISIBILITY}${CONST_KW}\\s+(\\w+)`);
      const constMatch = trimmed.match(constRe);
      if (constMatch) {
        // Skip if it looks like a local variable inside a function
        if (braceDepth === 0) {
          symbols.constants.push(sigLine(rawLines[i]));
        }
        continue;
      }
    }

    // Modules / namespaces
    const modRe = new RegExp(`^${VISIBILITY}${MOD_KW}\\s+(\\w+)`);
    if (trimmed.match(modRe) && braceDepth === 0) {
      symbols.modules.push(sigLine(rawLines[i]));
      continue;
    }
  }

  // Handle last open block
  if (inBlock) {
    symbols.classes.push({
      signature: inBlock.signature,
      methods: inBlock.methods
    });
  }

  return symbols;
}

/**
 * Extract signature from a raw line: trim and strip body (everything from `{` onwards)
 */
function sigLine(raw) {
  return raw.trim()
    .replace(/\s*\{[\s\S]*$/, '')
    .replace(/\s*:\s*$/, '')   // Python/Ruby trailing colon
    .replace(/[;]$/, '')
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Generic Import Extraction
// ─────────────────────────────────────────────────────────────

/**
 * Extract imports generically from source code.
 *
 * Returns: { imports: [{ spec, line, statement }] }
 */
export function extractGenericImports(content) {
  const lines = content.split('\n');
  const imports = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--') ||
        trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    let spec = null;
    let statement = trimmed;

    // Rust: use std::collections::HashMap;
    const useMatch = trimmed.match(/^(?:pub\s+)?use\s+(.+?)\s*;/);
    if (useMatch) {
      spec = useMatch[1];
    }

    // C/C++: #include <...> or #include "..."
    const includeMatch = trimmed.match(/^#\s*include\s+[<"]([^>"]+)[>"]/);
    if (includeMatch) {
      spec = includeMatch[1];
    }

    // Generic import: import ..., from X import Y
    if (!spec) {
      const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+?)(?:\s*;?\s*$)/);
      if (importMatch && !trimmed.startsWith('import(')) {
        spec = importMatch[1] || importMatch[2].split(',')[0].split(' as ')[0].trim();
        // Skip if this looks like a function call: import("...")
        if (spec.startsWith('(')) spec = null;
      }
    }

    // Ruby: require 'foo' or require_relative 'foo'
    if (!spec) {
      const requireMatch = trimmed.match(/^(?:require(?:_relative)?)\s+['"]([^'"]+)['"]/);
      if (requireMatch) {
        spec = requireMatch[1];
      }
    }

    // C#: using System.IO;
    if (!spec) {
      const usingMatch = trimmed.match(/^using\s+(?:static\s+)?([^=][^;]+);/);
      if (usingMatch) {
        spec = usingMatch[1].trim();
      }
    }

    if (spec && !seen.has(spec)) {
      seen.add(spec);
      imports.push({
        spec,
        line: lineNum,
        statement: statement.substring(0, 120)
      });
    }
  }

  return { imports };
}
