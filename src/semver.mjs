/**
 * semver.mjs — minimal SemVer parsing/comparison for tag selection.
 *
 * tl-gh's `release notes` operates on a REMOTE repo via the GitHub tags API, so
 * it can't lean on git's `--sort=version:refname` (that needs a local clone).
 * The tags API is NOT semver-ordered, so picking `tags[0]` as the previous tag
 * silently chose the wrong base — e.g. ranking 0.9.0 above 0.10.0 lexically and
 * producing a wrong "changes since X" range (edimuj/tokenlean#31). These helpers
 * give a correct ordering without a clone.
 */

// Parse a tag into a semver tuple. Tolerates a leading v/V and an optional
// -prerelease / +build. Returns null for non-semver tags so callers can exclude
// them from ordering rather than mis-sort them lexically.
export function parseSemver(tag) {
  const m = String(tag).trim().match(
    /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] || null };
}

// Compare two parsed semvers by precedence (SemVer §11). Returns -1 | 0 | 1.
// A release outranks its prerelease (1.2.0 > 1.2.0-rc.1). Prerelease identifiers
// compare field-by-field: numeric vs numeric numerically, numeric < alpha, alpha
// lexically; a shorter identifier set has lower precedence when all else matches.
export function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;   // release > prerelease
  if (!b.prerelease) return -1;
  const pa = a.prerelease.split('.');
  const pb = b.prerelease.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1; // fewer fields → lower precedence
    if (pb[i] === undefined) return 1;
    if (pa[i] === pb[i]) continue;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) return +pa[i] < +pb[i] ? -1 : 1;
    if (na) return -1;             // numeric identifiers rank below alphanumeric
    if (nb) return 1;
    return pa[i] < pb[i] ? -1 : 1; // lexical ASCII
  }
  return 0;
}

// Pick the previous release tag: the highest existing tag strictly less than
// `newTag` by semver precedence. `newTag` itself (a re-run after the tag exists)
// and anything newer are skipped. Falls back to the input order (first entry that
// isn't `newTag`) only when `newTag` or the whole list is non-semver — never a
// silent lexical comparison. Returns undefined for an empty list.
export function pickPreviousTag(tagList, newTag) {
  const list = (tagList || []).filter(Boolean);
  if (!list.length) return undefined;

  const target = parseSemver(newTag);
  if (target) {
    // Authoritative semver path: the highest tag strictly below the new tag, or
    // undefined if none is below it. We must NOT fall back to order here — that
    // would return a NEWER tag as "previous" and yield a backwards compare range.
    let best = null;
    let bestTag;
    for (const t of list) {
      const parsed = parseSemver(t);
      if (!parsed) continue;
      if (compareSemver(parsed, target) >= 0) continue; // skip self + newer
      if (!best || compareSemver(parsed, best) > 0) {
        best = parsed;
        bestTag = t;
      }
    }
    return bestTag;
  }

  // Non-semver new tag: best-effort original order, excluding an exact match.
  return list.find(t => t !== newTag);
}
