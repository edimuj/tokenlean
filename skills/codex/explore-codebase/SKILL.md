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
tl parallel "tl entry" "tl hotspots"
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
# Per file, gather context in one call:
tl parallel "symbols=tl symbols <file>" "exports=tl exports <file>"

# Or for entire directories:
tl symbols src/           # All files in a directory (compact one-liner per file)
```

### 4. Trace dependencies

```bash
tl parallel \
  "deps=tl deps <file>" \
  "impact=tl impact <file>" \
  "flow=tl flow <function> <file>"
```

### 5. Summarize

Produce:
- What the project does
- Top directories and responsibilities
- Main execution flow
- High-risk or high-churn areas

## Tips

- Use `tl parallel` to gather context on multiple files simultaneously.
- `tl context <dir>` shows token cost of a directory — skip reading dirs over 50k tokens directly.
- Use commit history (`git log -- <file>`) to identify active areas.
