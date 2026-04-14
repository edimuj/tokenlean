---
name: migrate-framework
description: "Migrate frameworks, APIs, or language versions incrementally with verification at each step. Surveys the migration surface, batches work by dependency order, and commits after each verified batch. Use when asked to migrate between frameworks, upgrade major versions, or adapt to new API versions."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Migrate Framework

Migrate incrementally — never change more than one batch without running tests.

## Workflow

```
Survey → Plan → Migrate → Verify → Clean up
```

### 1. Survey

Map the migration surface:

```bash
tl parallel \
  "structure=tl structure" \
  "search=tl search '<old-api-pattern>'" \
  "stack=tl stack"
tl context7 <framework> "migration guide" -t 5000  # Official migration path
# Or: tl browse <migration-guide-url>
```

### 2. Plan

Group the work into safe increments:

```bash
tl parallel "impact=tl impact <file>" "related=tl related <file>"
```

Order: leaf files (0 dependents) first, shared utilities last. Each increment must leave the codebase in a working state.

### 3. Migrate

One batch at a time:

```bash
tl symbols <file>          # Know the shape before modifying
tl snippet <function> <file>   # Read each usage site
# Apply the migration pattern from the guide
tl diff --breaking         # Catch accidental API changes after each batch
```

### 4. Verify

After every batch, not at the end:

```bash
tl parallel \
  "test=tl run '<test command>'" \
  "guard=tl guard" \
  "exports=tl exports <file>"
# Commit after each passing batch
```

### 5. Clean up

Remove old-world artifacts:

```bash
tl parallel \
  "search=tl search '<old-api-pattern>'" \
  "unused=tl unused" \
  "deps=tl deps <file>"
```

## Decision tree

```
Migration request → How big is the surface?
  ├─ Small (<10 usages) → Single batch
  │   → tl search to find all, migrate, tl run tests
  ├─ Medium (10-50 usages) → Batch by directory
  │   → tl related to group files
  │   → Migrate + test one directory at a time
  │   → Commit after each batch
  └─ Large (50+ usages) → Batch by dependency order
      → tl impact to sort files by dependents
      → Leaf files first, shared modules last
      → Migrate + test + commit per batch
      → tl search "<old-pattern>" to track remaining count
```

## Tips

- Never start migrating without the migration guide — tl context7 or tl browse first
- Commit after each passing batch — if batch 7 breaks, you bisect to batch 7
- Use `tl search "<old-pattern>"` to track how many usages remain after each batch
- Leaf files first reduces risk — they have no dependents to break
- For large migrations, `tl impact` output determines the safest execution order
