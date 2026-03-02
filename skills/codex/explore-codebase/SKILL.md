---
name: explore-codebase
description: Explore unfamiliar repositories in Codex by building a quick structural map, identifying execution entry points, and drilling into only the highest-value files.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Explore Codebase (Codex)

Understand architecture quickly with targeted reads.

## Workflow

```
Map -> Entry points -> Key modules -> Dependencies -> Summary
```

### 1. Map repository

```bash
rg --files
find . -maxdepth 3 -type d | sort
```

Identify core directories and likely runtime paths (`bin/`, `src/`, `test/`, config files).

### 2. Find entry points

```bash
ls -la bin
cat package.json
rg -n "bin|scripts|main|exports" package.json
```

### 3. Inspect key modules

```bash
rg -n "export |function |class " src
sed -n '1,220p' <key-file>
```

Read smaller files fully; skim larger files by symbol and targeted snippets.

### 4. Trace dependencies

```bash
rg -n "from '<module>'|require\('<module>'\)" src
rg -n "<core symbol>" src test bin
```

### 5. Summarize

Produce:
- What the project does
- Top directories and responsibilities
- Main execution flow
- High-risk or high-churn areas

## Tips

- Start broad, then narrow.
- Avoid opening many large files before you know they matter.
- Use commit history (`git log -- <file>`) to identify active areas.
