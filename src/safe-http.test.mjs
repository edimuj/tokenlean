import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  fetchPublicText,
  isPublicIp,
  requestPinned,
  resolvePublicTarget,
  SafeHttpError
} from './safe-http.mjs';

describe('safe HTTP policy', () => {
  it('allows public IPv4 and IPv6 addresses', () => {
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('1.1.1.1'), true);
    assert.equal(isPublicIp('2606:4700:4700::1111'), true);
  });

  it('blocks private, local, transition, and reserved address forms', () => {
    for (const address of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.169.254',
      '172.31.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '2002:7f00:1::'
    ]) {
      assert.equal(isPublicIp(address), false, address);
    }
  });

  it('rejects a hostname when any DNS answer is non-public', async () => {
    await assert.rejects(
      resolvePublicTarget('https://example.test', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 }
        ]
      }),
      error => error instanceof SafeHttpError && error.code === 'PRIVATE_ADDRESS'
    );
  });

  it('pins a validated address and validates every redirect hop', async () => {
    const resolved = [];
    const requested = [];
    const resolveTarget = async url => {
      resolved.push(url.toString());
      if (url.hostname === 'private.test') {
        throw new SafeHttpError('PRIVATE_ADDRESS', 'blocked redirect');
      }
      return {
        url,
        hostname: url.hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }],
        pinned: { address: '93.184.216.34', family: 4 }
      };
    };
    const request = async target => {
      requested.push(target.pinned.address);
      return {
        status: 302,
        statusText: 'Found',
        headers: { location: 'http://private.test/metadata' },
        body: ''
      };
    };

    await assert.rejects(
      fetchPublicText('https://public.test/start', { resolveTarget, request }),
      error => error.code === 'PRIVATE_ADDRESS'
    );
    assert.deepEqual(resolved, [
      'https://public.test/start',
      'http://private.test/metadata'
    ]);
    assert.deepEqual(requested, ['93.184.216.34']);
  });

  it('passes the pinned address into each successful hop', async () => {
    const pins = [];
    const resolveTarget = async url => ({
      url,
      hostname: url.hostname,
      addresses: [{ address: url.hostname === 'a.test' ? '1.1.1.1' : '8.8.8.8', family: 4 }],
      pinned: { address: url.hostname === 'a.test' ? '1.1.1.1' : '8.8.8.8', family: 4 }
    });
    const request = async target => {
      pins.push(target.pinned.address);
      if (target.url.hostname === 'a.test') {
        return { status: 301, statusText: 'Moved', headers: { location: 'https://b.test/final' }, body: '' };
      }
      return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'ok' };
    };

    const result = await fetchPublicText('https://a.test', { resolveTarget, request });
    assert.equal(result.body, 'ok');
    assert.equal(result.redirects, 1);
    assert.deepEqual(pins, ['1.1.1.1', '8.8.8.8']);
  });

  it('keeps the request deadline active while the body is streaming', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('headers arrived');
      setTimeout(() => response.end('too late'), 100);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address();
      const target = {
        url: new URL(`http://127.0.0.1:${port}/slow`),
        pinned: { address: '127.0.0.1', family: 4 }
      };
      await assert.rejects(
        requestPinned(target, { deadline: Date.now() + 30 }),
        error => error instanceof SafeHttpError && error.code === 'TIMEOUT'
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('stops a chunked decoded body at the aggregate byte ceiling', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('x'.repeat(800));
      response.end('y'.repeat(800));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address();
      const target = {
        url: new URL(`http://127.0.0.1:${port}/large`),
        pinned: { address: '127.0.0.1', family: 4 }
      };
      await assert.rejects(
        requestPinned(target, { deadline: Date.now() + 1000, maxBodyBytes: 1000 }),
        error => error instanceof SafeHttpError && error.code === 'BODY_TOO_LARGE'
      );
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
