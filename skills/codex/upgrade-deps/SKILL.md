---
name: upgrade-deps
description: Upgrade dependencies in Codex with version-jump-aware rigor: audit usage, read changelogs, apply minimal bumps, and verify behavior through targeted and full tests.
compatibility: Codex CLI with terminal access, npm, git, tokenlean CLI (npm i -g tokenlean)
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
tl impact <file>          # What depends on files that use this package?
tl deps <file>            # Trace imports from the package
```

### 2. Research change surface

Review release notes/changelog for:
- Removed/renamed APIs
- Changed defaults
- New peer dependencies

Use `tl browse <changelog-url>` to fetch changelogs as clean markdown.

### 3. Upgrade

```bash
npm install <package>@<version>
```

Keep upgrades scoped when possible (one major dependency at a time).

### 4. Verify

```bash
tl run "npm test"         # Token-efficient test output
tl guard                  # Check for broken imports, circular deps
```

Run targeted usage checks for files that import the upgraded package.

### 5. Clean up

```bash
tl unused                 # Find dead compatibility code
```

Remove obsolete workarounds when safe.

## Decision guide

- Patch: quick targeted verification.
- Minor: changelog + standard regression checks.
- Major: full usage audit + migration steps + broader tests.

## Tips

- Avoid combining unrelated upgrades in one patch.
- If a major upgrade is risky, stage changes in batches.
- Use `tl symbols <file>` to check if API surface changed after upgrade.
