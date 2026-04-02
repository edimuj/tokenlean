/**
 * Symbol formatting, counting, name extraction, and filtering for tl-symbols.
 *
 * Shared by both single-file (detailed) and multi-file (compact) modes.
 */

// ─────────────────────────────────────────────────────────────
// Formatting (per-language output rendering)
// ─────────────────────────────────────────────────────────────

export function formatSymbols(symbols, lang, out) {
  if (lang === 'js') {
    if (symbols.exports.length > 0) {
      out.add('Exports:');
      const unique = [...new Set(symbols.exports)];
      unique.forEach(e => out.add('  ' + e));
      out.blank();
    }

    if (symbols.classes.length > 0) {
      out.add('Classes:');
      for (const cls of symbols.classes) {
        out.add('  ' + cls.signature);
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    const nonExportedFuncs = symbols.functions.filter(f => !f.startsWith('export'));
    if (nonExportedFuncs.length > 0) {
      out.add('Functions:');
      nonExportedFuncs.forEach(f => out.add('  ' + f));
      out.blank();
    }

    const typesWithDetail = symbols.types.filter(t => {
      if (typeof t !== 'string') return true; // always show types with members
      return !t.startsWith('export'); // filter exported plain strings (already in Exports)
    });
    if (typesWithDetail.length > 0) {
      out.add('Types:');
      for (const t of typesWithDetail) {
        if (typeof t === 'string') {
          out.add('  ' + t);
        } else {
          out.add('  ' + t.signature);
          t.members.forEach(m => out.add('    ' + m));
        }
      }
      out.blank();
    }

    const nonExportedConsts = symbols.constants.filter(c => !c.startsWith('export'));
    if (nonExportedConsts.length > 0) {
      out.add('Constants:');
      nonExportedConsts.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'python') {
    if (symbols.classes.length > 0) {
      out.add('Classes:');
      for (const cls of symbols.classes) {
        out.add('  ' + cls.signature);
        if (cls.fields && cls.fields.length > 0) {
          if (cls.isEnum) {
            const MAX = 6;
            if (cls.fields.length <= MAX) {
              out.add('    ' + cls.fields.join(', '));
            } else {
              out.add('    ' + cls.fields.slice(0, MAX).join(', ') + `, ... +${cls.fields.length - MAX} more`);
            }
          } else {
            cls.fields.forEach(f => out.add('    ' + f));
          }
        }
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (symbols.functions.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }
  } else if (lang === 'rust') {
    // Modules
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    // Structs, Enums, Traits
    const structs = symbols.classes?.filter(c => !c.isTrait && c.signature.includes('struct')) || [];
    const enums = symbols.classes?.filter(c => !c.isTrait && c.signature.includes('enum')) || [];
    const traits = symbols.classes?.filter(c => c.isTrait) || [];

    if (structs.length > 0 || enums.length > 0) {
      out.add('Structs:');
      for (const s of structs) {
        let line = '  ' + s.signature;
        if (s.derive) line += '  #[derive(' + s.derive + ')]';
        if (s.fields?.length > 0) {
          const MAX = 8;
          const fieldStr = s.fields.length <= MAX
            ? s.fields.join(', ')
            : s.fields.slice(0, MAX).join(', ') + `, +${s.fields.length - MAX}`;
          line += '  { ' + fieldStr + ' }';
        }
        out.add(line);
        s.methods.forEach(m => out.add('    ' + m));
      }
      for (const e of enums) {
        let line = '  ' + e.signature;
        if (e.derive) line += '  #[derive(' + e.derive + ')]';
        if (e.variants?.length > 0) {
          const MAX = 6;
          const varStr = e.variants.length <= MAX
            ? e.variants.join(', ')
            : e.variants.slice(0, MAX).join(', ') + `, +${e.variants.length - MAX}`;
          line += ' { ' + varStr + ' }';
        }
        out.add(line);
        e.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (traits.length > 0) {
      out.add('Traits:');
      for (const t of traits) {
        out.add('  ' + t.signature);
        t.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    // Trait impls (summary)
    const traitImpls = symbols.impls?.filter(i => i.trait) || [];
    const orphanImpls = symbols.impls?.filter(i => !i.trait && i.methods) || [];
    if (traitImpls.length > 0 || orphanImpls.length > 0) {
      out.add('Impls:');
      for (const imp of traitImpls) {
        out.add(`  impl ${imp.trait} for ${imp.type}  (${imp.methodCount} method${imp.methodCount !== 1 ? 's' : ''})`);
      }
      for (const imp of orphanImpls) {
        out.add(`  impl ${imp.type}`);
        imp.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    // Functions
    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    // Types
    if (symbols.types?.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    // Constants
    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'ruby') {
    // Modules
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    // Classes (including module entries that have methods)
    const classEntries = symbols.classes?.filter(c => !c.isModule || c.methods.length > 0 || c.attrs.length > 0) || [];
    if (classEntries.length > 0) {
      out.add('Classes:');
      for (const cls of classEntries) {
        let header = '  ' + cls.sig;
        // Mixins
        const includes = cls.mixins?.filter(m => m.kind === 'include').map(m => m.name) || [];
        const extends_ = cls.mixins?.filter(m => m.kind === 'extend').map(m => m.name) || [];
        const mixinParts = [];
        if (includes.length > 0) mixinParts.push('include ' + includes.join(', '));
        if (extends_.length > 0) mixinParts.push('extend ' + extends_.join(', '));
        if (mixinParts.length > 0) header += '  [' + mixinParts.join(', ') + ']';
        out.add(header);

        // Attrs
        for (const attr of (cls.attrs || [])) {
          out.add('    ' + attr.kind + ' :' + attr.names.join(', :'));
        }

        // Constants
        if (cls.constants?.length > 0) {
          out.add('    ' + cls.constants.join(', '));
        }

        // Methods grouped by visibility
        const publicMethods = cls.methods.filter(m => m.visibility === 'public');
        const privateMethods = cls.methods.filter(m => m.visibility === 'private');
        const protectedMethods = cls.methods.filter(m => m.visibility === 'protected');

        for (const m of publicMethods) {
          out.add('    def ' + m.name);
        }
        if (privateMethods.length > 0) {
          out.add('    private:');
          for (const m of privateMethods) {
            out.add('      def ' + m.name);
          }
        }
        if (protectedMethods.length > 0) {
          out.add('    protected:');
          for (const m of protectedMethods) {
            out.add('      def ' + m.name);
          }
        }
      }
      out.blank();
    }

    // Top-level functions
    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    // Top-level constants
    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  } else if (lang === 'go') {
    if (symbols.types.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    if (symbols.functions.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }
  } else {
    // Generic fallback format
    if (symbols.modules?.length > 0) {
      out.add('Modules:');
      symbols.modules.forEach(m => out.add('  ' + m));
      out.blank();
    }

    if (symbols.classes?.length > 0) {
      out.add('Classes/Structs:');
      for (const cls of symbols.classes) {
        if (cls.fields && cls.fields.length > 0) {
          const MAX = 6;
          if (cls.fields.length <= MAX) {
            out.add('  ' + cls.signature + ' { ' + cls.fields.join(', ') + ' }');
          } else {
            out.add('  ' + cls.signature + ' { ' + cls.fields.slice(0, MAX).join(', ') + `, ... +${cls.fields.length - MAX} more }`);
          }
        } else {
          out.add('  ' + cls.signature);
        }
        cls.methods.forEach(m => out.add('    ' + m));
      }
      out.blank();
    }

    if (symbols.functions?.length > 0) {
      out.add('Functions:');
      symbols.functions.forEach(f => out.add('  ' + f));
      out.blank();
    }

    if (symbols.types?.length > 0) {
      out.add('Types:');
      symbols.types.forEach(t => out.add('  ' + t));
      out.blank();
    }

    if (symbols.constants?.length > 0) {
      out.add('Constants:');
      symbols.constants.forEach(c => out.add('  ' + c));
      out.blank();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Counting
// ─────────────────────────────────────────────────────────────

export function countSymbols(symbols) {
  let count = 0;
  if (symbols.exports) count += symbols.exports.length;
  if (symbols.classes) {
    count += symbols.classes.length;
    symbols.classes.forEach(c => {
      count += c.methods?.length || 0;
      count += c.fields?.length || 0;
      count += c.variants?.length || 0;
      count += c.attrs?.length || 0;
      count += c.constants?.length || 0;
    });
  }
  if (symbols.functions) count += symbols.functions.length;
  if (symbols.types) {
    count += symbols.types.length;
    symbols.types.forEach(t => count += t.members?.length || 0);
  }
  if (symbols.constants) count += symbols.constants.length;
  if (symbols.modules) count += symbols.modules.length;
  if (symbols.impls) count += symbols.impls.length;
  return count;
}

// ─────────────────────────────────────────────────────────────
// Name Extraction (compact multi-file mode)
// ─────────────────────────────────────────────────────────────

export function extractName(sig) {
  if (!sig) return null;
  // Strip common prefixes: export, async, function, const, type, interface, class, etc.
  const cleaned = sig
    .replace(/^export\s+(default\s+)?/, '')
    .replace(/^(async\s+)?(function\s+|const\s+|let\s+|var\s+|class\s+|abstract\s+class\s+|interface\s+|type\s+|enum\s+)/, '')
    .replace(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn\s+|struct\s+|enum\s+|trait\s+|impl\s+|mod\s+|module\s+|type\s+|const\s+|static\s+|let\s+)/, '')
    .replace(/^(func\s+)/, '')
    .replace(/^def\s+(?:self\.)?/, '')
    .replace(/^macro_rules!\s+/, '')
    .trim();
  const match = cleaned.match(/^(\w+)/);
  return match ? match[1] : null;
}

export function extractSymbolNames(symbols, lang, exportsOnly) {
  const names = [];

  if (exportsOnly && symbols.exports) {
    for (const e of symbols.exports) {
      const name = extractName(typeof e === 'string' ? e : e.signature || e);
      if (name) names.push(name);
    }
    return names;
  }

  // Classes — show ClassName with method count
  if (symbols.classes) {
    for (const cls of symbols.classes) {
      const sig = typeof cls === 'string' ? cls : cls.signature;
      const name = extractName(sig);
      const methodCount = cls.methods?.length || 0;
      if (name) names.push(methodCount > 0 ? `${name}(${methodCount}m)` : name);
    }
  }

  // Functions
  if (symbols.functions) {
    for (const f of symbols.functions) {
      const name = extractName(typeof f === 'string' ? f : f);
      if (name) names.push(name + '()');
    }
  }

  // Types
  if (symbols.types) {
    for (const t of symbols.types) {
      const sig = typeof t === 'string' ? t : t.signature;
      const name = extractName(sig);
      if (name) names.push(name);
    }
  }

  // Constants
  if (symbols.constants) {
    for (const c of symbols.constants) {
      const name = extractName(typeof c === 'string' ? c : c);
      if (name) names.push(name);
    }
  }

  // Modules (generic)
  if (symbols.modules) {
    for (const m of symbols.modules) {
      const name = extractName(m);
      if (name) names.push(name);
    }
  }

  return names;
}

// ─────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────

export function applySymbolFilter(symbols, filterType) {
  if (!filterType) return symbols;

  const filterMap = {
    function: () => {
      symbols.classes = [];
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\bfunction\b/.test(e) || /=>\s*$/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    class: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e => /\bclass\b/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    type: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.classes = symbols.classes ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\b(type|interface|enum)\b/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    constant: () => {
      symbols.functions = symbols.functions ? [] : undefined;
      symbols.classes = symbols.classes ? [] : undefined;
      symbols.types = symbols.types ? [] : undefined;
      symbols.exports = symbols.exports ? symbols.exports.filter(e =>
        /\bconst\b/.test(e) && !/=>/.test(e)) : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    },
    export: () => {
      symbols.functions = [];
      symbols.classes = [];
      symbols.types = symbols.types ? [] : undefined;
      symbols.constants = symbols.constants ? [] : undefined;
      symbols.modules = symbols.modules ? [] : undefined;
    }
  };

  if (filterMap[filterType]) filterMap[filterType]();
  return symbols;
}

// ─────────────────────────────────────────────────────────────
// Fast Function Filter (multi-file optimization)
// ─────────────────────────────────────────────────────────────

const FAST_FUNCTION_FILTER_LANGS = new Set(['python', 'go', 'rust', 'ruby']);

export function extractFunctionNamesFast(content, lang) {
  const names = [];
  const seen = new Set();

  function add(name) {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(`${name}()`);
  }

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    if (lang === 'js') {
      const fn = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/);
      if (fn) { add(fn[1]); continue; }

      const arrow = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (arrow) { add(arrow[1]); continue; }

      const fnExpr = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/);
      if (fnExpr) { add(fnExpr[1]); continue; }
    } else if (lang === 'python') {
      const py = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (py) { add(py[1]); continue; }
    } else if (lang === 'go') {
      const go = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<]/);
      if (go) { add(go[1]); continue; }
    } else if (lang === 'rust') {
      const rs = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)\s*[(<]/);
      if (rs) { add(rs[1]); continue; }
    } else if (lang === 'ruby') {
      const rb = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/);
      if (rb) { add(rb[1]); continue; }
    }
  }

  return names;
}

export function tryFastFunctionFilterNames(filePath, lang, exportsOnly, filterType, readFileSync) {
  if (exportsOnly || filterType !== 'function' || !FAST_FUNCTION_FILTER_LANGS.has(lang)) {
    return null;
  }

  const content = readFileSync(filePath, 'utf-8');
  const indicatorByLang = {
    js: /\bfunction\b|=>/,
    python: /\bdef\b/,
    go: /\bfunc\b/,
    rust: /\bfn\b/,
    ruby: /\bdef\b/
  };
  const hasIndicator = indicatorByLang[lang]?.test(content);
  if (!hasIndicator) return [];

  const names = extractFunctionNamesFast(content, lang);
  // If indicators exist but extraction found nothing, fallback to full parser for correctness.
  return names.length > 0 ? names : null;
}
