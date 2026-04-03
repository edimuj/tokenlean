#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  parseJsonSafe,
  isWithinSinceDays,
  isSameOrWithinPath,
  normalizeClaudeProjectPath,
  extractTlTool,
  compactCommand,
  extractCodexShellCommands,
  extractClaudeShellCommands
} from '../src/perf-log-mining.mjs';

const DEFAULT_OUT = 'benchmarks/agent-hotpaths.json';
const DEFAULT_MAX_TOOLS = 7;

const TOOL_TEMPLATES = {
  'tl-audit': ['node', 'bin/tl-audit.mjs', '--latest', '--provider', 'codex', '-j'],
  'tl-structure': ['node', 'bin/tl-structure.mjs', '-q'],
  'tl-symbols': ['node', 'bin/tl-symbols.mjs', 'src/output.mjs', '-q'],
  'tl-snippet': ['node', 'bin/tl-snippet.mjs', 'parseCommonArgs', 'src/output.mjs', '-q'],
  'tl-deps': ['node', 'bin/tl-deps.mjs', 'src/output.mjs', '-q'],
  'tl-impact': ['node', 'bin/tl-impact.mjs', 'src/output.mjs', '-q'],
  'tl-related': ['node', 'bin/tl-related.mjs', 'src/output.mjs', '-q'],
  'tl-run': ['node', 'bin/tl-run.mjs', 'echo ok', '-q'],
  'tl-context': ['node', 'bin/tl-context.mjs', 'src/output.mjs', '-q'],
  'tl-analyze': ['node', 'bin/tl-analyze.mjs', 'src/output.mjs', '-q']
};

function parseIntOption(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    projectPaths: [process.cwd()],
    out: DEFAULT_OUT,
    maxTools: DEFAULT_MAX_TOOLS,
    sinceDays: null,
    help: false
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--project') {
      options.projectPaths.push(argv[++idx]);
    } else if (arg === '--out') {
      options.out = argv[++idx];
    } else if (arg === '--max-tools') {
      options.maxTools = parseIntOption(argv[++idx], '--max-tools');
    } else if (arg === '--since-days') {
      options.sinceDays = parseIntOption(argv[++idx], '--since-days');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run bench:hotpaths:refresh -- [options]

Options:
  --project <path>      Include additional project path (repeatable)
  --max-tools <n>       Number of top tools to include (default: ${DEFAULT_MAX_TOOLS})
  --since-days <n>      Include only sessions from the last N days
  --out <path>          Scenario output path (default: ${DEFAULT_OUT})
  -h, --help            Show this help
`);
}

async function maybeAddLegacyProjectPath(projectPaths) {
  const deduped = new Set(projectPaths.map(pathValue => resolve(pathValue)));
  const current = resolve(process.cwd());
  const fromOssPath = current.replace('/projects/oss/', '/projects/');
  const legacy = resolve(homedir(), 'projects', basename(current));

  // Repository moved from /projects/<name> to /projects/oss/<name> in some setups.
  if (fromOssPath !== current) {
    deduped.add(resolve(fromOssPath));
  }

  // Common old location under ~/projects/<repo-name>.
  deduped.add(legacy);

  return [...deduped];
}

async function listJsonlRecursive(rootDir, options = {}) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      files.push(...await listJsonlRecursive(entryPath, options));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(entryPath);
      if (!isWithinSinceDays(info.mtimeMs, options.sinceDays)) continue;
      files.push({ path: entryPath, mtimeMs: info.mtimeMs });
    }
  }

  return files;
}

async function discoverClaudeSessionFiles(projectPaths, options = {}) {
  const root = join(homedir(), '.claude', 'projects');
  let rootEntries = [];
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const expectedNames = projectPaths.flatMap((pathValue) => {
    const normalized = normalizeClaudeProjectPath(resolve(pathValue));
    return [normalized, `-${normalized}`];
  });
  const matchedDirs = rootEntries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => expectedNames.some(expected => name === expected || name.startsWith(`${expected}-`)));

  const files = [];
  for (const dirName of matchedDirs) {
    const dirPath = join(root, dirName);
    // eslint-disable-next-line no-await-in-loop
    files.push(...await listJsonlRecursive(dirPath, options));
  }

  return files;
}

async function codexSessionMatchesProject(fileRecord, projectPaths, sinceDays = null) {
  if (!isWithinSinceDays(fileRecord?.mtimeMs, sinceDays)) return false;
  const filePath = fileRecord.path;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const record = parseJsonSafe(line);
      if (!record || record.type !== 'session_meta') continue;
      const sessionTimestamp = record.payload?.timestamp || record.timestamp || null;
      if (!isWithinSinceDays(sessionTimestamp, sinceDays)) return false;
      const cwd = record.payload?.cwd;
      return projectPaths.some(projectPath => isSameOrWithinPath(cwd, projectPath));
    }
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function discoverCodexSessionFiles(projectPaths, options = {}) {
  const root = join(homedir(), '.codex', 'sessions');
  let allFiles = [];
  try {
    allFiles = await listJsonlRecursive(root, options);
  } catch {
    return [];
  }

  const matches = [];
  for (const fileRecord of allFiles) {
    // eslint-disable-next-line no-await-in-loop
    const include = await codexSessionMatchesProject(fileRecord, projectPaths, options.sinceDays);
    if (include) matches.push(fileRecord);
  }

  return matches;
}

async function collectToolUsageFromFile(filePath, provider, stats) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  stats.filesScanned += 1;

  try {
    for await (const line of rl) {
      const record = parseJsonSafe(line);
      if (!record) continue;

      const commands = provider === 'codex'
        ? extractCodexShellCommands(record)
        : extractClaudeShellCommands(record);

      if (commands.length === 0) continue;

      commands.forEach((command) => {
        stats.commandsSeen += 1;
        const tool = extractTlTool(command);
        if (!tool) return;

        let entry = stats.tools.get(tool);
        if (!entry) {
          entry = { count: 0, samples: [] };
          stats.tools.set(tool, entry);
        }

        entry.count += 1;
        const sample = compactCommand(command);
        if (sample && !entry.samples.includes(sample) && entry.samples.length < 3) {
          entry.samples.push(sample);
        }
      });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function resolveBenchmarkArgv(tool) {
  return TOOL_TEMPLATES[tool] || null;
}

async function buildScenario(toolRows, options, projectPaths, scanStats) {
  const commands = [
    {
      id: 'node_startup_baseline',
      label: 'Node startup baseline',
      argv: ['node', '-e', '']
    }
  ];

  const included = [];
  for (const row of toolRows) {
    // eslint-disable-next-line no-await-in-loop
    const argv = await resolveBenchmarkArgv(row.tool);
    if (!argv) continue;

    commands.push({
      id: `log_${row.tool.replaceAll('-', '_')}`,
      label: `${row.tool} (from logs, ${row.count} uses)`,
      argv
    });
    included.push(row);

    if (included.length >= options.maxTools) break;
  }

  return {
    name: 'agent-hotpaths',
    description: `Generated from local agent session logs for ${projectPaths.join(', ')}.${options.sinceDays ? ` Window: last ${options.sinceDays} days.` : ''}`,
    generatedAt: new Date().toISOString(),
    source: {
      filesScanned: scanStats.filesScanned,
      shellCommandsSeen: scanStats.commandsSeen,
      tlCommandsSeen: toolRows.reduce((sum, row) => sum + row.count, 0),
      sinceDays: options.sinceDays,
      topTools: toolRows.slice(0, 12)
    },
    commands
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const projectPaths = await maybeAddLegacyProjectPath(options.projectPaths);

  process.stderr.write(`Projects: ${projectPaths.join(', ')}\n`);

  const [codexFiles, claudeFiles] = await Promise.all([
    discoverCodexSessionFiles(projectPaths, options),
    discoverClaudeSessionFiles(projectPaths, options)
  ]);

  process.stderr.write(`Found ${codexFiles.length} Codex sessions and ${claudeFiles.length} Claude sessions\n`);

  const stats = {
    filesScanned: 0,
    commandsSeen: 0,
    tools: new Map()
  };

  for (const file of codexFiles) {
    // eslint-disable-next-line no-await-in-loop
    await collectToolUsageFromFile(file.path, 'codex', stats);
  }
  for (const file of claudeFiles) {
    // eslint-disable-next-line no-await-in-loop
    await collectToolUsageFromFile(file.path, 'claude', stats);
  }

  const toolRows = [...stats.tools.entries()]
    .map(([tool, value]) => ({ tool, count: value.count, samples: value.samples }))
    .sort((a, b) => b.count - a.count);

  if (toolRows.length === 0) {
    throw new Error('No tl-* command usage found in discovered logs.');
  }

  const scenario = await buildScenario(toolRows, options, projectPaths, stats);

  const outPath = resolve(options.out);
  await mkdir(resolve(outPath, '..'), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

  process.stdout.write('Top tools from logs\n');
  toolRows.slice(0, 12).forEach((row, index) => {
    process.stdout.write(`${index + 1}. ${row.tool}: ${row.count} uses\n`);
    row.samples.forEach((sample) => {
      process.stdout.write(`   sample: ${sample}\n`);
    });
  });
  process.stdout.write(`\nWrote: ${outPath}\n`);
  process.stdout.write(`Included benchmark commands: ${scenario.commands.length}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
