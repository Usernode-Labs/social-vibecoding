'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const routes = require('../src/routes/visual-evidence');

test('artifact range parsing supports full, open, and suffix ranges and fails closed', () => {
  assert.equal(routes.parseRange(undefined, 100), null);
  assert.deepEqual(routes.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(routes.parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  for (const value of ['items=0-1', 'bytes=', 'bytes=20-10', 'bytes=100-', 'bytes=1-2,4-5']) {
    assert.equal(routes.parseRange(value, 100), false, value);
  }
});

test('artifact ids and proposal ids are canonical and traversal-proof', () => {
  assert.equal(routes.sessionId('42'), 42);
  assert.equal(routes.sessionId('0'), null);
  assert.equal(routes.sessionId('../42'), null);
  assert.equal(routes.sessionId(String(2 ** 40)), null);
});

test('the binary route is authenticated, current-run fenced, exact-head fenced, and private', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/visual-evidence.js'), 'utf8');
  assert.match(src, /loadContext\(pool, req\.params\.slug, id, req\.user, 'view'\)/);
  assert.match(src, /!config\.visualEvidence\?\.present/);
  assert.match(src, /s\.visual_evidence_run_id = r\.id/);
  assert.match(src, /s\.visual_evidence_state = 'verified' AND r\.state = 'verified'/);
  assert.match(src, /r\.head_sha = COALESCE/);
  assert.match(src, /Cache-Control': 'private, max-age=31536000, immutable'/);
  assert.match(src, /Vary: 'Cookie, Authorization'/);
  assert.match(src, /res\.status\(206\)/);
  assert.match(src, /res\.status\(416\)/);
  assert.doesNotMatch(src, /\/visuals\//, 'evidence never uses the public legacy media route');
});
