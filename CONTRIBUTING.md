# Contributing to tokenlean

Thanks for your interest in making AI-assisted coding more token-efficient! Whether it's a bug fix, a new tool, or a documentation tweak — contributions are welcome.

## Quick Links

- [Issues](https://github.com/edimuj/tokenlean/issues) — Bug reports and feature requests
- [Discussions](https://github.com/edimuj/tokenlean/discussions) — Questions and ideas
- [Changelog](CHANGELOG.md) — What's changed

## Getting Started

```bash
git clone https://github.com/edimuj/tokenlean.git
cd tokenlean
npm link    # Makes all tl-* commands available globally
```

Verify it works:

```bash
tl-structure --help
```

## Project Structure

```
bin/           # CLI entry points (tl-*.mjs)
src/
  output.mjs   # Common flags (-l, -t, -j, -q, -h), formatting, token estimation
  project.mjs  # File categorization, language detection, skip/important logic
  cache.mjs    # LRU disk cache with git-based invalidation
  traverse.mjs # Fast file traversal with symlink protection
  config.mjs   # Config file loading (.tokenleanrc.json)
```

## Adding a New Tool

Every tool follows the same pattern. Here's the recipe:

### 1. Create the file

Create `bin/tl-<name>.mjs`:

```javascript
#!/usr/bin/env node

// Prompt info for tl-prompt
if (process.argv.includes('--prompt')) {
  console.log(JSON.stringify({
    name: 'tl-<name>',
    desc: 'One-line description',
    when: 'before-read',        // or: before-modify, searching, utility
    example: 'tl-<name> src/'
  }));
  process.exit(0);
}

import {
  createOutput,
  parseCommonArgs,
  COMMON_OPTIONS_HELP
} from '../src/output.mjs';
import { findProjectRoot } from '../src/project.mjs';

const HELP = `
tl-<name> - One-line description

Usage: tl-<name> [path] [options]

Options:
${COMMON_OPTIONS_HELP}

Examples:
  tl-<name> src/               # Do the thing
`;

const args = process.argv.slice(2);
const options = parseCommonArgs(args);

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const projectRoot = findProjectRoot();
const out = createOutput(options);

// Your logic here...

out.print();
```

### 2. Register it

Add to `package.json` bin section:

```json
"tl-<name>": "bin/tl-<name>.mjs"
```

### 3. Make it executable

```bash
chmod +x bin/tl-<name>.mjs
```

### 4. Test it

```bash
npm link
tl-<name> --help
tl-<name> src/
tl-<name> src/ --json
```

### 5. Update docs

- Add to the appropriate table in `README.md`
- Add to the tools table in `CLAUDE.md`
- Update `CHANGELOG.md`

## Design Principles

These aren't suggestions — they're the rules of the game:

1. **Zero dependencies** — Only Node.js built-ins. No `package-lock.json` in production.
2. **Single purpose** — Each tool does one thing well. If it does two things, it's two tools.
3. **Token-conscious** — Every byte of output matters. No verbose explanations, no decorative borders.
4. **Fast** — No heavy parsing, no AST analysis, no external services (unless that's the tool's purpose).
5. **ES modules** — Use `.mjs` extension, `import`/`export` syntax.
6. **Common flags** — All tools support `-l` (limit lines), `-t` (limit tokens), `-j` (JSON), `-q` (quiet), `-h` (help).

## Code Style

We practice what we preach — keep it lean:

- No TypeScript (we're a CLI tool, not a library)
- No test framework (test manually, keep it simple)
- Prefer `execSync`/`spawnSync` with proper escaping (`shellEscape` from `output.mjs`)
- Use `spawnSync` with array args when building commands from user input (no shell injection)
- Handle errors gracefully — a tool should never crash with an unhandled exception

## Submitting Changes

1. **Fork & branch** — Create a branch from `main`
2. **Keep it focused** — One feature or fix per PR
3. **Test manually** — Run your tool against a real project
4. **Update docs** — README, CLAUDE.md, CHANGELOG
5. **Open a PR** — Describe what and why (not how — the code shows how)

## Reporting Bugs

[Open an issue](https://github.com/edimuj/tokenlean/issues/new?template=bug_report.md) with:

- The command you ran
- What you expected
- What actually happened
- Your Node.js version (`node --version`)

## Suggesting Tools

Got an idea for a new tool? [Open a feature request](https://github.com/edimuj/tokenlean/issues/new?template=feature_request.md). The best suggestions include:

- **What problem it solves** for AI agents
- **How many tokens it saves** compared to the alternative
- **A concrete example** of input and output

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
