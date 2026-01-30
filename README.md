# Claude Tools

Cross-project CLI tools for working with Claude Code. Helps reduce context usage and improve workflow efficiency.

## Installation

```bash
cd ~/projects/claude-tools
npm link
```

This makes all tools available globally.

## Tools

### claude-context

Estimate context token usage for files/directories.

```bash
claude-context              # Current dir, top 20 files
claude-context src/         # Specific directory
claude-context --top 50     # Show top 50 files
claude-context --all        # Show all files
```

### claude-search

Pre-defined search patterns for common lookups.

```bash
claude-search               # Show available patterns
claude-search hooks         # Run a specific pattern
```

Requires `.claude/search-patterns.json` in your project:

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

### claude-structure

Smart project overview with token estimates.

```bash
claude-structure            # Default depth (3)
claude-structure --depth 2  # Shallow view
claude-structure src/       # Specific directory
```

Shows directory tree with file counts and token estimates. Marks important directories/files with `*`.

### claude-diff

Token-efficient git diff summary.

```bash
claude-diff                 # Unstaged changes
claude-diff --staged        # Staged changes only
claude-diff HEAD~3          # Compare with ref
claude-diff --stat-only     # Just the summary
```

Categorizes changes by type (components, hooks, store, tests, etc.) and estimates token impact.

### claude-related

Find related files for a given file.

```bash
claude-related src/components/Button.tsx
```

Finds:
- Test files (`*.test.ts`, `*.spec.ts`, `__tests__/`)
- Type definitions
- Files that import this one
- Sibling files in the same directory

### claude-component

React component analyzer.

```bash
claude-component src/components/MyComponent.tsx
```

Shows:
- Props interface with types
- Hooks used
- Redux selectors/actions
- Import dependencies
- Styling approach

## Dependencies

- **ripgrep** (`rg`): Required for claude-search and claude-related
  ```bash
  brew install ripgrep  # macOS
  ```

## Adding to a Project

1. Create `.claude/search-patterns.json` with project-specific search patterns
2. Use the tools from anywhere in the project directory

## Why These Tools?

When working with Claude Code, context window usage directly impacts cost and effectiveness. These tools help:

- **Estimate before reading**: Know file sizes before deciding to read them
- **Find efficiently**: Pre-defined patterns avoid multiple grep iterations
- **Understand structure**: Quick project overview without reading everything
- **Navigate changes**: Understand diffs without full content
- **Analyze components**: Get component info without reading full file
