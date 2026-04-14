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
tl symbols <suspect-file>     # Identify functions to investigate
tl complexity <suspect-file>  # Find high-complexity hotspots
tl hotspots                   # Which files change most (often correlates with perf issues)
```

Prioritize hot paths and repeated work.

### 3. Analyze

```bash
tl snippet <function> <file>  # Read only the suspect function
tl flow <function> <file>     # Call graph — what calls what
tl deps <file>                # What does it pull in?
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
tl run "time <same command>"  # After — compare with baseline
tl run "npm test"             # Ensure no regressions
```

Report before/after numbers. No numbers means no verified gain.

## Tips

- Do not optimize cold paths.
- Keep benchmark input stable between runs.
- If tradeoffs exist (speed vs memory), document them explicitly.
