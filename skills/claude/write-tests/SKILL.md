---
name: write-tests
description: "Write effective tests by studying existing test patterns and understanding the code under test before writing assertions. Discovers test conventions, prioritizes public API coverage, and validates results. Use when asked to write tests, add test coverage, or create test files."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Write Tests

Write tests that match project conventions and cover real edge cases.

## Workflow

```
Discover → Understand → Design → Write → Validate
```

### 1. Discover

Find the testing landscape:

```bash
tl parallel \
  "testmap=tl test-map <file>" \
  "coverage=tl coverage <file>" \
  "example=tl example '*.test.*'" \
  "style=tl style"
```

### 2. Understand

Know the code before testing it:

```bash
tl parallel \
  "symbols=tl symbols <file>" \
  "exports=tl exports <file>" \
  "deps=tl deps <file>"
tl snippet <function> <file>   # Read each function to understand branches and edge cases
```

### 3. Design

For each exported function, identify:
- Happy path (normal input, expected output)
- Error cases (invalid input, missing data, exceptions)
- Edge cases (empty input, boundary values, null/undefined)

```bash
tl parallel "flow=tl flow <function> <file>" "types=tl types <file>"
```

### 4. Write

- Follow the pattern from existing test files found in step 1
- Match the project's test runner, assertion style, and file naming
- Colocate test files with source (or match existing convention)
- Mock external dependencies identified by tl deps, not internal functions

### 5. Validate

```bash
tl parallel \
  "new=tl run '<test command> <new-test-file>'" \
  "coverage=tl coverage <file>" \
  "full=tl run '<full test suite>'"
```

## Decision tree

```
Write tests → Do tests already exist for this file?
  ├─ Yes (extend) → tl test-map to find the test file
  │   → tl symbols on the test file to see what's covered
  │   → tl coverage to find gaps
  │   → Add missing cases following existing patterns
  ├─ No (create) → tl example "*.test.*" to learn project patterns
  │   → tl exports on source to prioritize public API
  │   → tl deps to identify what to mock
  │   → Create test file matching project conventions
  └─ Coverage target → tl coverage for current numbers
      → tl symbols to list all functions
      → Prioritize: exported > complex > simple
      → Write tests until target met
```

## Tips

- Always read an existing test file before writing a new one — tl example finds the precedent
- Mock external dependencies (APIs, databases), not internal functions
- Prioritize testing order: exported functions > complex functions > simple helpers
- Run tl coverage before and after to prove your tests added value
- If a function has no branches, a single happy-path test is sufficient
