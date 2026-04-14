---
name: explore-codebase
description: "Explore unfamiliar repositories in Codex by building a quick structural map, identifying execution entry points, and drilling into only the highest-value files."
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Explore Codebase (Codex)

Understand architecture quickly with targeted reads.

## Workflow

```
Map -> Entry points -> Key modules -> Dependencies -> Summary
```

### 1. Map repository

```bash
tl structure
```

Identify core directories, file counts, and token estimates. Note likely runtime paths (`bin/`, `src/`, `test/`, config files).

### 2. Find entry points

```bash
tl entry                  # Main entry points, route handlers, CLI commands
tl hotspots               # Most frequently changed files (where the action is)
```

### 3. Inspect key modules

For each important file:

```
File size → Decision
  ├─ <150 lines → Just read it
  ├─ 150-400 lines → tl symbols first, tl snippet for specifics
  └─ 400+ lines → tl symbols only, then tl snippet as needed
```

```bash
tl symbols <file>         # Signatures — what does this file expose?
tl symbols src/           # All files in a directory (compact one-liner per file)
tl exports <file>         # What's the public API?
```

### 4. Trace dependencies

```bash
tl deps <file>            # What does it import?
tl impact <file>          # Who depends on this?
tl flow <function> <file> # Call graph for a key function
```

### 5. Summarize

Produce:
- What the project does
- Top directories and responsibilities
- Main execution flow
- High-risk or high-churn areas

## Tips

- Run tl entry and tl hotspots in parallel — they're independent.
- `tl context <dir>` shows token cost of a directory — skip reading dirs over 50k tokens directly.
- Use commit history (`git log -- <file>`) to identify active areas.
