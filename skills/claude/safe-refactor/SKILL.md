---
name: safe-refactor
description: Refactor code safely by analyzing blast radius and dependencies before making changes. Covers renaming, moving, extracting, and restructuring code with verification at each step. Use when refactoring, renaming symbols, extracting functions, moving files, or restructuring code.
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Safe Refactor

Change code structure without breaking dependents.

## Workflow

```
Analyze → Plan → Change → Verify
```

### 1. Analyze what you're changing

```bash
tl-impact <file>      # Who depends on this file?
tl-exports <file>     # What's the public API surface?
tl-symbols <file>     # Full signature map
```

These three commands tell you:
- **Blast radius** — how many files will be affected
- **Contract** — which exports are consumed externally
- **Shape** — what you're working with

If tl-impact shows 10+ dependents, consider whether this refactor is worth the risk. Discuss with the user.

### 2. Understand consumers

For each file that imports from the target:

```bash
tl-snippet <imported-symbol> <consumer-file>
```

This shows how the symbol is actually used without reading the entire consumer file.

### 3. Make the changes

Apply the refactor. Then immediately check:

```bash
tl-guard              # Circular deps, unused exports, other issues
```

### 4. Verify

```bash
tl-run "<test-command>"   # Run tests — tl-run filters to just errors
tl-impact <file>          # Re-check: are all dependents still importing correctly?
```

If tests fail, `tl-run` output shows only the failures. Fix and re-run.

## Decision tree: refactor type

```
What are you changing?
  ├─ Renaming a symbol
  │   → tl-impact to find all importers
  │   → Update all import sites
  │   → tl-guard to verify no broken imports
  │
  ├─ Moving a file
  │   → tl-impact for full dependent list
  │   → Move file, update all import paths
  │   → tl-guard for circular deps
  │
  ├─ Extracting a function/module
  │   → tl-symbols + tl-deps on source file
  │   → Extract, add exports
  │   → tl-impact on original to update importers
  │   → tl-guard + tl-run tests
  │
  └─ Changing a function signature
      → tl-impact + tl-flow to find all callers
      → tl-snippet on each caller to see usage
      → Update signature + all call sites
      → tl-run tests
```

## Tips

- Always check tl-impact BEFORE starting — discovering 50 dependents mid-refactor is painful
- Run tl-exports before and after: the diff shows if you accidentally changed the public API
- For large refactors (10+ files), make incremental commits so you can bisect failures
- `tl-unused` after refactoring catches exports you forgot to clean up
