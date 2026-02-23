import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractGenericSymbols, extractGenericImports } from './generic-lang.mjs';

// ─────────────────────────────────────────────────────────────
// extractGenericSymbols
// ─────────────────────────────────────────────────────────────

describe('extractGenericSymbols', () => {

  describe('functions', () => {
    it('extracts Rust fn', () => {
      const r = extractGenericSymbols('fn parse(input: &str) -> Result<()> {\n}\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('parse'));
    });

    it('extracts Python def', () => {
      const r = extractGenericSymbols('def calculate(x, y):\n    return x + y\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('calculate'));
    });

    it('extracts Go func', () => {
      const r = extractGenericSymbols('func main() {\n}\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('main'));
    });

    it('extracts Kotlin fun', () => {
      const r = extractGenericSymbols('fun greet(name: String) {\n}\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('greet'));
    });

    it('extracts pub fn (Rust visibility)', () => {
      const r = extractGenericSymbols('pub fn serve(port: u16) {\n}\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('serve'));
    });

    it('extracts async function', () => {
      const r = extractGenericSymbols('async function fetchData() {\n}\n');
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('fetchData'));
    });
  });

  describe('classes and structs', () => {
    it('extracts class with methods', () => {
      const code = `class Parser {
  fn parse(input: &str) {
  }
  fn reset() {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Parser'));
      assert.strictEqual(r.classes[0].methods.length, 2);
    });

    it('extracts struct', () => {
      const r = extractGenericSymbols('struct Config {\n  port: u16,\n}\n');
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Config'));
    });

    it('extracts interface', () => {
      const r = extractGenericSymbols('interface Logger {\n  log(msg: string): void;\n}\n');
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Logger'));
    });

    it('extracts trait', () => {
      const r = extractGenericSymbols('trait Drawable {\n  fn draw(&self);\n}\n');
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Drawable'));
    });

    it('extracts enum', () => {
      const r = extractGenericSymbols('enum Color {\n  Red,\n  Green,\n}\n');
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Color'));
    });
  });

  describe('impl blocks', () => {
    it('extracts impl with methods', () => {
      const code = `impl Parser {
  fn new() -> Self {
  }
  fn parse(&self) {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Parser'));
      assert.ok(r.classes[0].methods.length >= 2);
    });

    it('extracts impl Trait for Type', () => {
      const code = `impl Display for Config {
  fn fmt(&self) {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Display'));
    });

    it('extracts impl with generic params', () => {
      const code = `impl<T: AsRef<str>> From<T> for TokenCounter {
  fn from(s: T) -> Self {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('From'));
      assert.strictEqual(r.classes[0].methods.length, 1);
    });

    it('extracts impl with lifetime params', () => {
      const code = `impl<'a> Iterator for TokenIter<'a> {
  fn next(&mut self) -> Option<Token> {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].signature.includes('Iterator'));
      assert.strictEqual(r.classes[0].methods.length, 1);
    });
  });

  describe('constants', () => {
    it('extracts module-level const', () => {
      const r = extractGenericSymbols('const MAX_SIZE: usize = 1024;\n');
      assert.strictEqual(r.constants.length, 1);
      assert.ok(r.constants[0].includes('MAX_SIZE'));
    });

    it('ignores const inside function body', () => {
      const code = `fn foo() {
  const x = 5;
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.constants.length, 0);
    });
  });

  describe('modules', () => {
    it('extracts module at depth 0', () => {
      const r = extractGenericSymbols('mod parser;\n');
      assert.strictEqual(r.modules.length, 1);
      assert.ok(r.modules[0].includes('parser'));
    });

    it('extracts namespace without body', () => {
      const r = extractGenericSymbols('namespace Utils;\n');
      assert.strictEqual(r.modules.length, 1);
      assert.ok(r.modules[0].includes('Utils'));
    });

    it('extracts namespace with brace on same line', () => {
      const r = extractGenericSymbols('namespace Utils {\n}\n');
      assert.strictEqual(r.modules.length, 1);
      assert.ok(r.modules[0].includes('Utils'));
    });
  });

  describe('comment stripping', () => {
    it('ignores // line comments', () => {
      const code = `// fn fake() {}
fn real() {
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('real'));
    });

    it('ignores /* block comments */', () => {
      const code = `/* fn fake() {} */
fn real() {
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('real'));
    });

    it('ignores # comments (Python/Ruby)', () => {
      const code = `# def fake():
def real():
    pass`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.functions.length, 1);
      assert.ok(r.functions[0].includes('real'));
    });
  });

  describe('signature cleaning', () => {
    it('strips body from signature', () => {
      const r = extractGenericSymbols('fn parse() { let x = 1; }\n');
      assert.ok(!r.functions[0].includes('{'));
    });

    it('strips Python trailing colon', () => {
      const r = extractGenericSymbols('def process(data):\n    pass\n');
      assert.ok(!r.functions[0].endsWith(':'));
    });
  });

  describe('type aliases', () => {
    it('extracts type alias', () => {
      const r = extractGenericSymbols('type Result = std::result::Result<(), Error>;\n');
      assert.strictEqual(r.types.length, 1);
      assert.ok(r.types[0].includes('Result'));
    });
  });

  describe('struct fields', () => {
    it('extracts fields from struct', () => {
      const code = `pub struct Config {
  pub host: String,
  port: u16,
  verbose: bool,
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(r.classes[0].fields);
      assert.strictEqual(r.classes[0].fields.length, 3);
      assert.ok(r.classes[0].fields.includes('host'));
      assert.ok(r.classes[0].fields.includes('port'));
      assert.ok(r.classes[0].fields.includes('verbose'));
    });

    it('does not extract fields from impl blocks', () => {
      const code = `impl Config {
  fn new() -> Self {
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.ok(!r.classes[0].fields || r.classes[0].fields.length === 0);
    });

    it('extracts trait method declarations as methods not fields', () => {
      const code = `pub trait Formatter {
  fn format(&self, count: usize) -> String;
  fn supports_streaming(&self) -> bool;
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.strictEqual(r.classes[0].methods.length, 2);
      assert.ok(!r.classes[0].fields || r.classes[0].fields.length === 0);
    });
  });

  describe('false positive filtering', () => {
    it('does not treat Ok() as a method inside impl', () => {
      const code = `impl Parser {
  fn parse(&self) -> Result<usize> {
    Ok(tokens.len())
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.strictEqual(r.classes[0].methods.length, 1);
      assert.ok(r.classes[0].methods[0].includes('parse'));
    });

    it('does not treat Err/Some/None/Self as methods', () => {
      const code = `impl Handler {
  fn handle(&self) {
    Some(value)
    None
    Err(e)
    Self::new()
  }
}`;
      const r = extractGenericSymbols(code);
      assert.strictEqual(r.classes.length, 1);
      assert.strictEqual(r.classes[0].methods.length, 1);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// extractGenericImports
// ─────────────────────────────────────────────────────────────

describe('extractGenericImports', () => {

  describe('Rust use', () => {
    it('extracts use statement', () => {
      const r = extractGenericImports('use std::collections::HashMap;\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'std::collections::HashMap');
    });

    it('extracts pub use', () => {
      const r = extractGenericImports('pub use crate::parser;\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'crate::parser');
    });
  });

  describe('C/C++ include', () => {
    it('extracts angle bracket include', () => {
      const r = extractGenericImports('#include <stdio.h>\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'stdio.h');
    });

    it('extracts quoted include', () => {
      const r = extractGenericImports('#include "myheader.h"\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'myheader.h');
    });

    it('still skips # comments that are not includes', () => {
      const r = extractGenericImports('# import os\nimport sys\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'sys');
    });
  });

  describe('Python import', () => {
    it('extracts simple import', () => {
      const r = extractGenericImports('import os\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'os');
    });

    it('extracts from X import Y', () => {
      const r = extractGenericImports('from pathlib import Path\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'pathlib');
    });
  });

  describe('Ruby require', () => {
    it('extracts require', () => {
      const r = extractGenericImports("require 'json'\n");
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'json');
    });

    it('extracts require_relative', () => {
      const r = extractGenericImports("require_relative 'helpers/utils'\n");
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'helpers/utils');
    });
  });

  describe('C# using', () => {
    it('extracts using statement', () => {
      const r = extractGenericImports('using System.IO;\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'System.IO');
    });
  });

  describe('deduplication', () => {
    it('deduplicates identical imports', () => {
      const r = extractGenericImports('import os\nimport os\n');
      assert.strictEqual(r.imports.length, 1);
    });
  });

  describe('comment skipping', () => {
    it('skips // commented imports', () => {
      const r = extractGenericImports('// import os\nimport sys\n');
      assert.strictEqual(r.imports.length, 1);
      assert.strictEqual(r.imports[0].spec, 'sys');
    });

    it('skips # commented imports', () => {
      const r = extractGenericImports('# import os\nimport sys\n');
      assert.strictEqual(r.imports.length, 1);
    });
  });

  describe('dynamic import skip', () => {
    it('skips import() calls', () => {
      const r = extractGenericImports('import("./module.js")\n');
      assert.strictEqual(r.imports.length, 0);
    });
  });

  describe('truncation', () => {
    it('truncates statement to 120 chars', () => {
      const longImport = `use ${'a'.repeat(200)};\n`;
      const r = extractGenericImports(longImport);
      assert.ok(r.imports.length >= 1);
      assert.ok(r.imports[0].statement.length <= 120);
    });
  });

  describe('line numbers', () => {
    it('returns 1-based line numbers', () => {
      const code = '\nimport os\n\nimport sys\n';
      const r = extractGenericImports(code);
      assert.strictEqual(r.imports[0].line, 2);
      assert.strictEqual(r.imports[1].line, 4);
    });
  });
});
