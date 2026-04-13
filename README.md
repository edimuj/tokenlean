<p align="center">
  <img src="https://raw.githubusercontent.com/edimuj/tokenlean/main/assets/tokenlean-mascot-200.png" alt="Tokenlean mascot - a squirrel collecting tokens" />
</p>

<h1 align="center">tokenlean</h1>

<p align="center">
  <strong>60+ CLI tools + MCP server that let AI agents understand codebases without burning tokens</strong>
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
tl doctor --agents        # Check MCP, hooks, skills, and project instructions
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
# Workflow-ready briefing        tl pack refactor src/auth.ts
# What should I run next?       tl advise "debug npm test"
```

Every tool supports `-l N` (limit lines), `-t N` (limit tokens), `-j` (JSON output), `-q` (quiet), and `-h` (help).

See [all tools](docs/tools.md) for the complete reference.

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

MCP tools include the core context reducers (`tl_symbols`, `tl_snippet`, `tl_run`, `tl_impact`, `tl_browse`, `tl_tail`, `tl_guard`, `tl_diff`) plus workflow routers (`tl_advise`, `tl_pack`) and briefing tools (`tl_analyze`, `tl_related`, `tl_context`, `tl_structure`, `tl_entry`). Structured JSON in/out — no bash command construction, no argument parsing, no stdout scraping.

**Hooks** — automatically nudge agents toward token-efficient tool usage:

```bash
tl hook install claude-code    # Claude Code (auto-detects claude-rig session)
tl hook install codex          # Codex (~/.codex/hooks.json)
tl hook install opencode       # Open Code (~/.config/opencode/plugins/)
tl hook status --all           # Check hook adapters
tl hook run -j                 # Structured policy decision for adapters/MCP
tl audit --all --savings       # Measure actual savings across sessions
tl audit --all --plan          # Turn audit findings into prioritized fixes
```

## MCP Server

`tl-mcp` exposes tokenlean tools as structured MCP function calls — no CLI argument construction, instant tool discovery.

### Quick start (stdio)

No daemon needed. Each agent session spawns a fresh process:

```json
{
  "mcpServers": {
    "tokenlean": { "command": "tl-mcp" }
  }
}
```

### Persistent daemon modes

`tl-mcp` now supports three useful daemon styles:

1. **Always on** — start at login via launchd/systemd
2. **Just for one agent session** — stdio starts a helper daemon only if needed, then stops it when the session exits
3. **Start on demand, self-expire later** — keep the daemon warm, but auto-exit after inactivity

#### 1) Always on at startup

**macOS (launchd):**

```bash
tl-mcp install-service
# optional idle shutdown even under launchd docs:
tl-mcp install-service --idle-timeout 120
```

**Linux (systemd user service):**

```bash
tl-mcp install-service
# or:
tl-mcp install-service --idle-timeout 120
```

To inspect the exact setup commands instead of piping them into bash:

```bash
tl-mcp install-service
```

#### 2) One Codex/agent session only

Use stdio as normal, but add `--session-daemon` if you want a temporary helper daemon only for that session:

```json
{
  "mcpServers": {
    "tokenlean": {
      "command": "tl-mcp",
      "args": ["--session-daemon"]
    }
  }
}
```

Behavior:
- if no daemon is running, `tl-mcp` starts one
- when that stdio session exits, it stops the daemon it created
- if a daemon was already running, it reuses it and leaves it alone

#### 3) Start if needed, then self-terminate after idle time

```bash
tl-mcp start --idle-timeout 120
tl-mcp status
tl-mcp stop
```

This keeps the daemon available across multiple sessions, but it shuts itself down after 120 minutes without MCP requests.

You can also make stdio auto-start a warm daemon with an idle timeout:

```bash
tl-mcp --idle-timeout 120
```

#### Agent config (after daemon is running)

**Claude Code:**
```bash
claude mcp add --transport http --scope user tokenlean http://127.0.0.1:3742/mcp
```

**`.mcp.json` (any agent):**
```json
{
  "mcpServers": {
    "tokenlean": { "type": "http", "url": "http://127.0.0.1:3742/mcp" }
  }
}
```

**Codex (`~/.codex/config.toml`):**
```toml
[mcp_servers.tokenlean]
command = "/opt/homebrew/bin/tl-mcp"   # macOS Homebrew
# command = "/usr/local/bin/tl-mcp"   # Linux
args = []
```

**Codex with a one-session helper daemon:**
```toml
[mcp_servers.tokenlean]
command = "/opt/homebrew/bin/tl-mcp"
args = ["--session-daemon"]
```

**Codex with warm-cache daemon that idles out after 120m:**
```toml
[mcp_servers.tokenlean]
command = "/opt/homebrew/bin/tl-mcp"
args = ["--idle-timeout", "120"]
```

Codex uses stdio (spawns a process per session), but calling the installed binary directly avoids the `npx` registry-check overhead.

### Available MCP tools

| Tool | Description |
|------|-------------|
| `tl_symbols` | Extract function/class signatures without bodies |
| `tl_snippet` | Extract a function/class by name |
| `tl_run` | Token-efficient command output (tests, builds) |
| `tl_impact` | What depends on a given file |
| `tl_browse` | Fetch a URL as clean markdown |
| `tl_tail` | Collapse repeated log patterns, surface errors |
| `tl_guard` | Pre-commit check (secrets, TODOs, unused, circular) |
| `tl_diff` | Token-efficient git diff summary |

Selective registration: `tl-mcp --tools symbols,snippet,run`

## Agent Skills

Ready-made workflows following the [Agent Skills](https://agentskills.io) open format. Each workflow ships in Claude Code and Codex variants with runtime-specific wording, but the underlying method is the same: gather narrow context first, then act.

| Workflow | Use it when... | Claude Code | Codex |
|----------|----------------|-------------|-------|
| Code review | Reviewing a PR or local diff with risk-first context gathering | [`code-review`](skills/claude/code-review/SKILL.md) | [`code-review`](skills/codex/code-review/SKILL.md) |
| Explore codebase | Understanding an unfamiliar repo without reading everything | [`explore-codebase`](skills/claude/explore-codebase/SKILL.md) | [`explore-codebase`](skills/codex/explore-codebase/SKILL.md) |
| Safe refactor | Renaming, moving, extracting, or reshaping shared code | [`safe-refactor`](skills/claude/safe-refactor/SKILL.md) | [`safe-refactor`](skills/codex/safe-refactor/SKILL.md) |
| Add feature | Implementing behavior after locating existing patterns | [`add-feature`](skills/claude/add-feature/SKILL.md) | [`add-feature`](skills/codex/add-feature/SKILL.md) |
| Debug bug | Reproducing, tracing, fixing, and verifying defects | [`debug-bug`](skills/claude/debug-bug/SKILL.md) | [`debug-bug`](skills/codex/debug-bug/SKILL.md) |
| Debug performance | Measuring before optimizing, then confirming wins | [`debug-performance`](skills/claude/debug-performance/SKILL.md) | [`debug-performance`](skills/codex/debug-performance/SKILL.md) |
| Write tests | Adding behavior-focused tests that match project conventions | [`write-tests`](skills/claude/write-tests/SKILL.md) | [`write-tests`](skills/codex/write-tests/SKILL.md) |
| Upgrade deps | Auditing usage and changelogs before dependency bumps | [`upgrade-deps`](skills/claude/upgrade-deps/SKILL.md) | [`upgrade-deps`](skills/codex/upgrade-deps/SKILL.md) |
| Migrate framework | Running incremental migrations in dependency-safe batches | [`migrate-framework`](skills/claude/migrate-framework/SKILL.md) | [`migrate-framework`](skills/codex/migrate-framework/SKILL.md) |

Install the variant for your agent:

```bash
# Copy all workflows
cp -r node_modules/tokenlean/skills/claude/* ~/.claude/skills/
cp -r node_modules/tokenlean/skills/codex/* ~/.codex/skills/

# Or copy one workflow
cp -r node_modules/tokenlean/skills/claude/code-review ~/.claude/skills/
cp -r node_modules/tokenlean/skills/codex/code-review ~/.codex/skills/
```

When working from a clone, replace `node_modules/tokenlean` with the local repo path.

## Design Principles

1. **Single purpose** — one tool, one job
2. **Minimal output** — show what's needed, nothing more
3. **Composable** — every tool supports `-j` for JSON piping
4. **Fast** — no heavy parsing, no external services, aggressive caching
5. **Multi-language** — JS/TS first, expanding to Python, Go, Rust, Ruby

## More

- [All tools](docs/tools.md) — complete tool reference with examples
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
