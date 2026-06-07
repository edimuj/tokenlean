/**
 * Duplicate / near-duplicate function detection engine.
 *
 * Pure, dependency-free. Extracts function bodies across languages, normalizes
 * them, and clusters by:
 *   - exact      identical normalized bodies (copy-paste, any name)
 *   - structural identical shape, different identifiers (renamed clones)
 *   - near       high token-shingle Jaccard similarity (lightly-edited clones)
 *   - names      same function name defined in multiple places (awareness)
 *
 * Detection is lexical/structural by design — it nails copy-paste, renames, and
 * same-shape clones with high precision and zero deps. It does NOT find semantic
 * duplicates (same intent, different code); that needs embeddings.
 */

import { createHash } from 'node:crypto';

// ── Language families ──────────────────────────────────────────
// brace: C-family with { } bodies and // /* */ comments
// python: indentation-delimited with # comments
const BRACE_LANGS = new Set([
  'javascript', 'typescript', 'go', 'rust', 'java', 'kotlin', 'swift',
  'c', 'cpp', 'csharp', 'php'
]);

export function langFamily(lang) {
  if (BRACE_LANGS.has(lang)) return 'brace';
  if (lang === 'python') return 'python';
  return null;
}

// Keywords kept literal during structural hashing (everything else → "_").
// A broad C-family superset — applied uniformly, so per-language clustering is
// unaffected by extra entries.
const BRACE_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'const', 'let', 'var', 'function', 'async', 'await', 'new', 'this',
  'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'class',
  'extends', 'super', 'import', 'export', 'from', 'default', 'yield', 'void',
  'delete', 'null', 'true', 'false', 'undefined', 'func', 'fn', 'fun', 'def',
  'pub', 'use', 'mod', 'struct', 'impl', 'trait', 'enum', 'match', 'where', 'as',
  'move', 'ref', 'static', 'public', 'private', 'protected', 'final', 'override',
  'abstract', 'interface', 'package', 'namespace', 'using', 'val', 'when', 'is',
  'mut', 'self', 'crate', 'dyn', 'unsafe', 'go', 'defer', 'chan', 'select', 'type'
]);
const PYTHON_KEYWORDS = new Set([
  'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'try', 'except', 'finally', 'raise', 'with', 'as', 'import', 'from', 'class',
  'pass', 'lambda', 'yield', 'async', 'await', 'global', 'nonlocal', 'del',
  'assert', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self'
]);

// Control-flow words that must not be mistaken for method names.
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'function',
  'with', 'await', 'super', 'typeof', 'case'
]);

const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 12);

// ── Brace matching (string/comment aware) ──────────────────────
// Find the index of the } matching the { at `open` in `src`.
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); if (nl === -1) return -1; i = nl; continue; }
    if (c === '/' && n === '*') { const close = src.indexOf('*/', i + 2); if (close === -1) return -1; i = close + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i, c); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Advance past a string literal starting at `i` (quote char `q`). Returns the
// index of the closing quote. Template literals are treated as opaque.
function skipString(src, i, q) {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j;
  }
  return src.length;
}

// ── Function extraction ────────────────────────────────────────

// Param groups exclude ; so a function *call* can't greedily span statement
// boundaries to a distant { and be mistaken for a definition.
const BRACE_STARTERS = [
  // function declarations
  /(?:^|[^.\w$])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^{};]*?\)\s*\{/g,
  // arrow assignments
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^{};]*?\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
  // go: func name(...) / func (recv) name(...)
  /func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\([^{};]*?\)[^{}\n;]*?\{/g,
  // rust: fn name<...>(...) -> ...
  /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^{}>]*>)?\s*\([^{};]*?\)\s*(?:->\s*[^{};]+?)?\{/g,
  // methods (line-anchored, with optional modifiers)
  /^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|final|get|set|\*)\s+)*([A-Za-z_$][\w$]*)\s*\([^{};]*?\)\s*(?::\s*[^{};=]+?)?\{/gm,
];

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function extractBrace(src) {
  const byStart = new Map(); // body-open index → fn (dedupe across patterns)
  for (const re of BRACE_STARTERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (!name || NOT_A_METHOD.has(name)) continue;
      const braceIdx = m.index + m[0].length - 1;
      if (src[braceIdx] !== '{' || byStart.has(braceIdx)) continue;
      const end = matchBrace(src, braceIdx);
      if (end === -1) continue;
      const signature = m[0].slice(0, -1).replace(/^[^\w$]+/, '').replace(/\s+/g, ' ').trim();
      byStart.set(braceIdx, {
        name,
        signature,
        line: lineOf(src, m.index + (m[0].startsWith('\n') ? 1 : 0)),
        endLine: lineOf(src, end),
        body: src.slice(braceIdx + 1, end)
      });
    }
  }
  return [...byStart.values()];
}

function extractPython(src) {
  const lines = src.split('\n');
  const fns = [];
  const defRe = /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(defRe);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    const name = m[2];
    // Body = subsequent lines more indented than the def (until dedent).
    const bodyLines = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === '') { bodyLines.push(ln); continue; }
      const ind = (ln.match(/^[ \t]*/)[0]).replace(/\t/g, '    ').length;
      if (ind <= indent) break;
      bodyLines.push(ln);
    }
    fns.push({ name, signature: lines[i].trim(), line: i + 1, endLine: j, body: bodyLines.join('\n') });
  }
  return fns;
}

/**
 * Extract functions from a source string.
 * @returns {{name:string,line:number,body:string}[]}
 */
export function extractFunctions(source, lang) {
  const fam = langFamily(lang);
  if (fam === 'brace') return extractBrace(source);
  if (fam === 'python') return extractPython(source);
  return [];
}

// ── Normalization ──────────────────────────────────────────────

function stripComments(body, fam) {
  if (fam === 'python') return body.replace(/#[^\n]*/g, ' ');
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function normalizeBody(body, fam) {
  return stripComments(body, fam).replace(/\s+/g, ' ').trim();
}

export function structuralBody(body, fam) {
  const keywords = fam === 'python' ? PYTHON_KEYWORDS : BRACE_KEYWORDS;
  return normalizeBody(body, fam)
    .replace(/[A-Za-z_$][\w$]*/g, w => keywords.has(w) ? w : '_')
    .replace(/\s+/g, ' ');
}

function tokenCount(body, fam) {
  const norm = normalizeBody(body, fam);
  return (norm.match(/[A-Za-z_$][\w$]*|[^\sA-Za-z_$]/g) || []).length;
}

function shingles(structural, k = 5) {
  const toks = structural.split(' ').filter(Boolean);
  const set = new Set();
  if (toks.length < k) { set.add(toks.join(' ')); return set; }
  for (let i = 0; i <= toks.length - k; i++) set.add(toks.slice(i, i + k).join(' '));
  return set;
}

function jaccard(a, b) {
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Names that are intentionally redefined per file/module — not duplication.
const IGNORE_NAMES = new Set([
  'main', 'default', 'setup', 'teardown', 'init', 'run', 'constructor',
  'toString', 'toJSON', 'render', 'handler', 'handle'
]);

// ── Clustering ─────────────────────────────────────────────────

// Two functions in the same file whose line ranges overlap — i.e. one is nested
// inside the other, so the parent's body trivially contains the child.
function overlaps(a, b) {
  if (a.file !== b.file) return false;
  const ae = a.endLine ?? a.line, be = b.endLine ?? b.line;
  return a.line <= be && b.line <= ae;
}

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return [...m.values()].filter(g => g.length >= 2);
}

/**
 * @param {{name,file,line,body,lang}[]} functions
 * @param {object} opts { minTokens=12, names=true, structural=true, near=0 }
 * @returns {{exact:[], structural:[], near:[], names:[], scanned:number}}
 */
export function findDuplicates(functions, opts = {}) {
  const { minTokens = 12, names = true, structural = true, near = 0 } = opts;

  // Enrich
  for (const f of functions) {
    f.fam = langFamily(f.lang);
    f.norm = normalizeBody(f.body, f.fam);
    f.normHash = hash(f.norm);
    f.structHash = hash(structuralBody(f.body, f.fam));
    f.tok = tokenCount(f.body, f.fam);
  }
  const meaty = functions.filter(f => f.tok >= minTokens);

  const fmt = g => g.map(f => ({ name: f.name, file: f.file, line: f.line }));

  // Exact: identical normalized bodies.
  const exact = groupBy(meaty, f => f.normHash)
    .map(g => ({ tokens: g[0].tok, count: g.length, members: fmt(g) }))
    .sort((a, b) => b.count - a.count || b.tokens - a.tokens);

  // Structural: same shape, but bodies differ (exclude exact).
  let structuralGroups = [];
  if (structural) {
    structuralGroups = groupBy(meaty, f => f.structHash)
      .filter(g => new Set(g.map(f => f.normHash)).size > 1)
      .map(g => ({ tokens: g[0].tok, count: g.length, members: fmt(g) }))
      .sort((a, b) => b.count - a.count || b.tokens - a.tokens);
  }

  // Near: token-shingle Jaccard ≥ threshold (exclude exact + structural).
  let nearPairs = [];
  if (near > 0) {
    const seen = new Set([
      ...exact.flatMap(g => g.members.map(m => `${m.file}:${m.line}`)),
      ...structuralGroups.flatMap(g => g.members.map(m => `${m.file}:${m.line}`)),
    ]);
    const cand = meaty.filter(f => !seen.has(`${f.file}:${f.line}`));
    for (const f of cand) f._sh = shingles(structuralBody(f.body, f.fam));
    cand.sort((a, b) => a.tok - b.tok);
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        if (cand[j].tok > cand[i].tok * 1.25) break; // token-band prefilter
        if (overlaps(cand[i], cand[j])) continue;     // skip nested (parent ⊇ child)
        const sim = jaccard(cand[i]._sh, cand[j]._sh);
        if (sim >= near) {
          nearPairs.push({
            similarity: Math.round(sim * 100) / 100,
            tokens: cand[i].tok,
            members: fmt([cand[i], cand[j]]),
          });
        }
      }
    }
    nearPairs.sort((a, b) => b.similarity - a.similarity);
  }

  // Names: same name in ≥2 places (awareness); skip intentional per-file names.
  let nameGroups = [];
  if (names) {
    nameGroups = groupBy(functions, f => f.name)
      .filter(g => !IGNORE_NAMES.has(g[0].name))
      .map(g => ({
        name: g[0].name,
        count: g.length,
        distinctImpls: new Set(g.map(f => f.normHash)).size,
        members: fmt(g),
      }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    exact,
    structural: structuralGroups,
    near: nearPairs,
    names: nameGroups,
    scanned: meaty.length,
    total: functions.length,
  };
}
