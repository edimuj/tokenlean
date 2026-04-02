import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPythonSymbols } from './symbols-python.mjs';

describe('extractPythonSymbols', () => {
  it('extracts top-level functions', () => {
    const symbols = extractPythonSymbols('def greet(name):\n    return f"Hello {name}"');
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'def greet(name)');
  });

  it('extracts async functions', () => {
    const symbols = extractPythonSymbols('async def fetch(url):\n    pass');
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('async def fetch'));
  });

  it('extracts classes with methods', () => {
    const code = `class Server:
    def __init__(self, host, port):
        pass
    def start(self):
        pass
    def stop(self):
        pass`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].signature, 'class Server');
    assert.equal(symbols.classes[0].methods.length, 3);
  });

  it('extracts classes with inheritance', () => {
    const symbols = extractPythonSymbols('class MyError(Exception):\n    pass');
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].signature, 'class MyError(Exception)');
  });

  it('extracts dataclass fields', () => {
    const code = `@dataclass
class Point:
    x: float
    y: float
    z: float = 0.0`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].fields.length, 3);
  });

  it('extracts enum values', () => {
    const code = `class Color(Enum):
    RED = 1
    GREEN = 2
    BLUE = 3`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].fields.length, 3);
    assert.equal(symbols.classes[0].isEnum, true);
  });

  it('handles __all__ filtering', () => {
    const code = `__all__ = ['public_fn', 'PublicClass']

def public_fn():
    pass

def _private_fn():
    pass

class PublicClass:
    pass

class PrivateClass:
    pass`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'def public_fn()');
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].signature, 'class PublicClass');
  });

  it('skips decorators', () => {
    const code = `@staticmethod
def helper():
    pass`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'def helper()');
  });

  it('separates class methods from top-level functions', () => {
    const code = `class Foo:
    def bar(self):
        pass

def standalone():
    pass`;
    const symbols = extractPythonSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].methods.length, 1);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'def standalone()');
  });

  it('extracts return type annotations', () => {
    const symbols = extractPythonSymbols('def add(x: int, y: int) -> int:\n    return x + y');
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('-> int'));
  });
});
