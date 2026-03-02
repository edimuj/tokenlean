---
name: code-review
description: Review changes in Codex with a risk-first workflow: establish scope, inspect high-impact files first, identify regressions/security issues, and report findings by severity.
compatibility: Codex CLI with terminal access, git (tokenlean CLI optional)
---

# Code Review (Codex)

Review diffs with a risk-first approach.

## Workflow

```
Scope -> Risk map -> Deep review -> Verify assumptions -> Output
```

### 1. Scope

```bash
git status --short
git diff --stat
git diff
```

For branch/PR-style review:

```bash
git log --oneline --decorate -n 20
git diff <base>...HEAD --stat
git diff <base>...HEAD
```

### 2. Risk map

Prioritize files that are:
- Public interfaces (`bin/`, exported modules, shared utilities)
- Security-sensitive (shell/command execution, path handling)
- High fan-out (widely imported modules)

Useful probes:

```bash
rg -n "export |spawn|exec|rm -rf|chmod|process\.env|token|secret" src bin
rg -n "<changed symbol>" src test
```

### 3. Deep review

For each high-risk file, check:
- Correctness and edge cases
- Backward compatibility
- Error handling and exit codes
- Injection/path traversal risks for shell and file operations

### 4. Verify assumptions

```bash
npm test
node bin/<changed-tool>.mjs --help
```

Run targeted commands that exercise changed behavior.

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
