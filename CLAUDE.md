# Tokenlean

CLI tools for AI agents - maximum insight with minimum tokens.

## Project Structure

```
bin/               # CLI entry points (tl-*.mjs) - thin wrappers
src/               # Shared modules
  output.mjs       # Common flags (-l, -t, -j, -q, -h), formatting, token estimation
  project.mjs      # File categorization, language detection, skip/important logic
  cache.mjs        # LRU disk cache for expensive operations (ripgrep results)
  traverse.mjs     # Fast file traversal with filtering
  config.mjs       # Config file loading (.tokenleanrc.json)
  shell.mjs        # Safe git/rg wrappers (spawnSync, no shell injection)
  generic-lang.mjs # Regex-based symbol/import extraction for non-JS/TS languages
skills/            # Agent skills
  claude/          # Claude Code skill variants
  codex/           # Codex skill variants
```

## Adding a New Tool

1. Create `bin/tl-<name>.mjs` with shebang `#!/usr/bin/env node`
2. Import shared modules from `../src/`
3. Use `output.mjs` for consistent flags and formatting
4. Add entry to `package.json` bin section
5. Run `npm link` to test locally

## Conventions

- **Minimal dependencies** - node-html-markdown for tl-browse, otherwise Node.js built-ins only
- **ES modules** - use `.mjs` extension, `import`/`export`
- All tools support common flags: `-l` (limit), `-t` (tokens), `-j` (JSON), `-q` (quiet), `-h` (help)
- Users invoke tools via `tl <command>` (e.g. `tl symbols`, `tl run`), which dispatches to `bin/tl-<command>.mjs`
- For noisy logs, prefer `tl tail <file>` (or piped stdin) to collapse repeats and surface error/warn lines
- Exit codes: 0 success, 1 error
- Output should be token-efficient (no verbose explanations)

## Shell Completions

`tl completions bash|zsh` outputs a completion script. Dynamic — new tools are picked up automatically.

Backend: `tl --list-commands [--with-desc]` and `tl --list-flags <command>` (extracts flags from tool source via regex).

## Testing

```bash
npm link              # Install locally
tl <tool> --help      # Verify help works
tl <tool> [args]      # Test functionality
```

## Publishing

```bash
npm version patch|minor|major
npm publish
```
