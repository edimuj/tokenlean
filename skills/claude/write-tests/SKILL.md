---
name: write-tests
description: Write effective tests by studying existing test patterns and understanding the code under test before writing assertions. Discovers test conventions, prioritizes public API coverage, and validates results. Use when asked to write tests, add test coverage, or create test files.
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
tl test-map <file>         # Do tests already exist for this file?
tl coverage <file>         # Which functions/branches are uncovered?
tl example "*.test.*"      # Existing test files — learn the project's patterns
tl style                   # Test naming conventions, assertion library, setup/teardown
```

### 2. Understand

Know the code before testing it:

```bash
tl symbols <file>          # Every function that needs testing
tl exports <file>          # Public API — test these first
tl deps <file>             # What needs mocking or stubbing
tl snippet <function> <file>   # Read each function to understand branches and edge cases
```

### 3. Design

For each exported function, identify:
- Happy path (normal input, expected output)
- Error cases (invalid input, missing data, exceptions)
- Edge cases (empty input, boundary values, null/undefined)

```bash
tl flow <function> <file>  # For complex functions — what gets called internally?
tl types <file>            # Input/output types and constraints
```

### 4. Write

- Follow the pattern from existing test files found in step 1
- Match the project's test runner, assertion style, and file naming
- Colocate test files with source (or match existing convention)
- Mock external dependencies identified by tl deps, not internal functions

### 5. Validate

```bash
tl run "<test command> <new-test-file>"   # Run just the new tests
tl coverage <file>         # Confirm coverage improved
tl run "<full test suite>" # Ensure no interference with existing tests
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
