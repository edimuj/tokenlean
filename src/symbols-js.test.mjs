import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsSymbols,
  extractSignatureLine,
  findOutsideParens,
  findLastArrowOutsideParens,
  joinMultiLineSignatures,
  filterExportsOnlySymbols
} from './symbols-js.mjs';

describe('extractSignatureLine', () => {
  it('strips block body', () => {
    assert.equal(
      extractSignatureLine('function foo(a, b) { return a + b; }'),
      'function foo(a, b)'
    );
  });

  it('strips arrow body keeping =>', () => {
    assert.equal(
      extractSignatureLine('const add = (a, b) => a + b'),
      'const add = (a, b) =>'
    );
  });

  it('strips value assignment', () => {
    assert.equal(
      extractSignatureLine('const MAX = 100;'),
      'const MAX'
    );
  });

  it('preserves generic type params', () => {
    assert.equal(
      extractSignatureLine('function map<T, U>(arr: T[], fn: (x: T) => U): U[]'),
      'function map<T, U>(arr: T[], fn: (x: T) => U): U[]'
    );
  });
});

describe('findOutsideParens', () => {
  it('finds char at top level', () => {
    assert.equal(findOutsideParens('a = b', '='), 2);
  });

  it('skips char inside parens', () => {
    assert.equal(findOutsideParens('fn(a = b) = c', '='), 10);
  });

  it('returns -1 when not found', () => {
    assert.equal(findOutsideParens('abc', '='), -1);
  });
});

describe('findLastArrowOutsideParens', () => {
  it('finds arrow at top level', () => {
    const str = '(a, b) => {}';
    assert.equal(findLastArrowOutsideParens(str), 7);
  });

  it('returns -1 when no arrow', () => {
    assert.equal(findLastArrowOutsideParens('function foo()'), -1);
  });
});

describe('joinMultiLineSignatures', () => {
  it('joins split function signatures', () => {
    const lines = [
      'function foo(',
      '  a: string,',
      '  b: number',
      ') {'
    ];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('function foo('));
    assert.ok(result[0].includes('a: string'));
  });

  it('passes through single-line signatures', () => {
    const lines = ['function foo(a, b) {', '  return a + b;', '}'];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result[0], 'function foo(a, b) {');
  });

  it('preserves comment lines', () => {
    const lines = ['// comment', 'function foo() {'];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result[0], '// comment');
  });

  it('does not count parens inside regex literals', () => {
    // The /\(/ regex literal has an unmatched `(` — must not throw off counter
    const lines = [
      'const re = /\\(/.test(s);',
      'export function afterRegex(x) {'
    ];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result.length, 2, 'lines must stay separate');
    assert.ok(result[1].includes('afterRegex'));
  });

  it('does not count parens inside string literals', () => {
    const lines = [
      "const msg = 'hello (world';",
      'function safe(x) {'
    ];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result.length, 2);
    assert.ok(result[1].includes('safe'));
  });

  it('does not count parens after line comment', () => {
    const lines = [
      'const x = 1; // note: see foo(bar',
      'function safe(x) {'
    ];
    const result = joinMultiLineSignatures(lines);
    assert.equal(result.length, 2);
    assert.ok(result[1].includes('safe'));
  });
});

describe('extractJsSymbols — regex/string paren safety', () => {
  it('captures function after a regex-literal line', () => {
    const code = [
      'const re = /\\(/.test(s);',
      'export function afterRegex(x) { return x; }'
    ].join('\n');
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.functions.length, 1, 'afterRegex must be captured');
    assert.ok(symbols.functions[0].includes('afterRegex'));
  });

  it('captures function after a string-with-paren line', () => {
    const code = [
      "const msg = 'open (paren';",
      'export function afterString(y) { return y; }'
    ].join('\n');
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('afterString'));
  });
});

describe('extractJsSymbols', () => {
  it('extracts exported functions', () => {
    const symbols = extractJsSymbols('export function greet(name) { return name; }');
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('greet'));
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts exported const arrow functions', () => {
    const symbols = extractJsSymbols('export const add = (a, b) => a + b;');
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts exported constants (non-arrow)', () => {
    const symbols = extractJsSymbols('export const MAX = 100;');
    assert.equal(symbols.constants.length, 1);
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts classes with methods', () => {
    const code = `class Foo {
  constructor(x) { this.x = x; }
  bar() { return this.x; }
}`;
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].methods.length, 2);
  });

  it('extracts exported classes', () => {
    const code = `export class MyClass {
  doThing() {}
}`;
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.ok(symbols.classes[0].signature.includes('export class MyClass'));
  });

  it('extracts interfaces with members', () => {
    const code = `interface Config {
  host: string
  port: number
}`;
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0].members.length, 2);
  });

  it('extracts enums with values', () => {
    const code = `enum Color {
  Red,
  Green,
  Blue
}`;
    const symbols = extractJsSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.ok(symbols.types[0].includes('Red'));
  });

  it('extracts non-exported functions', () => {
    const symbols = extractJsSymbols('function helper() { }');
    assert.equal(symbols.functions.length, 1);
  });

  it('skips non-exported when exportsOnly', () => {
    const code = `function internal() { }
export function external() { }`;
    const symbols = extractJsSymbols(code, true);
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('external'));
  });

  it('extracts re-exports', () => {
    const symbols = extractJsSymbols("export { foo, bar } from './utils';");
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts star re-exports', () => {
    const symbols = extractJsSymbols("export * from './types';");
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts export default', () => {
    const symbols = extractJsSymbols('export default function main() { }');
    assert.equal(symbols.exports.length, 1);
  });

  it('extracts top-level arrow functions', () => {
    const symbols = extractJsSymbols('const process = (data) => { }');
    assert.equal(symbols.functions.length, 1);
  });

  it('handles exported type aliases', () => {
    const symbols = extractJsSymbols('export type ID = string | number;');
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.exports.length, 1);
  });
});

describe('filterExportsOnlySymbols', () => {
  it('keeps only exported symbols', () => {
    const symbols = {
      exports: ['export function foo()'],
      classes: [
        { signature: 'export class A', methods: [] },
        { signature: 'class B', methods: [] }
      ],
      functions: ['export function foo()', 'function bar()'],
      types: ['export type X', 'type Y'],
      constants: ['export const Z', 'const W']
    };
    const filtered = filterExportsOnlySymbols(symbols);
    assert.equal(filtered.classes.length, 1);
    assert.equal(filtered.functions.length, 1);
    assert.equal(filtered.types.length, 1);
    assert.equal(filtered.constants.length, 1);
  });
});
