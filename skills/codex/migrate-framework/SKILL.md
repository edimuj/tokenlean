---
name: migrate-framework
description: Execute framework or API migrations in Codex through dependency-ordered batches, validating each batch before moving on to keep the codebase continuously working.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Migrate Framework (Codex)

Migrate in small verified batches.

## Workflow

```
Survey -> Plan batches -> Migrate batch -> Verify batch -> Clean up
```

### 1. Survey

```bash
rg -n "<old API pattern>" src test bin
git grep -n "<old API pattern>"
```

Collect official migration steps and breaking changes before editing.

### 2. Plan batches

Batch by risk:
- Leaf modules first
- Shared/public modules last
- Keep each batch reviewable and testable

### 3. Migrate one batch

```bash
# edit files in batch
rg -n "<old API pattern>" <batch-path>
```

### 4. Verify each batch

```bash
npm test
node bin/<affected-tool>.mjs --help
```

Do not proceed if current batch fails.

### 5. Clean up

```bash
rg -n "<old API pattern>" src test bin
```

Remove temporary shims and dead compatibility code.

## Tips

- For large migrations, commit after each passing batch.
- Keep behavior stable unless explicitly changing it.
- Track remaining usage count of old API after each batch.
