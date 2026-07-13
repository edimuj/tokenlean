import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_TAIL_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_BLOCK_BYTES = 64 * 1024;
const MAX_PENDING_LINE_CHARS = 256 * 1024;

function countLineBreaksBackward(buffer, state) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const byte = buffer[i];
    if (byte === 0x0a || (byte === 0x0d && state.rightByte !== 0x0a)) {
      state.breaks++;
    }
    state.rightByte = byte;
  }
}

/**
 * Read only enough blocks from the end of a file to recover its final lines.
 * A byte ceiling also prevents one enormous unterminated line from forcing a
 * whole-file allocation.
 */
export function readTailFile(filePath, lineCount, {
  maxBytes = DEFAULT_TAIL_READ_BYTES,
  blockBytes = DEFAULT_BLOCK_BYTES
} = {}) {
  const size = statSync(filePath).size;
  if (size === 0) {
    return { text: '', bytesRead: 0, totalBytes: 0, inputTruncated: false };
  }

  const wantedLines = Math.max(1, Math.floor(lineCount));
  const byteLimit = Math.max(1, Math.floor(maxBytes));
  const chunkSize = Math.max(1, Math.floor(blockBytes));
  const chunks = [];
  const newlineState = { breaks: 0, rightByte: null };
  let position = size;
  let bytesRead = 0;

  const fd = openSync(filePath, 'r');
  try {
    // One extra boundary ensures the decoded window starts before the first
    // requested line when the file itself ends in a newline.
    while (position > 0 && bytesRead < byteLimit && newlineState.breaks < wantedLines + 1) {
      const length = Math.min(chunkSize, position, byteLimit - bytesRead);
      const start = position - length;
      const buffer = Buffer.allocUnsafe(length);
      const actual = readSync(fd, buffer, 0, length, start);
      if (actual === 0) break;
      const chunk = actual === length ? buffer : buffer.subarray(0, actual);
      chunks.unshift(chunk);
      countLineBreaksBackward(chunk, newlineState);
      bytesRead += actual;
      position = start;
    }
  } finally {
    closeSync(fd);
  }

  return {
    text: Buffer.concat(chunks, bytesRead).toString('utf8'),
    bytesRead,
    totalBytes: size,
    // If enough line boundaries were found, omitted bytes are deliberately
    // outside the requested tail. Otherwise the byte ceiling cut a huge line.
    inputTruncated: position > 0 && newlineState.breaks < wantedLines + 1
  };
}

/** Process a growing file range in fixed-size decoded chunks. */
export function readFileRangeChunks(filePath, start, end, onChunk, {
  blockBytes = DEFAULT_BLOCK_BYTES
} = {}) {
  if (end <= start) return;
  const fd = openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const chunkSize = Math.max(1, Math.floor(blockBytes));
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, end - start));
  let position = start;
  try {
    while (position < end) {
      const wanted = Math.min(buffer.length, end - position);
      const actual = readSync(fd, buffer, 0, wanted, position);
      if (actual === 0) break;
      const text = decoder.write(buffer.subarray(0, actual));
      if (text) onChunk(text);
      position += actual;
    }
    const final = decoder.end();
    if (final) onChunk(final);
  } finally {
    closeSync(fd);
  }
}

function keepLast(items, count) {
  if (items.length > count * 2) items.splice(0, items.length - count);
}

/** Retain only the final lines of a stream instead of buffering all stdin. */
export async function readTailStream(stream, lineCount) {
  const wantedLines = Math.max(1, Math.floor(lineCount));
  const decoder = new StringDecoder('utf8');
  const lines = [];
  let pending = '';

  for await (const chunk of stream) {
    pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const parts = pending.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    pending = parts.pop() || '';
    for (const line of parts) lines.push(line);
    keepLast(lines, wantedLines);

    if (pending.length > MAX_PENDING_LINE_CHARS) {
      pending = `${pending.slice(0, MAX_PENDING_LINE_CHARS)}... [line truncated]`;
    }
  }

  pending += decoder.end();
  if (pending) lines.push(pending);
  return lines.slice(-wantedLines);
}
