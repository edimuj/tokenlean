#!/usr/bin/env node

/**
 * tl-component - React component analyzer
 *
 * Analyzes a React component to show props, hooks, dependencies,
 * and structure without reading the full file.
 *
 * Usage: tl-component <file.tsx>
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-component',
    desc: 'Analyze React component (props, hooks, imports)',
    when: 'before-read',
    example: 'tl-component src/Button.tsx'
  }));
  process.exit(0);
}

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  estimateTokens,
  formatTokens,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-component - React component analyzer

Usage: tl-component <file.tsx> [options]
${COMMON_OPTIONS_HELP}

Examples:
  tl-component src/Button.tsx       # Analyze component
  tl-component src/App.tsx -j       # JSON output
  tl-component src/Modal.tsx -q     # Quiet (minimal)
`;

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

// Main
const args = process.argv.slice(2);
const options = parseCommonArgs(args);
const targetFile = options.remaining.find(a => !a.startsWith('-'));

if (options.help || !targetFile) {
  console.log(HELP);
  process.exit(options.help ? 0 : 1);
}

const fullPath = targetFile.startsWith('/') ? targetFile : join(process.cwd(), targetFile);
if (!existsSync(fullPath)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

const content = readFileSync(fullPath, 'utf-8');
const projectRoot = findProjectRoot();
const relPath = relative(projectRoot, fullPath);

const analysis = {
  file: relPath,
  lines: content.split('\n').length,
  tokens: estimateTokens(content),
  imports: extractImports(content),
  hooks: extractHooks(content),
  propsInfo: extractProps(content),
  components: extractComponents(content),
  styles: extractStyles(content),
  redux: extractRedux(content)
};

const out = createOutput(options);

// Set JSON data
out.setData('file', analysis.file);
out.setData('lines', analysis.lines);
out.setData('tokens', analysis.tokens);
out.setData('components', analysis.components);
out.setData('props', analysis.propsInfo);
out.setData('hooks', analysis.hooks);
out.setData('imports', analysis.imports);
out.setData('styles', analysis.styles);
out.setData('redux', analysis.redux);

// Headers
out.header(`Component Analysis: ${analysis.file}`);
out.header(`${analysis.lines} lines, ~${formatTokens(analysis.tokens)} tokens`);
out.blank();

// Components
if (analysis.components.length > 0) {
  out.add(`Components: ${analysis.components.join(', ')}`);
}

// Props
if (analysis.propsInfo) {
  out.blank();
  out.add(`${analysis.propsInfo.name}:`);
  for (const p of analysis.propsInfo.props) {
    const opt = p.optional ? '?' : '';
    out.add(`  ${p.name}${opt}: ${p.type}`);
  }
}

// Hooks
if (analysis.hooks.length > 0) {
  out.blank();
  out.add(`Hooks: ${analysis.hooks.join(', ')}`);
}

// Redux
if (analysis.redux.dispatch || analysis.redux.selectors.length > 0) {
  out.blank();
  out.add('Redux:');
  if (analysis.redux.selectors.length > 0) {
    out.add(`  Selectors: ${analysis.redux.selectors.join(', ')}`);
  }
  if (analysis.redux.actions.length > 0) {
    out.add(`  Actions: ${analysis.redux.actions.join(', ')}`);
  }
}

// Imports summary
out.blank();
out.add('Imports:');
if (analysis.imports.react.length > 0) {
  out.add(`  React: ${analysis.imports.react.join(', ')}`);
}
if (analysis.imports.reactNative.length > 0) {
  out.add(`  React Native: ${analysis.imports.reactNative.join(', ')}`);
}
if (analysis.imports.internal.length > 0) {
  out.add(`  Internal: ${analysis.imports.internal.length} modules`);
  for (const i of analysis.imports.internal.slice(0, 5)) {
    out.add(`    ${i.source}`);
  }
  if (analysis.imports.internal.length > 5) {
    out.add(`    ... and ${analysis.imports.internal.length - 5} more`);
  }
}
if (analysis.imports.external.length > 0) {
  out.add(`  External: ${analysis.imports.external.map(i => i.source).join(', ')}`);
}

// Styles
if (analysis.styles.length > 0) {
  out.blank();
  out.add(`Styling: ${analysis.styles.join(', ')}`);
}

out.print();
