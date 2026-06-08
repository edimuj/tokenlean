---
name: dedup
description: "Find duplicate functions and eliminate them so they stay gone. Triage tl dupes output by tier, apply the right consolidation pattern, and lock the win with a duplication-ratchet test. Use when asked to dedupe, remove duplication, consolidate copy-paste, clean up repeated helpers, or act on tl dupes output."
compatibility: Requires tokenlean CLI tools (npm i -g tokenlean) and git
---

# Dedup

`tl dupes` *finds* duplicates; removing them well is the skill. Most of the
output is noise, the wins hide in two tiers, and the mitigation that actually
sticks is non-obvious: you remove the *second home*, not "fix both copies."

## Workflow

```
Scan → Triage → Mitigate → Verify → Ratchet
```

### 1. Scan

```bash
tl dupes --near        # structural + near surfaced first; tests excluded by default
```

Files copied verbatim into another tool (e.g. a plugin shipped into a user's
config dir) are **external contracts** — their duplicate helpers are by-design,
not cleanup targets. `tl dupes` excludes them by default. Mark your own in
`.tokenleanrc.json`:

```json
{ "externalContractFiles": ["src/my-copied-plugin.js"] }
```

Use `tl dupes --near --include-contracts` only when you deliberately want to
audit those copies too.

### 2. Triage by tier — signal vs. noise

`tl dupes` returns four tiers. Treat them differently:

- **Structural + near = signal.** Renamed clones and copy-paste-with-edits —
  the drift-prone ones. **Start here.**
- **Exact = quick wins**, but check intent first. Two trivial pass-throughs
  colliding (`return [...this.x.values()]`) aren't always worth a shared home.
- **Names = mostly noise.** Idiomatic repeats (`update`, `close`, `get`, logger
  levels). Skim, don't mine — add `--no-names` once you've glanced.

### 3. The "real dupe?" test

The rule that separates worth-fixing from leave-it:

- **Same *rule* encoded twice → collapse it.** Validation, response unwrapping,
  a path-containment check, a magic constant, a normalization step. These are
  the drift hazards: one copy gets a fix, the other doesn't, and a phantom bug
  surfaces weeks later.
- **Same *shape* by coincidence → leave it.** Logger `debug/info/warn/error`,
  SSE `emit*` helpers, store thunks, thin HTTP wrappers. Merging hurts
  readability for zero safety gain.

Propose a verdict per group; let the operator confirm. Dedup needs the
shape-vs-rule judgment — never auto-merge.

### 4. Mitigate: delete the home, don't fix the copies

The principle agents get wrong: **don't "find and fix both copies"** — you'll
miss the third one next time. Remove the second home so there's nothing left to
drift.

```
What's duplicated?
  ├─ Two classes, same except one method
  │   → abstract base class with one abstract seam (the part that differs)
  ├─ Two components with the same stateful logic
  │   → extract a hook / shared function
  ├─ A method defined but never called
  │   → delete it — verify dead first:  tl impact <file>  +  repo-wide call grep
  └─ A constant/type repeated
      → one exported definition, import everywhere
```

**Diff the copies before merging — the diff is often a latent bug.** When two
copies merge, their differences surface and force a decision. (Real case: two
response-unwrap helpers disagreed on whether an `{error}` field meant failure;
unifying them forced — and fixed — that decision.) Before collapsing:

```bash
tl snippet <fnA> <fileA>   # then diff against
tl snippet <fnB> <fileB>
```

### 5. Verify

```bash
tl parallel "test=tl run '<test-command>'" "guard=tl guard" "dupes=tl dupes --near"
```

The re-run of `tl dupes` confirms the group is gone (and didn't spawn a new one).

### 6. Ratchet — lock the win

This is the half that makes dedup *stick*. A **duplication ratchet** is a test
that counts the definition sites of a primitive that should have exactly one
home, and **fails CI if the count exceeds a baseline** — a ceiling that can only
move *down*:

- New copy added → count exceeds baseline → **hard fail**, message points at the
  canonical home.
- You consolidate → count drops → test passes but **prints "lower the baseline"**,
  locking the win.
- Eventually `baseline === 1` and the primitive is permanently single-homed.

The scan finds *today's* dupes; the ratchet stops *tomorrow's*. It turns "we
thought we fixed this already" from a recurring debug session into a test
failure at PR time.

**If a ratchet already exists:** after consolidating, lower its baselines for
anything you merged.

**If absent, offer to scaffold one.** Keep it tiny and language-agnostic —
**match definition sites, never call sites.** Node example:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Down-only ceiling. Lower each number as you consolidate; never raise it.
const BASELINES = {
  'unwrapResponse': 1,   // canonical: src/transport/unwrap.js
  'assertInRoot':   1,   // canonical: src/fs/path-guard.js
};

for (const [name, max] of Object.entries(BASELINES)) {
  test(`duplication ratchet: ${name} ≤ ${max} definition(s)`, () => {
    // Definition sites only — `function name`, `const name =`, `name(` as a method.
    const out = execFileSync('rg', [
      '-c', '--no-filename',
      `(function\\s+${name}\\b|\\b${name}\\s*[=(:])`,
      'src',
    ], { encoding: 'utf8' });
    const count = out.split('\n').filter(Boolean)
      .reduce((n, line) => n + Number(line), 0);
    assert.ok(count <= max,
      `${name} defined ${count}× (baseline ${max}). Reuse the canonical home or lower the baseline if you intentionally consolidated.`);
  });
}
```

Tune the regex to the language; the philosophy is constant: **a ceiling that
only ratchets down.**

## Tips

- Sequence it: structural/near first (real wins), exact second (quick), names
  last (skim). Don't burn the operator's attention on the names tier.
- Make incremental commits per consolidated group — if a merge breaks tests you
  can bisect, and each ratchet-baseline drop is its own clean diff.
- After collapsing, `tl unused` catches the now-dead exports you forgot to remove.
- Per-project only. Don't try to dedup across repos.
