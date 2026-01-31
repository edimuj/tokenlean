# tokenlean

Lean CLI tools for AI agents and developers. Reduce context usage, save tokens, improve workflow efficiency.

## The Problem

AI coding assistants are powerful, but they have a fundamental constraint: **context windows**. Every file you read,
every search result, every piece of context consumes tokens. This matters because:

- **Cost**: More tokens = higher API costs
- **Quality**: Overstuffed context leads to worse responses
- **Speed**: Larger contexts take longer to process
- **Limits**: Hit the ceiling and the AI loses important information

Most developers (and AI agents) approach codebases inefficiently - reading entire files when they only need function
signatures, grepping repeatedly when a structured search would do, or diving into implementation before understanding
the API surface.

## The Solution

tokenlean provides **25 specialized CLI tools** that give you (or your AI agent) exactly the information needed - no
more, no less. Each tool is designed to answer a specific question about your codebase with minimal token overhead.

Instead of reading a 500-line file to understand its exports, run `tl-exports` (~50 tokens). Instead of reading all your
types to understand data shapes, run `tl-types` (~100 tokens). Instead of guessing which files might be affected by a
change, run `tl-impact` and know for sure.

## Installation

```bash
npm install -g tokenlean
```

Or link locally for development:

```bash
git clone https://github.com/edimuj/tokenlean.git
cd tokenlean
npm link
```

## Quick Start

```bash
# Get project overview
tl-structure

# Before reading a file - check its size
tl-context src/api/

# Get function signatures without bodies
tl-symbols src/utils.ts

# Understand what a module exports
tl-exports src/lib/

# Check what would break if you change a file
tl-impact src/core/auth.ts
```

## AI Agent Integration

Add tokenlean instructions to your AI tool's config:

| AI Tool        | Config File                       | Command                                        |
|----------------|-----------------------------------|------------------------------------------------|
| Claude Code    | `CLAUDE.md`                       | `tl-prompt >> CLAUDE.md`                       |
| Cursor         | `.cursorrules`                    | `tl-prompt --minimal >> .cursorrules`          |
| GitHub Copilot | `.github/copilot-instructions.md` | `tl-prompt >> .github/copilot-instructions.md` |
| Windsurf       | `.windsurfrules`                  | `tl-prompt --minimal >> .windsurfrules`        |

The `--minimal` flag produces a compact version that uses fewer tokens.

## Tools Reference

### Before Reading Files

These tools help you understand code structure without reading full implementations.

| Tool           | Description                              | Example                   |
|----------------|------------------------------------------|---------------------------|
| `tl-structure` | Project overview with token estimates    | `tl-structure src/`       |
| `tl-context`   | Estimate token usage for files/dirs      | `tl-context src/api/`     |
| `tl-symbols`   | Function/class signatures without bodies | `tl-symbols src/utils.ts` |
| `tl-types`     | Full TypeScript type definitions         | `tl-types src/types/`     |
| `tl-exports`   | Public API surface of a module           | `tl-exports src/lib/`     |
| `tl-component` | React component analyzer (props, hooks)  | `tl-component Button.tsx` |
| `tl-entry`     | Find entry points and main files         | `tl-entry src/`           |

### Before Modifying Files

Understand dependencies and impact before making changes.

| Tool            | Description                                 | Example                             |
|-----------------|---------------------------------------------|-------------------------------------|
| `tl-impact`     | Blast radius - what depends on this file    | `tl-impact src/auth.ts`             |
| `tl-deps`       | Show what a file imports (with tree mode)   | `tl-deps src/api.ts --tree`         |
| `tl-related`    | Find tests, types, and importers            | `tl-related src/Button.tsx`         |
| `tl-flow`       | Call graph - what calls this, what it calls | `tl-flow src/utils.ts`              |
| `tl-coverage`   | Test coverage info for files                | `tl-coverage src/`                  |
| `tl-complexity` | Code complexity metrics                     | `tl-complexity src/ --threshold 10` |

### Understanding History

Track changes and authorship efficiently.

| Tool          | Description                      | Example                 |
|---------------|----------------------------------|-------------------------|
| `tl-diff`     | Token-efficient git diff summary | `tl-diff --staged`      |
| `tl-history`  | Recent commits for a file        | `tl-history src/api.ts` |
| `tl-blame`    | Compact per-line authorship      | `tl-blame src/api.ts`   |
| `tl-hotspots` | Frequently changed files (churn) | `tl-hotspots --days 30` |

### Finding Things

Search and discover code patterns.

| Tool        | Description                        | Example                  |
|-------------|------------------------------------|--------------------------|
| `tl-search` | Run pre-defined search patterns    | `tl-search hooks`        |
| `tl-todo`   | Find TODOs/FIXMEs in codebase      | `tl-todo src/`           |
| `tl-env`    | Find environment variables used    | `tl-env --required-only` |
| `tl-unused` | Find unused exports/files          | `tl-unused src/`         |
| `tl-api`    | Extract REST/GraphQL endpoints     | `tl-api src/routes/`     |
| `tl-routes` | Extract routes from web frameworks | `tl-routes app/`         |

### Configuration & Utilities

| Tool        | Description                    | Example               |
|-------------|--------------------------------|-----------------------|
| `tl-config` | Show/manage configuration      | `tl-config --init`    |
| `tl-prompt` | Generate AI agent instructions | `tl-prompt --minimal` |

## Common Options

All tools support these flags:

```
-l N, --max-lines N    Limit output to N lines
-t N, --max-tokens N   Limit output to ~N tokens
-j, --json             Output as JSON (for piping)
-q, --quiet            Minimal output (no headers/stats)
-h, --help             Show help
```

## Configuration

tokenlean uses `.tokenleanrc.json` for configuration:

- **Project config**: `.tokenleanrc.json` in your project root
- **Global config**: `~/.tokenleanrc.json` in your home directory

Project config overrides global config. Both are optional.

```json
{
  "output": {
    "maxLines": 100,
    "maxTokens": null
  },
  "skipDirs": [
    "generated",
    "vendor"
  ],
  "skipExtensions": [
    ".gen.ts"
  ],
  "importantDirs": [
    "domain",
    "core"
  ],
  "importantFiles": [
    "ARCHITECTURE.md"
  ],
  "searchPatterns": {
    "hooks": {
      "description": "Find React hooks",
      "pattern": "use[A-Z]\\w+",
      "glob": "**/*.{ts,tsx}"
    }
  },
  "hotspots": {
    "days": 90
  },
  "structure": {
    "depth": 3
  }
}
```

Config values extend built-in defaults (they don't replace them).

## Example Workflows

### Starting work on an unfamiliar codebase

```bash
tl-structure                    # Get the lay of the land
tl-entry                        # Find entry points
tl-exports src/lib/             # Understand the public API
tl-types src/types/             # Understand data shapes
```

### Before refactoring a file

```bash
tl-impact src/core/auth.ts      # What would break?
tl-deps src/core/auth.ts        # What does it depend on?
tl-related src/core/auth.ts     # Find the tests
tl-coverage src/core/auth.ts    # Is it well tested?
tl-complexity src/core/auth.ts  # How complex is it?
```

### Understanding a component

```bash
tl-component src/Button.tsx     # Props, hooks, dependencies
tl-symbols src/Button.tsx       # Function signatures
tl-history src/Button.tsx       # Recent changes
tl-blame src/Button.tsx         # Who wrote what
```

### Finding technical debt

```bash
tl-complexity src/ --threshold 15  # Complex functions
tl-unused src/                     # Dead code
tl-todo                            # Outstanding TODOs
tl-hotspots                        # Frequently changed (unstable?)
```

## Dependencies

- **ripgrep** (`rg`): Required for search-based tools
- **git**: Required for history/blame/diff tools

## Design Principles

1. **Single purpose**: Each tool does one thing well
2. **Minimal output**: Show only what's needed, nothing more
3. **Token-conscious**: Every tool is designed to save context tokens
4. **Composable**: Tools work together and support JSON output for piping
5. **Fast**: No heavy parsing or external services - just regex and file operations
6. **Universal**: Works with any JavaScript/TypeScript project, most tools support Python/Go too

## License

MIT
