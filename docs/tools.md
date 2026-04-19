# All Tools

Use `tl <command>` for all operations. Run `tl --help` for the full list, `tl <command> --help` for details.

Every tool supports `-l N` (limit lines), `-t N` (limit tokens), `-j` (JSON output), `-q` (quiet), and `-h` (help).

## Essential

The tools agents use 90% of the time.

| Tool           | Description                                    | Example                          |
|----------------|------------------------------------------------|----------------------------------|
| `tl symbols`   | Function/class signatures without bodies       | `tl symbols src/utils.ts` or `src/` |
| `tl snippet`   | Extract one function/class by name             | `tl snippet handleSubmit`        |
| `tl impact`    | Blast radius — what depends on this file       | `tl impact src/auth.ts`          |
| `tl run`       | Token-efficient command output (tests, builds) | `tl run "npm test"`              |
| `tl tail`      | Token-efficient log tailing and summarization  | `tl tail logs/app.log`           |
| `tl guard`     | Pre-commit check (secrets, TODOs, unused, circular) | `tl guard`                  |
| `tl commit-prep` | Pre-commit context: status + diff stat + log     | `tl commit-prep`            |
| `tl push`      | Stage, commit, push in one call                    | `tl push "feat: caching"`  |
| `tl structure` | Project overview with token estimates          | `tl structure src/`              |
| `tl browse`    | Fetch any URL as clean markdown                | `tl browse https://docs.example.com` |
| `tl context7`  | Look up library docs via Context7 API          | `tl context7 react "hooks"`      |
| `tl component` | React component analyzer (props, hooks, state) | `tl component Button.tsx`        |
| `tl parallel`  | Run commands in parallel, structured results   | `tl parallel "tl symbols f" "tl deps f"` |
| `tl analyze`   | Composite file profile (5 tools in 1)          | `tl analyze src/auth.ts`         |

## Understanding Code

Structure and signatures without reading implementations.

| Tool           | Description                              | Example                   |
|----------------|------------------------------------------|---------------------------|
| `tl context`   | Estimate token usage for files/dirs      | `tl context src/api/`     |
| `tl types`     | Full TypeScript type definitions         | `tl types src/types/`     |
| `tl exports`   | Public API surface of a module           | `tl exports src/lib/`     |
| `tl docs`      | Extract JSDoc/TSDoc documentation        | `tl docs src/utils/`      |
| `tl entry`     | Find entry points and main files         | `tl entry src/`           |
| `tl scope`     | Show what symbols are in scope at a line | `tl scope src/cache.mjs:52` |
| `tl schema`    | Extract DB schema from ORMs/migrations   | `tl schema`               |
| `tl stack`     | Auto-detect project technology stack     | `tl stack`                |

## Before Modifying Files

Understand dependencies and impact.

| Tool            | Description                                 | Example                             |
|-----------------|---------------------------------------------|-------------------------------------|
| `tl deps`       | Show what a file imports (with tree mode)   | `tl deps src/api.ts --tree`         |
| `tl related`    | Find tests, types, and importers            | `tl related src/Button.tsx`         |
| `tl flow`       | Call graph — what calls this, what it calls | `tl flow src/utils.ts`              |
| `tl coverage`   | Test coverage info for files                | `tl coverage src/`                  |
| `tl complexity` | Code complexity metrics                     | `tl complexity src/ --threshold 10` |
| `tl errors`     | Map error types and throw points            | `tl errors src/`                    |
| `tl test-map`   | Map source files to their test files        | `tl test-map src/cache.mjs`         |
| `tl style`      | Detect coding conventions from code         | `tl style src/`                     |

## Understanding History

Track changes and authorship.

| Tool           | Description                      | Example                  |
|----------------|----------------------------------|--------------------------|
| `tl diff`      | Token-efficient git diff summary | `tl diff --staged`       |
| `tl history`   | Recent commits for a file        | `tl history src/api.ts`  |
| `tl blame`     | Compact per-line authorship      | `tl blame src/api.ts`    |
| `tl hotspots`  | Frequently changed files (churn) | `tl hotspots --days 30`  |
| `tl pr`        | Summarize PR/branch for review   | `tl pr feature-branch`   |
| `tl changelog` | Generate changelog from commits  | `tl changelog --from v1` |

## Finding Things

Search and discover code patterns.

| Tool         | Description                        | Example                  |
|--------------|------------------------------------|--------------------------|
| `tl example` | Find diverse usage examples        | `tl example useAuth`     |
| `tl search`  | Run pre-defined search patterns    | `tl search hooks`        |
| `tl secrets` | Find hardcoded secrets & API keys  | `tl secrets --staged`    |
| `tl todo`    | Find TODOs/FIXMEs in codebase      | `tl todo src/`           |
| `tl env`     | Find environment variables used    | `tl env --required-only` |
| `tl unused`  | Find unused exports/files          | `tl unused src/`         |
| `tl api`     | Extract REST/GraphQL endpoints     | `tl api src/routes/`     |
| `tl routes`  | Extract routes from web frameworks | `tl routes app/`         |
| `tl npm`     | Quick npm package lookup/compare   | `tl npm express fastify` |

## GitHub Workflows

Multi-step `gh` operations in single commands.

| Tool | Description | Example |
|------|-------------|---------|
| `tl gh issue view` | View issue + all sub-issues in one call | `tl gh issue view -R owner/repo 434 --no-body` |
| `tl gh issue create-batch` | Create issues in bulk from JSON/JSONL | `echo '[...]' \| tl gh issue create-batch -R owner/repo` |
| `tl gh issue create-tree` | Create parent + children with sub-issue links | `echo '{...}' \| tl gh issue create-tree -R owner/repo` |
| `tl gh issue add-sub` | Link existing issues as sub-issues | `tl gh issue add-sub -R owner/repo --parent 10 42 43` |
| `tl gh issue close-batch` | Close multiple issues with optional comment | `tl gh issue close-batch -R owner/repo 1 2 3 -c "Done"` |
| `tl gh issue label-batch` | Add/remove labels across multiple issues | `tl gh issue label-batch -R owner/repo --add "P0" 1 2 3` |
| `tl gh pr digest` | Full PR status: CI, reviews, comments, merge readiness | `tl gh pr digest -R owner/repo 123` |
| `tl gh pr comments` | Review comments grouped by file with resolution status | `tl gh pr comments -R owner/repo 123 --unresolved` |
| `tl gh pr land` | Check CI, merge, close linked issues, delete branch | `tl gh pr land -R owner/repo 123` |
| `tl gh release notes` | Auto-changelog from commits/PRs, create release | `tl gh release notes -R owner/repo --tag v1.2.0` |

All issue-creating commands support `--project owner/N` to auto-add to a GitHub project board.

## Utilities

| Tool            | Description                              | Example                     |
|-----------------|------------------------------------------|-----------------------------|
| `tl audit`      | Analyze Claude/Codex sessions and estimate token savings | `tl audit --all --savings`  |
| `tl quota`      | Check AI subscription quota (Claude, Codex) | `tl quota`               |
| `tl hook`       | Install token-saving agent hooks         | `tl hook install claude-code` |
| `tl reddit`     | Read Reddit threads as clean text        | `tl reddit <url> -c 20`    |
| `tl cache`      | Manage tokenlean caches                  | `tl cache stats`            |
| `tl config`     | Show/manage configuration                | `tl config --init`          |
| `tl name`       | Check name availability (npm/GH/domains) | `tl name myproject -s`      |
| `tl playwright` | Headless browser content extraction      | `tl playwright example.com` |
| `tl prompt`     | Generate AI agent instructions           | `tl prompt --minimal`       |
| `tl completions`| Shell tab completions (bash/zsh)         | `tl completions bash >> ~/.bashrc` |
