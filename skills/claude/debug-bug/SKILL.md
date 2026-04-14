---
name: debug-bug
description: Systematically investigate and fix bugs using token-efficient context gathering. Reproduces the issue first, localizes with blame and history, traces the call path, then verifies the fix. Use when asked to fix a bug, investigate an error, or debug unexpected behavior.
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Debug Bug

Systematically find and fix bugs while reading as little code as possible.

## Workflow

```
Reproduce → Localize → Trace → Fix → Verify
```

### 1. Reproduce

```bash
tl run "<repro command>"   # Capture the actual error output
```

No fix without reproduction. If no repro command is given, ask for one. If the bug is in tests, run the failing test. This step is non-negotiable.

### 2. Localize

Narrow down where the bug lives:

```bash
tl errors                  # Scan for error patterns in the codebase
tl blame <file>            # Recent changes to the file mentioned in the error
tl history <file>          # If this is a regression — what changed recently?
```

If the error includes a stack trace, start with the top frame. If it's vague, use `tl search "<error message>"` to find where the error originates.

### 3. Trace

Understand the code path without reading entire files:

```bash
tl flow <function> <file>  # Call graph around the failing function
tl deps <file>             # What the buggy file depends on
tl snippet <function> <file>  # Read only the relevant function
```

### 4. Fix

Apply the minimal fix. Then check for side effects:

```bash
tl guard                   # Circular deps, unused exports, secrets
tl impact <file>           # Will the fix affect dependents?
```

### 5. Verify

```bash
tl run "<repro command>"   # Confirm the bug is fixed
tl run "<test command>"    # Ensure no regressions
```

## Decision tree

```
Bug report → Can you reproduce it?
  ├─ Yes → What layer does the error come from?
  │   ├─ Stack trace points to a file → tl blame + tl snippet on that file
  │   ├─ Error is vague / no stack → tl errors + tl search for the error message
  │   └─ Happening in dependency → tl deps to confirm, check dep version
  ├─ No → Ask for reproduction steps before proceeding
  └─ Intermittent → tl history on suspect files, look for recent changes
```

## Tips

- Run `tl blame` and `tl history` in parallel — they're independent
- Use `tl search "<error message>"` to find where errors are thrown
- Check `tl diff` for recent regressions — the bug may be in the last few commits
- If a file is under 150 lines, just read it directly — tokenlean overhead isn't worth it
- After fixing, run `tl impact` to ensure dependents aren't affected by the change
