#!/usr/bin/env node

/**
 * tl-schema - Extract database schema from ORMs and migrations
 *
 * Supports: Prisma, Drizzle, TypeORM, and raw SQL migrations
 * Shows tables, columns, types, and relationships without reading full files.
 *
 * Usage: tl-schema [path]
 */

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-schema',
    desc: 'Extract database schema from ORMs',
    when: 'before-read',
    example: 'tl-schema'
  }));
  process.exit(0);
}

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-schema - Extract database schema from ORMs and migrations

Usage: tl-schema [path] [options]

Options:
  --format <fmt>        Output format: compact, detailed, sql (default: compact)
  --orm <type>          Force ORM type: prisma, drizzle, typeorm, sql, mongoose
  --relations, -r       Show relationships only
  --no-relations        Hide relationships
${COMMON_OPTIONS_HELP}

Examples:
  tl-schema                      # Auto-detect and show schema
  tl-schema prisma/              # Scan specific directory
  tl-schema --format detailed    # Show column details
  tl-schema --orm prisma         # Force Prisma parser
  tl-schema -r                   # Show only relationships

Supports:
  Prisma:   schema.prisma files
  Drizzle:  TypeScript schema files (schema.ts, *.schema.ts)
  TypeORM:  Entity decorators (@Entity, @Column)
  SQL:      CREATE TABLE statements in migrations
  Mongoose: Schema definitions
`;

// ─────────────────────────────────────────────────────────────
// Schema Data Structures
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Column
 * @property {string} name
 * @property {string} type
 * @property {boolean} nullable
 * @property {boolean} primaryKey
 * @property {boolean} unique
 * @property {string} [default]
 * @property {string} [references] - Foreign key reference "Table.column"
 */

/**
 * @typedef {Object} Table
 * @property {string} name
 * @property {Column[]} columns
 * @property {string} [source] - File where defined
 */

// ─────────────────────────────────────────────────────────────
// ORM Detection
// ─────────────────────────────────────────────────────────────

function detectORM(projectRoot) {
  const detected = [];

  // Check for Prisma
  const prismaLocations = [
    'prisma/schema.prisma',
    'schema.prisma',
    'db/schema.prisma'
  ];
  for (const loc of prismaLocations) {
    if (existsSync(join(projectRoot, loc))) {
      detected.push({ type: 'prisma', path: join(projectRoot, loc) });
    }
  }

  // Check for Drizzle
  const drizzleLocations = [
    'src/db/schema.ts',
    'src/schema.ts',
    'db/schema.ts',
    'drizzle/schema.ts',
    'src/db/schema',
    'src/schema'
  ];
  for (const loc of drizzleLocations) {
    const fullPath = join(projectRoot, loc);
    if (existsSync(fullPath)) {
      detected.push({ type: 'drizzle', path: fullPath });
    }
  }

  // Check package.json for ORM dependencies
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['@prisma/client'] || deps['prisma']) {
        // Already detected above
      }
      if (deps['drizzle-orm']) {
        // Look for schema files
        const schemaFiles = findSchemaFiles(projectRoot, 'drizzle');
        schemaFiles.forEach(f => {
          if (!detected.some(d => d.path === f)) {
            detected.push({ type: 'drizzle', path: f });
          }
        });
      }
      if (deps['typeorm']) {
        const entityFiles = findSchemaFiles(projectRoot, 'typeorm');
        entityFiles.forEach(f => detected.push({ type: 'typeorm', path: f }));
      }
      if (deps['mongoose']) {
        const modelFiles = findSchemaFiles(projectRoot, 'mongoose');
        modelFiles.forEach(f => detected.push({ type: 'mongoose', path: f }));
      }
    } catch { }
  }

  // Check for SQL migrations
  const migrationDirs = [
    'migrations',
    'db/migrations',
    'src/migrations',
    'database/migrations',
    'supabase/migrations'
  ];
  for (const dir of migrationDirs) {
    const fullPath = join(projectRoot, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      detected.push({ type: 'sql', path: fullPath });
    }
  }

  return detected;
}

function findSchemaFiles(root, type) {
  const files = [];
  const searchDirs = ['src', 'lib', 'app', 'db', 'database', 'models', 'entities'];

  function search(dir, depth = 0) {
    if (depth > 3) return;
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          search(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (!['.ts', '.js', '.mts', '.mjs'].includes(ext)) continue;

          if (type === 'drizzle') {
            if (entry.name.includes('schema') || entry.name.includes('table')) {
              files.push(fullPath);
            }
          } else if (type === 'typeorm') {
            if (entry.name.includes('entity') || entry.name.includes('.entity.')) {
              files.push(fullPath);
            }
          } else if (type === 'mongoose') {
            if (entry.name.includes('model') || entry.name.includes('schema')) {
              files.push(fullPath);
            }
          }
        }
      }
    } catch { }
  }

  for (const dir of searchDirs) {
    search(join(root, dir));
  }

  return files;
}

// ─────────────────────────────────────────────────────────────
// Prisma Parser
// ─────────────────────────────────────────────────────────────

function parsePrisma(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const tables = [];

  // Match model blocks
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  let match;

  while ((match = modelRegex.exec(content)) !== null) {
    const modelName = match[1];
    const body = match[2];
    const columns = [];

    // Parse each line in the model
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      // Field pattern: name Type modifiers
      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?\s*(\?)?(.*)$/);
      if (fieldMatch) {
        const [, name, type, isArray, isOptional, rest] = fieldMatch;

        // Skip relation fields (they reference other models)
        const isRelation = tables.some(t => t.name === type) ||
          content.includes(`model ${type}`);

        const column = {
          name,
          type: isArray ? `${type}[]` : type,
          nullable: !!isOptional,
          primaryKey: rest.includes('@id'),
          unique: rest.includes('@unique'),
        };

        // Check for @default
        const defaultMatch = rest.match(/@default\(([^)]+)\)/);
        if (defaultMatch) {
          column.default = defaultMatch[1];
        }

        // Check for @relation (foreign key)
        const relationMatch = rest.match(/@relation\([^)]*references:\s*\[(\w+)\][^)]*\)/);
        if (relationMatch) {
          // Find which field this references
          const referencesMatch = rest.match(/@relation\([^)]*fields:\s*\[(\w+)\]/);
          if (referencesMatch) {
            // This is the FK field, mark the actual column
            const fkField = referencesMatch[1];
            const existingCol = columns.find(c => c.name === fkField);
            if (existingCol) {
              existingCol.references = `${type}.${relationMatch[1]}`;
            }
          }
          continue; // Skip the relation field itself
        }

        // Skip if it's a relation type (references another model)
        if (content.includes(`model ${type} {`)) {
          continue;
        }

        columns.push(column);
      }
    }

    tables.push({
      name: modelName,
      columns,
      source: relative(process.cwd(), filePath)
    });
  }

  // Second pass: detect foreign keys from relation fields
  const relationRegex = /(\w+)\s+(\w+)(\[\])?\s*@relation\([^)]*fields:\s*\[(\w+)\][^)]*references:\s*\[(\w+)\]/g;
  while ((match = relationRegex.exec(content)) !== null) {
    const [, , targetModel, , fkField, targetField] = match;

    // Find the table containing this FK
    for (const table of tables) {
      const col = table.columns.find(c => c.name === fkField);
      if (col && !col.references) {
        col.references = `${targetModel}.${targetField}`;
      }
    }
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────
// Drizzle Parser
// ─────────────────────────────────────────────────────────────

function parseDrizzle(filePath) {
  const isDir = statSync(filePath).isDirectory();
  const files = isDir
    ? readdirSync(filePath)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .map(f => join(filePath, f))
    : [filePath];

  const tables = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');

    // Match pgTable, mysqlTable, sqliteTable definitions
    const tableRegex = /(?:export\s+const\s+)?(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"`](\w+)['"`]\s*,\s*\{([^}]+)\}/g;
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
      const [, varName, tableName, body] = match;
      const columns = [];

      // Parse column definitions
      const colRegex = /(\w+)\s*:\s*(varchar|text|integer|int|bigint|boolean|timestamp|date|serial|uuid|json|jsonb|decimal|real|doublePrecision)\s*\(([^)]*)\)([^,\n]*)/g;
      let colMatch;

      while ((colMatch = colRegex.exec(body)) !== null) {
        const [, name, type, args, modifiers] = colMatch;

        columns.push({
          name,
          type: type,
          nullable: !modifiers.includes('.notNull()'),
          primaryKey: modifiers.includes('.primaryKey()'),
          unique: modifiers.includes('.unique()'),
          default: modifiers.includes('.default(') ? 'has default' : undefined,
          references: extractDrizzleReference(modifiers)
        });
      }

      tables.push({
        name: tableName,
        columns,
        source: relative(process.cwd(), file)
      });
    }
  }

  return tables;
}

function extractDrizzleReference(modifiers) {
  const refMatch = modifiers.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/);
  if (refMatch) {
    return `${refMatch[1]}.${refMatch[2]}`;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// TypeORM Parser
// ─────────────────────────────────────────────────────────────

function parseTypeORM(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const tables = [];

  // Find @Entity decorator and class
  const entityRegex = /@Entity\s*\(\s*(?:['"`](\w+)['"`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
  let match;

  while ((match = entityRegex.exec(content)) !== null) {
    const tableName = match[1] || match[2].toLowerCase() + 's'; // Default pluralization
    const className = match[2];

    // Find the class body
    const classStart = content.indexOf('{', match.index);
    let braceDepth = 1;
    let classEnd = classStart + 1;
    while (braceDepth > 0 && classEnd < content.length) {
      if (content[classEnd] === '{') braceDepth++;
      if (content[classEnd] === '}') braceDepth--;
      classEnd++;
    }

    const classBody = content.slice(classStart, classEnd);
    const columns = [];

    // Parse @Column decorators
    const colRegex = /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn)\s*\(([^)]*)\)\s*(\w+)\s*[?!]?\s*:\s*(\w+)/g;
    let colMatch;

    while ((colMatch = colRegex.exec(classBody)) !== null) {
      const [, decorator, args, name, type] = colMatch;

      columns.push({
        name,
        type: mapTypeORMType(type, args),
        nullable: args.includes('nullable: true') || args.includes('nullable:true'),
        primaryKey: decorator.includes('Primary'),
        unique: args.includes('unique: true') || args.includes('unique:true'),
      });
    }

    // Parse @ManyToOne, @OneToMany for relations
    const relRegex = /@(ManyToOne|OneToOne)\s*\([^)]*\)\s*(?:@JoinColumn\s*\([^)]*\))?\s*(\w+)/g;
    let relMatch;

    while ((relMatch = relRegex.exec(classBody)) !== null) {
      const [fullMatch, relType, fieldName] = relMatch;
      // Look for @JoinColumn to find FK
      const joinColMatch = fullMatch.match(/@JoinColumn\s*\(\s*\{\s*name:\s*['"`](\w+)['"`]/);
      if (joinColMatch) {
        const existingCol = columns.find(c => c.name === joinColMatch[1]);
        if (existingCol) {
          // Try to extract target table from the relation
          const targetMatch = fullMatch.match(/@(?:ManyToOne|OneToOne)\s*\(\s*\(\)\s*=>\s*(\w+)/);
          if (targetMatch) {
            existingCol.references = `${targetMatch[1]}.id`;
          }
        }
      }
    }

    tables.push({
      name: tableName,
      columns,
      source: relative(process.cwd(), filePath)
    });
  }

  return tables;
}

function mapTypeORMType(tsType, args) {
  // Check if type is specified in decorator args
  const typeMatch = args.match(/type:\s*['"`](\w+)['"`]/);
  if (typeMatch) return typeMatch[1];

  // Map TypeScript types to SQL types
  const typeMap = {
    'string': 'varchar',
    'number': 'integer',
    'boolean': 'boolean',
    'Date': 'timestamp',
  };
  return typeMap[tsType] || tsType;
}

// ─────────────────────────────────────────────────────────────
// SQL Migration Parser
// ─────────────────────────────────────────────────────────────

function parseSQLMigrations(dirPath) {
  const tables = new Map(); // Use map to merge migrations

  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Sort to process in order

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), 'utf-8');

    // Match CREATE TABLE statements
    const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([^;]+)\)/gi;
    let match;

    while ((match = createRegex.exec(content)) !== null) {
      const tableName = match[1];
      const body = match[2];
      const columns = [];

      // Parse column definitions
      const lines = body.split(',').map(l => l.trim());
      for (const line of lines) {
        // Skip constraints
        if (/^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(line)) {
          // But extract FK info
          const fkMatch = line.match(/FOREIGN\s+KEY\s*\(["`]?(\w+)["`]?\)\s*REFERENCES\s+["`]?(\w+)["`]?\s*\(["`]?(\w+)["`]?\)/i);
          if (fkMatch) {
            const col = columns.find(c => c.name === fkMatch[1]);
            if (col) {
              col.references = `${fkMatch[2]}.${fkMatch[3]}`;
            }
          }
          continue;
        }

        const colMatch = line.match(/^["`]?(\w+)["`]?\s+(\w+(?:\([^)]+\))?)\s*(.*)/i);
        if (colMatch) {
          const [, name, type, rest] = colMatch;
          columns.push({
            name,
            type: type.toLowerCase(),
            nullable: !rest.toUpperCase().includes('NOT NULL'),
            primaryKey: rest.toUpperCase().includes('PRIMARY KEY'),
            unique: rest.toUpperCase().includes('UNIQUE'),
            references: extractSQLReference(rest)
          });
        }
      }

      tables.set(tableName, {
        name: tableName,
        columns,
        source: file
      });
    }

    // Handle ALTER TABLE ADD COLUMN
    const alterRegex = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?\s+(\w+(?:\([^)]+\))?)\s*([^;]*)/gi;
    while ((match = alterRegex.exec(content)) !== null) {
      const [, tableName, colName, type, rest] = match;
      const table = tables.get(tableName);
      if (table) {
        table.columns.push({
          name: colName,
          type: type.toLowerCase(),
          nullable: !rest.toUpperCase().includes('NOT NULL'),
          primaryKey: false,
          unique: rest.toUpperCase().includes('UNIQUE'),
          references: extractSQLReference(rest)
        });
      }
    }
  }

  return Array.from(tables.values());
}

function extractSQLReference(text) {
  const refMatch = text.match(/REFERENCES\s+["`]?(\w+)["`]?\s*\(["`]?(\w+)["`]?\)/i);
  if (refMatch) {
    return `${refMatch[1]}.${refMatch[2]}`;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// Mongoose Parser
// ─────────────────────────────────────────────────────────────

function parseMongoose(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const tables = [];

  // Match Schema definitions
  const schemaRegex = /(?:const|let|var)\s+(\w+)Schema\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/g;
  let match;

  while ((match = schemaRegex.exec(content)) !== null) {
    const modelName = match[1];
    const body = match[2];
    const columns = [];

    // Parse field definitions (simplified)
    const fieldRegex = /(\w+)\s*:\s*(?:\{[^}]*type\s*:\s*(\w+)[^}]*\}|(\w+))/g;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      const name = fieldMatch[1];
      const type = fieldMatch[2] || fieldMatch[3];

      if (!['type', 'required', 'default', 'unique', 'ref'].includes(name)) {
        columns.push({
          name,
          type: type || 'Mixed',
          nullable: !body.includes(`${name}.*required.*true`),
          primaryKey: name === '_id',
          unique: body.includes(`${name}.*unique.*true`),
        });
      }
    }

    tables.push({
      name: modelName,
      columns,
      source: relative(process.cwd(), filePath)
    });
  }

  return tables;
}

// ─────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────

function formatCompact(tables, out, showRelations = true) {
  for (const table of tables) {
    const pk = table.columns.find(c => c.primaryKey);
    const pkStr = pk ? `${pk.name}` : '';

    out.add(`${table.name} (${pkStr ? 'PK: ' + pkStr : table.columns.length + ' cols'})`);

    // Show columns briefly
    const cols = table.columns.map(c => {
      let str = `  ${c.name}: ${c.type}`;
      if (c.nullable) str += '?';
      if (c.primaryKey) str += ' [PK]';
      if (c.unique) str += ' [UQ]';
      if (c.references) str += ` -> ${c.references}`;
      return str;
    });

    cols.forEach(c => out.add(c));
    out.blank();
  }
}

function formatDetailed(tables, out) {
  for (const table of tables) {
    out.add(`┌─ ${table.name}`);
    if (table.source) out.add(`│  Source: ${table.source}`);
    out.add('│');

    for (const col of table.columns) {
      let flags = [];
      if (col.primaryKey) flags.push('PK');
      if (col.unique) flags.push('UQ');
      if (!col.nullable) flags.push('NOT NULL');
      if (col.default) flags.push(`DEFAULT ${col.default}`);

      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      out.add(`│  ${col.name.padEnd(20)} ${col.type.padEnd(15)}${flagStr}`);

      if (col.references) {
        out.add(`│  └── FK -> ${col.references}`);
      }
    }

    out.add('└─');
    out.blank();
  }
}

function formatRelationsOnly(tables, out) {
  out.header('Relationships:');
  out.blank();

  const relations = [];
  for (const table of tables) {
    for (const col of table.columns) {
      if (col.references) {
        const [targetTable] = col.references.split('.');
        relations.push({
          from: table.name,
          fromCol: col.name,
          to: targetTable,
          toCol: col.references.split('.')[1]
        });
      }
    }
  }

  if (relations.length === 0) {
    out.add('No foreign key relationships found');
    return;
  }

  // Group by source table
  const bySource = {};
  for (const rel of relations) {
    if (!bySource[rel.from]) bySource[rel.from] = [];
    bySource[rel.from].push(rel);
  }

  for (const [table, rels] of Object.entries(bySource)) {
    out.add(`${table}:`);
    for (const rel of rels) {
      out.add(`  ${rel.fromCol} -> ${rel.to}.${rel.toCol}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

let targetPath = null;
let format = 'compact';
let forceORM = null;
let relationsOnly = false;
let hideRelations = false;

for (let i = 0; i < options.remaining.length; i++) {
  const arg = options.remaining[i];

  if (arg === '--format' && options.remaining[i + 1]) {
    format = options.remaining[++i];
  } else if (arg === '--orm' && options.remaining[i + 1]) {
    forceORM = options.remaining[++i];
  } else if (arg === '--relations' || arg === '-r') {
    relationsOnly = true;
  } else if (arg === '--no-relations') {
    hideRelations = true;
  } else if (!arg.startsWith('-')) {
    targetPath = arg;
  }
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const out = createOutput(options);

// Detect or use forced ORM
let sources = [];

// If a specific file is provided, detect type from filename
if (targetPath && existsSync(targetPath) && statSync(targetPath).isFile()) {
  const filename = basename(targetPath);
  let type = forceORM;

  if (!type) {
    if (filename.endsWith('.prisma')) type = 'prisma';
    else if (filename.includes('schema') && (filename.endsWith('.ts') || filename.endsWith('.js'))) type = 'drizzle';
    else if (filename.includes('entity') && (filename.endsWith('.ts') || filename.endsWith('.js'))) type = 'typeorm';
    else if (filename.endsWith('.sql')) type = 'sql';
  }

  if (type) {
    sources = [{ type, path: targetPath }];
  }
} else if (forceORM) {
  const projectRoot = targetPath || findProjectRoot();
  if (targetPath) {
    sources = [{ type: forceORM, path: targetPath }];
  } else {
    sources = detectORM(projectRoot).filter(s => s.type === forceORM);
  }
} else {
  const projectRoot = targetPath || findProjectRoot();
  sources = detectORM(projectRoot);
}

if (sources.length === 0) {
  console.error('No database schema found. Supported: Prisma, Drizzle, TypeORM, SQL migrations, Mongoose');
  console.error('Use --orm <type> to force a specific parser');
  process.exit(1);
}

// Parse all sources
let allTables = [];

for (const source of sources) {
  let tables = [];

  try {
    switch (source.type) {
      case 'prisma':
        tables = parsePrisma(source.path);
        break;
      case 'drizzle':
        tables = parseDrizzle(source.path);
        break;
      case 'typeorm':
        tables = parseTypeORM(source.path);
        break;
      case 'sql':
        tables = parseSQLMigrations(source.path);
        break;
      case 'mongoose':
        tables = parseMongoose(source.path);
        break;
    }
  } catch (err) {
    out.add(`! Error parsing ${source.path}: ${err.message}`);
  }

  allTables = allTables.concat(tables);
}

// Dedupe tables by name (in case of multiple sources)
const tableMap = new Map();
for (const table of allTables) {
  if (!tableMap.has(table.name) || table.columns.length > tableMap.get(table.name).columns.length) {
    tableMap.set(table.name, table);
  }
}
allTables = Array.from(tableMap.values());

if (allTables.length === 0) {
  console.error('No tables found in schema');
  process.exit(1);
}

// Output
out.header(`Database Schema (${allTables.length} tables)`);
out.header(`Source: ${sources.map(s => s.type).join(', ')}`);
out.blank();

// Set JSON data
out.setData('tables', allTables);
out.setData('sources', sources.map(s => ({ type: s.type, path: relative(process.cwd(), s.path) })));
out.setData('tableCount', allTables.length);

if (relationsOnly) {
  formatRelationsOnly(allTables, out);
} else if (format === 'detailed') {
  formatDetailed(allTables, out);
} else {
  formatCompact(allTables, out, !hideRelations);
}

// Summary
const totalCols = allTables.reduce((sum, t) => sum + t.columns.length, 0);
const relations = allTables.reduce((sum, t) => sum + t.columns.filter(c => c.references).length, 0);

out.stats(`${allTables.length} tables, ${totalCols} columns, ${relations} relationships`);

out.print();
