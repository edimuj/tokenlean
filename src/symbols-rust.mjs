/**
 * Rust symbol extraction for tl-symbols.
 *
 * Pure function: content string → symbols object.
 */

function collectRustContainerItem(trimmed, container) {
  if (container.kind === 'struct') {
    // Collect field names: "pub name: Type," or "name: Type,"
    const fieldMatch = trimmed.match(/^(?:pub(?:\([^)]+\))?\s+)?(\w+)\s*:/);
    if (fieldMatch) container.items.push(fieldMatch[1]);
  } else if (container.kind === 'enum') {
    // Collect variant names
    const varMatch = trimmed.match(/^(\w+)/);
    if (varMatch) {
      let variant = varMatch[1];
      // Annotate variant shape
      if (trimmed.includes('{')) variant += '{...}';
      else if (trimmed.includes('(')) variant += '(...)';
      container.items.push(variant);
    }
  } else if (container.kind === 'trait') {
    // Collect method signatures
    const fnMatch = trimmed.match(/^(?:async\s+)?fn\s+/);
    if (fnMatch) {
      const sig = trimmed.replace(/\s*\{.*$/, '').replace(/;$/, '').trim();
      container.items.push(sig);
    }
    // Collect associated types
    const typeMatch = trimmed.match(/^type\s+(\w+)/);
    if (typeMatch) {
      container.items.push(trimmed.replace(/;$/, '').trim());
    }
  } else if (container.kind === 'impl') {
    // Collect method signatures
    const fnMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+/);
    if (fnMatch) {
      const sig = trimmed.replace(/\s*\{.*$/, '').replace(/\s*where\s+.*$/, '').trim();
      container.items.push(sig);
    }
  }
}

function finalizeRustContainer(container, symbols, structMap) {
  if (container.kind === 'struct') {
    const entry = { signature: container.sig, methods: [], derive: container.derive };
    if (container.items.length > 0) entry.fields = container.items;
    symbols.classes.push(entry);
    structMap.set(container.name, symbols.classes.length - 1);
  } else if (container.kind === 'enum') {
    const entry = { signature: container.sig, methods: [], derive: container.derive };
    if (container.items.length > 0) entry.variants = container.items;
    symbols.classes.push(entry);
    structMap.set(container.name, symbols.classes.length - 1);
  } else if (container.kind === 'trait') {
    // Traits go to classes with isTrait flag
    symbols.classes.push({ signature: container.sig, methods: container.items, isTrait: true });
  } else if (container.kind === 'impl') {
    if (container.implFor) {
      // Trait impl: summary line under impls
      symbols.impls.push({
        trait: container.implFor,
        type: container.implType,
        methodCount: container.items.length
      });
    } else {
      // Inherent impl: attach methods to the struct/enum
      const idx = structMap.get(container.implType);
      if (idx !== undefined) {
        symbols.classes[idx].methods.push(...container.items);
      } else {
        // Struct defined elsewhere — create a placeholder
        symbols.impls.push({
          trait: null,
          type: container.implType,
          methods: container.items
        });
      }
    }
  }
}

export function extractRustSymbols(content) {
  const symbols = {
    classes: [],   // structs + enums
    functions: [], // top-level fn + macro_rules!
    types: [],     // type aliases
    constants: [], // const + static
    modules: [],   // mod declarations
    impls: []      // trait impl summary lines
  };

  const lines = content.split('\n');
  let braceDepth = 0;
  let pendingDerive = null; // #[derive(...)] waiting for struct/enum

  // Current container: struct, enum, trait, or impl
  let container = null;
  // { kind: 'struct'|'enum'|'trait'|'impl', sig, items, derive, implFor, implType, containerDepth }

  // Map from type name -> class entry index (for attaching inherent impl methods)
  const structMap = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and line comments
    if (!trimmed || trimmed.startsWith('//')) continue;

    // Capture #[derive(...)]
    const deriveMatch = trimmed.match(/^#\[derive\(([^)]+)\)\]/);
    if (deriveMatch) {
      pendingDerive = deriveMatch[1].trim();
      continue;
    }
    // Skip other attributes
    if (trimmed.startsWith('#[')) continue;

    // Count braces
    let lineOpen = 0, lineClose = 0;
    let inStr = false, strChar = '';
    for (let j = 0; j < trimmed.length; j++) {
      const ch = trimmed[j];
      if (inStr) { if (ch === strChar && trimmed[j - 1] !== '\\') inStr = false; continue; }
      if (ch === '"' || ch === '\'') { inStr = true; strChar = ch; continue; }
      if (ch === '/' && trimmed[j + 1] === '/') break; // rest is comment
      if (ch === '{') lineOpen++;
      else if (ch === '}') lineClose++;
    }

    const prevDepth = braceDepth;
    braceDepth += lineOpen - lineClose;

    // Exiting a container
    if (container && braceDepth <= container.containerDepth) {
      finalizeRustContainer(container, symbols, structMap);
      container = null;
    }

    // Inside a container: collect items at depth containerDepth+1
    if (container && prevDepth >= container.containerDepth + 1) {
      if (prevDepth === container.containerDepth + 1) {
        collectRustContainerItem(trimmed, container);
      }
      continue;
    }

    // Top-level declarations (prevDepth === 0 or entering a new container)
    if (prevDepth === 0) {
      // struct
      const structMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?struct\s+(\w+)(?:<[^>]*>)?/);
      if (structMatch) {
        const vis = structMatch[1]?.trim() || '';
        const name = structMatch[2];
        const sig = (vis ? vis + ' ' : '') + 'struct ' + name;
        // Tuple struct or unit struct (no brace block)
        if (lineOpen === 0 || trimmed.endsWith(';')) {
          const entry = { signature: sig, methods: [], derive: pendingDerive };
          symbols.classes.push(entry);
          structMap.set(name, symbols.classes.length - 1);
          pendingDerive = null;
        } else {
          container = { kind: 'struct', sig, name, items: [], derive: pendingDerive, containerDepth: prevDepth };
          pendingDerive = null;
        }
        continue;
      }

      // enum
      const enumMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?enum\s+(\w+)(?:<[^>]*>)?/);
      if (enumMatch) {
        const vis = enumMatch[1]?.trim() || '';
        const name = enumMatch[2];
        const sig = (vis ? vis + ' ' : '') + 'enum ' + name;
        container = { kind: 'enum', sig, name, items: [], derive: pendingDerive, containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // trait
      const traitMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?trait\s+(\w+)(?:<[^>]*>)?/);
      if (traitMatch) {
        const vis = traitMatch[1]?.trim() || '';
        const sig = (vis ? vis + ' ' : '') + 'trait ' + traitMatch[2];
        container = { kind: 'trait', sig, items: [], containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // impl
      const implMatch = trimmed.match(/^impl(?:<[^>]*>)?\s+(?:([\w:]+(?:<[^>]*>)?)\s+for\s+)?([\w:]+)(?:<[^>]*>)?/);
      if (implMatch && !trimmed.match(/^(pub|fn|struct|enum|trait|type|const|static|mod|use|macro)/)) {
        const traitName = implMatch[1]?.replace(/<.*>/, '') || null;
        const typeName = implMatch[2];
        container = { kind: 'impl', implFor: traitName, implType: typeName, items: [], containerDepth: prevDepth };
        pendingDerive = null;
        continue;
      }

      // fn
      const fnMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
      if (fnMatch) {
        const sig = trimmed.replace(/\s*\{.*$/, '').replace(/\s*where\s+.*$/, '').trim();
        symbols.functions.push(sig);
        pendingDerive = null;
        continue;
      }

      // type alias
      const typeMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?type\s+(\w+)/);
      if (typeMatch) {
        const sig = trimmed.replace(/;$/, '').trim();
        symbols.types.push(sig);
        pendingDerive = null;
        continue;
      }

      // const / static
      const constMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(const|static)\s+(\w+)/);
      if (constMatch) {
        const sig = trimmed.replace(/;$/, '').trim();
        symbols.constants.push(sig);
        pendingDerive = null;
        continue;
      }

      // mod
      const modMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?mod\s+(\w+)/);
      if (modMatch) {
        const vis = modMatch[1]?.trim() || '';
        symbols.modules.push((vis ? vis + ' ' : '') + 'mod ' + modMatch[2]);
        pendingDerive = null;
        continue;
      }

      // macro_rules!
      const macroMatch = trimmed.match(/^macro_rules!\s+(\w+)/);
      if (macroMatch) {
        symbols.functions.push('macro_rules! ' + macroMatch[1]);
        pendingDerive = null;
        continue;
      }
    }
  }

  // Flush last container
  if (container) {
    finalizeRustContainer(container, symbols, structMap);
  }

  return symbols;
}
