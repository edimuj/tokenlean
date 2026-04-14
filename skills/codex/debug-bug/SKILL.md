---
name: debug-bug
description: "Fix bugs in Codex by enforcing reproduction first, tracing the failing path with minimal reads, applying the smallest safe fix, and re-running the repro and relevant tests."
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Debug Bug (Codex)

No fix without reproduction.

## Workflow

```
Reproduce -> Localize -> Trace -> Fix -> Verify
```

### 1. Reproduce

```bash
tl run "<repro command>"  # Capture the actual error output
```

Capture exact command, error output, and exit code. If no repro command is given, ask for one.

### 2. Localize

```bash
tl parallel \
  "errors=tl errors" \
  "blame=tl blame <file>" \
  "history=tl history <file>"
```

If the error includes a stack trace, start at the top project frame.

### 3. Trace

```bash
tl parallel \
  "flow=tl flow <function> <file>" \
  "deps=tl deps <file>" \
  "snippet=tl snippet <function> <file>"
```

### 4. Fix

Apply the minimal change that resolves the root cause. Then check for side effects:

```bash
tl parallel "guard=tl guard" "impact=tl impact <file>"
```

### 5. Verify

```bash
tl parallel "repro=tl run '<repro command>'" "tests=tl run 'npm test'"
```

## Tips

- Distinguish symptom fixes from root-cause fixes.
- Prefer deterministic repros over intermittent observations.
- Use `tl parallel` to run all context-gathering commands simultaneously.
- Check `tl diff` for recent regressions — the bug may be in the last few commits.
