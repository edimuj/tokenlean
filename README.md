<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/tokenlean-mascot-200.png" alt="Tokenlean mascot - a squirrel collecting tokens" />
</p>

<h1 align="center">tokenlean</h1>

<p align="center">
  <strong>60 CLI tools + MCP server that let AI agents understand codebases without burning tokens</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/v/tokenlean.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/tokenlean"><img src="https://img.shields.io/npm/dm/tokenlean.svg" alt="npm downloads"></a>
  <a href="https://github.com/edimuj/tokenlean/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tokenlean.svg" alt="license"></a>
</p>

<p align="center">
  <a href="#the-problem">Why</a> •
  <a href="#install">Install</a> •
  <a href="#quick-reference">Quick Reference</a> •
  <a href="docs/tools.md">All Tools</a> •
  <a href="#ai-agent-integration">AI Integration</a> •
  <a href="docs/workflows.md">Workflows</a> •
  <a href="docs/language-support.md">Languages</a>
</p>

---

**Zero config** — `npm i -g tokenlean` and you're done
&middot;
**Token-conscious** — every tool outputs only what's needed
&middot;
**Fast** — ripgrep-powered with disk caching
&middot;
**Multi-language** — JS/TS, Python, Go, Rust, Ruby
&middot;
**MCP native** — structured tool access, no shell overhead
&middot;
**Minimal deps** — installs in seconds

---

## The Problem

If you've ever checked your usage quota at 2 PM and decided whether to debug now or wait for the reset — this is for you. Enterprise teams with unlimited API keys don't feel the burn. Solo devs, small teams, anyone on a Pro subscription does. Every `cat` of a 2000-line file when you needed one function, every 300-line test run when only 3 lines failed, every full directory read to find a signature — that's your working day getting shorter.

tokenlean fixes this:

| Instead of...                             | Use                 | Savings               |
|-------------------------------------------|---------------------|-----------------------|
| Reading a 500-line file for signatures    | `tl symbols`        | **~90% fewer tokens** |
| Reading all files to find exports         | `tl exports`        | **~95% fewer tokens** |
| Guessing what a change might break        | `tl impact`         | **Know for sure**     |
| Reading a file to extract one function    | `tl snippet`        | **~85% fewer tokens** |
| Running `npm test` and reading all output | `tl run "npm test"` | **Errors only**       |
| Scanning long logs for real failures      | `tl tail app.log`   | **Errors/warns + dedupe** |

### How much are you wasting?

Find out in one command, no install needed:

```bash
npx tokenlean audit --all --savings --claudecode
```

```
Summary (348 Claude Code sessions)
  Opportunities:
  Category                Count  Actual     Saveable   Suggestion
  ----------------------------------------------------------------------------
  read-large-file          75x    253.4k      202.7k   -> tl symbols + tl snippet
  build-test-output        34x     28.2k       18.3k   -> tl run
  tail-command              7x      4.8k        3.3k   -> tl tail
  curl-command             13x      3.2k        2.3k   -> tl browse
  cat-large-file            1x      1.1k         902   -> tl symbols + tl snippet
  webfetch                  4x      1.2k         823   -> tl browse
  head-command             11x      3.8k         759   -> Read tool (with limit)

  Still saveable:     243.6k of 363.9k (67%)

  Already saved by tokenlean:
  Tool              Count  Compressed   Raw estimate   Saved
  ------------------------------------------------------------------
  tl snippet          233x      215.7k            2.2M   1.9M
  tl symbols           93x       59.0k          295.0k   236.0k
  tl run               98x       28.7k           82.0k   53.3k

  Tokens saved:       2.2M (424 uses)
  Capture rate:       90% of potential savings realized
```

<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/demo.gif" alt="tokenlean demo — tl structure, tl symbols, and tl exports in action" width="800" />
</p>

## Install

```bash
npm install -g tokenlean
```

Requires **Node.js >= 18**, **[ripgrep](https://github.com/BurntSushi/ripgrep)** for search tools, and **git** for
history tools.

Use `tl` as the global entry point — one command, many subcommands:

```bash
tl                        # List all available commands
tl doctor                 # Verify Node.js, ripgrep, git, hooks, and config
tl update                 # Update the global tokenlean install
tl completions bash|zsh   # Tab completions for subcommands and flags
```

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
# What's in this file?           tl symbols src/auth.ts
# Functions only (dir/multi-file) tl symbols src/ --filter function
# Extract just one function      tl snippet handleSubmit
# What does this module export?  tl exports src/lib/
# How many tokens will this cost? tl context src/api/
# What's the project shape?      tl structure

# What depends on this file?     tl impact src/auth.ts
# How complex is this code?      tl complexity src/auth.ts
# Where are the tests?           tl related src/Button.tsx

# What changed recently?         tl diff --staged
# Is it safe to commit?          tl guard
# Find real usage examples       tl example useAuth
# Summarize noisy logs            tl tail logs/app.log
# What's the tech stack?         tl stack
```

Every tool supports `-l N` (limit lines), `-t N` (limit tokens), `-j` (JSON output), `-q` (quiet), and `-h` (help).

See [all 60 tools](docs/tools.md) for the complete reference.

## AI Agent Integration

Add tokenlean instructions to your AI tool's config with a single command:

| AI Tool        | Command                                        |
|----------------|------------------------------------------------|
| Claude Code    | `tl prompt >> CLAUDE.md`                       |
| Codex          | `tl prompt --codex >> AGENTS.md`               |
| Cursor         | `tl prompt --minimal >> .cursorrules`          |
| GitHub Copilot | `tl prompt >> .github/copilot-instructions.md` |
| Windsurf       | `tl prompt --minimal >> .windsurfrules`        |

**MCP Server** — expose tokenlean as native MCP tools for structured, faster access with no CLI overhead:

```bash
# Add to any project's .mcp.json (Claude Code, Codex, etc.)
{
  "mcpServers": {
    "tokenlean": { "command": "tl mcp" }
  }
}

# Or pick just the tools you need
{ "command": "tl mcp", "args": ["--tools", "symbols,snippet,run"] }
```

8 core tools available via MCP: `tl_symbols`, `tl_snippet`, `tl_run`, `tl_impact`, `tl_browse`, `tl_tail`, `tl_guard`, `tl_diff`. Structured JSON in/out — no bash command construction, no argument parsing, no stdout scraping.

**Hooks** — automatically nudge agents toward token-efficient tool usage:

```bash
tl hook install claude-code    # Gentle reminders when agents waste tokens
tl audit --all --savings       # Measure actual savings across sessions
```

See [measuring token savings](docs/workflows.md#measuring-token-savings) for full audit and hook setup details.

## Agent Skills

Ready-made workflows following the [Agent Skills](https://agentskills.io) open format, organized for both Claude Code and Codex runtimes.

### Claude Code skills

| Skill | What it does |
|-------|-------------|
| [`code-review`](skills/claude/code-review/SKILL.md) | Review PRs efficiently — scope, blast radius, complexity, then targeted code reading |
| [`explore-codebase`](skills/claude/explore-codebase/SKILL.md) | Understand an unfamiliar project in minutes without reading everything |
| [`safe-refactor`](skills/claude/safe-refactor/SKILL.md) | Rename, move, or extract code with impact analysis and verification at each step |
| [`add-feature`](skills/claude/add-feature/SKILL.md) | Add functionality by studying existing patterns first — locate, learn conventions, implement, verify |
| [`debug-bug`](skills/claude/debug-bug/SKILL.md) | Systematic bug investigation — reproduce, localize with blame/history, trace call path, verify fix |
| [`debug-performance`](skills/claude/debug-performance/SKILL.md) | Measure before optimizing — establish baselines, identify bottlenecks, confirm improvements with numbers |
| [`write-tests`](skills/claude/write-tests/SKILL.md) | Write tests by studying existing patterns and code under test before writing assertions |
| [`upgrade-deps`](skills/claude/upgrade-deps/SKILL.md) | Upgrade dependencies safely — audit usage, research breaking changes, scale effort to version jump |
| [`migrate-framework`](skills/claude/migrate-framework/SKILL.md) | Incremental framework/API migration with verification at each step, batched by dependency order |

### Codex skills

| Skill | What it does |
|-------|-------------|
| [`code-review`](skills/codex/code-review/SKILL.md) | Risk-first code review workflow for Codex using git diff + targeted validation |
| [`explore-codebase`](skills/codex/explore-codebase/SKILL.md) | Build a fast architecture map in Codex with targeted reads and dependency tracing |
| [`safe-refactor`](skills/codex/safe-refactor/SKILL.md) | Refactor safely in Codex using blast-radius checks and incremental verification |
| [`add-feature`](skills/codex/add-feature/SKILL.md) | Add features in Codex by mapping precedent first, then implementing minimal safe changes |
| [`debug-bug`](skills/codex/debug-bug/SKILL.md) | Repro-first bug fixing workflow in Codex with root-cause tracing and regression checks |
| [`debug-performance`](skills/codex/debug-performance/SKILL.md) | Performance debugging in Codex with baseline metrics and before/after proof |
| [`write-tests`](skills/codex/write-tests/SKILL.md) | Write behavior-focused tests in Codex that match project conventions |
| [`upgrade-deps`](skills/codex/upgrade-deps/SKILL.md) | Dependency upgrade workflow in Codex with changelog-driven risk control |
| [`migrate-framework`](skills/codex/migrate-framework/SKILL.md) | Incremental framework/API migrations in Codex with batch-level verification |

```bash
# Claude Code — copy a skill
cp -r node_modules/tokenlean/skills/claude/code-review ~/.claude/skills/

# Claude Code — copy all skills
cp -r node_modules/tokenlean/skills/claude/* ~/.claude/skills/

# Codex — copy a skill
cp -r node_modules/tokenlean/skills/codex/code-review ~/.codex/skills/

# Codex — copy all skills
cp -r node_modules/tokenlean/skills/codex/* ~/.codex/skills/

# Or clone and pick what you need
git clone https://github.com/edimuj/tokenlean.git
cp -r tokenlean/skills/claude/code-review ~/.claude/skills/
cp -r tokenlean/skills/codex/code-review ~/.codex/skills/
```

## Design Principles

1. **Single purpose** — one tool, one job
2. **Minimal output** — show what's needed, nothing more
3. **Composable** — every tool supports `-j` for JSON piping
4. **Fast** — no heavy parsing, no external services, aggressive caching
5. **Multi-language** — JS/TS first, expanding to Python, Go, Rust, Ruby

## More

- [All 58 tools](docs/tools.md) — complete tool reference with examples
- [Workflows](docs/workflows.md) — task-oriented recipes (refactoring, PR review, releases, etc.)
- [Language support](docs/language-support.md) — compatibility matrix across languages
- [Configuration](docs/configuration.md) — `.tokenleanrc.json` schema and caching

## Also by Exelerus

| Project | Description |
|---------|-------------|
| [claude-rig](https://github.com/edimuj/claude-rig) | Run multiple Claude Code profiles side-by-side — isolate or share settings, plugins, MCPs per rig |
| [agent-awareness](https://github.com/edimuj/agent-awareness) | Modular awareness plugins for AI coding agents |
| [claude-mneme](https://github.com/edimuj/claude-mneme) | Persistent memory for Claude Code — context across sessions |
| [claude-simple-status](https://github.com/edimuj/claude-simple-status) | Minimal statusline — model, context usage, quota at a glance |
| [vexscan-claude-code](https://github.com/edimuj/vexscan-claude-code) | Security scanner for untrusted plugins, skills, MCPs, and hooks |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on adding tools, code style, and
submitting PRs.

## License

[MIT](LICENSE) © [Edin Mujkanovic](https://github.com/edimuj)
