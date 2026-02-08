#!/usr/bin/env node

/**
 * tl-stack - Auto-detect project technology stack
 *
 * Scans manifest files, configs, and dependencies to produce
 * a compact "project DNA" summary. One command, full picture.
 *
 * Usage: tl-stack [dir] [options]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-stack',
    desc: 'Auto-detect project technology stack',
    when: 'before-read',
    example: 'tl-stack'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-stack - Auto-detect project technology stack

Usage: tl-stack [dir] [options]

Scans manifest files, configs, and dependencies to produce
a compact "project DNA" summary. One command, full picture.

Options:
${COMMON_OPTIONS_HELP}

Examples:
  tl-stack                        # Current project
  tl-stack /path/to/project       # Specific directory
  tl-stack -j                     # JSON output
  tl-stack -q                     # Compact, no header
`;

// ─────────────────────────────────────────────────────────────
// Version Helpers
// ─────────────────────────────────────────────────────────────

function cleanVersion(v) {
  if (!v || v === '*' || v === 'latest') return null;
  const m = v.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return null; }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

function exists(dir, ...paths) {
  return existsSync(join(dir, ...paths));
}

function hasDir(dir, name) {
  try {
    const entries = readdirSync(join(dir, name), { withFileTypes: true });
    return entries.length > 0;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// Dependency Detection Maps
// ─────────────────────────────────────────────────────────────

// dep name -> [category, display name]
const DEP_MAP = {
  // Frameworks (full-stack / SSR)
  'next':                 ['framework', 'Next.js'],
  'nuxt':                 ['framework', 'Nuxt'],
  '@remix-run/react':     ['framework', 'Remix'],
  'gatsby':               ['framework', 'Gatsby'],
  'astro':                ['framework', 'Astro'],
  '@angular/core':        ['framework', 'Angular'],
  '@sveltejs/kit':        ['framework', 'SvelteKit'],

  // UI Libraries
  'react':                ['ui', 'React'],
  'react-native':         ['ui', 'React Native'],
  'expo':                 ['ui', 'Expo'],
  'vue':                  ['ui', 'Vue'],
  'svelte':               ['ui', 'Svelte'],
  'solid-js':             ['ui', 'Solid'],
  'preact':               ['ui', 'Preact'],
  'htmx.org':             ['ui', 'htmx'],

  // Server Frameworks
  'express':              ['server', 'Express'],
  'fastify':              ['server', 'Fastify'],
  'koa':                  ['server', 'Koa'],
  'hono':                 ['server', 'Hono'],
  '@nestjs/core':         ['server', 'NestJS'],
  '@hapi/hapi':           ['server', 'Hapi'],

  // Desktop/Runtime
  'electron':             ['runtime', 'Electron'],
  'tauri':                ['runtime', 'Tauri'],

  // Styling
  'tailwindcss':          ['styling', 'Tailwind CSS'],
  'styled-components':    ['styling', 'Styled Components'],
  '@emotion/react':       ['styling', 'Emotion'],
  '@emotion/styled':      ['styling', 'Emotion'],
  'sass':                 ['styling', 'Sass'],
  'node-sass':            ['styling', 'Sass'],
  'less':                 ['styling', 'Less'],
  '@mui/material':        ['styling', 'Material UI'],
  '@chakra-ui/react':     ['styling', 'Chakra UI'],
  'antd':                 ['styling', 'Ant Design'],
  '@radix-ui/react-slot': ['styling', 'Radix UI'],
  'shadcn-ui':            ['styling', 'shadcn/ui'],

  // State Management
  '@reduxjs/toolkit':     ['state', 'Redux Toolkit'],
  'redux':                ['state', 'Redux'],
  'zustand':              ['state', 'Zustand'],
  'mobx':                 ['state', 'MobX'],
  'recoil':               ['state', 'Recoil'],
  'jotai':                ['state', 'Jotai'],
  'pinia':                ['state', 'Pinia'],
  'vuex':                 ['state', 'Vuex'],
  'xstate':               ['state', 'XState'],
  '@tanstack/react-query':['state', 'TanStack Query'],
  'swr':                  ['state', 'SWR'],

  // ORM / Database Clients
  'prisma':               ['orm', 'Prisma'],
  '@prisma/client':       ['orm', 'Prisma'],
  'drizzle-orm':          ['orm', 'Drizzle'],
  'typeorm':              ['orm', 'TypeORM'],
  'sequelize':            ['orm', 'Sequelize'],
  'mongoose':             ['orm', 'Mongoose'],
  'knex':                 ['orm', 'Knex'],
  'kysely':               ['orm', 'Kysely'],
  '@mikro-orm/core':      ['orm', 'MikroORM'],
  'better-sqlite3':       ['database', 'SQLite'],
  'pg':                   ['database', 'PostgreSQL'],
  'mysql2':               ['database', 'MySQL'],
  'ioredis':              ['database', 'Redis'],
  'redis':                ['database', 'Redis'],
  '@supabase/supabase-js':['database', 'Supabase'],
  'firebase':             ['database', 'Firebase'],
  '@aws-sdk/client-dynamodb': ['database', 'DynamoDB'],

  // Testing
  'jest':                 ['testing', 'Jest'],
  'vitest':               ['testing', 'Vitest'],
  'mocha':                ['testing', 'Mocha'],
  'cypress':              ['testing', 'Cypress'],
  '@playwright/test':     ['testing', 'Playwright'],
  'playwright':           ['testing', 'Playwright'],
  '@testing-library/react': ['testing', 'Testing Library'],
  '@testing-library/vue': ['testing', 'Testing Library'],
  'storybook':            ['testing', 'Storybook'],
  '@storybook/react':     ['testing', 'Storybook'],
  'supertest':            ['testing', 'Supertest'],

  // API
  'graphql':              ['api', 'GraphQL'],
  '@apollo/server':       ['api', 'Apollo GraphQL'],
  '@apollo/client':       ['api', 'Apollo Client'],
  '@trpc/server':         ['api', 'tRPC'],
  '@trpc/client':         ['api', 'tRPC'],
  '@grpc/grpc-js':        ['api', 'gRPC'],
  'socket.io':            ['api', 'Socket.IO'],
  'ws':                   ['api', 'WebSockets'],

  // Auth
  'next-auth':            ['auth', 'NextAuth'],
  'passport':             ['auth', 'Passport'],
  '@auth0/nextjs-auth0':  ['auth', 'Auth0'],
  '@clerk/nextjs':        ['auth', 'Clerk'],
  'lucia':                ['auth', 'Lucia'],

  // Linting (devDeps usually)
  'eslint':               ['linting', 'ESLint'],
  'prettier':             ['linting', 'Prettier'],
  '@biomejs/biome':       ['linting', 'Biome'],
  'stylelint':            ['linting', 'Stylelint'],
  'oxlint':               ['linting', 'Oxlint'],

  // Bundler
  'webpack':              ['bundler', 'Webpack'],
  'vite':                 ['bundler', 'Vite'],
  'esbuild':              ['bundler', 'esbuild'],
  'rollup':               ['bundler', 'Rollup'],
  'parcel':               ['bundler', 'Parcel'],
  'tsup':                 ['bundler', 'tsup'],
  'turbopack':            ['bundler', 'Turbopack'],
};

// Frameworks that suppress showing their UI lib separately
const SUPPRESSIONS = {
  'Next.js':    ['React'],
  'Remix':      ['React'],
  'Gatsby':     ['React'],
  'Nuxt':       ['Vue'],
  'SvelteKit':  ['Svelte'],
  'Expo':       ['React Native', 'React'],
};

// ─────────────────────────────────────────────────────────────
// File-Based Detection
// ─────────────────────────────────────────────────────────────

function detectFromFiles(dir) {
  const found = [];

  // CI/CD
  if (hasDir(dir, '.github/workflows'))
    found.push({ category: 'ci', name: 'GitHub Actions' });
  if (exists(dir, '.gitlab-ci.yml'))
    found.push({ category: 'ci', name: 'GitLab CI' });
  if (exists(dir, '.circleci/config.yml'))
    found.push({ category: 'ci', name: 'CircleCI' });
  if (exists(dir, 'Jenkinsfile'))
    found.push({ category: 'ci', name: 'Jenkins' });
  if (exists(dir, '.travis.yml'))
    found.push({ category: 'ci', name: 'Travis CI' });
  if (exists(dir, 'bitbucket-pipelines.yml'))
    found.push({ category: 'ci', name: 'Bitbucket Pipelines' });

  // Deploy
  if (exists(dir, 'Dockerfile'))
    found.push({ category: 'deploy', name: 'Docker' });
  if (exists(dir, 'docker-compose.yml') || exists(dir, 'docker-compose.yaml') || exists(dir, 'compose.yml'))
    found.push({ category: 'deploy', name: 'Docker Compose' });
  if (exists(dir, 'vercel.json') || exists(dir, '.vercel'))
    found.push({ category: 'deploy', name: 'Vercel' });
  if (exists(dir, 'netlify.toml'))
    found.push({ category: 'deploy', name: 'Netlify' });
  if (exists(dir, 'fly.toml'))
    found.push({ category: 'deploy', name: 'Fly.io' });
  if (exists(dir, 'render.yaml'))
    found.push({ category: 'deploy', name: 'Render' });
  if (exists(dir, 'Procfile'))
    found.push({ category: 'deploy', name: 'Heroku' });
  if (exists(dir, 'cdk.json'))
    found.push({ category: 'deploy', name: 'AWS CDK' });
  if (exists(dir, 'serverless.yml') || exists(dir, 'serverless.yaml'))
    found.push({ category: 'deploy', name: 'Serverless' });
  if (exists(dir, 'terraform'))
    found.push({ category: 'deploy', name: 'Terraform' });

  // Monorepo
  if (exists(dir, 'turbo.json'))
    found.push({ category: 'monorepo', name: 'Turborepo' });
  if (exists(dir, 'nx.json'))
    found.push({ category: 'monorepo', name: 'Nx' });
  if (exists(dir, 'lerna.json'))
    found.push({ category: 'monorepo', name: 'Lerna' });
  if (exists(dir, 'pnpm-workspace.yaml'))
    found.push({ category: 'monorepo', name: 'pnpm workspaces' });

  // Package manager
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock'))
    found.push({ category: 'package', name: 'bun' });
  else if (exists(dir, 'pnpm-lock.yaml'))
    found.push({ category: 'package', name: 'pnpm' });
  else if (exists(dir, 'yarn.lock'))
    found.push({ category: 'package', name: 'yarn' });
  else if (exists(dir, 'package-lock.json'))
    found.push({ category: 'package', name: 'npm' });

  // Language
  if (exists(dir, 'tsconfig.json'))
    found.push({ category: 'language', name: 'TypeScript' });
  if (exists(dir, '.flowconfig'))
    found.push({ category: 'language', name: 'Flow' });

  // Linting (file-based — catches cases without deps listed)
  if (exists(dir, 'biome.json') || exists(dir, 'biome.jsonc'))
    found.push({ category: 'linting', name: 'Biome' });

  return found;
}

// ─────────────────────────────────────────────────────────────
// Node.js Detection (package.json)
// ─────────────────────────────────────────────────────────────

function detectFromPackageJson(dir) {
  const pkg = readJSON(join(dir, 'package.json'));
  if (!pkg) return { found: [], pkg: null };

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const found = [];

  // Runtime
  const nodeVersion = pkg.engines?.node;
  found.push({
    category: 'runtime',
    name: 'Node.js',
    version: nodeVersion ? cleanVersion(nodeVersion) + (nodeVersion.startsWith('>=') ? '+' : '') : null
  });

  // Language — TypeScript version
  if (allDeps['typescript']) {
    found.push({ category: 'language', name: 'TypeScript', version: cleanVersion(allDeps['typescript']) });
  }

  // Scan all deps against the map
  for (const [dep, version] of Object.entries(allDeps)) {
    const mapping = DEP_MAP[dep];
    if (mapping) {
      const [category, name] = mapping;
      // Skip duplicates
      if (!found.some(f => f.name === name)) {
        found.push({ category, name, version: cleanVersion(version) });
      }
    }
  }

  // Framework details
  if (allDeps['next']) {
    if (hasDir(dir, 'app')) {
      const detail = exists(dir, 'pages') ? 'hybrid (App + Pages)' : 'App Router';
      const entry = found.find(f => f.name === 'Next.js');
      if (entry) entry.detail = detail;
    } else if (hasDir(dir, 'pages')) {
      const entry = found.find(f => f.name === 'Next.js');
      if (entry) entry.detail = 'Pages Router';
    }
  }

  // Scripts-based detection
  const scripts = pkg.scripts || {};
  const scriptStr = Object.values(scripts).join(' ');
  if (/\bvitest\b/.test(scriptStr) && !found.some(f => f.name === 'Vitest'))
    found.push({ category: 'testing', name: 'Vitest' });
  if (/\bjest\b/.test(scriptStr) && !found.some(f => f.name === 'Jest'))
    found.push({ category: 'testing', name: 'Jest' });
  if (/\bcypress\b/.test(scriptStr) && !found.some(f => f.name === 'Cypress'))
    found.push({ category: 'testing', name: 'Cypress' });

  return { found, pkg };
}

// ─────────────────────────────────────────────────────────────
// Go Detection
// ─────────────────────────────────────────────────────────────

function detectFromGoMod(dir) {
  const content = readText(join(dir, 'go.mod'));
  if (!content) return [];

  const found = [];

  const goVer = content.match(/^go\s+(\d+\.\d+)/m);
  found.push({ category: 'runtime', name: 'Go', version: goVer ? goVer[1] : null });
  found.push({ category: 'language', name: 'Go' });

  // Detect common Go frameworks
  const goFrameworks = {
    'github.com/gin-gonic/gin': 'Gin',
    'github.com/labstack/echo': 'Echo',
    'github.com/gofiber/fiber': 'Fiber',
    'github.com/gorilla/mux': 'Gorilla Mux',
    'github.com/go-chi/chi': 'Chi',
  };

  const goLibs = {
    'gorm.io/gorm': ['orm', 'GORM'],
    'github.com/jmoiron/sqlx': ['orm', 'sqlx'],
    'github.com/lib/pq': ['database', 'PostgreSQL'],
    'github.com/go-sql-driver/mysql': ['database', 'MySQL'],
    'github.com/go-redis/redis': ['database', 'Redis'],
    'go.mongodb.org/mongo-driver': ['database', 'MongoDB'],
  };

  for (const [pkg, name] of Object.entries(goFrameworks)) {
    if (content.includes(pkg)) found.push({ category: 'framework', name });
  }
  for (const [pkg, [cat, name]] of Object.entries(goLibs)) {
    if (content.includes(pkg)) found.push({ category: cat, name });
  }

  found.push({ category: 'testing', name: 'go test (built-in)' });

  return found;
}

// ─────────────────────────────────────────────────────────────
// Python Detection
// ─────────────────────────────────────────────────────────────

function detectFromPython(dir) {
  const found = [];
  let depsText = '';

  // Read pyproject.toml or requirements.txt
  const pyproject = readText(join(dir, 'pyproject.toml'));
  const requirements = readText(join(dir, 'requirements.txt'));

  if (pyproject) {
    depsText = pyproject;
    const pyVer = pyproject.match(/python\s*=\s*"([^"]+)"/);
    found.push({
      category: 'runtime',
      name: 'Python',
      version: pyVer ? cleanVersion(pyVer[1]) + (pyVer[1].startsWith('^') || pyVer[1].startsWith('>=') ? '+' : '') : null
    });

    // Detect build system
    if (pyproject.includes('[tool.poetry]')) found.push({ category: 'package', name: 'Poetry' });
    else if (pyproject.includes('[tool.hatch]')) found.push({ category: 'package', name: 'Hatch' });
    else if (pyproject.includes('[build-system]')) found.push({ category: 'package', name: 'pip' });
  } else if (requirements) {
    depsText = requirements;
    found.push({ category: 'runtime', name: 'Python' });
    found.push({ category: 'package', name: 'pip' });
  } else if (exists(dir, 'setup.py')) {
    depsText = readText(join(dir, 'setup.py')) || '';
    found.push({ category: 'runtime', name: 'Python' });
  } else {
    return [];
  }

  found.push({ category: 'language', name: 'Python' });

  const pyDeps = {
    'django': ['framework', 'Django'],
    'flask': ['framework', 'Flask'],
    'fastapi': ['framework', 'FastAPI'],
    'starlette': ['framework', 'Starlette'],
    'streamlit': ['framework', 'Streamlit'],
    'sqlalchemy': ['orm', 'SQLAlchemy'],
    'tortoise-orm': ['orm', 'Tortoise ORM'],
    'django-rest-framework': ['api', 'DRF'],
    'celery': ['infra', 'Celery'],
    'pytest': ['testing', 'pytest'],
    'unittest': ['testing', 'unittest'],
    'ruff': ['linting', 'Ruff'],
    'black': ['linting', 'Black'],
    'mypy': ['linting', 'mypy'],
    'flake8': ['linting', 'Flake8'],
    'psycopg2': ['database', 'PostgreSQL'],
    'pymongo': ['database', 'MongoDB'],
    'redis': ['database', 'Redis'],
  };

  const lower = depsText.toLowerCase();
  for (const [dep, [cat, name]] of Object.entries(pyDeps)) {
    if (lower.includes(dep)) found.push({ category: cat, name });
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Rust Detection
// ─────────────────────────────────────────────────────────────

function detectFromRust(dir) {
  const content = readText(join(dir, 'Cargo.toml'));
  if (!content) return [];

  const found = [];
  found.push({ category: 'runtime', name: 'Rust' });
  found.push({ category: 'language', name: 'Rust' });
  found.push({ category: 'package', name: 'Cargo' });

  const rustDeps = {
    'actix-web': ['framework', 'Actix Web'],
    'axum': ['framework', 'Axum'],
    'rocket': ['framework', 'Rocket'],
    'warp': ['framework', 'Warp'],
    'tokio': ['runtime', 'Tokio'],
    'diesel': ['orm', 'Diesel'],
    'sqlx': ['orm', 'SQLx'],
    'sea-orm': ['orm', 'SeaORM'],
    'serde': ['infra', 'Serde'],
    'tauri': ['runtime', 'Tauri'],
  };

  for (const [dep, [cat, name]] of Object.entries(rustDeps)) {
    if (content.includes(`"${dep}"`) || content.includes(`${dep} =`)) {
      found.push({ category: cat, name });
    }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Docker Compose Database Detection
// ─────────────────────────────────────────────────────────────

function detectFromDockerCompose(dir) {
  const files = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'];
  let content = null;

  for (const f of files) {
    content = readText(join(dir, f));
    if (content) break;
  }
  if (!content) return [];

  const found = [];
  const imageMap = {
    'postgres': 'PostgreSQL',
    'mysql': 'MySQL',
    'mariadb': 'MariaDB',
    'mongo': 'MongoDB',
    'redis': 'Redis',
    'elasticsearch': 'Elasticsearch',
    'rabbitmq': 'RabbitMQ',
    'memcached': 'Memcached',
    'minio': 'MinIO',
  };

  for (const [image, name] of Object.entries(imageMap)) {
    if (new RegExp(`image:\\s*${image}`, 'i').test(content)) {
      found.push({ category: 'database', name });
    }
  }

  return found;
}

// ─────────────────────────────────────────────────────────────
// Post-Processing
// ─────────────────────────────────────────────────────────────

function postProcess(detections) {
  // Deduplicate
  const seen = new Set();
  const unique = detections.filter(d => {
    const key = `${d.category}:${d.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Apply suppressions: if Next.js exists, merge React into its detail
  const frameworkNames = new Set(unique.filter(d => d.category === 'framework').map(d => d.name));
  const suppressed = new Set();

  for (const [framework, suppList] of Object.entries(SUPPRESSIONS)) {
    if (frameworkNames.has(framework)) {
      for (const supp of suppList) suppressed.add(supp);
    }
  }

  // For suppressed UI libs, merge their version into the framework detail
  const result = [];
  for (const d of unique) {
    if (d.category === 'ui' && suppressed.has(d.name)) {
      // Merge into framework
      const fw = result.find(r => r.category === 'framework' && SUPPRESSIONS[r.name]?.includes(d.name));
      if (fw) {
        const info = d.version ? `${d.name} ${d.version}` : d.name;
        fw.detail = fw.detail ? `${info}, ${fw.detail}` : info;
      }
      continue;
    }
    result.push(d);
  }

  // Suppress duplicate language entries (e.g., TypeScript from file + dep)
  // Keep the one with a version
  const langMap = {};
  for (const d of result) {
    if (d.category === 'language') {
      if (!langMap[d.name] || d.version) langMap[d.name] = d;
    }
  }
  return result.filter(d => d.category !== 'language' || langMap[d.name] === d);
}

// ─────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────

const CATEGORY_ORDER = [
  'runtime', 'language', 'framework', 'ui', 'server', 'styling', 'state',
  'orm', 'database', 'api', 'auth', 'testing', 'linting', 'bundler',
  'infra', 'ci', 'deploy', 'monorepo', 'package'
];

const CATEGORY_LABELS = {
  runtime: 'Runtime',
  language: 'Language',
  framework: 'Framework',
  ui: 'UI',
  server: 'Server',
  styling: 'Styling',
  state: 'State',
  orm: 'ORM',
  database: 'Database',
  api: 'API',
  auth: 'Auth',
  testing: 'Testing',
  linting: 'Linting',
  bundler: 'Bundler',
  infra: 'Infra',
  ci: 'CI/CD',
  deploy: 'Deploy',
  monorepo: 'Monorepo',
  package: 'Package',
};

function formatEntry(d) {
  let s = d.name;
  if (d.version) s += ` ${d.version}`;
  if (d.detail) s += ` (${d.detail})`;
  return s;
}

function displayStack(out, detections, quiet) {
  // Group by category
  const groups = {};
  for (const d of detections) {
    if (!groups[d.category]) groups[d.category] = [];
    groups[d.category].push(d);
  }

  // Find max label length for alignment
  const activeCategories = CATEGORY_ORDER.filter(c => groups[c]);
  const maxLabel = Math.max(...activeCategories.map(c => CATEGORY_LABELS[c].length));

  for (const cat of CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    const label = CATEGORY_LABELS[cat].padEnd(maxLabel);
    const entries = groups[cat].map(formatEntry).join(', ');
    out.add(`  ${label}   ${entries}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main() {
  const opts = parseCommonArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP.trim());
    process.exit(0);
  }

  const dir = resolve(opts.remaining[0] || findProjectRoot() || '.');

  if (!existsSync(dir)) {
    console.error(`Error: directory not found: ${dir}`);
    process.exit(1);
  }

  // Collect all detections
  let detections = [];

  // File-based detections (CI, deploy, monorepo, package manager, language)
  detections.push(...detectFromFiles(dir));

  // Ecosystem-specific detections
  const { found: nodeDets } = detectFromPackageJson(dir);
  detections.push(...nodeDets);
  detections.push(...detectFromGoMod(dir));
  detections.push(...detectFromPython(dir));
  detections.push(...detectFromRust(dir));
  detections.push(...detectFromDockerCompose(dir));

  if (detections.length === 0) {
    console.error('Error: no recognizable project files found');
    process.exit(1);
  }

  // Post-process
  detections = postProcess(detections);

  // Output
  const out = createOutput(opts);
  out.header('Project Stack');
  out.blank();

  if (opts.json) {
    // Group for JSON
    const groups = {};
    for (const d of detections) {
      if (!groups[d.category]) groups[d.category] = [];
      groups[d.category].push({
        name: d.name,
        ...(d.version && { version: d.version }),
        ...(d.detail && { detail: d.detail })
      });
    }
    out.setData('stack', groups);
  }

  displayStack(out, detections, opts.quiet);
  out.print();
}

main();
