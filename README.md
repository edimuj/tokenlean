<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/tokenlean-mascot-200.png" alt="Tokenlean mascot - a squirrel collecting tokens" />
</p>

<h1 align="center">tokenlean</h1>

<p align="center">
  <strong>Lean CLI tools for AI agents — maximum insight, minimum tokens</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/v/tokenlean.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/dm/tokenlean.svg" alt="npm downloads"></a>
  <a href="https://github.com/edimuj/tokenlean/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tokenlean.svg" alt="license"></a>
  <a href="https://github.com/edimuj/tokenlean"><img src="https://img.shields.io/github/stars/edimuj/tokenlean.svg?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#tools-reference">Tools</a> •
  <a href="#ai-agent-integration">AI Integration</a> •
  <a href="#configuration">Configuration</a>
</p>

---

## Why tokenlean?

AI coding assistants are powerful, but they have a fundamental constraint: **context windows**. Every file read, every
search result consumes tokens. This matters because:

| Problem     | Impact                                |
|-------------|---------------------------------------|
| **Cost**    | More tokens = higher API costs        |
| **Quality** | Overstuffed context = worse responses |
| **Speed**   | Larger contexts = longer processing   |
| **Limits**  | Hit the ceiling = lost information    |

**tokenlean** provides **32 specialized CLI tools** that give you exactly the information needed — no more, no less.

```
Instead of reading a 500-line file    →  tl-exports (~50 tokens)
Instead of reading all type files     →  tl-types (~100 tokens)
Instead of guessing impact            →  tl-impact (know for sure)
```

## Installation

```bash
npm install -g tokenlean
```

<details>
<summary>Development setup</summary>

```bash
git clone https://github.com/edimuj/tokenlean.git
cd tokenlean
npm link
```

</details>

### Requirements

- **Node.js** >= 18.0.0
- **ripgrep** (`rg`) — for search-based tools
- **git** — for history/blame/diff tools

## Quick Start

```bash
# Get project overview
tl-structure

# Check file sizes before reading
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

Understand code structure without reading full implementations.

| Tool           | Description                              | Example                   |
|----------------|------------------------------------------|---------------------------|
| `tl-structure` | Project overview with token estimates    | `tl-structure src/`       |
| `tl-context`   | Estimate token usage for files/dirs      | `tl-context src/api/`     |
| `tl-symbols`   | Function/class signatures without bodies | `tl-symbols src/utils.ts` |
| `tl-types`     | Full TypeScript type definitions         | `tl-types src/types/`     |
| `tl-exports`   | Public API surface of a module           | `tl-exports src/lib/`     |
| `tl-component` | React component analyzer (props, hooks)  | `tl-component Button.tsx` |
| `tl-docs`      | Extract JSDoc/TSDoc documentation        | `tl-docs src/utils/`      |
| `tl-entry`     | Find entry points and main files         | `tl-entry src/`           |
| `tl-schema`    | Extract DB schema from ORMs/migrations   | `tl-schema`               |

### Before Modifying Files

Understand dependencies and impact before making changes.

| Tool            | Description                                 | Example                             |
|-----------------|---------------------------------------------|-------------------------------------|
| `tl-impact`     | Blast radius — what depends on this file    | `tl-impact src/auth.ts`             |
| `tl-deps`       | Show what a file imports (with tree mode)   | `tl-deps src/api.ts --tree`         |
| `tl-related`    | Find tests, types, and importers            | `tl-related src/Button.tsx`         |
| `tl-flow`       | Call graph — what calls this, what it calls | `tl-flow src/utils.ts`              |
| `tl-coverage`   | Test coverage info for files                | `tl-coverage src/`                  |
| `tl-complexity` | Code complexity metrics                     | `tl-complexity src/ --threshold 10` |

### Understanding History

Track changes and authorship efficiently.

| Tool           | Description                      | Example                  |
|----------------|----------------------------------|--------------------------|
| `tl-diff`      | Token-efficient git diff summary | `tl-diff --staged`       |
| `tl-history`   | Recent commits for a file        | `tl-history src/api.ts`  |
| `tl-blame`     | Compact per-line authorship      | `tl-blame src/api.ts`    |
| `tl-hotspots`  | Frequently changed files (churn) | `tl-hotspots --days 30`  |
| `tl-pr`        | Summarize PR/branch for review   | `tl-pr feature-branch`   |
| `tl-changelog` | Generate changelog from commits  | `tl-changelog --from v1` |

### Finding Things

Search and discover code patterns.

| Tool         | Description                        | Example                  |
|--------------|------------------------------------|--------------------------|
| `tl-search`  | Run pre-defined search patterns    | `tl-search hooks`        |
| `tl-secrets` | Find hardcoded secrets & API keys  | `tl-secrets --staged`    |
| `tl-todo`    | Find TODOs/FIXMEs in codebase      | `tl-todo src/`           |
| `tl-env`     | Find environment variables used    | `tl-env --required-only` |
| `tl-unused`  | Find unused exports/files          | `tl-unused src/`         |
| `tl-api`     | Extract REST/GraphQL endpoints     | `tl-api src/routes/`     |
| `tl-routes`  | Extract routes from web frameworks | `tl-routes app/`         |

### Utilities

| Tool        | Description                      | Example                |
|-------------|----------------------------------|------------------------|
| `tl-cache`  | Manage ripgrep result cache      | `tl-cache stats`       |
| `tl-config` | Show/manage configuration        | `tl-config --init`     |
| `tl-name`   | Check name availability (npm/GH) | `tl-name myproject -s` |
| `tl-prompt` | Generate AI agent instructions   | `tl-prompt --minimal`  |

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

Create `.tokenleanrc.json` in your project root or `~/.tokenleanrc.json` globally:

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
  }
}
```

<details>
<summary>Full configuration reference</summary>

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
  },
  "cache": {
    "enabled": true,
    "ttl": 300,
    "maxSize": "100MB",
    "location": null
  }
}
```

Config values extend built-in defaults (they don't replace them).

</details>

## Caching

tokenlean caches expensive ripgrep operations with **git-based invalidation** — automatically invalidates on commits or
file changes.

```bash
tl-cache stats      # View cache statistics
tl-cache clear      # Clear cache for current project
tl-cache clear-all  # Clear all cached data
```

Disable with `TOKENLEAN_CACHE=0` or in config: `{"cache":{"enabled":false}}`

## Example Workflows

<details>
<summary><strong>Starting on an unfamiliar codebase</strong></summary>

```bash
tl-structure                    # Get the lay of the land
tl-entry                        # Find entry points
tl-exports src/lib/             # Understand the public API
tl-docs src/utils/              # Read documentation, not code
tl-types src/types/             # Understand data shapes
tl-schema                       # Understand the database
```

</details>

<details>
<summary><strong>Before refactoring a file</strong></summary>

```bash
tl-impact src/core/auth.ts      # What would break?
tl-deps src/core/auth.ts        # What does it depend on?
tl-related src/core/auth.ts     # Find the tests
tl-coverage src/core/auth.ts    # Is it well tested?
tl-complexity src/core/auth.ts  # How complex is it?
```

</details>

<details>
<summary><strong>Understanding a component</strong></summary>

```bash
tl-component src/Button.tsx     # Props, hooks, dependencies
tl-symbols src/Button.tsx       # Function signatures
tl-history src/Button.tsx       # Recent changes
tl-blame src/Button.tsx         # Who wrote what
```

</details>

<details>
<summary><strong>Finding technical debt</strong></summary>

```bash
tl-complexity src/ --threshold 15  # Complex functions
tl-unused src/                     # Dead code
tl-todo                            # Outstanding TODOs
tl-hotspots                        # Frequently changed (unstable?)
```

</details>

<details>
<summary><strong>Security check before committing</strong></summary>

```bash
tl-secrets                         # Scan for hardcoded secrets
tl-secrets --staged                # Only check staged files
tl-secrets --min-severity high     # Only high severity issues
```

</details>

<details>
<summary><strong>Reviewing a PR</strong></summary>

```bash
tl-pr feature-branch               # Summary of branch changes
tl-pr 123                          # GitHub PR #123 (needs gh CLI)
tl-pr --full                       # Include files, stats, commits
```

</details>

<details>
<summary><strong>Preparing a release</strong></summary>

```bash
tl-changelog --unreleased          # What's new since last tag
tl-changelog v0.1.0..v0.2.0        # Between versions
tl-changelog --format compact      # Quick summary
```

</details>

<details>
<summary><strong>Starting a new project</strong></summary>

```bash
tl-name coolproject awesomelib     # Check npm, GitHub, domains
tl-name myapp -s                   # Suggest variations if taken
tl-name myapp --tld io             # Check .io domain
```

</details>

## Design Principles

1. **Single purpose** — Each tool does one thing well
2. **Minimal output** — Show only what's needed
3. **Token-conscious** — Every tool saves context tokens
4. **Composable** — Tools work together with JSON output for piping
5. **Fast** — No heavy parsing or external services
6. **Universal** — Works with JS/TS projects, most tools support Python/Go too

## Other tools for Claude Code

| Project                                                                | Description                                                                    |
|------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| [claude-mneme](https://github.com/edimuj/claude-mneme)                 | Persistent memory for Claude Code — remember context across sessions           |
| [claude-simple-status](https://github.com/edimuj/claude-simple-status) | Minimal statusline showing model, context usage, and quota                     |
| [vexscan-claude-code](https://github.com/edimuj/vexscan-claude-code)   | Security scanner protecting against untrusted plugins, skills, MCPs, and hooks |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE) © [Edin Mujkanovic](https://github.com/edimuj)
