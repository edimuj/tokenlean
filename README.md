# tokenlean

Lean CLI tools for AI agents and developers. Reduce context usage, save tokens, improve workflow efficiency.

## Installation

```bash
npm install -g tokenlean
```

Or link locally for development:
```bash
git clone https://github.com/YOUR_USERNAME/tokenlean.git
cd tokenlean
npm link
```

## Tools

### tl-context

Estimate context token usage for files/directories.

```bash
tl-context              # Current dir, top 20 files
tl-context src/         # Specific directory
tl-context --top 50     # Show top 50 files
tl-context --all        # Show all files
```

### tl-search

Pre-defined search patterns for common lookups.

```bash
tl-search               # Show available patterns
tl-search hooks         # Run a specific pattern
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

### tl-structure

Smart project overview with token estimates.

```bash
tl-structure            # Default depth (3)
tl-structure --depth 2  # Shallow view
tl-structure src/       # Specific directory
```

Shows a directory tree with file counts and token estimates. Marks important directories/files with `*`.

### tl-diff

Token-efficient git diff summary.

```bash
tl-diff                 # Unstaged changes
tl-diff --staged        # Staged changes only
tl-diff HEAD~3          # Compare with ref
tl-diff --stat-only     # Just the summary
```

Categorizes changes by type (components, hooks, store, tests, etc.) and estimates token impact.

### tl-related

Find related files for a given file.

```bash
tl-related src/components/Button.tsx
```

Finds:
- Test files (`*.test.ts`, `*.spec.ts`, `__tests__/`)
- Type definitions
- Files that import this one
- Sibling files in the same directory

### tl-component

React component analyzer.

```bash
tl-component src/components/MyComponent.tsx
```

Shows:
- Props interface with types
- Hooks used
- Redux selectors/actions
- Import dependencies
- Styling approach

## Dependencies

- **ripgrep** (`rg`): Required for tl-search and tl-related 

## Why tokenlean?

When working with AI coding assistants, context window usage directly impacts cost and effectiveness. These tools help:

- **Estimate before reading**: Know file sizes before deciding to read them
- **Find efficiently**: Pre-defined patterns avoid multiple grep iterations
- **Understand structure**: Quick project overview without reading everything
- **Navigate changes**: Understand diffs without full content
- **Analyze components**: Get component info without reading the full file

## License

MIT
