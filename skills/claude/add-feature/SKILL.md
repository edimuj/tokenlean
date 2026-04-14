---
name: add-feature
description: Add new functionality by understanding existing patterns and dependencies before writing code. Locates where the feature belongs, studies conventions, implements following precedent, then verifies integration. Use when asked to add a feature, flag, endpoint, component, or module.
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
tl structure               # Project layout — where does this kind of code live?
tl entry                   # Entry points and module boundaries
tl example <pattern>       # Find similar existing features to follow as precedent
```

### 2. Understand

Before writing a single line:

```bash
tl symbols <file>          # Signatures in the file you'll modify
tl style                   # Project conventions — naming, formatting, patterns
tl deps <file>             # What the target file already imports
tl exports <file>          # Current public API surface
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
tl impact <modified-file>  # Verify you haven't broken dependents
tl guard                   # Circular deps, unused exports, secrets
tl diff --breaking         # If you changed any public API signatures
```

### 5. Verify

```bash
tl run "<test command>"    # Run tests
tl test-map <file>         # Find which test files cover the modified code
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
