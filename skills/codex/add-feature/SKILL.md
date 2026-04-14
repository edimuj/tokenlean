---
name: add-feature
description: Add new functionality in Codex by mapping existing architecture first, then implementing the smallest compatible change and verifying behavior with focused checks.
compatibility: Codex CLI with terminal access, Node.js >=18, git, tokenlean CLI (npm i -g tokenlean)
---

# Add Feature (Codex)

Add functionality by understanding existing code paths before editing.

## Workflow

```
Locate -> Understand -> Implement -> Integrate -> Verify
```

### 1. Locate

```bash
tl structure              # Project layout and file counts
tl entry                  # Entry points (bin/, routing, handlers)
```

Find where similar behavior already exists and which files most likely own the feature.

### 2. Understand

```bash
tl symbols <target-file>  # Signatures — what's already there
tl deps <target-file>     # What does it depend on?
tl exports <target-file>  # Public API surface
tl snippet <function> <file>  # Read specific functions, not whole files
```

### 3. Implement

- Prefer extending an existing pattern over introducing a new one.
- Keep edits minimal and local.
- Preserve existing CLI flags and output style when editing `bin/tl-*.mjs`.

### 4. Integrate

```bash
tl impact <changed-file>  # Will the change affect dependents?
tl guard                  # Circular deps, unused exports, secrets
```

Check:
- New behavior is wired to entry points
- Imports/exports are consistent
- Help text/docs are updated if CLI behavior changed

### 5. Verify

```bash
tl run "npm test"         # Token-efficient test output
tl run "node bin/<changed-tool>.mjs --help"  # Verify help works
```

Use narrower checks first when possible (single test file or targeted command), then broader checks.

## Tips

- Read only the files needed to make a safe change.
- Keep commits easy to review: one behavior change per patch.
- For large surface changes, split into small verified batches.
