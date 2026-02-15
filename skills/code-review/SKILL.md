---
name: code-review
description: Thorough code review using token-efficient context gathering. Analyzes PRs, diffs, or staged changes by checking blast radius, complexity, and dependencies before reviewing the actual code. Use when asked to review a PR, review changes, or do a code review.
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Code Review

Review code changes thoroughly while reading as little raw code as possible.

## Workflow

```
Changes → Scope check → Context gathering → Deep review → Output
```

### 1. Determine scope

```bash
# For a PR or branch
tl-pr

# For uncommitted work
tl-diff

# For a specific commit range
tl-diff <ref>
```

If the diff is large (>20 files), focus on the highest-impact files first.

### 2. Gather context on changed files

For each changed file, run these in parallel:

```bash
tl-impact <file>      # What depends on this file — will anything break?
tl-symbols <file>     # Signatures overview — understand the file without reading it
tl-complexity <file>  # Cyclomatic complexity — flag functions that are getting too complex
```

For files with high impact (many dependents), also run:

```bash
tl-exports <file>     # Was the public API changed? Are exports still compatible?
```

### 3. Review the code

Now read the actual diff. You already know:
- **What changed** (from step 1)
- **What depends on it** (from tl-impact)
- **The shape of the code** (from tl-symbols)
- **Complexity hotspots** (from tl-complexity)

Use `tl-snippet <function> <file>` to read specific changed functions rather than full files.

### 4. Check for common issues

```bash
tl-guard              # Secrets, stale TODOs, unused exports, circular deps
```

### 5. Output format

Structure the review as:

```markdown
## Summary
One-paragraph assessment: what this change does and overall quality.

## Issues
- **[severity]** file:line — description and suggestion

## Observations
- Non-blocking notes, style comments, questions for the author

## Verdict
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
```

Severity levels: **critical** (bugs, security), **warning** (potential problems), **nit** (style, minor).

## Decision tree: how deep to go

```
File changed → How many dependents? (tl-impact)
  ├─ 0 dependents → Light review (just read the diff)
  ├─ 1-5 dependents → Standard review (symbols + diff)
  └─ 6+ dependents → Deep review (symbols + exports + snippet each changed function)
```

## Tips

- Run context-gathering commands in parallel — they're independent
- For test files, skip tl-impact (nothing depends on tests)
- `tl-symbols -j` gives JSON output if you need structured data
- If a file is under 150 lines, just read it directly — tl-* overhead isn't worth it
