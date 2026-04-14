---
name: safe-refactor
description: Refactor safely in Codex by mapping dependents before edits, making structural changes in small increments, and validating imports, exports, and tests after each change.
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Safe Refactor (Codex)

Change structure without changing behavior.

## Workflow

```
Analyze impact -> Plan -> Refactor -> Verify
```

### 1. Analyze impact

```bash
tl impact <file>          # Who depends on this file?
tl exports <file>         # What's the public API surface?
tl symbols <file>         # Full signature map
```

These three commands tell you:
- **Blast radius** — how many files will be affected
- **Contract** — which exports are consumed externally
- **Shape** — what you're working with

If tl impact shows 10+ dependents, consider whether this refactor is worth the risk.

### 2. Plan

Choose smallest safe unit:
- rename symbol
- move file
- extract function/module
- simplify internal structure

### 3. Refactor

For each consumer of the target:

```bash
tl snippet <imported-symbol> <consumer-file>  # How is the symbol actually used?
```

Apply the refactor. Then immediately check:

```bash
tl guard                  # Circular deps, unused exports, other issues
```

### 4. Verify

```bash
tl run "npm test"         # Token-efficient test output — shows only failures
tl impact <file>          # Re-check: are all dependents still importing correctly?
tl diff                   # Review what actually changed
```

## Decision guide

```
What are you changing?
  ├─ Renaming a symbol
  │   → tl impact to find all importers
  │   → Update all import sites
  │   → tl guard to verify no broken imports
  │
  ├─ Moving a file
  │   → tl impact for full dependent list
  │   → Move file, update all import paths
  │   → tl guard for circular deps
  │
  ├─ Extracting a function/module
  │   → tl symbols + tl deps on source file
  │   → Extract, add exports
  │   → tl impact on original to update importers
  │   → tl guard + tl run tests
  │
  └─ Changing a function signature
      → tl impact + tl flow to find all callers
      → tl snippet on each caller to see usage
      → Update signature + all call sites
      → tl run tests
```

## Tips

- Always check tl impact BEFORE starting — discovering 50 dependents mid-refactor is painful.
- Run tl exports before and after: the diff shows if you accidentally changed the public API.
- `tl unused` after refactoring catches exports you forgot to clean up.
- If blast radius is large, split into sequenced commits.
