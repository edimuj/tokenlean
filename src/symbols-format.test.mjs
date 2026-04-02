import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countSymbols,
  extractName,
  extractSymbolNames,
  applySymbolFilter,
  extractFunctionNamesFast
} from './symbols-format.mjs';

describe('countSymbols', () => {
  it('counts flat symbol arrays', () => {
    const symbols = {
      exports: ['a', 'b'],
      functions: ['fn1', 'fn2', 'fn3'],
      classes: [],
      types: [],
      constants: ['C']
    };
    assert.equal(countSymbols(symbols), 6);
  });

  it('counts class methods and fields', () => {
    const symbols = {
      classes: [{ signature: 'class Foo', methods: ['bar', 'baz'], fields: ['x'] }],
      functions: [],
    };
    // 1 class + 2 methods + 1 field = 4
    assert.equal(countSymbols(symbols), 4);
  });

  it('counts Rust-specific: modules, impls, variants', () => {
    const symbols = {
      classes: [{ signature: 'enum Color', methods: [], variants: ['Red', 'Blue'] }],
      functions: ['fn main()'],
      modules: ['mod utils'],
      impls: [{ trait: 'Display', type: 'Color' }],
      types: [],
      constants: []
    };
    // 1 enum + 2 variants + 1 fn + 1 mod + 1 impl = 6
    assert.equal(countSymbols(symbols), 6);
  });

  it('counts type members', () => {
    const symbols = {
      types: [{ signature: 'interface Config', members: ['host', 'port'] }],
      functions: []
    };
    // 1 type + 2 members = 3
    assert.equal(countSymbols(symbols), 3);
  });
});

describe('extractName', () => {
  it('extracts from exported function', () => {
    assert.equal(extractName('export function greet(name)'), 'greet');
  });

  it('extracts from const', () => {
    assert.equal(extractName('export const MAX'), 'MAX');
  });

  it('extracts from class', () => {
    assert.equal(extractName('class MyService'), 'MyService');
  });

  it('extracts from Rust fn', () => {
    assert.equal(extractName('pub fn process(data: &[u8])'), 'process');
  });

  it('extracts from Python def', () => {
    assert.equal(extractName('def calculate(x, y)'), 'calculate');
  });

  it('extracts from Go func', () => {
    assert.equal(extractName('func HandleRequest(w http.ResponseWriter, r *http.Request)'), 'HandleRequest');
  });

  it('extracts from Ruby def', () => {
    assert.equal(extractName('def self.configure'), 'configure');
  });

  it('extracts from macro_rules', () => {
    assert.equal(extractName('macro_rules! my_macro'), 'my_macro');
  });

  it('returns null for empty input', () => {
    assert.equal(extractName(''), null);
    assert.equal(extractName(null), null);
  });
});

describe('extractSymbolNames', () => {
  it('returns export names when exportsOnly', () => {
    const symbols = {
      exports: ['export function foo()', 'export const BAR'],
      functions: ['export function foo()', 'function baz()'],
      constants: ['export const BAR', 'const QUX']
    };
    const names = extractSymbolNames(symbols, 'js', true);
    assert.equal(names.length, 2);
    assert.ok(names.includes('foo'));
    assert.ok(names.includes('BAR'));
  });

  it('returns all names when not exportsOnly', () => {
    const symbols = {
      functions: ['function foo()', 'function bar()'],
      classes: [{ signature: 'class Svc', methods: ['run', 'stop'] }],
      types: ['type Config'],
      constants: ['const MAX']
    };
    const names = extractSymbolNames(symbols, 'js', false);
    assert.ok(names.includes('foo()'));
    assert.ok(names.includes('bar()'));
    assert.ok(names.includes('Svc(2m)'));
    assert.ok(names.includes('Config'));
    assert.ok(names.includes('MAX'));
  });
});

describe('applySymbolFilter', () => {
  it('filters to functions only', () => {
    const symbols = {
      functions: ['fn1'],
      classes: [{ signature: 'class A' }],
      types: ['type T'],
      constants: ['const C'],
      exports: ['export function fn1', 'export class A'],
      modules: ['mod m']
    };
    applySymbolFilter(symbols, 'function');
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.classes.length, 0);
    assert.equal(symbols.types.length, 0);
    assert.equal(symbols.constants.length, 0);
  });

  it('filters to classes only', () => {
    const symbols = {
      functions: ['fn1'],
      classes: [{ signature: 'class A' }],
      exports: ['export class A'],
    };
    applySymbolFilter(symbols, 'class');
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.functions.length, 0);
    assert.equal(symbols.exports.length, 1);
  });

  it('returns symbols unchanged when no filter', () => {
    const symbols = { functions: ['fn1'], classes: [] };
    applySymbolFilter(symbols, null);
    assert.equal(symbols.functions.length, 1);
  });
});

describe('extractFunctionNamesFast', () => {
  it('extracts JS functions', () => {
    const code = `function foo() {}
const bar = (x) => x;
const baz = function() {};`;
    const names = extractFunctionNamesFast(code, 'js');
    assert.deepEqual(names, ['foo()', 'bar()', 'baz()']);
  });

  it('extracts Python functions', () => {
    const code = `def greet(name):
    pass
async def fetch_data():
    pass`;
    const names = extractFunctionNamesFast(code, 'python');
    assert.deepEqual(names, ['greet()', 'fetch_data()']);
  });

  it('extracts Go functions', () => {
    const code = `func main() {
}
func (s *Server) Handle(w http.ResponseWriter) {
}`;
    const names = extractFunctionNamesFast(code, 'go');
    assert.deepEqual(names, ['main()', 'Handle()']);
  });

  it('extracts Rust functions', () => {
    const code = `pub fn process(data: &[u8]) -> Result<()> {
}
fn helper() {
}`;
    const names = extractFunctionNamesFast(code, 'rust');
    assert.deepEqual(names, ['process()', 'helper()']);
  });

  it('extracts Ruby methods', () => {
    const code = `def initialize(name)
end
def self.create(attrs)
end`;
    const names = extractFunctionNamesFast(code, 'ruby');
    assert.deepEqual(names, ['initialize()', 'create()']);
  });

  it('deduplicates names', () => {
    const code = `function foo() {}
function foo() {}`;
    const names = extractFunctionNamesFast(code, 'js');
    assert.equal(names.length, 1);
  });

  it('skips comments', () => {
    const code = `// function fake() {}
function real() {}`;
    const names = extractFunctionNamesFast(code, 'js');
    assert.deepEqual(names, ['real()']);
  });
});
