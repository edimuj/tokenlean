import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, formatElapsed, shellQuote, parseJson, countBraces } from './text-util.mjs';

test('stripAnsi removes CSI, OSC and single-char escapes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b]0;title\x07text'), 'text');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('formatElapsed scales ms → s → m', () => {
  assert.equal(formatElapsed(500), '500ms');
  assert.equal(formatElapsed(1500), '1.5s');
  assert.equal(formatElapsed(65000), '1m5s');
});

test('shellQuote passes safe tokens, quotes the rest', () => {
  assert.equal(shellQuote('--flag=value'), '--flag=value');
  assert.equal(shellQuote('has space'), '"has space"');
  assert.equal(shellQuote(''), '""');
});

test('parseJson returns parsed value or null', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson('not json'), null);
});

test('countBraces ignores braces in strings and comments', () => {
  assert.deepEqual(countBraces('function f() {'), { open: 1, close: 0 });
  assert.deepEqual(countBraces('}'), { open: 0, close: 1 });
  assert.deepEqual(countBraces('const s = "{ not a brace }";'), { open: 0, close: 0 });
  assert.deepEqual(countBraces('x } // } trailing'), { open: 0, close: 1 });
});
