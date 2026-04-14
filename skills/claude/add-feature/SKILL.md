---
name: add-feature
description: "Add new functionality by understanding existing patterns and dependencies before writing code. Locates where the feature belongs, studies conventions, implements following precedent, then verifies integration. Use when asked to add a feature, flag, endpoint, component, or module."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Add Feature

Add functionality by understanding existing code before writing new code.

## Workflow

```
Locate → Understand → Implement → Integrate → Verify
```

### 1. Locate

Find where the feature belongs:

```bash
tl parallel "tl structure" "tl entry" "tl example <pattern>"
```

### 2. Understand

Before writing a single line:

```bash
tl parallel \
  "symbols=tl symbols <file>" \
  "style=tl style" \
  "deps=tl deps <file>" \
  "exports=tl exports <file>"
```

### 3. Implement

```bash
# Extending an existing file?
tl snippet <function> <file>   # Read just the function you're modifying

# New file?
# Follow conventions from tl style, place per tl structure

# Adding a dependency?
tl npm <package>           # Check size, health, and download stats first
```

### 4. Integrate

Wire it into the existing system:

```bash
tl parallel \
  "impact=tl impact <modified-file>" \
  "guard=tl guard" \
  "diff=tl diff --breaking"
```

### 5. Verify

```bash
tl parallel "test=tl run '<test command>'" "testmap=tl test-map <file>"
```

## Decision tree

```
Feature request → Does similar functionality exist?
  ├─ Yes (extending) → tl example to find the pattern
  │   → tl symbols on target file
  │   → tl snippet on the function to extend
  │   → Implement following the existing pattern
  ├─ Yes (replacing) → tl impact on what you're replacing
  │   → tl exports to check public API surface
  │   → Implement, update all consumers
  └─ No (greenfield) → tl structure for placement
      → tl style for conventions
      → tl entry to understand how it'll be wired in
      → Implement, then tl guard to check integration
```

## Tips

- Always run `tl example` before implementing — the codebase almost always has a precedent
- Use `tl npm` before adding any new dependency — check size and health
- Run `tl diff --breaking` after modifying any file with exports
- For React/frontend projects, also use `tl component` on main UI files
- If a file is under 150 lines, just read it directly — tokenlean overhead isn't worth it
