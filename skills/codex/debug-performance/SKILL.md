---
name: debug-performance
description: Improve performance in Codex by measuring baseline behavior, isolating hot paths, implementing focused optimizations, and confirming wins with before/after numbers.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Debug Performance (Codex)

Measure first. Optimize second.

## Workflow

```
Measure -> Isolate -> Analyze -> Optimize -> Confirm
```

### 1. Measure

```bash
time <command>
```

Capture baseline metrics (latency, throughput, memory) before edits.

### 2. Isolate

```bash
rg -n "<slow operation symbol>" src
rg -n "for |while |map\(|filter\(|reduce\(" <suspect-file>
```

Prioritize hot paths and repeated work.

### 3. Analyze

Inspect only relevant functions/loops/I/O:

```bash
sed -n '1,260p' <suspect-file>
```

Check for:
- N^2 loops
- Repeated expensive I/O
- Heavy initialization on hot paths
- Work that can be cached or deferred

### 4. Optimize

- Use the smallest optimization with clear impact.
- Preserve behavior and API.
- Prefer algorithmic improvements over micro-optimizations.

### 5. Confirm

```bash
time <same command>
npm test
```

Report before/after numbers. No numbers means no verified gain.

## Tips

- Do not optimize cold paths.
- Keep benchmark input stable between runs.
- If tradeoffs exist (speed vs memory), document them explicitly.
