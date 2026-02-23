# New Agent Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create six new SKILL.md files teaching AI agents how to use tokenlean tools for common development scenarios.

**Architecture:** Each skill is a standalone markdown file in `skills/<name>/SKILL.md` with YAML frontmatter, numbered workflow steps, a decision tree, and tips. No code — pure instruction files.

**Tech Stack:** Markdown only. Ships as part of the tokenlean npm package.

**Design doc:** `docs/plans/2026-02-23-new-skills-design.md`

**Template reference:** `skills/code-review/SKILL.md` — follow this structure exactly:
- YAML frontmatter: `name`, `description`, `compatibility`
- H1 title + one-line purpose
- `## Workflow` with ASCII flow summary + numbered `### N. Step name` sections
- Each step has bash code blocks with inline comments
- `## Decision tree` with ASCII tree using `├─` / `└─`
- `## Tips` with 3-5 bullet points
- Target: ~80-100 lines

---

### Task 1: Create `debug-bug` skill

**Files:**
- Create: `skills/debug-bug/SKILL.md`

**Step 1: Create directory and write SKILL.md**

Write the file following the template pattern. Content from design doc section 1:

- **Frontmatter name:** `debug-bug`
- **Frontmatter description:** `Systematically investigate and fix bugs using token-efficient context gathering. Reproduces the issue first, localizes with blame and history, traces the call path, then verifies the fix. Use when asked to fix a bug, investigate an error, or debug unexpected behavior.`
- **Workflow:** `Reproduce → Localize → Trace → Fix → Verify`
- **Steps:**
  1. Reproduce — `tl-run "<repro command>"`. No fix without reproduction. If no repro given, ask.
  2. Localize — `tl-errors`, `tl-blame <file>`, `tl-history <file>`
  3. Trace — `tl-flow <function> <file>`, `tl-deps <file>`, `tl-snippet <function> <file>`
  4. Fix — Minimal fix, then `tl-guard` + `tl-impact <file>`
  5. Verify — `tl-run` repro again + `tl-run` tests
- **Decision tree:** Branch on reproducibility (yes/no/intermittent), then on error source (stack trace/vague/dependency)
- **Tips:** Parallel tl-blame + tl-history; use tl-search for error messages; check tl-diff for recent regressions; small files (<150 lines) just read directly

**Step 2: Verify structure**

Run: `head -5 skills/debug-bug/SKILL.md`
Expected: YAML frontmatter with `---` delimiters, `name: debug-bug`

Run: `wc -l skills/debug-bug/SKILL.md`
Expected: 80-100 lines

**Step 3: Commit**

```bash
git add skills/debug-bug/SKILL.md
git commit -m "feat: add debug-bug skill"
```

---

### Task 2: Create `add-feature` skill

**Files:**
- Create: `skills/add-feature/SKILL.md`

**Step 1: Create directory and write SKILL.md**

- **Frontmatter name:** `add-feature`
- **Frontmatter description:** `Add new functionality by understanding existing patterns and dependencies before writing code. Locates where the feature belongs, studies conventions, implements following precedent, then verifies integration. Use when asked to add a feature, flag, endpoint, component, or module.`
- **Workflow:** `Locate → Understand → Implement → Integrate → Verify`
- **Steps:**
  1. Locate — `tl-structure`, `tl-entry`, `tl-example <pattern>`
  2. Understand — `tl-symbols <file>`, `tl-style`, `tl-deps <file>`, `tl-exports <file>`
  3. Implement — Extending: `tl-snippet`. New file: conventions from `tl-style` + `tl-structure`. New dep: `tl-npm <package>`
  4. Integrate — `tl-impact <modified-file>`, `tl-guard`, `tl-diff --breaking`
  5. Verify — `tl-run "<test command>"`, `tl-test-map <file>`
- **Decision tree:** Branch on extending vs replacing vs greenfield
- **Tips:** Always run tl-example first; tl-npm before adding deps; tl-diff --breaking if exports changed; for React use tl-component

**Step 2: Verify structure**

Run: `head -5 skills/add-feature/SKILL.md && wc -l skills/add-feature/SKILL.md`
Expected: Frontmatter present, 80-100 lines

**Step 3: Commit**

```bash
git add skills/add-feature/SKILL.md
git commit -m "feat: add add-feature skill"
```

---

### Task 3: Create `debug-performance` skill

**Files:**
- Create: `skills/debug-performance/SKILL.md`

**Step 1: Create directory and write SKILL.md**

- **Frontmatter name:** `debug-performance`
- **Frontmatter description:** `Diagnose and fix performance issues by measuring before optimizing. Establishes baselines, identifies bottlenecks through call graphs and complexity analysis, then confirms improvements with numbers. Use when asked to optimize, speed up, reduce memory usage, or fix slowness.`
- **Workflow:** `Measure → Identify → Analyze → Optimize → Confirm`
- **Steps:**
  1. Measure — `tl-run "<benchmark>"`, `tl-complexity <file>`, `tl-hotspots`
  2. Identify — `tl-flow <function> <file>`, `tl-deps <file>`, `tl-symbols <file>`
  3. Analyze — `tl-snippet <function> <file>`, `tl-related <file>`, `tl-scope <function> <file>`
  4. Optimize — Algorithmic: `tl-flow`. Caching: `tl-impact`. I/O: `tl-deps`
  5. Confirm — `tl-run "<same benchmark>"`
- **Decision tree:** Branch on measurement type (specific operation/vague/memory)
- **Tips:** Before/after is mandatory; tl-complexity >10 is a red flag; check tl-deps for heavy imports; don't optimize cold paths

**Step 2: Verify structure**

Run: `head -5 skills/debug-performance/SKILL.md && wc -l skills/debug-performance/SKILL.md`
Expected: Frontmatter present, 80-100 lines

**Step 3: Commit**

```bash
git add skills/debug-performance/SKILL.md
git commit -m "feat: add debug-performance skill"
```

---

### Task 4: Create `upgrade-deps` skill

**Files:**
- Create: `skills/upgrade-deps/SKILL.md`

**Step 1: Create directory and write SKILL.md**

- **Frontmatter name:** `upgrade-deps`
- **Frontmatter description:** `Upgrade dependencies safely by auditing usage, researching breaking changes, and verifying after upgrade. Scales effort to version jump size — light check for patches, full audit for majors. Use when asked to upgrade, bump, or update a dependency or package.`
- **Workflow:** `Audit → Research → Upgrade → Verify → Clean up`
- **Steps:**
  1. Audit — `tl-npm <package>`, `tl-search "<package>"`, `tl-deps` on importers
  2. Research — `tl-browse <changelog-url>`, `tl-context7 <package> "migration guide"`
  3. Upgrade — Update package.json, `tl-diff --breaking`, `tl-snippet` on each usage site
  4. Verify — `tl-run "<test command>"`, `tl-test-map`, `tl-guard`
  5. Clean up — `tl-unused`, `tl-search` for old version workarounds
- **Decision tree:** Branch on version jump size (patch/minor/major)
- **Tips:** tl-npm shows changelog URL; tl-context7 for popular frameworks; check peer deps; tl-unused after removing compat code

**Step 2: Verify structure**

Run: `head -5 skills/upgrade-deps/SKILL.md && wc -l skills/upgrade-deps/SKILL.md`
Expected: Frontmatter present, 80-100 lines

**Step 3: Commit**

```bash
git add skills/upgrade-deps/SKILL.md
git commit -m "feat: add upgrade-deps skill"
```

---

### Task 5: Create `write-tests` skill

**Files:**
- Create: `skills/write-tests/SKILL.md`

**Step 1: Create directory and write SKILL.md**

- **Frontmatter name:** `write-tests`
- **Frontmatter description:** `Write effective tests by studying existing test patterns and understanding the code under test before writing assertions. Discovers test conventions, prioritizes public API coverage, and validates results. Use when asked to write tests, add test coverage, or create test files.`
- **Workflow:** `Discover → Understand → Design → Write → Validate`
- **Steps:**
  1. Discover — `tl-test-map <file>`, `tl-coverage <file>`, `tl-example "*.test.*"`, `tl-style`
  2. Understand — `tl-symbols <file>`, `tl-exports <file>`, `tl-deps <file>`, `tl-snippet <function> <file>`
  3. Design — Happy path, error cases, edge cases, boundary values. `tl-flow` for complex functions, `tl-types <file>`
  4. Write — Follow existing patterns. Match runner + assertion style. Mock external deps from `tl-deps`
  5. Validate — `tl-run` new tests, `tl-coverage` again, `tl-run` full suite
- **Decision tree:** Branch on tests exist (extend) / no tests (create) / coverage target
- **Tips:** Read an existing test first (tl-example); mock deps not internals; prioritize exported > complex > simple; tl-coverage before and after

**Step 2: Verify structure**

Run: `head -5 skills/write-tests/SKILL.md && wc -l skills/write-tests/SKILL.md`
Expected: Frontmatter present, 80-100 lines

**Step 3: Commit**

```bash
git add skills/write-tests/SKILL.md
git commit -m "feat: add write-tests skill"
```

---

### Task 6: Create `migrate-framework` skill

**Files:**
- Create: `skills/migrate-framework/SKILL.md`

**Step 1: Create directory and write SKILL.md**

- **Frontmatter name:** `migrate-framework`
- **Frontmatter description:** `Migrate frameworks, APIs, or language versions incrementally with verification at each step. Surveys the migration surface, batches work by dependency order, and commits after each verified batch. Use when asked to migrate between frameworks, upgrade major versions, or adapt to new API versions.`
- **Workflow:** `Survey → Plan → Migrate incrementally → Verify each step → Clean up`
- **Steps:**
  1. Survey — `tl-structure`, `tl-search "<old-api>"`, `tl-stack`, `tl-context7` or `tl-browse` for migration guide
  2. Plan — `tl-impact` to sort by dependents, `tl-related` to batch. Leaf files first, shared modules last
  3. Migrate — One batch at a time. `tl-symbols`, `tl-snippet`, apply pattern, `tl-diff --breaking`
  4. Verify — After each batch: `tl-run`, `tl-guard`, `tl-exports`. Commit after each passing batch
  5. Clean up — `tl-search "<old-api>"` returns zero, `tl-unused`, `tl-deps` for lingering imports
- **Decision tree:** Branch on surface size (small <10 / medium 10-50 / large 50+)
- **Tips:** Never migrate without the migration guide; commit after each batch; tl-search tracks remaining count; leaf files first reduces risk

**Step 2: Verify structure**

Run: `head -5 skills/migrate-framework/SKILL.md && wc -l skills/migrate-framework/SKILL.md`
Expected: Frontmatter present, 80-100 lines

**Step 3: Commit**

```bash
git add skills/migrate-framework/SKILL.md
git commit -m "feat: add migrate-framework skill"
```

---

### Task 7: Final verification and combined commit

**Step 1: Verify all six skills exist**

Run: `ls skills/*/SKILL.md`
Expected: 9 files (3 existing + 6 new)

**Step 2: Verify line counts are consistent**

Run: `wc -l skills/*/SKILL.md`
Expected: All files between 80-100 lines

**Step 3: Verify all frontmatter is valid**

Run: `head -5 skills/*/SKILL.md`
Expected: Each starts with `---`, has `name:` and `description:`

**Step 4: Spot-check tool references**

Verify no made-up tl-tools are referenced. All tool names must exist in `bin/`:

Run: `grep -roh 'tl-[a-z-]*' skills/*/SKILL.md | sort -u`
Cross-reference against: `ls bin/ | sed 's/\.mjs//'`

Any tool in skills not in bin/ is an error — fix it.
