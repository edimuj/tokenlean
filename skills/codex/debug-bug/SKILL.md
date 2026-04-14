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
tl errors                 # Scan for error patterns in the codebase
tl blame <file>           # Recent changes to the suspect file
tl history <file>         # If this is a regression — what changed recently?
```

If the error includes a stack trace, start at the top project frame.

### 3. Trace

```bash
tl flow <function> <file>     # Call graph around the failing function
tl deps <file>                # What the buggy file depends on
tl snippet <function> <file>  # Read only the relevant function
```

### 4. Fix

Apply the minimal change that resolves the root cause. Then check for side effects:

```bash
tl guard                  # Circular deps, unused exports, secrets
tl impact <file>          # Will the fix affect dependents?
```

### 5. Verify

```bash
tl run "<repro command>"  # Confirm the bug is fixed
tl run "npm test"         # Ensure no regressions
```

## Tips

- Distinguish symptom fixes from root-cause fixes.
- Prefer deterministic repros over intermittent observations.
- Run tl blame and tl history in parallel — they're independent.
- Check `tl diff` for recent regressions — the bug may be in the last few commits.
