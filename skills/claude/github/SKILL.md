---
name: github
description: "Git commits, pushes, and GitHub operations using tokenlean. Covers tl push (with multi-file safety guard), tl commit-prep, tl gh (bulk issue/PR/release operations), and when to use tl gh vs gh CLI vs GitHub MCP. Use when committing, pushing, creating/closing/viewing issues, managing PRs, creating releases, or any git/GitHub workflow."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean), git, and gh CLI
---

# GitHub & Git Operations

Token-efficient git and GitHub workflows via `tl push`, `tl commit-prep`, and `tl gh`.

## Committing & Pushing

### tl push

Stages, commits, and pushes in one call.

**Critical: multi-file safety guard.** When multiple files are modified and no explicit files are given, `tl push` refuses to proceed. It prints the modified file list and exits with code 1. You must specify which files to include.

```bash
# Single modified file — auto-stages
tl push "feat: add caching"

# Multiple modified files — MUST specify files
tl push "fix: resolve race" src/worker.mjs src/queue.mjs

# Include untracked (new) files
tl push "feat: new tool" bin/tl-new.mjs -A

# Commit without pushing
tl push "wip: checkpoint" src/foo.mjs --no-push

# Amend previous commit
tl push "fix: better msg" --amend

# Preview what would happen
tl push "test" --dry-run
```

### tl commit-prep

Pre-commit context in one call: git status + diff stat + recent log. Use before `tl push` when you need to see what changed.

```bash
tl commit-prep
# then decide which files to include:
tl push "fix: typo" README.md
```

### Workflow

```
Need to commit?
  ├─ Know which files → tl push "msg" file1 file2
  ├─ Need to see changes → tl commit-prep, then tl push "msg" file1 file2
  └─ Only one file modified → tl push "msg" (auto-stages)
```

## GitHub Operations — tl gh

Wraps multi-step GitHub API calls into single commands. Requires `-R owner/repo`.

### When to use which tool

| Scenario | Tool |
|---|---|
| Single issue/PR read or write | `gh` CLI |
| Bulk operations (create/close/label many) | `tl gh` |
| View issue with all sub-issues | `tl gh issue view` |
| Full PR status (CI + reviews + merge readiness) | `tl gh pr digest` |
| Check CI → merge → close issues → delete branch | `tl gh pr land` |
| Auto-generate release changelog | `tl gh release notes` |

### Issue commands

```bash
# View issue with sub-issues (single GraphQL call)
tl gh issue view -R owner/repo 434
tl gh issue view -R owner/repo 434 --no-body    # compact
tl gh issue view -R owner/repo 434 --full        # complete bodies

# Bulk create from JSON array or JSONL on stdin
echo '[{"title":"Bug A","labels":["bug"]},{"title":"Bug B"}]' | tl gh issue create-batch -R owner/repo

# Create parent + children with auto sub-issue links
cat tree.json | tl gh issue create-tree -R owner/repo
# Input: {"title": "Epic", "body": "...", "children": [{"title": "Task 1"}, {"title": "Task 2"}]}

# Link existing issues as sub-issues
tl gh issue add-sub -R owner/repo --parent 10 42 43 44

# Close multiple issues
tl gh issue close-batch -R owner/repo 1 2 3 -c "Sprint complete"
tl gh issue close-batch -R owner/repo 10 11 --reason "not planned"

# Add/remove labels in bulk
tl gh issue label-batch -R owner/repo --add "bug,P0" --remove "triage" 1 2 3
```

### PR commands

```bash
# Full PR digest: state, CI, reviews, unresolved comments, merge readiness
tl gh pr digest -R owner/repo 123

# Review comments grouped by file
tl gh pr comments -R owner/repo 123
tl gh pr comments -R owner/repo 123 --unresolved

# Land a PR: wait for CI → merge → close linked issues → delete branch
tl gh pr land -R owner/repo 123
tl gh pr land -R owner/repo 123 --method rebase --dry-run
```

### Project commands

```bash
# Add issues to a project board in bulk
tl gh project add-batch -R owner/repo --project owner/1 452 453 454
```

### Release commands

```bash
# Auto-changelog from PRs/commits since last tag
tl gh release notes -R owner/repo --tag v1.2.0
tl gh release notes -R owner/repo --tag v1.2.0 --dry-run
```

### Global flags

All `tl gh` commands support: `-R owner/repo` (required), `-j` (JSON output), `-q` (quiet), `--project owner/N` (auto-add created issues to board).

## Tips

- Always use `tl push` instead of raw `git add` + `git commit` + `git push` sequences
- When multiple files are modified, run `tl commit-prep` first to see the full picture, then specify files explicitly
- `tl gh issue view` fetches sub-issues in a single API call — much cheaper than listing + fetching individually
- `tl gh pr land --dry-run` is safe to run — shows what would happen without acting
- Pipe JSON into bulk commands: `tl gh issue create-batch`, `tl gh issue create-tree`
