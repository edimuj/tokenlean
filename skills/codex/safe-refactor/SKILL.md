---
name: safe-refactor
description: Refactor safely in Codex by mapping dependents before edits, making structural changes in small increments, and validating imports, exports, and tests after each change.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Safe Refactor (Codex)

Change structure without changing behavior.

## Workflow

```
Analyze impact -> Plan -> Refactor -> Verify
```

### 1. Analyze impact

```bash
rg -n "<target symbol|module>" src test bin
rg -n "export |import " <target-file>
```

Determine blast radius before touching code.

### 2. Plan

Choose smallest safe unit:
- rename symbol
- move file
- extract function/module
- simplify internal structure

### 3. Refactor

- Keep edits focused.
- Update all import/export sites in the same patch.
- Avoid incidental cleanups that increase risk.

### 4. Verify

```bash
npm test
git diff --stat
git diff
```

Confirm no behavior regressions and no broken references.

## Decision guide

- Rename: update declarations and all call/import sites together.
- Move file: move + rewrite imports in one atomic change.
- Signature change: update all callers before finishing.

## Tips

- If blast radius is large, split into sequenced commits.
- Prefer reversible steps so failures are easy to isolate.
