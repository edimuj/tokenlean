import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemver, compareSemver, pickPreviousTag } from './semver.mjs';

describe('semver', () => {
  it('parses plain, v-prefixed, prerelease, and build-metadata tags', () => {
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
    assert.deepEqual(parseSemver('v0.50.1'), { major: 0, minor: 50, patch: 1, prerelease: null });
    assert.deepEqual(parseSemver('1.2.0-rc.1'), { major: 1, minor: 2, patch: 0, prerelease: 'rc.1' });
    assert.deepEqual(parseSemver('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it('returns null for non-semver tags', () => {
    for (const t of ['latest', 'nightly', 'v1', '1.2', 'release-2024', '']) {
      assert.equal(parseSemver(t), null, `"${t}" should not parse`);
    }
  });

  it('orders by numeric precedence, not lexically (the #31 bug)', () => {
    // The whole point: 0.10.0 > 0.9.0 numerically, even though "0.10.0" < "0.9.0"
    // as strings.
    assert.equal(compareSemver(parseSemver('0.10.0'), parseSemver('0.9.0')), 1);
    assert.equal(compareSemver(parseSemver('0.9.0'), parseSemver('0.10.0')), -1);
    assert.equal(compareSemver(parseSemver('1.2.3'), parseSemver('1.2.3')), 0);
  });

  it('ranks a release above its prerelease, and orders prerelease identifiers', () => {
    assert.equal(compareSemver(parseSemver('1.2.0'), parseSemver('1.2.0-rc.1')), 1);
    assert.equal(compareSemver(parseSemver('1.2.0-rc.1'), parseSemver('1.2.0-rc.2')), -1);
    assert.equal(compareSemver(parseSemver('1.2.0-alpha'), parseSemver('1.2.0-beta')), -1);
    // numeric identifiers rank below alphanumeric
    assert.equal(compareSemver(parseSemver('1.2.0-1'), parseSemver('1.2.0-alpha')), -1);
    // a shorter prerelease set has lower precedence
    assert.equal(compareSemver(parseSemver('1.2.0-rc'), parseSemver('1.2.0-rc.1')), -1);
  });

  describe('pickPreviousTag', () => {
    it('picks the highest tag strictly below the new tag regardless of API order', () => {
      // Deliberately scrambled order, mixed v-prefix — the #31 scenario.
      const tags = ['0.9.0', '0.10.0', 'v0.49.10', '0.50.0', '0.8.5'];
      assert.equal(pickPreviousTag(tags, '0.50.1'), '0.50.0');
      assert.equal(pickPreviousTag(tags, '0.10.0'), '0.9.0');
      assert.equal(pickPreviousTag(tags, '1.0.0'), '0.50.0');
    });

    it('excludes the new tag itself on a re-run (strictly less than)', () => {
      const tags = ['0.50.1', '0.50.0', '0.49.10'];
      assert.equal(pickPreviousTag(tags, '0.50.1'), '0.50.0');
    });

    it('ignores non-semver tags when a semver new tag is given', () => {
      const tags = ['latest', 'nightly', '0.49.10', '0.50.0'];
      assert.equal(pickPreviousTag(tags, '0.50.1'), '0.50.0');
    });

    it('treats a prerelease as the previous tag when it is the highest below', () => {
      const tags = ['1.2.0-rc.1', '1.1.0'];
      assert.equal(pickPreviousTag(tags, '1.2.0'), '1.2.0-rc.1');
    });

    it('falls back to input order for a non-semver new tag', () => {
      const tags = ['nightly-2', 'nightly-1'];
      assert.equal(pickPreviousTag(tags, 'nightly-3'), 'nightly-2');
    });

    it('returns undefined for an empty list', () => {
      assert.equal(pickPreviousTag([], '1.0.0'), undefined);
      assert.equal(pickPreviousTag(undefined, '1.0.0'), undefined);
    });

    it('returns undefined when no tag is below the new tag', () => {
      assert.equal(pickPreviousTag(['2.0.0', '3.0.0'], '1.0.0'), undefined);
    });
  });
});
