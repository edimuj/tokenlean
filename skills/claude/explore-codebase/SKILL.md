---
name: explore-codebase
description: "Efficiently explore and understand an unfamiliar codebase using token-lean context gathering. Maps project structure, identifies key files, and builds understanding progressively without reading everything. Use when onboarding to a new project, asked to understand a codebase, or starting work in unfamiliar code."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Explore Codebase

Understand a project in minutes by reading as little raw code as possible.

## Workflow

```
Structure → Key areas → Drill down → Report
```

### 1. Get the map

```bash
tl structure
```

This shows directories, file counts, and token estimates. Identify:
- Where the bulk of the code lives
- Entry points (usually obvious from directory names)
- Test coverage presence

### 2. Find entry points and hot files

```bash
tl parallel "tl entry" "tl hotspots"
```

Entry points tell you where execution starts. Hotspots tell you where development is active.

### 3. Understand key files

For each important file identified above:

```
File size → Decision
  ├─ <150 lines → Just read it
  ├─ 150-400 lines → tl symbols first, tl snippet for specifics
  └─ 400+ lines → tl symbols only, then tl snippet as needed
```

```bash
# Per file, gather context in one call:
tl parallel "symbols=tl symbols <file>" "deps=tl deps <file>" "exports=tl exports <file>"

# Or for entire directories:
tl symbols src/           # All files in a directory (compact one-liner per file)
tl symbols a.ts b.ts      # Multiple specific files (compact)
```

### 4. Trace the dependency graph

Pick the most central file (usually has the most importers):

```bash
tl parallel "impact=tl impact <file>" "flow=tl flow <function> <file>"
```

This reveals the architecture: which modules are core infrastructure vs. leaf nodes.

### 5. Check conventions

```bash
tl style              # Coding conventions (naming, formatting, patterns)
```

Run once at the start of a session to match the project's style.

### 6. Report

Summarize your understanding:

```markdown
## Project overview
What it does, in one sentence.

## Architecture
Key directories and their roles. How data/control flows.

## Key files
The 5-10 most important files with one-line descriptions.

## Patterns
Conventions, frameworks, notable architectural decisions.

## Entry points
Where execution starts, how to run/test.
```

## Tips

- Use `tl parallel` to gather context on multiple files simultaneously
- `tl context <dir>` shows token cost of a directory — skip reading dirs over 50k tokens directly
- For React/frontend projects, also run `tl component` on main UI files
- For API projects, `tl api` and `tl routes` reveal endpoint structure
