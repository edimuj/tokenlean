# New Agent Skills Design

Six standalone skills teaching AI agents how to use tokenlean tools for common development scenarios.

## Existing Skills

- `code-review` — Review changes using tl-impact, tl-symbols, tl-complexity, tl-guard
- `explore-codebase` — Map and understand unfamiliar projects using tl-structure, tl-entry, tl-hotspots
- `safe-refactor` — Analyze blast radius before restructuring code

## New Skills

### 1. `debug-bug`

**Trigger:** Fix a bug, investigate an error, debug unexpected behavior.

**Problem:** Agents read too much code, guess at fixes, debug the wrong layer, skip reproduction.

**Workflow:** `Reproduce → Localize → Trace → Fix → Verify`

1. **Reproduce** — `tl-run "<repro command>"` to capture actual error. No fix without reproduction.
2. **Localize** — `tl-errors` for error patterns, `tl-blame <file>` for recent changes, `tl-history <file>` for regressions.
3. **Trace** — `tl-flow <function> <file>` for call graph, `tl-deps <file>` for dependencies, `tl-snippet <function> <file>` for relevant code only.
4. **Fix** — Minimal fix, then `tl-guard` + `tl-impact <file>`.
5. **Verify** — `tl-run` repro command again + `tl-run` test command.

**Decision tree:**

```
Bug report → Can you reproduce it?
  ├─ Yes → What layer does the error come from?
  │   ├─ Stack trace points to a file → tl-blame + tl-snippet on that file
  │   ├─ Error is vague / no stack → tl-errors + tl-search for the error message
  │   └─ Happening in dependency → tl-deps to confirm, then check dep version
  ├─ No → Ask for reproduction steps
  └─ Intermittent → tl-history on suspect files, look for recent changes
```

**Key rule:** No fix without reproduction.

---

### 2. `add-feature`

**Trigger:** Add functionality — new flag, endpoint, component, tool, or module.

**Problem:** Agents jump straight to coding without understanding existing patterns, where to hook in, or what they'll affect.

**Workflow:** `Locate → Understand → Implement → Integrate → Verify`

1. **Locate** — `tl-structure` for layout, `tl-entry` for module boundaries, `tl-example <pattern>` to find similar existing features.
2. **Understand** — `tl-symbols <file>` on target files, `tl-style` for conventions, `tl-deps <file>` + `tl-exports <file>` for current API surface.
3. **Implement** — Extending: `tl-snippet` to read just the function to modify. New file: follow conventions from `tl-style` + `tl-structure`. New dep: `tl-npm <package>` first.
4. **Integrate** — `tl-impact <modified-file>`, `tl-guard`, `tl-diff --breaking` if public API changed.
5. **Verify** — `tl-run "<test command>"`, `tl-test-map <file>` to find relevant tests.

**Decision tree:**

```
Feature request → Does similar functionality exist?
  ├─ Yes (extending) → tl-example to find the pattern
  │   → tl-symbols on target file
  │   → tl-snippet on the function to extend
  │   → Implement following the existing pattern
  ├─ Yes (replacing) → tl-impact on what you're replacing
  │   → tl-exports to check public API surface
  │   → Implement, update all consumers
  └─ No (greenfield) → tl-structure for placement
      → tl-style for conventions
      → tl-entry to understand how it'll be wired in
      → Implement, then tl-guard to check integration
```

**Key rule:** Never start implementing until you've run `tl-example` — the codebase almost always has a precedent.

---

### 3. `debug-performance`

**Trigger:** Improve performance, fix slowness, reduce memory usage, optimize a bottleneck.

**Problem:** Agents guess at what's slow instead of measuring. They optimize the wrong thing or micro-optimize code off the hot path.

**Workflow:** `Measure → Identify → Analyze → Optimize → Confirm`

1. **Measure** — `tl-run "<benchmark>"` for baseline, `tl-complexity` across suspect files, `tl-hotspots` for frequently-changed files.
2. **Identify** — `tl-flow <function> <file>` for full call chain, `tl-deps <file>` for expensive imports, `tl-symbols <file>` on hot files.
3. **Analyze** — `tl-snippet <function> <file>` on hot path functions, `tl-related <file>` for contributing files, `tl-scope <function> <file>` for data flow.
4. **Optimize** — Apply fix. Algorithmic: `tl-flow` to verify simpler path. Caching: `tl-impact` to check caller count. I/O: `tl-deps` for unnecessary reads.
5. **Confirm** — `tl-run "<same benchmark>"` to measure improvement.

**Decision tree:**

```
"It's slow" → Do you have a measurement?
  ├─ Yes (specific operation) → tl-flow on that operation
  │   → tl-snippet on each function in the chain
  │   → Find the O(n²) or blocking I/O
  ├─ Vague ("the app is slow") → tl-hotspots + tl-complexity
  │   → Profile the top 3 complex files
  │   → tl-flow on entry points to find hot paths
  └─ Memory issue → tl-deps on entry point
      → Look for large imports, circular refs
      → tl-guard for circular deps
```

**Key rule:** Always run the benchmark twice — once before and once after. An optimization without a before/after measurement is just a guess.

---

### 4. `upgrade-deps`

**Trigger:** Upgrade a dependency, bump a package version, update a library.

**Problem:** Agents upgrade blindly, miss breaking changes, don't check what the dependency is used for.

**Workflow:** `Audit → Research → Upgrade → Verify → Clean up`

1. **Audit** — `tl-npm <package>` for version info, `tl-search "<package>"` for all usage sites, `tl-deps` on files that import it.
2. **Research** — `tl-browse <changelog-url>` for changelog, `tl-context7 <package> "migration guide"` for framework docs. Look for: removed APIs, renamed functions, changed defaults, new peer deps.
3. **Upgrade** — Update package.json, install. `tl-diff --breaking` on wrapper files. `tl-snippet <symbol> <file>` on each usage site to check API compatibility.
4. **Verify** — `tl-run "<test command>"`, `tl-test-map` for targeted test runs, `tl-guard`.
5. **Clean up** — `tl-unused` for dead compat code, `tl-search` for version-gated workarounds.

**Decision tree:**

```
Upgrade request → How big is the version jump?
  ├─ Patch (1.2.3 → 1.2.4) → Light check
  │   → tl-npm to confirm, upgrade, tl-run tests
  ├─ Minor (1.2 → 1.3) → Standard check
  │   → tl-search for usage, tl-browse changelog
  │   → Upgrade, tl-run tests
  └─ Major (1.x → 2.x) → Full audit
      → tl-search for all usage sites
      → tl-browse changelog + migration guide
      → tl-snippet on every consumer
      → Upgrade, tl-diff --breaking, tl-run tests
      → tl-unused to clean up compat code
```

**Key rule:** Never upgrade a major version without reading the migration guide first.

---

### 5. `write-tests`

**Trigger:** Write tests, add test coverage, create test files for existing code.

**Problem:** Agents write shallow happy-path tests, ignore existing test patterns, miss edge cases.

**Workflow:** `Discover → Understand → Design → Write → Validate`

1. **Discover** — `tl-test-map <file>` for existing tests, `tl-coverage <file>` for uncovered functions, `tl-example "*.test.*"` for project test patterns, `tl-style` for conventions.
2. **Understand** — `tl-symbols <file>` for all functions, `tl-exports <file>` to prioritize public API, `tl-deps <file>` for mocking targets, `tl-snippet <function> <file>` for branches/edge cases.
3. **Design** — For each exported function: happy path, error cases, edge cases, boundary values. `tl-flow` for complex functions, `tl-types <file>` for input/output constraints.
4. **Write** — Follow patterns from existing test files. Match runner, assertion style, file naming. Mock external deps (from `tl-deps`), not internal functions.
5. **Validate** — `tl-run` new tests only, `tl-coverage` to confirm improvement, `tl-run` full suite for interference check.

**Decision tree:**

```
Write tests → Do tests already exist for this file?
  ├─ Yes (extend) → tl-test-map to find the test file
  │   → tl-symbols on the test file to see what's covered
  │   → tl-coverage to find gaps
  │   → Add missing cases following existing patterns
  ├─ No (create) → tl-example "*.test.*" to learn project patterns
  │   → tl-exports on source to prioritize public API
  │   → tl-deps to identify what to mock
  │   → Create test file matching project conventions
  └─ Coverage target → tl-coverage for current numbers
      → tl-symbols to list all functions
      → Prioritize: exported > complex > simple
      → Write tests until target met
```

**Key rule:** Read an existing test file before writing a new one. `tl-example` finds the precedent.

---

### 6. `migrate-framework`

**Trigger:** Migrate between frameworks, upgrade to a new major framework version, move between API versions, adapt to a new language version.

**Problem:** Agents try to change everything at once and break things, or change too little and leave a half-migrated codebase.

**Workflow:** `Survey → Plan → Migrate incrementally → Verify each step → Clean up`

1. **Survey** — `tl-structure` for project size, `tl-search "<old-api-pattern>"` for all migration targets, `tl-stack` for current versions, `tl-context7` or `tl-browse` for migration guide.
2. **Plan** — `tl-impact` on high-usage files (do last), `tl-related` to batch related files. Order: leaf files first → shared utilities last. Each increment must leave the codebase working.
3. **Migrate** — One batch at a time. `tl-symbols` before modifying, `tl-snippet` on each usage site, apply migration pattern, `tl-diff --breaking` after each batch.
4. **Verify** — After each batch: `tl-run` tests, `tl-guard`, `tl-exports` on modified files. Commit after each passing batch.
5. **Clean up** — `tl-search "<old-api-pattern>"` should return zero. `tl-unused` for dead compat code. `tl-deps` to confirm no lingering old imports.

**Decision tree:**

```
Migration request → How big is the surface?
  ├─ Small (<10 usages) → Single batch
  │   → tl-search to find all, migrate, tl-run tests
  ├─ Medium (10-50 usages) → Batch by directory
  │   → tl-related to group files
  │   → Migrate + test one directory at a time
  │   → Commit after each batch
  └─ Large (50+ usages) → Batch by dependency order
      → tl-impact to sort files by dependents
      → Leaf files first, shared modules last
      → Migrate + test + commit per batch
      → tl-search "<old-pattern>" to track remaining count
```

**Key rule:** Never migrate more than one batch without running tests. Every batch gets a `tl-run` and a commit.

---

## Skill File Structure

Each skill follows the existing pattern:

```
skills/
  debug-bug/SKILL.md
  add-feature/SKILL.md
  debug-performance/SKILL.md
  upgrade-deps/SKILL.md
  write-tests/SKILL.md
  migrate-framework/SKILL.md
```

Each SKILL.md contains:
- YAML frontmatter (name, description, compatibility)
- One-line purpose statement
- Workflow with numbered steps and tl-tool commands
- Decision tree for branching scenarios
- Key rule as a single enforced constraint

## Design Principles

- **Standalone** — each skill is self-contained, no cross-references between skills
- **Tool-first** — every step maps to specific tl-* commands, no vague "understand the code" steps
- **Decision trees** — agents get a clear branching path instead of a flat checklist
- **Key rules** — one non-negotiable constraint per skill that prevents the most common failure mode
- **~80-90 lines** — matching existing skill length, scannable in one read
