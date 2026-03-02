---
name: write-tests
description: Write high-value tests in Codex by matching repository test conventions, prioritizing public behavior, and validating coverage gains without overfitting implementation details.
compatibility: Codex CLI with terminal access, Node.js test tooling, git (tokenlean CLI optional)
---

# Write Tests (Codex)

Write tests that protect behavior, not internals.

## Workflow

```
Discover patterns -> Understand unit -> Design cases -> Implement tests -> Validate
```

### 1. Discover test patterns

```bash
rg --files test src | rg "test|spec"
rg -n "describe\(|it\(|test\(" test src
```

Match existing test style, helpers, and naming.

### 2. Understand code under test

```bash
sed -n '1,260p' <source-file>
rg -n "export |function |class " <source-file>
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
npm test
```

If available, run targeted test files first, then full suite.

## Tips

- One clear behavior per test.
- Avoid brittle assertions tied to implementation details.
- Add regression tests for every bug fix when feasible.
