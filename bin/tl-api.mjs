#!/usr/bin/env node

/**
 * tl-api - Extract REST/GraphQL API endpoints from code
 *
 * Scans source files for API endpoint definitions in common frameworks
 * (Express, Fastify, Koa, Hono, NestJS, etc.) and GraphQL schemas.
 *
 * Usage: tl-api [dir] [--rest-only] [--graphql-only]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-api',
    desc: 'Extract REST/GraphQL API endpoints',
    when: 'before-read',
    example: 'tl-api src/api/'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot, findCodeFiles } from '../src/project.mjs';

const HELP = `
tl-api - Extract REST/GraphQL API endpoints from code

Usage: tl-api [dir] [options]

Options:
  --rest-only, -r       Only show REST endpoints
  --graphql-only, -g    Only show GraphQL operations
  --group-by-file       Group endpoints by file (default: by method)
  --with-handlers       Show handler function names
${COMMON_OPTIONS_HELP}

Examples:
  tl-api                          # All endpoints
  tl-api src/routes/              # Scan specific directory
  tl-api -r                       # REST only
  tl-api --group-by-file          # Group by file

Detects:
  REST: Express, Fastify, Koa, Hono, NestJS decorators, fetch handlers
  GraphQL: Query/Mutation/Subscription definitions, resolvers
`;

// ─────────────────────────────────────────────────────────────
// REST Endpoint Extraction
// ─────────────────────────────────────────────────────────────

function extractRestEndpoints(content, filePath) {
  const endpoints = [];
  const lines = content.split('\n');

  // Common HTTP methods
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
  const methodsUpper = methods.map(m => m.toUpperCase());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Express/Koa/Fastify style: app.get('/path', handler) or router.post('/path', ...)
    for (const method of methods) {
      // Match: app.get('/path' or router.get("/path" or .get(`/path`
      const routerPattern = new RegExp(`\\.(${method})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'i');
      const match = trimmed.match(routerPattern);
      if (match) {
        const handler = extractHandlerName(trimmed, lines, i);
        endpoints.push({
          method: match[1].toUpperCase(),
          path: match[2],
          line: i + 1,
          handler,
          framework: 'express-like'
        });
      }
    }

    // NestJS decorators: @Get('/path'), @Post('/path'), etc.
    for (const method of methodsUpper) {
      const decoratorPattern = new RegExp(`@(${method})\\s*\\(\\s*['"\`]?([^'"\`\\)]*)?['"\`]?\\s*\\)`, 'i');
      const match = trimmed.match(decoratorPattern);
      if (match) {
        // Get the method name from next non-decorator line
        let handler = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (!nextLine.startsWith('@') && nextLine.includes('(')) {
            const funcMatch = nextLine.match(/(?:async\s+)?(\w+)\s*\(/);
            if (funcMatch) handler = funcMatch[1];
            break;
          }
        }
        endpoints.push({
          method: match[1].toUpperCase(),
          path: match[2] || '/',
          line: i + 1,
          handler,
          framework: 'nestjs'
        });
      }
    }

    // Hono style: app.get('/path', (c) => ...) or new Hono().get(...)
    const honoPattern = /\.(?:on|get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i;
    const honoMatch = trimmed.match(honoPattern);
    if (honoMatch && !endpoints.some(e => e.line === i + 1)) {
      const methodMatch = trimmed.match(/\.(get|post|put|patch|delete|on)\s*\(/i);
      if (methodMatch) {
        endpoints.push({
          method: methodMatch[1].toUpperCase(),
          path: honoMatch[1],
          line: i + 1,
          handler: '',
          framework: 'hono'
        });
      }
    }

    // Next.js API routes: export async function GET/POST/etc
    const nextPattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/;
    const nextMatch = trimmed.match(nextPattern);
    if (nextMatch) {
      endpoints.push({
        method: nextMatch[1],
        path: '(from filename)',
        line: i + 1,
        handler: nextMatch[1],
        framework: 'nextjs'
      });
    }

    // Fetch API route handlers: case 'GET': or method === 'POST'
    const fetchPattern = /(?:case\s+['"]|method\s*===?\s*['"])(GET|POST|PUT|PATCH|DELETE)['"]:/i;
    const fetchMatch = trimmed.match(fetchPattern);
    if (fetchMatch) {
      endpoints.push({
        method: fetchMatch[1].toUpperCase(),
        path: '(handler)',
        line: i + 1,
        handler: '',
        framework: 'fetch'
      });
    }
  }

  return endpoints;
}

function extractHandlerName(line, lines, lineIndex) {
  // Try to find handler name in the same line or next lines
  // Pattern: , handlerName) or , (req, res) =>
  const inlineMatch = line.match(/,\s*(\w+)\s*\)/);
  if (inlineMatch && !['req', 'res', 'ctx', 'c', 'request', 'response'].includes(inlineMatch[1])) {
    return inlineMatch[1];
  }

  // Check for arrow function or function reference
  const arrowMatch = line.match(/,\s*(?:async\s+)?\(.*?\)\s*=>/);
  if (arrowMatch) return '(inline)';

  return '';
}

// ─────────────────────────────────────────────────────────────
// GraphQL Extraction
// ─────────────────────────────────────────────────────────────

function extractGraphqlOperations(content, filePath) {
  const operations = [];
  const lines = content.split('\n');

  // Track if we're in a type definition
  let currentType = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // GraphQL SDL: type Query { ... }
    const typeMatch = trimmed.match(/^type\s+(Query|Mutation|Subscription)\s*\{?/);
    if (typeMatch) {
      currentType = typeMatch[1];
      braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }

    // Track brace depth
    if (currentType) {
      braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

      if (braceDepth <= 0) {
        currentType = null;
        continue;
      }

      // Field definition: fieldName(args): Type
      const fieldMatch = trimmed.match(/^(\w+)\s*(?:\([^)]*\))?\s*:/);
      if (fieldMatch && !trimmed.startsWith('#')) {
        operations.push({
          type: currentType,
          name: fieldMatch[1],
          line: i + 1,
          source: 'schema'
        });
      }
    }

    // Resolver definitions: Query: { fieldName: ... } or Mutation: { ... }
    const resolverTypeMatch = trimmed.match(/^(Query|Mutation|Subscription)\s*:\s*\{/);
    if (resolverTypeMatch) {
      currentType = resolverTypeMatch[1];
      braceDepth = 1;
      continue;
    }

    // NestJS GraphQL decorators: @Query(), @Mutation()
    const decoratorMatch = trimmed.match(/@(Query|Mutation|Subscription)\s*\(/);
    if (decoratorMatch) {
      // Get operation name from next line
      let opName = '';
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (!nextLine.startsWith('@')) {
          const funcMatch = nextLine.match(/(?:async\s+)?(\w+)\s*\(/);
          if (funcMatch) opName = funcMatch[1];
          break;
        }
      }
      operations.push({
        type: decoratorMatch[1],
        name: opName || '(unknown)',
        line: i + 1,
        source: 'decorator'
      });
    }

    // gql tagged template: Query { fieldName }
    if (trimmed.includes('gql`') || trimmed.includes('gql(')) {
      // Simple extraction from template literals
      const gqlContent = extractGqlTemplate(lines, i);
      const gqlOps = parseGqlString(gqlContent, i + 1);
      operations.push(...gqlOps);
    }
  }

  return operations;
}

function extractGqlTemplate(lines, startLine) {
  let content = '';
  let depth = 0;
  let started = false;

  for (let i = startLine; i < Math.min(startLine + 50, lines.length); i++) {
    const line = lines[i];

    if (line.includes('`')) {
      if (!started) {
        started = true;
        content += line.split('`')[1] || '';
      } else {
        content += line.split('`')[0] || '';
        break;
      }
    } else if (started) {
      content += line + '\n';
    }
  }

  return content;
}

function parseGqlString(content, baseLine) {
  const operations = [];
  const lines = content.split('\n');

  let currentType = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const typeMatch = trimmed.match(/^type\s+(Query|Mutation|Subscription)/);
    if (typeMatch) {
      currentType = typeMatch[1];
      continue;
    }

    if (currentType && trimmed.match(/^\w+\s*[(:]/)) {
      const fieldMatch = trimmed.match(/^(\w+)/);
      if (fieldMatch) {
        operations.push({
          type: currentType,
          name: fieldMatch[1],
          line: baseLine + i,
          source: 'gql-template'
        });
      }
    }

    if (trimmed === '}') {
      currentType = null;
    }
  }

  return operations;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

// Parse custom options
let restOnly = false;
let graphqlOnly = false;
let groupByFile = false;
let withHandlers = false;

const remaining = [];
for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--rest-only' || arg === '-r') {
    restOnly = true;
  } else if (arg === '--graphql-only' || arg === '-g') {
    graphqlOnly = true;
  } else if (arg === '--group-by-file') {
    groupByFile = true;
  } else if (arg === '--with-handlers') {
    withHandlers = true;
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

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Find all code files
let files = [];
const stat = statSync(targetDir);
if (stat.isFile()) {
  files = [targetDir];
} else {
  files = findCodeFiles(targetDir);
}

if (files.length === 0) {
  console.error('No code files found');
  process.exit(1);
}

const allRest = [];
const allGraphql = [];

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const relPath = relative(projectRoot, file);

  if (!graphqlOnly) {
    const rest = extractRestEndpoints(content, file);
    rest.forEach(e => allRest.push({ ...e, file: relPath }));
  }

  if (!restOnly) {
    const graphql = extractGraphqlOperations(content, file);
    graphql.forEach(o => allGraphql.push({ ...o, file: relPath }));
  }
}

// Deduplicate GraphQL operations (same name+type+file)
const seenGraphql = new Set();
const dedupedGraphql = allGraphql.filter(op => {
  const key = `${op.type}:${op.name}:${op.file}`;
  if (seenGraphql.has(key)) return false;
  seenGraphql.add(key);
  return true;
});

// Set JSON data
out.setData('rest', allRest);
out.setData('graphql', dedupedGraphql);
out.setData('totalEndpoints', allRest.length + dedupedGraphql.length);

// Output REST endpoints
if (allRest.length > 0) {
  out.header(`REST Endpoints (${allRest.length})`);
  out.blank();

  if (groupByFile) {
    const byFile = new Map();
    for (const ep of allRest) {
      if (!byFile.has(ep.file)) byFile.set(ep.file, []);
      byFile.get(ep.file).push(ep);
    }

    for (const [file, endpoints] of byFile) {
      out.add(`  ${file}`);
      for (const ep of endpoints) {
        const handler = withHandlers && ep.handler ? ` -> ${ep.handler}` : '';
        out.add(`    ${ep.method.padEnd(7)} ${ep.path}${handler}`);
      }
    }
  } else {
    // Group by method
    const byMethod = new Map();
    for (const ep of allRest) {
      if (!byMethod.has(ep.method)) byMethod.set(ep.method, []);
      byMethod.get(ep.method).push(ep);
    }

    const methodOrder = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'];
    for (const method of methodOrder) {
      const endpoints = byMethod.get(method);
      if (!endpoints) continue;

      out.add(`  ${method}`);
      for (const ep of endpoints) {
        const handler = withHandlers && ep.handler ? ` -> ${ep.handler}` : '';
        const location = groupByFile ? '' : ` (${ep.file}:${ep.line})`;
        out.add(`    ${ep.path}${handler}${location}`);
      }
    }
  }
  out.blank();
}

// Output GraphQL operations
if (dedupedGraphql.length > 0) {
  out.header(`GraphQL Operations (${dedupedGraphql.length})`);
  out.blank();

  const byType = new Map();
  for (const op of dedupedGraphql) {
    if (!byType.has(op.type)) byType.set(op.type, []);
    byType.get(op.type).push(op);
  }

  for (const type of ['Query', 'Mutation', 'Subscription']) {
    const ops = byType.get(type);
    if (!ops) continue;

    out.add(`  ${type}`);
    for (const op of ops) {
      out.add(`    ${op.name} (${op.file}:${op.line})`);
    }
  }
  out.blank();
}

// Summary
if (!options.quiet) {
  if (allRest.length === 0 && dedupedGraphql.length === 0) {
    out.add('No API endpoints found');
  } else {
    const parts = [];
    if (allRest.length > 0) parts.push(`${allRest.length} REST`);
    if (dedupedGraphql.length > 0) parts.push(`${dedupedGraphql.length} GraphQL`);
    out.add(`Total: ${parts.join(', ')} endpoints`);
  }
}

out.print();
