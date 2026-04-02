/**
 * Ruby symbol extraction for tl-symbols.
 *
 * Pure function: content string → symbols object.
 */

function isRubyBlockOpener(trimmed) {
  // Block openers that require a matching 'end'
  // Skip if it's a one-liner (has end on same line)
  if (trimmed.includes('; end')) return false;

  // do..end blocks
  if (trimmed.endsWith(' do') || trimmed.endsWith('{') || trimmed === 'begin') return true;

  // Control structures at statement start (not inline modifiers)
  if (/^(if|unless|while|until|for|case)\s/.test(trimmed)) return true;

  return false;
}

export function extractRubySymbols(content) {
  const symbols = {
    classes: [],
    functions: [],
    modules: [],
    constants: []
  };

  const lines = content.split('\n');

  // Scope stack: each entry = { kind: 'class'|'module'|'def'|'block', name, ... }
  const scopeStack = [];
  // Current class/module context
  let currentClass = null; // { sig, methods, attrs, constants, mixins, visibility }
  let classStack = []; // for nested classes

  function pushClass(sig, name) {
    if (currentClass) classStack.push(currentClass);
    currentClass = {
      sig, name,
      methods: [],
      attrs: [],
      constants: [],
      mixins: [],
      visibility: 'public'
    };
  }

  function popClass() {
    if (currentClass) {
      symbols.classes.push(currentClass);
    }
    currentClass = classStack.pop() || null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Module
    const modMatch = trimmed.match(/^module\s+([\w:]+)/);
    if (modMatch) {
      symbols.modules.push('module ' + modMatch[1]);
      pushClass(null, modMatch[1]); // modules can contain methods too
      currentClass.isModule = true;
      currentClass.sig = 'module ' + modMatch[1];
      scopeStack.push({ kind: 'module' });
      continue;
    }

    // Class
    const classMatch = trimmed.match(/^class\s+([\w:]+)(?:\s*<\s*([\w:]+))?/);
    if (classMatch) {
      const name = classMatch[1];
      const parent = classMatch[2];
      const sig = parent ? `class ${name} < ${parent}` : `class ${name}`;
      pushClass(sig, name);
      scopeStack.push({ kind: 'class' });
      continue;
    }

    // def self.method (class method)
    const classMethodMatch = trimmed.match(/^def\s+self\.(\w+[?!=]?)(?:\s*\(([^)]*)\))?/);
    if (classMethodMatch) {
      const params = classMethodMatch[2] || '';
      const methodName = params ? `self.${classMethodMatch[1]}(${params})` : 'self.' + classMethodMatch[1];
      if (currentClass) {
        const vis = currentClass.visibility;
        currentClass.methods.push({ name: methodName, visibility: vis });
      } else {
        symbols.functions.push('def ' + methodName);
      }
      // Only push to scope if it has a body (not one-liner)
      if (!trimmed.includes('; end')) {
        scopeStack.push({ kind: 'def' });
      }
      continue;
    }

    // def method
    const defMatch = trimmed.match(/^def\s+(\w+[?!=]?)(?:\s*\(([^)]*)\))?/);
    if (defMatch) {
      const methodName = defMatch[1];
      const params = defMatch[2] || '';
      if (currentClass) {
        const vis = currentClass.visibility;
        const sig = params ? `${methodName}(${params})` : methodName;
        currentClass.methods.push({ name: sig, visibility: vis });
      } else {
        const sig = params ? `def ${methodName}(${params})` : `def ${methodName}`;
        symbols.functions.push(sig);
      }
      if (!trimmed.includes('; end')) {
        scopeStack.push({ kind: 'def' });
      }
      continue;
    }

    // attr_reader / attr_accessor / attr_writer
    const attrMatch = trimmed.match(/^(attr_reader|attr_accessor|attr_writer)\s+(.+)/);
    if (attrMatch && currentClass) {
      const kind = attrMatch[1];
      const attrs = attrMatch[2].split(',').map(a => a.trim().replace(/^:/, ''));
      currentClass.attrs.push({ kind, names: attrs });
      continue;
    }

    // include / extend
    const mixinMatch = trimmed.match(/^(include|extend)\s+(.+)/);
    if (mixinMatch && currentClass) {
      currentClass.mixins.push({ kind: mixinMatch[1], name: mixinMatch[2].trim() });
      continue;
    }

    // Visibility modifiers (section-style)
    if (currentClass) {
      if (trimmed === 'private' || trimmed === 'private:') { currentClass.visibility = 'private'; continue; }
      if (trimmed === 'protected' || trimmed === 'protected:') { currentClass.visibility = 'protected'; continue; }
      if (trimmed === 'public' || trimmed === 'public:') { currentClass.visibility = 'public'; continue; }
      // Single-method visibility: private :method_name
      const singleVisMatch = trimmed.match(/^(private|protected)\s+:(\w+)/);
      if (singleVisMatch) {
        const method = currentClass.methods.find(m => m.name === singleVisMatch[2] || m.name.startsWith(singleVisMatch[2] + '('));
        if (method) method.visibility = singleVisMatch[1];
        continue;
      }
    }

    // Constants inside class (UPPER_CASE = ...)
    if (currentClass && trimmed.match(/^[A-Z][A-Z_0-9]*\s*=/)) {
      const constName = trimmed.match(/^([A-Z][A-Z_0-9]*)/)[1];
      currentClass.constants.push(constName);
      continue;
    }

    // Top-level constants
    if (!currentClass && trimmed.match(/^[A-Z][A-Z_0-9]*\s*=/)) {
      const constName = trimmed.match(/^([A-Z][A-Z_0-9]*)/)[1];
      symbols.constants.push(constName);
      continue;
    }

    // end keyword — pop scope
    if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#')) {
      const top = scopeStack.pop();
      if (top?.kind === 'class' || top?.kind === 'module') {
        popClass();
      }
      continue;
    }

    // Other block openers that need end-matching: do..end, begin, if/unless/while/for/case at statement level
    // We only track these to correctly match 'end' keywords
    if (isRubyBlockOpener(trimmed)) {
      scopeStack.push({ kind: 'block' });
    }
  }

  // Flush remaining
  while (currentClass) popClass();

  return symbols;
}
