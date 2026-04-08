#!/usr/bin/env node

/**
 * tl-mcp — Tokenlean MCP Server
 *
 * Exposes tokenlean tools as MCP tools for direct, structured access.
 * Saves tokens (no CLI arg construction/parsing) and provides tool discovery.
 *
 * Usage:
 *   tl-mcp                     # Start with all tools
 *   tl-mcp --tools symbols,snippet,run   # Only specific tools
 *
 * Configure in .mcp.json:
 *   { "mcpServers": { "tokenlean": { "command": "tl-mcp" } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS, registerTools } from '../src/mcp-tools.mjs';

// Parse --tools flag for selective registration
const toolsIdx = process.argv.indexOf('--tools');
const selectedTools = toolsIdx !== -1 && process.argv[toolsIdx + 1]
  ? new Set(process.argv[toolsIdx + 1].split(',').map(t => t.startsWith('tl_') ? t : `tl_${t}`))
  : null;

const server = new McpServer({
  name: 'tokenlean',
  version: '0.33.0',
});

if (selectedTools) {
  // Register only selected tools
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

const transport = new StdioServerTransport();
await server.connect(transport);
