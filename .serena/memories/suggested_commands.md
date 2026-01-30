# Suggested Commands

## Development

### Install/Link Tools Globally
```bash
npm link
```

### Test a Tool Locally
```bash
node bin/claude-context.mjs [args]
node bin/claude-search.mjs [args]
# etc.
```

## Using the Tools

### Estimate Context Usage
```bash
claude-context              # Current dir, top 20 files
claude-context src/         # Specific directory
claude-context --top 50     # Show top 50 files
claude-context --all        # Show all files
```

### Search with Patterns
```bash
claude-search               # Show available patterns
claude-search hooks         # Run a specific pattern
```

### Project Structure Overview
```bash
claude-structure            # Default depth (3)
claude-structure --depth 2  # Shallow view
```

### Git Diff Summary
```bash
claude-diff                 # Unstaged changes
claude-diff --staged        # Staged changes only
claude-diff HEAD~3          # Compare with ref
```

### Find Related Files
```bash
claude-related src/components/Button.tsx
```

### Analyze React Component
```bash
claude-component src/components/MyComponent.tsx
```

## Git
```bash
git status
git diff
git log --oneline -10
```

## System (macOS/Darwin)
```bash
ls -la
find . -name "*.mjs"
rg "pattern"               # ripgrep for searching
```
