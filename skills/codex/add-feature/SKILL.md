---
name: add-feature
description: "Add new functionality in Codex by mapping existing architecture first, then implementing the smallest compatible change and verifying behavior with focused checks."
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
tl parallel "tl structure" "tl entry"
```

Find where similar behavior already exists and which files most likely own the feature.

### 2. Understand

```bash
tl parallel \
  "symbols=tl symbols <target-file>" \
  "deps=tl deps <target-file>" \
  "exports=tl exports <target-file>"
tl snippet <function> <file>  # Read specific functions, not whole files
```

### 3. Implement

- Prefer extending an existing pattern over introducing a new one.
- Keep edits minimal and local.
- Preserve existing CLI flags and output style when editing `bin/tl-*.mjs`.

### 4. Integrate

```bash
tl parallel "impact=tl impact <changed-file>" "guard=tl guard"
```

Check:
- New behavior is wired to entry points
- Imports/exports are consistent
- Help text/docs are updated if CLI behavior changed

### 5. Verify

```bash
tl parallel "test=tl run 'npm test'" "help=tl run 'node bin/<changed-tool>.mjs --help'"
```

Use narrower checks first when possible (single test file or targeted command), then broader checks.

## Tips

- Read only the files needed to make a safe change.
- Keep commits easy to review: one behavior change per patch.
- For large surface changes, split into small verified batches.
