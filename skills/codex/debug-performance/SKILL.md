---
name: debug-performance
description: "Improve performance in Codex by measuring baseline behavior, isolating hot paths, implementing focused optimizations, and confirming wins with before/after numbers."
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Debug Performance (Codex)

Measure first. Optimize second.

## Workflow

```
Measure -> Isolate -> Analyze -> Optimize -> Confirm
```

### 1. Measure

```bash
tl run "time <command>"   # Capture baseline with token-efficient output
```

Capture baseline metrics (latency, throughput, memory) before edits.

### 2. Isolate

```bash
tl parallel \
  "symbols=tl symbols <suspect-file>" \
  "complexity=tl complexity <suspect-file>" \
  "hotspots=tl hotspots"
```

Prioritize hot paths and repeated work.

### 3. Analyze

```bash
tl parallel \
  "snippet=tl snippet <function> <file>" \
  "flow=tl flow <function> <file>" \
  "deps=tl deps <file>"
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
tl parallel "after=tl run 'time <same command>'" "tests=tl run 'npm test'"
```

Report before/after numbers. No numbers means no verified gain.

## Tips

- Do not optimize cold paths.
- Keep benchmark input stable between runs.
- If tradeoffs exist (speed vs memory), document them explicitly.
