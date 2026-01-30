#!/usr/bin/env node

/**
 * Claude Component - React component analyzer
 *
 * Analyzes a React component to show props, hooks, dependencies,
 * and structure without reading the full file.
 *
 * Usage: claude-component <file.tsx>
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative, dirname, basename } from 'path';

function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function extractImports(content) {
  const imports = {
    react: [],
    reactNative: [],
    internal: [],
    external: [],
    types: []
  };

  const importRegex = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const names = (match[1] || match[2]).split(',').map(s => s.trim());
    const source = match[3];

    if (source === 'react') {
      imports.react.push(...names);
    } else if (source.startsWith('react-native')) {
      imports.reactNative.push(...names);
    } else if (source.startsWith('.') || source.startsWith('@/')) {
      imports.internal.push({ names, source });
    } else if (source.includes('/types') || names.some(n => n.startsWith('type ') || /^[A-Z].*Props$/.test(n))) {
      imports.types.push({ names, source });
    } else {
      imports.external.push({ names, source });
    }
  }

  return imports;
}

function extractHooks(content) {
  const hooks = [];
  const hookRegex = /\b(use[A-Z]\w+)\s*\(/g;
  let match;

  const seen = new Set();
  while ((match = hookRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      hooks.push(match[1]);
    }
  }

  return hooks;
}

function extractProps(content) {
  // Look for Props interface/type
  const propsMatch = content.match(/(?:interface|type)\s+(\w*Props)\s*(?:=\s*)?{([^}]+)}/);
  if (!propsMatch) return null;

  const name = propsMatch[1];
  const body = propsMatch[2];

  const props = [];
  const propRegex = /(\w+)(\?)?:\s*([^;]+)/g;
  let match;

  while ((match = propRegex.exec(body)) !== null) {
    props.push({
      name: match[1],
      optional: !!match[2],
      type: match[3].trim()
    });
  }

  return { name, props };
}

function extractComponents(content) {
  const components = [];

  // Function components
  const funcRegex = /(?:export\s+)?(?:const|function)\s+(\w+)\s*(?::\s*React\.FC)?[^=]*=?\s*(?:\([^)]*\)|[^=])\s*(?:=>|{)/g;
  let match;

  while ((match = funcRegex.exec(content)) !== null) {
    const name = match[1];
    // Check if it looks like a component (PascalCase, returns JSX)
    if (/^[A-Z]/.test(name) && !name.endsWith('Props') && !name.endsWith('Type')) {
      components.push(name);
    }
  }

  return [...new Set(components)];
}

function extractStyles(content) {
  const styles = [];

  // StyleSheet.create
  if (content.includes('StyleSheet.create')) {
    styles.push('StyleSheet');
  }

  // styled-components / emotion
  if (content.includes('styled.') || content.includes('styled(')) {
    styles.push('styled-components');
  }

  // Tailwind / NativeWind
  if (content.includes('className=') || content.includes('tw`')) {
    styles.push('Tailwind/NativeWind');
  }

  // Inline styles
  if (content.match(/style=\{\{/)) {
    styles.push('inline styles');
  }

  return styles;
}

function extractRedux(content) {
  const redux = {
    selectors: [],
    actions: [],
    dispatch: false
  };

  // useSelector calls
  const selectorRegex = /useSelector\(\s*(?:\([^)]*\)\s*=>)?\s*(\w+)/g;
  let match;
  while ((match = selectorRegex.exec(content)) !== null) {
    redux.selectors.push(match[1]);
  }

  // useDispatch
  if (content.includes('useDispatch')) {
    redux.dispatch = true;
  }

  // dispatch calls
  const dispatchRegex = /dispatch\(\s*(\w+)/g;
  while ((match = dispatchRegex.exec(content)) !== null) {
    redux.actions.push(match[1]);
  }

  return redux;
}

function printAnalysis(analysis) {
  const { file, lines, tokens, imports, hooks, propsInfo, components, styles, redux } = analysis;

  console.log(`\n🧩 Component Analysis: ${file}`);
  console.log(`   ${lines} lines, ~${tokens} tokens\n`);

  // Components
  if (components.length > 0) {
    console.log(`📦 Components: ${components.join(', ')}`);
  }

  // Props
  if (propsInfo) {
    console.log(`\n📋 ${propsInfo.name}:`);
    for (const p of propsInfo.props) {
      const opt = p.optional ? '?' : '';
      console.log(`   ${p.name}${opt}: ${p.type}`);
    }
  }

  // Hooks
  if (hooks.length > 0) {
    console.log(`\n🪝 Hooks: ${hooks.join(', ')}`);
  }

  // Redux
  if (redux.dispatch || redux.selectors.length > 0) {
    console.log(`\n📦 Redux:`);
    if (redux.selectors.length > 0) {
      console.log(`   Selectors: ${redux.selectors.join(', ')}`);
    }
    if (redux.actions.length > 0) {
      console.log(`   Actions: ${redux.actions.join(', ')}`);
    }
  }

  // Imports summary
  console.log(`\n📥 Imports:`);
  if (imports.react.length > 0) {
    console.log(`   React: ${imports.react.join(', ')}`);
  }
  if (imports.reactNative.length > 0) {
    console.log(`   React Native: ${imports.reactNative.join(', ')}`);
  }
  if (imports.internal.length > 0) {
    console.log(`   Internal: ${imports.internal.length} modules`);
    for (const i of imports.internal.slice(0, 5)) {
      console.log(`     ${i.source}`);
    }
    if (imports.internal.length > 5) {
      console.log(`     ... and ${imports.internal.length - 5} more`);
    }
  }
  if (imports.external.length > 0) {
    console.log(`   External: ${imports.external.map(i => i.source).join(', ')}`);
  }

  // Styles
  if (styles.length > 0) {
    console.log(`\n🎨 Styling: ${styles.join(', ')}`);
  }

  console.log();
}

// Main
const args = process.argv.slice(2);
const targetFile = args[0];

if (!targetFile) {
  console.log('\nUsage: claude-component <file.tsx>\n');
  console.log('Analyzes a React component to show props, hooks, and dependencies.');
  process.exit(1);
}

const fullPath = targetFile.startsWith('/') ? targetFile : join(process.cwd(), targetFile);
if (!existsSync(fullPath)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const content = readFileSync(fullPath, 'utf-8');
const projectRoot = findProjectRoot();

const analysis = {
  file: relative(projectRoot, fullPath),
  lines: content.split('\n').length,
  tokens: Math.ceil(content.length / 4),
  imports: extractImports(content),
  hooks: extractHooks(content),
  propsInfo: extractProps(content),
  components: extractComponents(content),
  styles: extractStyles(content),
  redux: extractRedux(content)
};

printAnalysis(analysis);
