<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/tokenlean-mascot-200.png" alt="Tokenlean mascot - a squirrel collecting tokens" />
</p>

<h1 align="center">tokenlean</h1>

<p align="center">
  <strong>39 CLI tools that let AI agents understand codebases without burning tokens</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/v/tokenlean.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/dm/tokenlean.svg" alt="npm downloads"></a>
  <a href="https://github.com/edimuj/tokenlean/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tokenlean.svg" alt="license"></a>
  <a href="https://github.com/edimuj/tokenlean"><img src="https://img.shields.io/github/stars/edimuj/tokenlean.svg?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#install">Install</a> •
  <a href="#quick-reference">Quick Reference</a> •
  <a href="#all-tools">All Tools</a> •
  <a href="#language-support">Language Support</a> •
  <a href="#ai-agent-integration">AI Integration</a> •
  <a href="#workflows">Workflows</a> •
  <a href="#changelog">Changelog</a>
</p>

---

**Zero dependencies** — only Node.js built-ins, installs in seconds
&nbsp;&middot;&nbsp;
**Token-conscious** — every tool outputs only what's needed, nothing more
&nbsp;&middot;&nbsp;
**Fast** — ripgrep-powered search with disk caching
&nbsp;&middot;&nbsp;
**Universal** — JS/TS first, most tools work with Python and Go too

---

## The Problem

AI coding assistants are powerful, but every file read and every search result eats context window tokens. That means
higher costs, worse responses, slower processing, and hitting limits sooner.

tokenlean fixes this:

| Instead of...                             | Use                 | Savings               |
|-------------------------------------------|---------------------|-----------------------|
| Reading a 500-line file for signatures    | `tl-symbols`        | **~90% fewer tokens** |
| Reading all files to find exports         | `tl-exports`        | **~95% fewer tokens** |
| Guessing what a change might break        | `tl-impact`         | **Know for sure**     |
| Reading a file to extract one function    | `tl-snippet`        | **~85% fewer tokens** |
| Running `npm test` and reading all output | `tl-run "npm test"` | **Errors only**       |

<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/demo.gif" alt="tokenlean demo — tl-structure, tl-symbols, and tl-exports in action" width="800" />
</p>

## Install

```bash
npm install -g tokenlean
```

Requires **Node.js >= 18**, **[ripgrep](https://github.com/BurntSushi/ripgrep)** for search tools, and **git** for
history tools.

<details>
<summary>Development setup</summary>

```bash
git clone https://github.com/edimuj/tokenlean.git
cd tokenlean
npm link
```

</details>

## Quick Reference

```bash
# What's in this file?           tl-symbols src/auth.ts
# Extract just one function      tl-snippet handleSubmit
# What does this module export?  tl-exports src/lib/
# How many tokens will this cost? tl-context src/api/
# What's the project shape?      tl-structure

# What depends on this file?     tl-impact src/auth.ts
# How complex is this code?      tl-complexity src/auth.ts
# Where are the tests?           tl-related src/Button.tsx

# What changed recently?         tl-diff --staged
# Is it safe to commit?          tl-guard
# Find real usage examples       tl-example useAuth
# What's the tech stack?         tl-stack
```

Every tool supports `-l N` (limit lines), `-t N` (limit tokens), `-j` (JSON output), `-q` (quiet), and `-h` (help).

## AI Agent Integration

Add tokenlean instructions to your AI tool's config with a single command:

| AI Tool        | Command                                        |
|----------------|------------------------------------------------|
| Claude Code    | `tl-prompt >> CLAUDE.md`                       |
| Cursor         | `tl-prompt --minimal >> .cursorrules`          |
| GitHub Copilot | `tl-prompt >> .github/copilot-instructions.md` |
| Windsurf       | `tl-prompt --minimal >> .windsurfrules`        |

## All Tools

<details open>
<summary><strong>Before Reading Files</strong> — understand structure without reading implementations</summary>

| Tool           | Description                              | Example                   |
|----------------|------------------------------------------|---------------------------|
| `tl-analyze`   | Composite file profile (5 tools in 1)   | `tl-analyze src/auth.ts`  |
| `tl-structure` | Project overview with token estimates    | `tl-structure src/`       |
| `tl-context`   | Estimate token usage for files/dirs      | `tl-context src/api/`     |
| `tl-symbols`   | Function/class signatures without bodies | `tl-symbols src/utils.ts` |
| `tl-snippet`   | Extract function/class body by name      | `tl-snippet handleSubmit` |
| `tl-types`     | Full TypeScript type definitions         | `tl-types src/types/`     |
| `tl-exports`   | Public API surface of a module           | `tl-exports src/lib/`     |
| `tl-component` | React component analyzer (props, hooks)  | `tl-component Button.tsx` |
| `tl-docs`      | Extract JSDoc/TSDoc documentation        | `tl-docs src/utils/`      |
| `tl-entry`     | Find entry points and main files         | `tl-entry src/`           |
| `tl-schema`    | Extract DB schema from ORMs/migrations   | `tl-schema`               |
| `tl-stack`     | Auto-detect project technology stack     | `tl-stack`                |

</details>

<details>
<summary><strong>Before Modifying Files</strong> — understand dependencies and impact</summary>

| Tool            | Description                                 | Example                             |
|-----------------|---------------------------------------------|-------------------------------------|
| `tl-impact`     | Blast radius — what depends on this file    | `tl-impact src/auth.ts`             |
| `tl-deps`       | Show what a file imports (with tree mode)   | `tl-deps src/api.ts --tree`         |
| `tl-related`    | Find tests, types, and importers            | `tl-related src/Button.tsx`         |
| `tl-flow`       | Call graph — what calls this, what it calls | `tl-flow src/utils.ts`              |
| `tl-coverage`   | Test coverage info for files                | `tl-coverage src/`                  |
| `tl-complexity` | Code complexity metrics                     | `tl-complexity src/ --threshold 10` |
| `tl-style`      | Detect coding conventions from code         | `tl-style src/`                     |

</details>

<details>
<summary><strong>Understanding History</strong> — track changes and authorship</summary>

| Tool           | Description                      | Example                  |
|----------------|----------------------------------|--------------------------|
| `tl-diff`      | Token-efficient git diff summary | `tl-diff --staged`       |
| `tl-history`   | Recent commits for a file        | `tl-history src/api.ts`  |
| `tl-blame`     | Compact per-line authorship      | `tl-blame src/api.ts`    |
| `tl-hotspots`  | Frequently changed files (churn) | `tl-hotspots --days 30`  |
| `tl-pr`        | Summarize PR/branch for review   | `tl-pr feature-branch`   |
| `tl-changelog` | Generate changelog from commits  | `tl-changelog --from v1` |

</details>

<details>
<summary><strong>Finding Things</strong> — search and discover code patterns</summary>

| Tool         | Description                        | Example                  |
|--------------|------------------------------------|--------------------------|
| `tl-example` | Find diverse usage examples        | `tl-example useAuth`     |
| `tl-search`  | Run pre-defined search patterns    | `tl-search hooks`        |
| `tl-secrets` | Find hardcoded secrets & API keys  | `tl-secrets --staged`    |
| `tl-todo`    | Find TODOs/FIXMEs in codebase      | `tl-todo src/`           |
| `tl-env`     | Find environment variables used    | `tl-env --required-only` |
| `tl-unused`  | Find unused exports/files          | `tl-unused src/`         |
| `tl-api`     | Extract REST/GraphQL endpoints     | `tl-api src/routes/`     |
| `tl-routes`  | Extract routes from web frameworks | `tl-routes app/`         |
| `tl-npm`     | Quick npm package lookup/compare   | `tl-npm express fastify` |

</details>

<details>
<summary><strong>Utilities</strong></summary>

| Tool            | Description                              | Example                     |
|-----------------|------------------------------------------|-----------------------------|
| `tl-cache`      | Manage ripgrep result cache              | `tl-cache stats`            |
| `tl-config`     | Show/manage configuration                | `tl-config --init`          |
| `tl-context7`   | Look up library docs via Context7 API    | `tl-context7 react "hooks"` |
| `tl-name`       | Check name availability (npm/GH/domains) | `tl-name myproject -s`      |
| `tl-playwright` | Headless browser content extraction      | `tl-playwright example.com` |
| `tl-prompt`     | Generate AI agent instructions           | `tl-prompt --minimal`       |
| `tl-run`        | Smart command runner with summaries      | `tl-run "npm test"`         |

</details>

## Language Support

Code analysis tools are JS/TS-first, but many work across languages. Git-based and search tools work with any language.

|                 | JS/TS | Python | Go | Any language |
|-----------------|:-----:|:------:|:--:|:------------:|
| `tl-symbols`    |   ✓   |   ✓    | ✓  |      ◐       |
| `tl-snippet`    |   ✓   |   ✓    | ✓  |      ◐       |
| `tl-exports`    |   ✓   |   ◐    | ◐  |      -       |
| `tl-deps`       |   ✓   |   ✓    | ✓  |      -       |
| `tl-impact`     |   ✓   |   ✓    | ✓  |      -       |
| `tl-complexity` |   ✓   |   ✓    | ✓  |      -       |
| `tl-flow`       |   ✓   |   ◐    | ◐  |      -       |
| `tl-docs`       |   ✓   |   ◐    | ◐  |      -       |
| `tl-types`      |   ✓   |   -    | -  |      -       |
| `tl-component`  |   ✓   |   -    | -  |      -       |
| `tl-style`      |   ✓   |   -    | -  |      -       |
| `tl-routes`     |   ✓   |   ◐    | -  |      -       |

**✓** full support &nbsp; **◐** partial (basic patterns, may miss language-specific constructs) &nbsp; **-** not supported

Tools not listed (tl-structure, tl-search, tl-diff, tl-todo, tl-secrets, tl-guard, tl-blame, tl-history, tl-hotspots, tl-example, tl-env, tl-run, etc.) are language-agnostic and work with any codebase.

## Configuration

<details>
<summary>Create <code>.tokenleanrc.json</code> in your project root or <code>~/.tokenleanrc.json</code> globally</summary>

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

<details>
<summary>Caching</summary>

tokenlean caches expensive ripgrep operations with **git-based invalidation** — automatically invalidates on commits or
file changes.

```bash
tl-cache stats      # View cache statistics
tl-cache clear      # Clear cache for current project
tl-cache clear-all  # Clear all cached data
```

Disable with `TOKENLEAN_CACHE=0` or in config: `{"cache":{"enabled":false}}`

</details>

## Workflows

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
tl-changelog v0.1.0..v0.2.0       # Between versions
tl-changelog --format compact      # Quick summary
```

</details>

<details>
<summary><strong>Starting a new project</strong></summary>

```bash
tl-name coolproject awesomelib     # Check npm, GitHub, domains
tl-name myapp -s                   # Suggest variations if taken
tl-npm express fastify koa         # Compare framework options
```

</details>

<details>
<summary><strong>Running commands efficiently</strong></summary>

```bash
tl-run "npm test"                  # Summarize test results
tl-run "npm run build"             # Extract build errors only
tl-run "eslint src/"               # Summarize lint violations
tl-run "npm test" -j               # Structured JSON output
```

</details>

<details>
<summary><strong>Looking up documentation</strong></summary>

```bash
tl-context7 react "useEffect"      # Look up React docs
tl-context7 nextjs "app router"    # Next.js docs
tl-npm lodash --deps               # Check package dependencies
tl-npm chalk --versions            # Version history
```

</details>

<details>
<summary><strong>Extracting web content</strong></summary>

```bash
tl-playwright example.com                 # Extract page text
tl-playwright example.com -s "h1,h2,h3"  # Extract headings only
tl-playwright example.com --screenshot p  # Save screenshot
tl-playwright example.com --eval "title"  # Evaluate JS expression
```

</details>

## Design Principles

1. **Single purpose** — Each tool does one thing well
2. **Minimal output** — Show only what's needed
3. **Token-conscious** — Every tool saves context tokens
4. **Composable** — Tools work together with JSON output for piping
5. **Fast** — No heavy parsing or external services
6. **Universal** — Works with JS/TS projects, most tools support Python/Go too

## When NOT to Use tokenlean

- **Non-AI workflows** — if you're not constrained by context windows, standard tools work fine
- **Very small codebases** (<5K LOC) — you can read everything directly without token pressure
- **Languages beyond JS/TS/Python/Go** — code analysis tools are JS/TS-first; git/search tools still work everywhere, but `tl-symbols`, `tl-deps`, etc. may miss language-specific constructs (see [Language Support](#language-support))

## Other Tools for Claude Code

| Project                                                                | Description                                                                    |
|------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| [claude-mneme](https://github.com/edimuj/claude-mneme)                 | Persistent memory for Claude Code — remember context across sessions           |
| [claude-simple-status](https://github.com/edimuj/claude-simple-status) | Minimal statusline showing model, context usage, and quota                     |
| [vexscan-claude-code](https://github.com/edimuj/vexscan-claude-code)   | Security scanner protecting against untrusted plugins, skills, MCPs, and hooks |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes in each release.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding tools, code style, and
submitting PRs.

## License

[MIT](LICENSE) © [Edin Mujkanovic](https://github.com/edimuj)
