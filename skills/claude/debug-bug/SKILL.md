---
name: debug-bug
description: "Systematically investigate and fix bugs using token-efficient context gathering. Reproduces the issue first, localizes with blame and history, traces the call path, then verifies the fix. Use when asked to fix a bug, investigate an error, or debug unexpected behavior."
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
tl parallel \
  "errors=tl errors" \
  "blame=tl blame <file>" \
  "history=tl history <file>"
```

If the error includes a stack trace, start with the top frame. If it's vague, use `tl search "<error message>"` to find where the error originates.

### 3. Trace

Understand the code path without reading entire files:

```bash
tl parallel \
  "flow=tl flow <function> <file>" \
  "deps=tl deps <file>" \
  "snippet=tl snippet <function> <file>"
```

### 4. Fix

Apply the minimal fix. Then check for side effects:

```bash
tl parallel "guard=tl guard" "impact=tl impact <file>"
```

### 5. Verify

```bash
tl parallel "repro=tl run '<repro command>'" "tests=tl run '<test command>'"
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

- Use `tl parallel` to run context-gathering commands simultaneously
- Use `tl search "<error message>"` to find where errors are thrown
- Check `tl diff` for recent regressions — the bug may be in the last few commits
- If a file is under 150 lines, just read it directly — tokenlean overhead isn't worth it
- After fixing, run `tl impact` to ensure dependents aren't affected by the change
