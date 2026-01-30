# Claude Tools

Cross-project CLI tools for working with Claude Code.

## Installation

```bash
cd ~/projects/claude-tools
npm link
```

This makes the tools available globally.

## Tools

### claude-search

Pre-defined search patterns for common lookups.

```bash
claude-search <pattern-name>
```

Requires a `.claude/search-patterns.json` in your project:

```json
{
  "patterns": {
    "hooks": {
      "description": "Find all lifecycle hooks",
      "pattern": "on(Mount|Unmount|Update)",
      "glob": "**/*.ts"
    }
  }
}
```

### claude-context

Estimate context token usage for files/directories.

```bash
# Analyze current directory
claude-context

# Analyze specific path
claude-context src/

# Show top 50 files
claude-context --top 50

# Show all files
claude-context --all
```

Helps identify which files/directories contribute most to context usage.

## Adding to a Project

1. Create `.claude/search-patterns.json` with project-specific patterns
2. Run `claude-search` to use them

## Dependencies

- **ripgrep** (`rg`): Required for claude-search
  ```bash
  brew install ripgrep  # macOS
  ```
