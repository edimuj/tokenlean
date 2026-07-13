import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { readTailFile, readTailStream } from './tail-reader.mjs';

describe('bounded tail readers', () => {
  it('reads only end blocks while returning the requested final lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tail-reader-'));
    const file = join(dir, 'large.log');
    try {
      const lines = Array.from({ length: 20_000 }, (_, i) => `line-${i}`);
      writeFileSync(file, `${lines.join('\n')}\n`);
      const result = readTailFile(file, 5, { blockBytes: 128 });

      assert.ok(result.bytesRead < result.totalBytes / 10);
      assert.deepStrictEqual(result.text.trim().split('\n').slice(-5), lines.slice(-5));
      assert.strictEqual(result.inputTruncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exact tails with one-byte blocks for terminated and unterminated files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tail-reader-'));
    const file = join(dir, 'edge.log');
    try {
      for (const content of ['one\ntwo\nthree\n', 'one\ntwo\nthree']) {
        writeFileSync(file, content);
        const result = readTailFile(file, 2, { blockBytes: 1 });
        const lines = result.text.split('\n').filter(Boolean).slice(-2);
        assert.deepStrictEqual(lines, ['two', 'three'], JSON.stringify(content));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors a byte ceiling for a huge unterminated line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-tail-reader-'));
    const file = join(dir, 'huge.log');
    try {
      writeFileSync(file, 'x'.repeat(10_000));
      const result = readTailFile(file, 600, { maxBytes: 1024, blockBytes: 128 });
      assert.strictEqual(result.bytesRead, 1024);
      assert.strictEqual(result.text.length, 1024);
      assert.strictEqual(result.inputTruncated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains only final lines from stdin-like streams', async () => {
    const stream = Readable.from(['one\ntwo\n', 'three\nfour\n']);
    assert.deepStrictEqual(await readTailStream(stream, 2), ['three', 'four']);
  });
});
