import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFunctions, normalizeBody, structuralBody, langFamily, findDuplicates
} from './dupes.mjs';

describe('langFamily', () => {
  it('maps languages to families', () => {
    assert.equal(langFamily('javascript'), 'brace');
    assert.equal(langFamily('go'), 'brace');
    assert.equal(langFamily('rust'), 'brace');
    assert.equal(langFamily('python'), 'python');
    assert.equal(langFamily('markdown'), null);
  });
});

describe('extractFunctions (brace)', () => {
  it('extracts declarations, arrows, methods, async', () => {
    const src = `
export function foo(a, b) { return a + b; }
const bar = (x) => { return x * 2; };
async function baz() { await go(); }
class K {
  method(y) { return y; }
}
`;
    const names = extractFunctions(src, 'javascript').map(f => f.name).sort();
    assert.deepEqual(names, ['bar', 'baz', 'foo', 'method']);
  });

  it('does NOT extract function calls as definitions (the ; guard)', () => {
    const src = `
function caller() {
  join(a, 'x'), join(b, 'y');
  for (const z of zs) {
    doThing();
  }
}
`;
    const names = extractFunctions(src, 'javascript').map(f => f.name);
    assert.deepEqual(names, ['caller'], 'only caller — not join/for');
  });

  it('extracts nested functions with line ranges', () => {
    const src = `function outer() {
  const r = [];
  function inner() {
    return 1;
  }
  return r;
}`;
    const fns = extractFunctions(src, 'javascript');
    const outer = fns.find(f => f.name === 'outer');
    const inner = fns.find(f => f.name === 'inner');
    assert.ok(outer && inner);
    assert.ok(outer.line < inner.line && inner.endLine < outer.endLine, 'inner nested in outer');
  });

  it('matches braces inside strings without breaking', () => {
    const src = `function f() { const s = "} not the end {"; return s; }`;
    const fns = extractFunctions(src, 'javascript');
    assert.equal(fns.length, 1);
    assert.match(fns[0].body, /not the end/);
  });

  it('extracts go and rust functions', () => {
    assert.deepEqual(
      extractFunctions('func Add(a int, b int) int {\n return a + b\n}', 'go').map(f => f.name),
      ['Add']);
    assert.deepEqual(
      extractFunctions('fn add(a: i32, b: i32) -> i32 {\n a + b\n}', 'rust').map(f => f.name),
      ['add']);
  });
});

describe('extractFunctions (python)', () => {
  it('extracts def by indentation', () => {
    const src = [
      'def foo(a, b):',
      '    x = a + b',
      '    return x',
      '',
      'def bar():',
      '    return 1',
    ].join('\n');
    const fns = extractFunctions(src, 'python');
    assert.deepEqual(fns.map(f => f.name), ['foo', 'bar']);
    assert.match(fns[0].body, /x = a \+ b/);
  });
});

describe('normalization', () => {
  it('normalizeBody strips comments and collapses whitespace', () => {
    const a = normalizeBody('  return  a; // c\n', 'brace');
    const b = normalizeBody('return a; /* x */', 'brace');
    assert.equal(a, b);
  });
  it('structuralBody renames identifiers but keeps keywords', () => {
    const a = structuralBody('const x = 1; return x;', 'brace');
    const b = structuralBody('const y = 1; return y;', 'brace');
    assert.equal(a, b);
    assert.match(a, /const _ = 1; return _/);
  });
});

describe('findDuplicates', () => {
  const mk = (name, file, line, body, lang = 'javascript') => ({ name, file, line, endLine: line + 3, body, lang });

  it('groups exact duplicates regardless of name', () => {
    const body = 'const a = compute(input); const b = a * 2; return b + offset;';
    const fns = [
      mk('getId', 'a.js', 1, body),
      mk('fetchId', 'b.js', 1, body),
    ];
    const r = findDuplicates(fns, { minTokens: 0 });
    assert.equal(r.exact.length, 1);
    assert.equal(r.exact[0].count, 2);
  });

  it('flags structural clones (renamed) separately from exact', () => {
    const fns = [
      mk('a', 'a.js', 1, 'const total = sum(items); return total + base;'),
      mk('b', 'b.js', 1, 'const result = sum(values); return result + start;'),
    ];
    const r = findDuplicates(fns, { minTokens: 0 });
    assert.equal(r.exact.length, 0, 'bodies differ -> not exact');
    assert.equal(r.structural.length, 1, 'same shape -> structural');
  });

  it('finds near-duplicates above the threshold', () => {
    // Similar but structurally different (b has an extra statement), so they
    // miss the exact/structural tiers but share most shingles.
    const a = 'const out = []; const seen = new Set(); for (const item of input) { if (seen.has(item.id)) { continue; } seen.add(item.id); const row = transform(item, opts); if (row.valid) { out.push(row); } } return out;';
    const b = a.replace('return out;', 'log(out.length); return out;');
    const fns = [mk('x', 'a.js', 1, a), mk('y', 'b.js', 1, b)];
    const r = findDuplicates(fns, { minTokens: 0, near: 0.6 });
    assert.equal(r.exact.length, 0);
    assert.equal(r.structural.length, 0);
    assert.equal(r.near.length, 1);
    assert.ok(r.near[0].similarity >= 0.6);
  });

  it('skips near-dup pairs where one function contains the other', () => {
    const inner = 'const out = []; const seen = new Set(); for (const item of input) { if (seen.has(item.id)) { continue; } seen.add(item.id); out.push(item); } return out;';
    const outer = inner + ' extra(); more(); stuff(); done();';
    const fns = [
      { name: 'outer', file: 'a.js', line: 1, endLine: 20, body: outer, lang: 'javascript' },
      { name: 'inner', file: 'a.js', line: 5, endLine: 10, body: inner, lang: 'javascript' },
    ];
    // Without the containment skip these would be near-dupes; with it, none.
    const r = findDuplicates(fns, { minTokens: 0, near: 0.6 });
    assert.equal(r.near.length, 0);
  });

  it('reports repeated names but skips intentional per-file names', () => {
    const fns = [
      mk('detectLang', 'a.js', 1, 'return ext1;'),
      mk('detectLang', 'b.js', 1, 'return ext2;'),
      mk('main', 'a.js', 1, 'return runA();'),
      mk('main', 'b.js', 1, 'return runB();'),
    ];
    const r = findDuplicates(fns, { minTokens: 0 });
    const names = r.names.map(g => g.name);
    assert.ok(names.includes('detectLang'));
    assert.ok(!names.includes('main'), 'main is ignored');
  });

  it('respects minTokens', () => {
    const fns = [mk('a', 'a.js', 1, 'return 1;'), mk('b', 'b.js', 1, 'return 1;')];
    assert.equal(findDuplicates(fns, { minTokens: 50 }).exact.length, 0);
    assert.equal(findDuplicates(fns, { minTokens: 0 }).exact.length, 1);
  });
});
