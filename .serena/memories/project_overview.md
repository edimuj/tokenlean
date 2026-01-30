# Claude Tools - Project Overview

## Purpose
Cross-project CLI tools for working with Claude Code. These tools help reduce context token usage and improve workflow efficiency when working with AI coding assistants.

## Tech Stack
- **Runtime**: Node.js (ES Modules)
- **Language**: JavaScript (.mjs files)
- **Type**: CLI tools (executable scripts)
- **Package Manager**: npm

## Available Tools

| Command | Purpose |
|---------|---------|
| `claude-context` | Estimate context token usage for files/directories |
| `claude-search` | Pre-defined search patterns from project config |
| `claude-structure` | Smart project overview with token estimates |
| `claude-diff` | Token-efficient git diff summary |
| `claude-related` | Find related files (tests, types, importers) |
| `claude-component` | React component analyzer |

## External Dependencies
- **ripgrep** (`rg`): Required for claude-search and claude-related

## Project Structure
```
claude-tools/
├── bin/                    # Executable CLI scripts
│   ├── claude-context.mjs
│   ├── claude-search.mjs
│   ├── claude-structure.mjs
│   ├── claude-diff.mjs
│   ├── claude-related.mjs
│   └── claude-component.mjs
├── src/                    # Source/shared code (currently empty)
├── package.json
└── README.md
```

## Installation
```bash
cd ~/projects/claude-tools
npm link
```
This makes all tools available globally.
