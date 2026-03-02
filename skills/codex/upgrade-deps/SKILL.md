---
name: upgrade-deps
description: Upgrade dependencies in Codex with version-jump-aware rigor: audit usage, read changelogs, apply minimal bumps, and verify behavior through targeted and full tests.
compatibility: Codex CLI with terminal access, npm, git (tokenlean CLI optional)
---

# Upgrade Deps (Codex)

Upgrade dependencies with usage awareness and verification.

## Workflow

```
Audit -> Research -> Upgrade -> Verify -> Clean up
```

### 1. Audit usage

```bash
npm ls <package>
rg -n "<package>|<imported symbol>" src test bin
```

### 2. Research change surface

Review release notes/changelog for:
- Removed/renamed APIs
- Changed defaults
- New peer dependencies

### 3. Upgrade

```bash
npm install <package>@<version>
```

Keep upgrades scoped when possible (one major dependency at a time).

### 4. Verify

```bash
npm test
node bin/<affected-tool>.mjs --help
```

Run targeted usage checks for files that import the upgraded package.

### 5. Clean up

```bash
rg -n "<legacy workaround|old API usage>" src test bin
```

Remove obsolete compatibility code when safe.

## Decision guide

- Patch: quick targeted verification.
- Minor: changelog + standard regression checks.
- Major: full usage audit + migration steps + broader tests.

## Tips

- Avoid combining unrelated upgrades in one patch.
- If a major upgrade is risky, stage changes in batches.
