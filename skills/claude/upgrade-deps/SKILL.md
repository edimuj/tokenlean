---
name: upgrade-deps
description: Upgrade dependencies safely by auditing usage, researching breaking changes, and verifying after upgrade. Scales effort to version jump size — light check for patches, full audit for majors. Use when asked to upgrade, bump, or update a dependency or package.
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Upgrade Deps

Upgrade dependencies safely by understanding usage before changing versions.

## Workflow

```
Audit → Research → Upgrade → Verify → Clean up
```

### 1. Audit

Understand current usage before changing anything:

```bash
tl npm <package>           # Current vs latest version, changelog link, health
tl search "<package-name>" # Every file that imports or uses the dependency
tl deps <file>             # Context around each file that imports it
```

### 2. Research

Check what changed between versions:

```bash
tl browse <changelog-url>  # Read the changelog as markdown
tl context7 <package> "migration guide"  # Framework docs if available
```

Look for: removed APIs, renamed functions, changed defaults, new peer deps.

### 3. Upgrade

Apply the version bump:

```bash
# Update package.json and install
tl diff --breaking         # Detect signature mismatches in wrapper files
tl snippet <symbol> <file> # Check each usage site against new API
```

### 4. Verify

```bash
tl run "<test command>"    # Full test suite
tl test-map <file>         # Find specific tests for targeted runs
tl guard                   # Check for new issues
```

### 5. Clean up

Remove old compatibility code:

```bash
tl unused                  # Exports that only existed for the old version
tl search "<old-version>"  # Version-gated code or workarounds
```

## Decision tree

```
Upgrade request → How big is the version jump?
  ├─ Patch (1.2.3 → 1.2.4) → Light check
  │   → tl npm to confirm, upgrade, tl run tests
  ├─ Minor (1.2 → 1.3) → Standard check
  │   → tl search for usage, tl browse changelog
  │   → Upgrade, tl run tests
  └─ Major (1.x → 2.x) → Full audit
      → tl search for all usage sites
      → tl browse changelog + migration guide
      → tl snippet on every consumer
      → Upgrade, tl diff --breaking, tl run tests
      → tl unused to clean up compat code
```

## Tips

- tl npm output includes the changelog URL — use it with tl browse
- Use tl context7 for popular frameworks (React, Next.js, etc.) — it has migration guides
- Always check for changed peer dependencies after major upgrades
- Run tl unused after removing compatibility code — catch leftover dead exports
- Never upgrade a major version without reading the migration guide first
