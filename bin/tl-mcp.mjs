#!/usr/bin/env node

/**
 * tl-mcp — Tokenlean MCP Server
 *
 * Exposes tokenlean tools as MCP tools for direct, structured access.
 * Saves tokens (no CLI arg construction/parsing) and provides tool discovery.
 *
 * Modes:
 *   tl-mcp                          # stdio (one-off, per-session use)
 *   tl-mcp serve [--port 3742]      # HTTP server, foreground
 *   tl-mcp start [--port 3742]      # daemonize HTTP server (background)
 *   tl-mcp stop                     # stop background daemon
 *   tl-mcp status                   # show daemon status + URL
 *   tl-mcp install-service          # print launchd/systemd setup instructions
 *
 * Stdio — configure in .mcp.json:
 *   { "mcpServers": { "tokenlean": { "command": "tl-mcp" } } }
 *
 * HTTP daemon — configure in .mcp.json (or agent config):
 *   { "mcpServers": { "tokenlean": { "type": "http", "url": "http://127.0.0.1:3742/mcp" } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS, registerTools } from '../src/mcp-tools.mjs';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const DEFAULT_PORT = 3742;
const PID_DIR = join(homedir(), '.tokenlean');
const PID_FILE = join(PID_DIR, 'tl-mcp.pid');
const PORT_FILE = join(PID_DIR, 'tl-mcp.port');
const LAUNCHD_LABEL = 'com.tokenlean.mcp';
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

// ─── arg parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0] ?? 'stdio';
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? Number(args[portIdx + 1]) : DEFAULT_PORT;
const toolsIdx = args.indexOf('--tools');
const selectedTools = toolsIdx !== -1 && args[toolsIdx + 1]
  ? new Set(args[toolsIdx + 1].split(',').map(t => t.startsWith('tl_') ? t : `tl_${t}`))
  : null;

// ─── helpers ────────────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: 'tokenlean', version });
  if (selectedTools) {
    const filtered = TOOLS.filter(t => selectedTools.has(t.name));
    if (filtered.length === 0) {
      const available = TOOLS.map(t => t.name.replace('tl_', '')).join(', ');
      console.error(`No matching tools. Available: ${available}`);
      process.exit(1);
    }
    for (const tool of filtered) {
      server.tool(tool.name, tool.description, tool.schema, tool.handler);
    }
  } else {
    registerTools(server);
  }
  return server;
}

function ensurePidDir() {
  if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  try { return Number(readFileSync(PID_FILE, 'utf8').trim()); } catch { return null; }
}

function readSavedPort() {
  if (!existsSync(PORT_FILE)) return DEFAULT_PORT;
  try { return Number(readFileSync(PORT_FILE, 'utf8').trim()); } catch { return DEFAULT_PORT; }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probePort(p) {
  return new Promise(resolve => {
    const sock = createConnection(p, '127.0.0.1');
    sock.setTimeout(500);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

function launchctlPid() {
  try {
    const out = execFileSync('launchctl', ['list', LAUNCHD_LABEL], { encoding: 'utf8' });
    const m = out.match(/"PID"\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ─── serve (HTTP StreamableHTTP) ────────────────────────────────────────────

async function runServe(p) {
  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    // Stateless mode: fresh transport per request (all tools are pure/stateless)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(p, '127.0.0.1', () => {
    console.error(`tl-mcp listening on http://127.0.0.1:${p}/mcp`);
  });

  process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
  process.on('SIGINT', () => { httpServer.close(); process.exit(0); });
}

// ─── daemon: start ──────────────────────────────────────────────────────────

async function cmdStart(p) {
  // Check if already alive on port (handles launchd/systemd case too)
  if (await probePort(p)) {
    const launchPid = platform() === 'darwin' ? launchctlPid() : null;
    const pid = launchPid ?? readPid();
    const pidStr = pid ? ` (pid ${pid})` : '';
    console.log(`tl-mcp already running${pidStr}`);
    console.log(`  http://127.0.0.1:${p}/mcp`);
    return;
  }

  ensurePidDir();
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, 'serve', '--port', String(p)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  writeFileSync(PID_FILE, String(child.pid));
  writeFileSync(PORT_FILE, String(p));
  console.log(`tl-mcp daemon started (pid ${child.pid}, port ${p})`);
  console.log(`  http://127.0.0.1:${p}/mcp`);
}

// ─── daemon: stop ───────────────────────────────────────────────────────────

async function cmdStop() {
  // macOS: if launchd is managing it, unload the agent
  if (platform() === 'darwin' && existsSync(LAUNCHD_PLIST)) {
    const launchPid = launchctlPid();
    if (launchPid) {
      try {
        execFileSync('launchctl', ['unload', LAUNCHD_PLIST]);
        console.log(`tl-mcp launchd agent unloaded (was pid ${launchPid})`);
        console.log(`  To re-enable at login: launchctl load ${LAUNCHD_PLIST}`);
        return;
      } catch {
        // fall through to PID file
      }
    }
  }

  const pid = readPid();
  if (!pid) {
    if (await probePort(readSavedPort())) {
      console.log('tl-mcp: running but not managed by this process (launchd/systemd?)');
      console.log('  Use your service manager to stop it, or: tl-mcp install-service');
    } else {
      console.log('tl-mcp: not running');
    }
    return;
  }
  if (!isRunning(pid)) {
    console.log(`tl-mcp: stale pid ${pid}, cleaning up`);
    try { unlinkSync(PID_FILE); } catch {}
    return;
  }
  process.kill(pid, 'SIGTERM');
  try { unlinkSync(PID_FILE); } catch {}
  console.log(`tl-mcp daemon stopped (pid ${pid})`);
}

// ─── daemon: status ─────────────────────────────────────────────────────────

async function cmdStatus() {
  const p = readSavedPort();
  const alive = await probePort(p);

  if (!alive) {
    console.log('tl-mcp: not running');
    return;
  }

  // Try to surface the PID from wherever we can find it
  let pid = null;
  if (platform() === 'darwin') pid = launchctlPid();
  if (!pid) {
    const filePid = readPid();
    if (filePid && isRunning(filePid)) pid = filePid;
  }

  const pidStr = pid ? ` (pid ${pid})` : '';
  console.log(`tl-mcp: running${pidStr}`);
  console.log(`  http://127.0.0.1:${p}/mcp`);
}

// ─── install-service ────────────────────────────────────────────────────────

function cmdInstallService() {
  const nodePath = process.execPath;
  const selfPath = fileURLToPath(import.meta.url);
  const logFile = join(homedir(), '.tokenlean', 'tl-mcp.log');

  if (platform() === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${selfPath}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${DEFAULT_PORT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
</dict>
</plist>`;

    console.log('# macOS launchd — auto-starts at login, restarts on crash\n');
    console.log(`# 1. Write the plist:`);
    console.log(`mkdir -p ~/.tokenlean`);
    console.log(`cat > ${LAUNCHD_PLIST} << 'EOF'`);
    console.log(plist);
    console.log('EOF\n');
    console.log(`# 2. Load it now:`);
    console.log(`launchctl load ${LAUNCHD_PLIST}\n`);
    console.log(`# 3. Verify:`);
    console.log(`launchctl list ${LAUNCHD_LABEL}\n`);
    console.log(`# To unload: launchctl unload ${LAUNCHD_PLIST}`);
    console.log(`# Logs: tail -f ${logFile}`);
  } else {
    // Linux systemd (user service)
    const serviceDir = join(homedir(), '.config', 'systemd', 'user');
    const servicePath = join(serviceDir, 'tl-mcp.service');
    const unit = `[Unit]
Description=Tokenlean MCP Server
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${selfPath} serve --port ${DEFAULT_PORT}
Restart=on-failure
RestartSec=3
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target`;

    console.log('# Linux systemd (user service) — auto-starts at login\n');
    console.log(`# 1. Write the unit file:`);
    console.log(`mkdir -p ${serviceDir}`);
    console.log(`cat > ${servicePath} << 'EOF'`);
    console.log(unit);
    console.log('EOF\n');
    console.log(`# 2. Enable and start:`);
    console.log(`systemctl --user daemon-reload`);
    console.log(`systemctl --user enable --now tl-mcp\n`);
    console.log(`# 3. Verify:`);
    console.log(`systemctl --user status tl-mcp\n`);
    console.log(`# To stop: systemctl --user stop tl-mcp`);
    console.log(`# To disable: systemctl --user disable tl-mcp`);
    console.log(`# Logs: journalctl --user -u tl-mcp -f`);
  }

  console.log(`\n# Agent config (after service is running):`);
  console.log(`# Claude Code: claude mcp add --transport http --scope user tokenlean http://127.0.0.1:${DEFAULT_PORT}/mcp`);
  console.log(`# .mcp.json:   { "mcpServers": { "tokenlean": { "type": "http", "url": "http://127.0.0.1:${DEFAULT_PORT}/mcp" } } }`);
}

// ─── stdio ──────────────────────────────────────────────────────────────────

async function runStdio() {
  // If the HTTP daemon isn't running, start it in the background so future
  // sessions connect instantly instead of paying this cold-start each time.
  const p = readSavedPort();
  if (!(await probePort(p))) {
    ensurePidDir();
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'serve', '--port', String(p)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));
    writeFileSync(PORT_FILE, String(p));
    console.error(`tl-mcp: cold-start tax applied (stdio mode). Started background daemon (pid ${child.pid}).`);
    console.error(`  Next session: zero cold-start via http://127.0.0.1:${p}/mcp`);
    console.error(`  Make it permanent across reboots: tl-mcp install-service`);
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── dispatch ───────────────────────────────────────────────────────────────

switch (subcommand) {
  case 'serve':           await runServe(port); break;
  case 'start':           await cmdStart(port); break;
  case 'stop':            await cmdStop(); break;
  case 'status':          await cmdStatus(); break;
  case 'install-service': cmdInstallService(); break;
  default:                await runStdio(); break;
}
