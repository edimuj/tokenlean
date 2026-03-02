---
name: debug-bug
description: Fix bugs in Codex by enforcing reproduction first, tracing the failing path with minimal reads, applying the smallest safe fix, and re-running the repro and relevant tests.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Debug Bug (Codex)

No fix without reproduction.

## Workflow

```
Reproduce -> Localize -> Trace -> Fix -> Verify
```

### 1. Reproduce

```bash
<repro command>
```

Capture exact:
- Command
- Error output
- Exit code

### 2. Localize

```bash
rg -n "<error text|code|symbol>" src test bin
git log --oneline -- <suspect-file>
git blame -L <start>,<end> <suspect-file>
```

If stack trace exists, start at top project frame.

### 3. Trace

```bash
rg -n "<function name>" src test
sed -n '1,260p' <suspect-file>
```

If available, tokenlean shortcuts:

```bash
tl-flow <function> <file>
tl-snippet <function> <file>
```

### 4. Fix

- Apply the minimal change that resolves the root cause.
- Keep behavior unchanged outside the failing path.
- Add/update tests when practical.

### 5. Verify

```bash
<repro command>
npm test
```

Re-run the original repro first, then regression checks.

## Tips

- Distinguish symptom fixes from root-cause fixes.
- Prefer deterministic repros over intermittent observations.
- Record assumptions when full verification is not possible.
