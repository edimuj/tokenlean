---
name: code-review
description: "Review changes in Codex with a risk-first workflow: establish scope, inspect high-impact files first, identify regressions/security issues, and report findings by severity."
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Code Review (Codex)

Review diffs with a risk-first approach.

## Workflow

```
Scope -> Risk map -> Deep review -> Verify assumptions -> Output
```

### 1. Scope

```bash
tl diff                   # Staged/unstaged changes, token-efficient
tl diff <ref>             # Specific commit range
tl pr                     # For branch/PR review
```

### 2. Risk map

For each changed file:

```bash
tl parallel \
  "impact=tl impact <file>" \
  "symbols=tl symbols <file>" \
  "complexity=tl complexity <file>"
```

For files with high impact (many dependents):

```bash
tl exports <file>         # Was the public API changed?
```

### 3. Deep review

Read the actual diff. You already know:
- **What changed** (from step 1)
- **What depends on it** (from tl impact)
- **The shape of the code** (from tl symbols)
- **Complexity hotspots** (from tl complexity)

Use `tl snippet <function> <file>` to read specific changed functions rather than full files.

### 4. Verify assumptions

```bash
tl parallel "guard=tl guard" "test=tl run 'npm test'"
```

### 5. Output format

```markdown
## Findings
- [severity] path:line - issue, impact, fix recommendation

## Open Questions
- Missing context needed for confidence

## Summary
- Overall risk and release recommendation
```

Severity: `critical`, `warning`, `nit`.

## Tips

- Findings first, summary second.
- Avoid style-only feedback unless it affects maintainability or bugs.
- If no findings, explicitly state that and mention residual risk.
- For test files, skip tl impact (nothing depends on tests).
- If a file is under 150 lines, just read it directly.
