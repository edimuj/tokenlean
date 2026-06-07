import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHttpUrl,
  isLocalOrPrivateHost,
  isApiLikeUrl,
  hasApiCurlOptions,
} from './url-policy.mjs';

test('extractHttpUrl pulls the first http(s) URL', () => {
  assert.equal(extractHttpUrl('curl https://example.com/page'), 'https://example.com/page');
  assert.equal(extractHttpUrl('echo hello'), null);
});

test('isLocalOrPrivateHost flags loopback and RFC1918 ranges', () => {
  assert.equal(isLocalOrPrivateHost('localhost'), true);
  assert.equal(isLocalOrPrivateHost('127.0.0.1'), true);
  assert.equal(isLocalOrPrivateHost('192.168.1.5'), true);
  assert.equal(isLocalOrPrivateHost('172.16.0.1'), true);
  assert.equal(isLocalOrPrivateHost('example.com'), false);
});

test('isApiLikeUrl detects api hosts, api/graphql paths and local hosts', () => {
  assert.equal(isApiLikeUrl('https://api.github.com/repos'), true);
  assert.equal(isApiLikeUrl('https://example.com/api/v1'), true);
  assert.equal(isApiLikeUrl('https://example.com/graphql'), true);
  assert.equal(isApiLikeUrl('http://localhost:3000/'), true);
  assert.equal(isApiLikeUrl('https://example.com/docs'), false);
  assert.equal(isApiLikeUrl('not a url'), true); // unparseable → treat as API (don't suggest browse)
});

test('hasApiCurlOptions detects request-shaping flags', () => {
  assert.equal(hasApiCurlOptions('curl -X POST https://x'), true);
  assert.equal(hasApiCurlOptions('curl --header "A: b" https://x'), true);
  assert.equal(hasApiCurlOptions('curl https://x'), false);
});
