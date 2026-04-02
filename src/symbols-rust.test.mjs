import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRustSymbols } from './symbols-rust.mjs';

describe('extractRustSymbols', () => {
  it('extracts pub functions', () => {
    const code = `pub fn process(data: &[u8]) -> Result<()> {
    Ok(())
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.ok(symbols.functions[0].includes('pub fn process'));
  });

  it('extracts private functions', () => {
    const code = `fn helper() {
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'fn helper()');
  });

  it('extracts structs with fields', () => {
    const code = `pub struct Config {
    pub host: String,
    pub port: u16,
    debug: bool,
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].signature, 'pub struct Config');
    assert.deepEqual(symbols.classes[0].fields, ['host', 'port', 'debug']);
  });

  it('extracts unit structs', () => {
    const code = 'pub struct Marker;';
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].signature, 'pub struct Marker');
  });

  it('extracts enums with variants', () => {
    const code = `pub enum Shape {
    Circle(f64),
    Rectangle { width: f64, height: f64 },
    Point,
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.ok(symbols.classes[0].signature.includes('enum Shape'));
    assert.equal(symbols.classes[0].variants.length, 3);
    assert.equal(symbols.classes[0].variants[0], 'Circle(...)');
    assert.equal(symbols.classes[0].variants[1], 'Rectangle{...}');
    assert.equal(symbols.classes[0].variants[2], 'Point');
  });

  it('extracts derive attributes', () => {
    const code = `#[derive(Debug, Clone)]
pub struct Point {
    x: f64,
    y: f64,
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes[0].derive, 'Debug, Clone');
  });

  it('extracts traits', () => {
    const code = `pub trait Drawable {
    fn draw(&self);
    fn bounds(&self) -> Rect;
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].isTrait, true);
    assert.equal(symbols.classes[0].methods.length, 2);
  });

  it('attaches inherent impl methods to structs', () => {
    const code = `pub struct Vec2 {
    x: f64,
    y: f64,
}

impl Vec2 {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn length(&self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].methods.length, 2);
  });

  it('extracts trait impl summary', () => {
    const code = `impl Display for Point {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.impls.length, 1);
    assert.equal(symbols.impls[0].trait, 'Display');
    assert.equal(symbols.impls[0].type, 'Point');
    assert.equal(symbols.impls[0].methodCount, 1);
  });

  it('extracts type aliases', () => {
    const code = 'pub type Result<T> = std::result::Result<T, Error>';
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.types.length, 1);
  });

  it('extracts constants', () => {
    const code = 'pub const MAX_SIZE: usize = 1024;';
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.constants.length, 1);
  });

  it('extracts modules', () => {
    const code = 'pub mod utils;';
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.modules.length, 1);
    assert.equal(symbols.modules[0], 'pub mod utils');
  });

  it('extracts macro_rules', () => {
    const code = `macro_rules! my_macro {
    ($x:expr) => { println!("{}", $x) }
}`;
    const symbols = extractRustSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'macro_rules! my_macro');
  });
});
