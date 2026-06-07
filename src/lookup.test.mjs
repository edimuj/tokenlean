import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { words, searchFunctions } from './lookup.mjs';

describe('words', () => {
  it('splits camelCase, snake_case, kebab and paths', () => {
    assert.deepEqual(words('getUserId'), ['get', 'user', 'id']);
    assert.deepEqual(words('parse_config_file'), ['parse', 'config', 'file']);
    assert.deepEqual(words('strip-ansi'), ['strip', 'ansi']);
    assert.deepEqual(words('HTTPRequest'), ['http', 'request']);
    assert.deepEqual(words(''), []);
  });
});

describe('searchFunctions', () => {
  const fns = [
    { name: 'getUserId', signature: 'function getUserId(session)', file: 'a.js', line: 1, body: 'return session.user.id;', lang: 'javascript' },
    { name: 'fetchId', signature: 'function fetchId(req)', file: 'b.js', line: 1, body: 'return req.id;', lang: 'javascript' },
    { name: 'formatElapsed', signature: 'function formatElapsed(ms)', file: 'c.js', line: 1, body: 'return ms + "ms";', lang: 'javascript' },
    { name: 'totallyUnrelated', signature: 'function totallyUnrelated()', file: 'd.js', line: 1, body: 'doStuff();', lang: 'javascript' },
  ];

  it('ranks an exact name match top', () => {
    const r = searchFunctions(fns, 'getUserId');
    assert.equal(r[0].name, 'getUserId');
    assert.ok(r[0].score >= 0.9);
  });

  it('matches by intent phrase via name words', () => {
    const r = searchFunctions(fns, 'get user id');
    assert.equal(r[0].name, 'getUserId');
  });

  it('finds partial matches and ranks them lower', () => {
    const r = searchFunctions(fns, 'get id');
    const names = r.map(m => m.name);
    assert.ok(names.includes('getUserId'));
    // fetchId shares "id" only
    const gid = r.find(m => m.name === 'getUserId');
    const fid = r.find(m => m.name === 'fetchId');
    if (fid) assert.ok(gid.score >= fid.score);
  });

  it('returns nothing for a novel query', () => {
    assert.equal(searchFunctions(fns, 'quantum teleporter widget').length, 0);
  });

  it('respects minScore and limit', () => {
    const loose = searchFunctions(fns, 'get id', { minScore: 0.3 }).length;
    const strict = searchFunctions(fns, 'get id', { minScore: 0.99 }).length;
    assert.ok(strict < loose, 'higher minScore filters partial matches');
    assert.ok(searchFunctions(fns, 'format', { limit: 1 }).length <= 1);
  });

  it('reports token cost and location', () => {
    const r = searchFunctions(fns, 'formatElapsed');
    assert.equal(r[0].file, 'c.js');
    assert.ok(r[0].tokens >= 1);
  });
});
