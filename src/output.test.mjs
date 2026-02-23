import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, formatTokens, parseCommonArgs, Output, formatTable } from './output.mjs';

// ─────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns ceil(length / 4)', () => {
    assert.strictEqual(estimateTokens('abcde'), 2); // 5/4 = 1.25 => 2
  });

  it('returns 0 for empty string', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('returns 0 for non-string input', () => {
    assert.strictEqual(estimateTokens(42), 0);
    assert.strictEqual(estimateTokens(null), 0);
    assert.strictEqual(estimateTokens(undefined), 0);
  });

  it('handles exact multiple of 4', () => {
    assert.strictEqual(estimateTokens('abcd'), 1);
  });
});

// ─────────────────────────────────────────────────────────────
// formatTokens
// ─────────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('formats millions', () => {
    assert.strictEqual(formatTokens(1500000), '1.5M');
  });

  it('formats at exactly 1M', () => {
    assert.strictEqual(formatTokens(1000000), '1.0M');
  });

  it('formats thousands', () => {
    assert.strictEqual(formatTokens(2500), '2.5k');
  });

  it('formats at exactly 1000', () => {
    assert.strictEqual(formatTokens(1000), '1.0k');
  });

  it('returns plain number below 1000', () => {
    assert.strictEqual(formatTokens(999), '999');
  });

  it('returns 0 as string', () => {
    assert.strictEqual(formatTokens(0), '0');
  });
});

// ─────────────────────────────────────────────────────────────
// parseCommonArgs
// ─────────────────────────────────────────────────────────────

describe('parseCommonArgs', () => {
  it('parses -l with value', () => {
    const opts = parseCommonArgs(['-l', '50']);
    assert.strictEqual(opts.maxLines, 50);
  });

  it('parses --max-lines with value', () => {
    const opts = parseCommonArgs(['--max-lines', '100']);
    assert.strictEqual(opts.maxLines, 100);
  });

  it('parses -t with value', () => {
    const opts = parseCommonArgs(['-t', '500']);
    assert.strictEqual(opts.maxTokens, 500);
  });

  it('parses boolean flags -j -q -h', () => {
    const opts = parseCommonArgs(['-j', '-q', '-h']);
    assert.strictEqual(opts.json, true);
    assert.strictEqual(opts.quiet, true);
    assert.strictEqual(opts.help, true);
  });

  it('collects remaining args', () => {
    const opts = parseCommonArgs(['file.js', '-q', 'other']);
    assert.deepStrictEqual(opts.remaining, ['file.js', 'other']);
    assert.strictEqual(opts.quiet, true);
  });

  it('returns defaults when no args', () => {
    const opts = parseCommonArgs([]);
    assert.strictEqual(opts.maxLines, Infinity);
    assert.strictEqual(opts.maxTokens, Infinity);
    assert.strictEqual(opts.json, false);
    assert.strictEqual(opts.quiet, false);
    assert.strictEqual(opts.help, false);
    assert.deepStrictEqual(opts.remaining, []);
  });

  it('-l 0 becomes Infinity (parseInt quirk)', () => {
    const opts = parseCommonArgs(['-l', '0']);
    assert.strictEqual(opts.maxLines, Infinity);
  });
});

// ─────────────────────────────────────────────────────────────
// Output class
// ─────────────────────────────────────────────────────────────

describe('Output', () => {
  it('add() collects lines', () => {
    const out = new Output();
    out.add('line 1');
    out.add('line 2');
    assert.ok(out.render().includes('line 1'));
    assert.ok(out.render().includes('line 2'));
  });

  it('truncates at maxLines', () => {
    const out = new Output({ maxLines: 2 });
    out.add('a');
    out.add('b');
    out.add('c');
    assert.ok(out.truncated);
    assert.ok(out.render().includes('truncated'));
    assert.ok(!out.render().includes('\nc'));
  });

  it('truncates at maxTokens', () => {
    const out = new Output({ maxTokens: 5 });
    out.add('a'.repeat(20)); // 5 tokens
    out.add('b'.repeat(20)); // would push over
    assert.ok(out.truncated);
  });

  it('header skipped in quiet mode', () => {
    const out = new Output({ quiet: true });
    out.header('HEADER');
    out.add('content');
    const result = out.render();
    assert.ok(!result.includes('HEADER'));
    assert.ok(result.includes('content'));
  });

  it('blank skipped in quiet mode', () => {
    const out = new Output({ quiet: true });
    out.add('a');
    out.blank();
    out.add('b');
    // In quiet mode, blank lines aren't added, so lines are joined directly
    assert.strictEqual(out.lines.length, 2);
  });

  it('stats skipped in quiet mode', () => {
    const out = new Output({ quiet: true });
    out.add('content');
    out.stats('3 files');
    assert.ok(!out.render().includes('3 files'));
  });

  it('stats skipped when truncated', () => {
    const out = new Output({ maxLines: 1 });
    out.add('a');
    out.add('b');
    out.stats('summary');
    assert.ok(!out.render().includes('summary'));
  });

  it('render joins lines', () => {
    const out = new Output();
    out.add('a');
    out.add('b');
    assert.strictEqual(out.render(), 'a\nb');
  });

  it('render shows truncation notice with remaining count', () => {
    const out = new Output({ maxLines: 1 });
    out.add('a');
    out.add('b');
    out.add('c');
    const result = out.render();
    assert.ok(result.includes('truncated'));
    assert.ok(result.includes('2 more lines'));
  });

  it('JSON mode returns data with metadata', () => {
    const out = new Output({ json: true });
    out.setData('files', ['a.js']);
    out.add('line');
    const result = JSON.parse(out.render());
    assert.deepStrictEqual(result.files, ['a.js']);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.totalItems, 1);
  });

  it('section adds title and formatted items', () => {
    const out = new Output();
    out.section('Functions:', ['foo', 'bar'], name => `  ${name}()`);
    const result = out.render();
    assert.ok(result.includes('Functions:'));
    assert.ok(result.includes('  foo()'));
    assert.ok(result.includes('  bar()'));
  });
});

// ─────────────────────────────────────────────────────────────
// formatTable
// ─────────────────────────────────────────────────────────────

describe('formatTable', () => {
  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(formatTable([]), []);
  });

  it('pads columns to max width', () => {
    const rows = [['ab', 'x'], ['a', 'xy']];
    const result = formatTable(rows);
    // 'ab' is max 2 for col0, 'xy' is max 2 for col1
    assert.strictEqual(result[0], 'ab  x ');
    assert.strictEqual(result[1], 'a   xy');
  });

  it('right-aligns numbers', () => {
    const rows = [[5, 'foo'], [100, 'bar']];
    const result = formatTable(rows);
    assert.ok(result[0].startsWith('  5'));
    assert.ok(result[1].startsWith('100'));
  });

  it('right-aligns formatted number strings (e.g. 1.5k)', () => {
    const rows = [['1.5k', 'desc'], ['200', 'other']];
    const result = formatTable(rows);
    // '1.5k' is 4 chars, '200' is 3 chars — '200' gets padded to ' 200'
    assert.ok(result[1].includes(' 200'));
  });

  it('applies indent option', () => {
    const rows = [['a', 'b']];
    const result = formatTable(rows, { indent: '>> ' });
    assert.ok(result[0].startsWith('>> '));
  });

  it('applies separator option', () => {
    const rows = [['a', 'b']];
    const result = formatTable(rows, { separator: ' | ' });
    assert.ok(result[0].includes(' | '));
  });
});
