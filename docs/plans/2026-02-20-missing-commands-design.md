# Missing Commands Design — 2026-02-20

## tl-test — Run relevant tests for changed files

Detects changed files via `git diff --name-only` (unstaged + staged), maps each to test files using tl-test-map's logic, executes via `node --test`, pipes through tl-run's summarizer.

**Flags:** `--since <ref>` (commit range), `--dry-run` (list tests only), `--runner <cmd>` (override test command)

**Output:** Token-lean test results (pass/fail summary + failure details).

---

## tl-lint-config — Summarize project lint/format rules

Scans for config files: `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `tsconfig.json`, `biome.json`, `.editorconfig`. Reads each, extracts key rules into compact summary. JSON/YAML parsing only, no AST.

**Output:** One section per config, showing non-default/notable rules. ~100-300 tokens.

---

## tl-risk-assess — Quick risk score for a file

Spawns tl-impact, tl-complexity, tl-test-map as subprocesses (like tl-analyze). Combines into risk score 1-10:
- Blast radius: importer count (tl-impact)
- Complexity: max cyclomatic (tl-complexity)
- Test coverage: has tests? coverage %? (tl-test-map)

**Output:** ~50-100 tokens. Score + breakdown + suggestion.

---

## tl-monorepo — Package structure overview

Detects monorepo pattern (workspaces in package.json, lerna.json, pnpm-workspace.yaml). Lists packages with internal cross-dependencies. Exits with "Not a monorepo" for single-package projects.

---

## tl-changelog --draft — Release changelog drafting

Enhancement to existing tl-changelog. Adds `--draft` flag that:
1. Auto-detects last tag
2. Groups commits by type
3. Suggests semver bump (breaking->major, feat->minor, fix->patch)
4. Outputs ready-to-paste changelog entry
