---
name: write-tests
description: "Write high-value tests in Codex by matching repository test conventions, prioritizing public behavior, and validating coverage gains without overfitting implementation details."
compatibility: Codex CLI with terminal access, Node.js test tooling, git, tokenlean CLI (npm i -g tokenlean)
---

# Write Tests (Codex)

Write tests that protect behavior, not internals.

## Workflow

```
Discover patterns -> Understand unit -> Design cases -> Implement tests -> Validate
```

### 1. Discover test patterns

```bash
tl parallel \
  "structure=tl structure" \
  "symbols=tl symbols test/" \
  "related=tl related <source-file>"
```

Match existing test style, helpers, and naming.

### 2. Understand code under test

```bash
tl parallel "symbols=tl symbols <source-file>" "exports=tl exports <source-file>"
tl snippet <function> <file>  # Read specific function implementations
```

Prioritize exported/public behavior.

### 3. Design cases

Cover:
- happy path
- error path
- edge cases (empty/null/boundary)

### 4. Implement tests

- Reuse existing fixtures/helpers.
- Mock only true external dependencies.
- Keep assertions specific and stable.

### 5. Validate

```bash
tl run "npm test"         # Token-efficient output — shows only failures
```

If available, run targeted test files first, then full suite.

## Tips

- One clear behavior per test.
- Avoid brittle assertions tied to implementation details.
- Add regression tests for every bug fix when feasible.
- `tl test-map <source-file>` shows which test files cover a given source file.
