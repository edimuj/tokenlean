---
name: add-feature
description: Add new functionality in Codex by mapping existing architecture first, then implementing the smallest compatible change and verifying behavior with focused checks.
compatibility: Codex CLI with terminal access, Node.js >=18, git (tokenlean CLI optional)
---

# Add Feature (Codex)

Add functionality by understanding existing code paths before editing.

## Workflow

```
Locate -> Understand -> Implement -> Integrate -> Verify
```

### 1. Locate

```bash
rg --files
rg -n "<feature keyword>" src bin test
```

Find:
- Where similar behavior already exists
- Entry points (`bin/`, routing, handlers)
- Files most likely to own the feature

### 2. Understand

```bash
sed -n '1,220p' <target-file>
rg -n "export |function |class " <target-file>
rg -n "<target symbol>" src test
```

If available, tokenlean shortcuts:

```bash
tl-symbols <target-file>
tl-deps <target-file>
tl-exports <target-file>
```

### 3. Implement

- Prefer extending an existing pattern over introducing a new one.
- Keep edits minimal and local.
- Preserve existing CLI flags and output style when editing `bin/tl-*.mjs`.

### 4. Integrate

```bash
rg -n "<new symbol|flag|option>" src bin test
```

Check:
- New behavior is wired to entry points
- Imports/exports are consistent
- Help text/docs are updated if CLI behavior changed

### 5. Verify

```bash
npm test
node bin/<changed-tool>.mjs --help
```

Use narrower checks first when possible (single test file or targeted command), then broader checks.

## Tips

- Read only the files needed to make a safe change.
- Keep commits easy to review: one behavior change per patch.
- For large surface changes, split into small verified batches.
