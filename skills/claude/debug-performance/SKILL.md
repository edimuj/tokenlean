---
name: debug-performance
description: "Diagnose and fix performance issues by measuring before optimizing. Establishes baselines, identifies bottlenecks through call graphs and complexity analysis, then confirms improvements with numbers. Use when asked to optimize, speed up, reduce memory usage, or fix slowness."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Debug Performance

Find and fix performance bottlenecks by measuring, not guessing.

## Workflow

```
Measure → Identify → Analyze → Optimize → Confirm
```

### 1. Measure

Establish a baseline before touching anything:

```bash
tl parallel \
  "baseline=tl run '<benchmark or timed command>'" \
  "complexity=tl complexity <file>" \
  "hotspots=tl hotspots"
```

### 2. Identify

Find the actual bottleneck:

```bash
tl parallel \
  "flow=tl flow <function> <file>" \
  "deps=tl deps <file>" \
  "symbols=tl symbols <file>"
```

### 3. Analyze

Understand why it's slow:

```bash
tl parallel \
  "snippet=tl snippet <function> <file>" \
  "related=tl related <file>" \
  "scope=tl scope <function> <file>"
```

### 4. Optimize

Apply the fix based on the bottleneck type:

```bash
# Algorithmic change
tl flow <function> <file>     # Verify new path is simpler

# Caching opportunity
tl impact <file>              # How many callers benefit?

# Reducing I/O
tl deps <file>                # Identify unnecessary imports

# Parallelization
tl flow <function> <file>     # Confirm no shared state
```

### 5. Confirm

```bash
tl run "<same benchmark>"     # Measure improvement — no numbers, no claim
```

## Decision tree

```
"It's slow" → Do you have a measurement?
  ├─ Yes (specific operation) → tl flow on that operation
  │   → tl snippet on each function in chain
  │   → Find the O(n^2) or blocking I/O
  ├─ Vague ("app is slow") → tl hotspots + tl complexity
  │   → Profile top 3 complex files
  │   → tl flow on entry points to find hot paths
  └─ Memory issue → tl deps on entry point
      → Look for large imports, circular refs
      → tl guard for circular deps
```

## Tips

- Always benchmark before AND after — optimizations without numbers are guesses
- `tl complexity` > 10 on a function is a red flag for performance problems
- Check `tl deps` for heavy imports that could be lazy-loaded
- Don't optimize cold paths — use `tl flow` to confirm the function is on the hot path
- Use `tl parallel` for all context-gathering steps — they're independent
