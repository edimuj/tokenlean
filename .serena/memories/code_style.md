# Code Style & Conventions

## General Style
- ES Modules (`.mjs` extension, `"type": "module"` in package.json)
- Shebang: `#!/usr/bin/env node`
- File-level JSDoc comment describing tool purpose and usage

## Naming Conventions
- CLI tools: `claude-{name}.mjs` pattern
- Functions: camelCase
- Constants: UPPER_SNAKE_CASE for sets/arrays of config values
- Variables: camelCase

## Code Patterns
- Use Node.js built-in modules (fs, path, child_process)
- No external dependencies (pure Node.js scripts)
- Simple argument parsing (manual, no libraries)
- Console output with emoji prefixes for visual clarity
- Error handling with try/catch for file operations

## File Structure Pattern
Each CLI tool follows this structure:
1. Shebang
2. JSDoc comment with purpose and usage
3. Imports
4. Constants (config values)
5. Helper functions
6. Main logic at bottom

## Output Formatting
- Use emoji for visual markers (📊, ✨, etc.)
- Align columns in tabular output
- Use `padStart`/`padEnd` for alignment
- Format large numbers (k, M suffixes)
