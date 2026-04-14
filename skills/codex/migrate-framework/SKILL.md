---
name: migrate-framework
description: Execute framework or API migrations in Codex through dependency-ordered batches, validating each batch before moving on to keep the codebase continuously working.
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Migrate Framework (Codex)

Migrate in small verified batches.

## Workflow

```
Survey -> Plan batches -> Migrate batch -> Verify batch -> Clean up
```

### 1. Survey

```bash
tl structure              # Understand project layout
tl deps <file>            # Trace dependency chains for migration ordering
```

Collect official migration steps and breaking changes before editing.

### 2. Plan batches

```bash
tl impact <file>          # Understand blast radius of each module
```

Batch by risk:
- Leaf modules first
- Shared/public modules last
- Keep each batch reviewable and testable

### 3. Migrate one batch

```bash
tl symbols <file>         # Understand what exists before editing
tl snippet <function> <file>  # Read specific functions that use the old API
```

### 4. Verify each batch

```bash
tl run "npm test"         # Token-efficient output — errors only
tl guard                  # Circular deps, unused exports
```

Do not proceed if current batch fails.

### 5. Clean up

```bash
tl unused                 # Find dead code left behind
```

Remove temporary shims and dead compatibility code.

## Tips

- For large migrations, commit after each passing batch.
- Keep behavior stable unless explicitly changing it.
- Use `tl impact` to track remaining usage count of old API after each batch.
