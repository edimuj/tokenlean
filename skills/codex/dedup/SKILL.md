---
name: dedup
description: "Find duplicate functions in Codex and remove them so they stay gone — triage tl dupes by tier, consolidate the second home (not both copies), and add a duplication-ratchet test to block regressions. Use when deduping, removing copy-paste, consolidating repeated helpers, or acting on tl dupes output."
compatibility: Codex CLI with terminal access, git, tokenlean CLI (npm i -g tokenlean)
---

# Dedup (Codex)

`tl dupes` finds duplicates; removing them well is the skill. Most tiers are
noise, the wins hide in two of them, and the mitigation that sticks is
non-obvious: remove the *second home*, don't "fix both copies."

## Workflow

```
Scan -> Triage -> Mitigate -> Verify -> Ratchet
```

### 1. Scan

```bash
tl dupes --near        # structural + near first; tests excluded by default
```

Files copied verbatim into another tool (a plugin shipped into a user's config
dir) are **external contracts** — their duplicate helpers are by-design. `tl
dupes` excludes them by default. Mark your own in `.tokenleanrc.json`:

```json
{ "externalContractFiles": ["src/my-copied-plugin.js"] }
```

`tl dupes --near --include-contracts` audits those copies too, when you mean to.

### 2. Triage by tier

Four tiers, treated differently:

- **Structural + near = signal.** Renamed clones, copy-paste-with-edits — the
  drift-prone ones. Start here.
- **Exact = quick wins**, but check intent. Trivial pass-throughs that collide
  aren't always worth a shared home.
- **Names = mostly noise.** Idiomatic repeats (`update`, `close`, `get`). Skim;
  add `--no-names` after a glance.

### 3. The "real dupe?" test

- **Same *rule* encoded twice → collapse it.** Validation, response unwrapping,
  path-containment checks, magic constants, normalization. Drift hazards: one
  copy gets fixed, the other doesn't, phantom bug later.
- **Same *shape* by coincidence → leave it.** Logger levels, SSE `emit*`
  helpers, store thunks, thin HTTP wrappers. Merging costs readability for no
  safety gain.

Propose a verdict per group; the operator confirms. Never auto-merge — the
shape-vs-rule call needs judgment.

### 4. Mitigate: delete the home

Don't "find and fix both copies" — you'll miss the third next time. Remove the
second home.

```
What's duplicated?
  ├─ Two classes, same except one method
  │   → abstract base class with one abstract seam (the differing part)
  ├─ Two components with the same stateful logic
  │   → extract a hook / shared function
  ├─ A method defined but never called
  │   → delete it — verify dead:  tl impact <file>  +  repo-wide call grep
  └─ A constant/type repeated
      → one exported definition, import everywhere
```

**Diff the copies before merging — the diff is often a latent bug.** Merging
surfaces their differences and forces a decision (e.g. two unwrap helpers
disagreeing on whether `{error}` means failure — unifying fixed it).

```bash
tl snippet <fnA> <fileA>
tl snippet <fnB> <fileB>     # diff the two before collapsing
```

### 5. Verify

```bash
tl parallel \
  "test=tl run '<test-command>'" \
  "guard=tl guard" \
  "dupes=tl dupes --near"
```

The `tl dupes` re-run confirms the group is gone and no new one appeared.

### 6. Ratchet — lock the win

A **duplication ratchet** is a test that counts the definition sites of a
primitive that should have one home and **fails CI if the count exceeds a
baseline** — a ceiling that only moves *down*:

- New copy → exceeds baseline → hard fail, message names the canonical home.
- You consolidate → count drops → passes, prints "lower the baseline."
- Eventually `baseline === 1`: permanently single-homed.

The scan finds today's dupes; the ratchet stops tomorrow's. If a ratchet already
exists, lower its baselines after consolidating. If absent, offer to scaffold
one — tiny, language-agnostic, **matching definition sites, never call sites**:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Down-only ceiling. Lower as you consolidate; never raise.
const BASELINES = { unwrapResponse: 1, assertInRoot: 1 };

for (const [name, max] of Object.entries(BASELINES)) {
  test(`duplication ratchet: ${name} <= ${max}`, () => {
    const out = execFileSync('rg', [
      '-c', '--no-filename',
      `(function\\s+${name}\\b|\\b${name}\\s*[=(:])`, 'src',
    ], { encoding: 'utf8' });
    const count = out.split('\n').filter(Boolean)
      .reduce((n, l) => n + Number(l), 0);
    assert.ok(count <= max,
      `${name} defined ${count}x (baseline ${max}). Reuse the canonical home or lower the baseline.`);
  });
}
```

Tune the regex per language; the philosophy is constant: a ceiling that only
ratchets down.

## Tips

- Sequence: structural/near (real wins) → exact (quick) → names (skim). Don't
  spend attention on the names tier.
- Commit per consolidated group — bisectable, and each baseline drop is a clean
  diff.
- `tl unused` after collapsing catches now-dead exports.
- Per-project only; don't dedup across repos.
