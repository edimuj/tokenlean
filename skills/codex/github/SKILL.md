---
name: github
description: "Git commits, pushes, and GitHub operations using tokenlean. Covers tl push (with multi-file safety guard), tl commit-prep, tl gh (bulk issue/PR/release operations). Use when committing, pushing, creating/closing/viewing issues, managing PRs, creating releases, or any git/GitHub workflow."
compatibility: Codex CLI with terminal access, git, gh CLI, tokenlean CLI (npm i -g tokenlean)
---

# GitHub & Git Operations (Codex)

Token-efficient git and GitHub workflows via `tl push`, `tl commit-prep`, and `tl gh`.

## Committing & Pushing

### tl push

Stages, commits, and pushes in one call.

**Critical: multi-file safety guard.** When multiple files are modified and no explicit files are given, `tl push` refuses to proceed — prints the modified file list and exits 1. You must specify which files to include.

```bash
# Single modified file — auto-stages
tl push "feat: add caching"

# Multiple modified files — MUST specify files
tl push "fix: resolve race" src/worker.mjs src/queue.mjs

# Include untracked (new) files
tl push "feat: new tool" bin/tl-new.mjs -A

# Commit without pushing
tl push "wip: checkpoint" src/foo.mjs --no-push

# Preview first
tl push "test" --dry-run
```

### tl commit-prep

Pre-commit context: git status + diff stat + recent log. Use before `tl push` to decide which files to include.

```bash
tl commit-prep
tl push "fix: typo" README.md
```

## GitHub Operations — tl gh

Wraps multi-step GitHub API calls into single commands. Always pass `-R owner/repo`.

### Issue commands

```bash
tl gh issue view -R owner/repo 434                 # with sub-issues
tl gh issue view -R owner/repo 434 --no-body        # compact

echo '[{"title":"A"},{"title":"B"}]' | tl gh issue create-batch -R owner/repo
tl gh issue add-sub -R owner/repo --parent 10 42 43
tl gh issue close-batch -R owner/repo 1 2 3 -c "Done"
tl gh issue label-batch -R owner/repo --add "bug" 1 2 3
```

### PR commands

```bash
tl gh pr digest -R owner/repo 123                   # full status
tl gh pr comments -R owner/repo 123 --unresolved    # unresolved threads
tl gh pr land -R owner/repo 123                     # CI wait + merge + cleanup
```

### Release commands

```bash
tl gh release notes -R owner/repo --tag v1.2.0
```

## When to use which

- Single issue/PR read or write: `gh` CLI directly
- Bulk operations: `tl gh` (create-batch, close-batch, label-batch)
- View issue with sub-issues: `tl gh issue view`
- Full PR readiness check: `tl gh pr digest`
- Merge + cleanup: `tl gh pr land`

## Tips

- Always use `tl push` instead of raw git sequences
- Run `tl commit-prep` first when unsure what changed
- Use `--dry-run` on `tl push` and `tl gh pr land` to preview safely
