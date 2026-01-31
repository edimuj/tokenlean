#!/usr/bin/env node

/**
 * tl-routes - Extract routes from web frameworks
 *
 * Scans source files for route definitions in common web frameworks
 * (Next.js, React Router, Vue Router, Express, etc.) and shows the
 * route structure.
 *
 * Usage: tl-routes [dir] [--tree]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-routes',
    desc: 'Extract routes from web frameworks',
    when: 'before-read',
    example: 'tl-routes src/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, dirname, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, shouldSkip } from '../src/project.mjs';

const HELP = `
tl-routes - Extract routes from web frameworks

Usage: tl-routes [dir] [options]

Options:
  --tree                Show routes as tree structure
  --with-components     Show component/handler for each route
  --framework <name>    Force specific framework detection
${COMMON_OPTIONS_HELP}

Examples:
  tl-routes                       # Auto-detect framework
  tl-routes src/                  # Scan specific directory
  tl-routes --tree                # Tree view
  tl-routes app/ --with-components

Detects:
  - Next.js App Router (app/ directory structure)
  - Next.js Pages Router (pages/ directory)
  - React Router (createBrowserRouter, <Route>)
  - Vue Router (createRouter, routes array)
  - Express/Fastify routes
  - SvelteKit (+page.svelte)
  - Remix (routes/ directory)
`;

// ─────────────────────────────────────────────────────────────
// Framework Detection
// ─────────────────────────────────────────────────────────────

function detectFramework(projectRoot) {
  // Check package.json for framework hints
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) return 'nextjs';
      if (deps['react-router'] || deps['react-router-dom']) return 'react-router';
      if (deps['vue-router']) return 'vue-router';
      if (deps['@sveltejs/kit']) return 'sveltekit';
      if (deps['@remix-run/react']) return 'remix';
      if (deps['express']) return 'express';
      if (deps['fastify']) return 'fastify';
      if (deps['hono']) return 'hono';
    } catch {}
  }

  // Check for directory structures
  if (existsSync(join(projectRoot, 'app')) && existsSync(join(projectRoot, 'app/page.tsx'))) {
    return 'nextjs-app';
  }
  if (existsSync(join(projectRoot, 'src/app')) && existsSync(join(projectRoot, 'src/app/page.tsx'))) {
    return 'nextjs-app';
  }
  if (existsSync(join(projectRoot, 'pages'))) {
    return 'nextjs-pages';
  }
  if (existsSync(join(projectRoot, 'src/routes'))) {
    return 'sveltekit';
  }

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// Next.js App Router
// ─────────────────────────────────────────────────────────────

function extractNextAppRoutes(appDir, projectRoot) {
  const routes = [];

  function scanDir(dir, routePath = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        let segment = entry.name;

        // Handle special Next.js conventions
        if (segment.startsWith('(') && segment.endsWith(')')) {
          // Route group - doesn't affect URL
          scanDir(fullPath, routePath);
        } else if (segment.startsWith('[') && segment.endsWith(']')) {
          // Dynamic segment
          if (segment.startsWith('[...')) {
            segment = '*'; // Catch-all
          } else {
            segment = `:${segment.slice(1, -1)}`;
          }
          scanDir(fullPath, `${routePath}/${segment}`);
        } else if (segment.startsWith('@')) {
          // Parallel route slot - skip
          continue;
        } else {
          scanDir(fullPath, `${routePath}/${segment}`);
        }
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase();

        if (name === 'page.tsx' || name === 'page.jsx' || name === 'page.js' || name === 'page.ts') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'page'
          });
        } else if (name === 'route.tsx' || name === 'route.ts' || name === 'route.js') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'api'
          });
        } else if (name === 'layout.tsx' || name === 'layout.jsx' || name === 'layout.js') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'layout'
          });
        }
      }
    }
  }

  scanDir(appDir);
  return routes;
}

// ─────────────────────────────────────────────────────────────
// Next.js Pages Router
// ─────────────────────────────────────────────────────────────

function extractNextPagesRoutes(pagesDir, projectRoot) {
  const routes = [];

  function scanDir(dir, routePath = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        let segment = entry.name;

        if (segment.startsWith('[') && segment.endsWith(']')) {
          if (segment.startsWith('[...')) {
            segment = '*';
          } else {
            segment = `:${segment.slice(1, -1)}`;
          }
        }

        scanDir(fullPath, `${routePath}/${segment}`);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!['.tsx', '.jsx', '.js', '.ts'].includes(ext)) continue;

        const name = basename(entry.name, ext);

        if (name === 'index') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: routePath.startsWith('/api') ? 'api' : 'page'
          });
        } else if (name.startsWith('[') && name.endsWith(']')) {
          let segment = name;
          if (segment.startsWith('[...')) {
            segment = '*';
          } else {
            segment = `:${segment.slice(1, -1)}`;
          }
          routes.push({
            path: `${routePath}/${segment}`,
            file: relative(projectRoot, fullPath),
            type: routePath.startsWith('/api') ? 'api' : 'page'
          });
        } else {
          routes.push({
            path: `${routePath}/${name}`,
            file: relative(projectRoot, fullPath),
            type: routePath.startsWith('/api') ? 'api' : 'page'
          });
        }
      }
    }
  }

  scanDir(pagesDir);
  return routes;
}

// ─────────────────────────────────────────────────────────────
// React Router
// ─────────────────────────────────────────────────────────────

function extractReactRouterRoutes(content, filePath, projectRoot) {
  const routes = [];
  const relPath = relative(projectRoot, filePath);

  // Match <Route path="..." element={...} /> or path: "..."
  const routePatterns = [
    /<Route\s+[^>]*path\s*=\s*["']([^"']+)["'][^>]*>/g,
    /path\s*:\s*["']([^"']+)["']/g,
    /createBrowserRouter\s*\(\s*\[[\s\S]*?path\s*:\s*["']([^"']+)["']/g
  ];

  for (const pattern of routePatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1];
      if (!routes.some(r => r.path === path)) {
        routes.push({
          path,
          file: relPath,
          type: 'page'
        });
      }
    }
  }

  return routes;
}

// ─────────────────────────────────────────────────────────────
// Vue Router
// ─────────────────────────────────────────────────────────────

function extractVueRouterRoutes(content, filePath, projectRoot) {
  const routes = [];
  const relPath = relative(projectRoot, filePath);

  // Match path: '/...' in route configs
  const pathPattern = /path\s*:\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = pathPattern.exec(content)) !== null) {
    const path = match[1];
    if (!routes.some(r => r.path === path)) {
      routes.push({
        path,
        file: relPath,
        type: 'page'
      });
    }
  }

  return routes;
}

// ─────────────────────────────────────────────────────────────
// SvelteKit
// ─────────────────────────────────────────────────────────────

function extractSvelteKitRoutes(routesDir, projectRoot) {
  const routes = [];

  function scanDir(dir, routePath = '') {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        let segment = entry.name;

        if (segment.startsWith('(') && segment.endsWith(')')) {
          scanDir(fullPath, routePath);
        } else if (segment.startsWith('[') && segment.endsWith(']')) {
          segment = `:${segment.slice(1, -1)}`;
          scanDir(fullPath, `${routePath}/${segment}`);
        } else {
          scanDir(fullPath, `${routePath}/${segment}`);
        }
      } else if (entry.isFile()) {
        if (entry.name === '+page.svelte') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'page'
          });
        } else if (entry.name === '+server.js' || entry.name === '+server.ts') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'api'
          });
        } else if (entry.name === '+layout.svelte') {
          routes.push({
            path: routePath || '/',
            file: relative(projectRoot, fullPath),
            type: 'layout'
          });
        }
      }
    }
  }

  scanDir(routesDir);
  return routes;
}

// ─────────────────────────────────────────────────────────────
// File Discovery
// ─────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);

function findCodeFiles(dir, files = []) {
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!shouldSkip(entry.name, true)) {
        findCodeFiles(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext) && !shouldSkip(entry.name, false)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function buildRouteTree(routes) {
  const tree = { children: {}, routes: [] };

  for (const route of routes) {
    const parts = route.path.split('/').filter(Boolean);
    let node = tree;

    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { children: {}, routes: [] };
      }
      node = node.children[part];
    }

    node.routes.push(route);
  }

  return tree;
}

function printTree(node, out, prefix = '', isLast = true, path = '') {
  const childKeys = Object.keys(node.children);

  // Print routes at this level
  for (const route of node.routes) {
    const typeIcon = route.type === 'api' ? '⚡' : route.type === 'layout' ? '📐' : '📄';
    out.add(`${prefix}${typeIcon} ${route.path || '/'}`);
  }

  // Print children
  childKeys.forEach((key, index) => {
    const child = node.children[key];
    const isLastChild = index === childKeys.length - 1;
    const newPrefix = prefix + (isLast ? '  ' : '│ ');
    const branch = isLastChild ? '└─' : '├─';

    out.add(`${prefix}${branch} /${key}`);
    printTree(child, out, newPrefix, isLastChild, `${path}/${key}`);
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let treeView = false;
let withComponents = false;
let forcedFramework = null;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--tree') {
    treeView = true;
  } else if (arg === '--with-components') {
    withComponents = true;
  } else if (arg === '--framework') {
    forcedFramework = options.remaining[++i];
  } else if (!arg.startsWith('-')) {
    remaining.push(arg);
  }
}

const targetDir = remaining[0] || '.';

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

// Resolve target directory to absolute path
const targetAbsolute = targetDir.startsWith('/') ? targetDir : join(process.cwd(), targetDir);

// Use target directory as project root if it has package.json, otherwise find from cwd
const projectRoot = existsSync(join(targetAbsolute, 'package.json'))
  ? targetAbsolute
  : findProjectRoot(targetAbsolute);
const out = createOutput(options);

// Detect framework from target directory
const framework = forcedFramework || detectFramework(targetAbsolute);

let routes = [];

// Extract routes based on framework
const searchRoot = targetAbsolute;

if (framework === 'nextjs' || framework === 'nextjs-app') {
  // Try app directory first
  const appDirs = [
    join(searchRoot, 'app'),
    join(searchRoot, 'src/app')
  ];

  for (const appDir of appDirs) {
    if (existsSync(appDir)) {
      routes = extractNextAppRoutes(appDir, searchRoot);
      break;
    }
  }

  // Also check pages directory
  const pagesDirs = [
    join(searchRoot, 'pages'),
    join(searchRoot, 'src/pages')
  ];

  for (const pagesDir of pagesDirs) {
    if (existsSync(pagesDir)) {
      routes.push(...extractNextPagesRoutes(pagesDir, searchRoot));
    }
  }
} else if (framework === 'nextjs-pages') {
  const pagesDirs = [
    join(searchRoot, 'pages'),
    join(searchRoot, 'src/pages')
  ];

  for (const pagesDir of pagesDirs) {
    if (existsSync(pagesDir)) {
      routes = extractNextPagesRoutes(pagesDir, searchRoot);
      break;
    }
  }
} else if (framework === 'sveltekit') {
  const routesDirs = [
    join(searchRoot, 'src/routes'),
    join(searchRoot, 'routes')
  ];

  for (const routesDir of routesDirs) {
    if (existsSync(routesDir)) {
      routes = extractSvelteKitRoutes(routesDir, searchRoot);
      break;
    }
  }
} else if (framework === 'react-router' || framework === 'vue-router') {
  // Scan code files for route definitions
  const files = findCodeFiles(searchRoot);

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');

    if (framework === 'react-router') {
      routes.push(...extractReactRouterRoutes(content, file, searchRoot));
    } else {
      routes.push(...extractVueRouterRoutes(content, file, searchRoot));
    }
  }
} else {
  // Generic scan - look for common route patterns
  const files = findCodeFiles(searchRoot);

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    routes.push(...extractReactRouterRoutes(content, file, searchRoot));
    routes.push(...extractVueRouterRoutes(content, file, searchRoot));
  }
}

// Deduplicate routes
const seen = new Set();
routes = routes.filter(r => {
  const key = `${r.path}:${r.type}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Sort routes
routes.sort((a, b) => a.path.localeCompare(b.path));

// Set JSON data
out.setData('framework', framework);
out.setData('routes', routes);
out.setData('totalRoutes', routes.length);

// Output
out.header(`🛤️  Routes (${framework})`);
out.blank();

if (routes.length === 0) {
  out.add('No routes found');
} else if (treeView) {
  const tree = buildRouteTree(routes);
  printTree(tree, out);
} else {
  // Group by type
  const pages = routes.filter(r => r.type === 'page');
  const apis = routes.filter(r => r.type === 'api');
  const layouts = routes.filter(r => r.type === 'layout');

  if (pages.length > 0) {
    out.add('Pages:');
    for (const route of pages) {
      const component = withComponents ? ` → ${route.file}` : '';
      out.add(`  ${route.path}${component}`);
    }
    out.blank();
  }

  if (apis.length > 0) {
    out.add('API Routes:');
    for (const route of apis) {
      const component = withComponents ? ` → ${route.file}` : '';
      out.add(`  ${route.path}${component}`);
    }
    out.blank();
  }

  if (layouts.length > 0) {
    out.add('Layouts:');
    for (const route of layouts) {
      const component = withComponents ? ` → ${route.file}` : '';
      out.add(`  ${route.path}${component}`);
    }
    out.blank();
  }
}

// Summary
if (!options.quiet && routes.length > 0) {
  const pages = routes.filter(r => r.type === 'page').length;
  const apis = routes.filter(r => r.type === 'api').length;
  const layouts = routes.filter(r => r.type === 'layout').length;

  const parts = [];
  if (pages > 0) parts.push(`${pages} pages`);
  if (apis > 0) parts.push(`${apis} API`);
  if (layouts > 0) parts.push(`${layouts} layouts`);

  out.add(`Total: ${parts.join(', ')}`);
}

out.print();
