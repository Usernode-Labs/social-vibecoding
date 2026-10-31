'use strict';

// tests/session-fence-signals.test.js
//
// The three problems the session-fences observer reads from UI telemetry:
// a signed-out or public read the guard cut off, a build that cuts off far
// more signed-in reads than the one before it, and invite pages falling back
// to the pitch because the invite could not be read.
//
// Run with: node --test tests/session-fence-signals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { itemsFrom } = require('../src/services/signal-observers/session-fences');

const now = Date.parse('2026-10-30T12:00:00Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60 * 1000).toISOString();

function fenceRow({ visit = 'visit-1', minutesAgo = 1, signedIn = false, build = 'abcdef1',
  path = '/api/public/invites/:token', reason = 'epoch', count = 1, userId = null } = {}) {
  return {
    id: `${visit}-${minutesAgo}-${path}`,
    user_id: userId,
    created_at: at(minutesAgo),
    metadata: {
      kind: 'session_fence', visitId: visit, signedIn, build,
      fences: [{ path, reason, public: path.startsWith('/api/public/'), count }],
    },
  };
}

function loadRow({ build = 'abcdef1', minutesAgo = 1 } = {}) {
  return { id: `load-${build}-${minutesAgo}`, user_id: 1, created_at: at(minutesAgo),
    metadata: { kind: 'page_load', build, visitId: 'load-visit' } };
}

function settlementRow({ settled = 'card', minutesAgo = 1, visit = 'settle-1' } = {}) {
  return { id: `settle-${visit}-${settled}`, user_id: null, created_at: at(minutesAgo),
    metadata: { kind: 'invite_settlement', visitId: visit, settled, build: 'abcdef1' } };
}

test('a signed-out page fenced on two visits in an hour files, one visit does not', () => {
  const one = itemsFrom([fenceRow({ visit: 'v1' })], { now });
  assert.deepEqual(one, [], 'a single odd visit files nothing');

  const rows = [fenceRow({ visit: 'v1', count: 2 }), fenceRow({ visit: 'v2' })];
  const item = itemsFrom(rows, { now }).find((i) => i.kind === 'session_fence_public');
  assert.ok(item);
  assert.equal(item.key, '/api/public/invites/:token');
  assert.equal(item.topic, 'onboarding');
  assert.equal(item.fixer, 'bot');
  assert.match(item.evidence.lines.join('\n'), /2 visits in the last hour/);
  assert.match(item.evidence.lines.join('\n'), /3 reads/);
  assert.doesNotMatch(JSON.stringify(item), /visit-1|v1|v2/, 'no visit id is public');
});

test('a signed-in read under a private path never files the public problem', () => {
  const rows = [
    fenceRow({ visit: 'v1', signedIn: true, path: '/api/private' }),
    fenceRow({ visit: 'v2', signedIn: true, path: '/api/private' }),
  ];
  assert.equal(itemsFrom(rows, { now }).some((i) => i.kind === 'session_fence_public'), false);
});

test('a build fencing at least twice the previous rate files a release jump', () => {
  const rows = [];
  for (let i = 0; i < 200; i += 1) rows.push(loadRow({ build: 'aaaaaaa', minutesAgo: 60 + i / 10 }));
  rows.push(fenceRow({ visit: 'old', build: 'aaaaaaa', minutesAgo: 60, signedIn: true,
    path: '/api/private', userId: 1, count: 5 }));
  for (let i = 0; i < 200; i += 1) rows.push(loadRow({ build: 'bbbbbbb', minutesAgo: 10 + i / 100 }));
  rows.push(fenceRow({ visit: 'new', build: 'bbbbbbb', minutesAgo: 10, signedIn: true,
    path: '/api/private', userId: 1, count: 20 }));

  const item = itemsFrom(rows, { now }).find((i) => i.kind === 'session_fence_jump');
  assert.ok(item, '100 per 1,000 against 25 is a jump');
  assert.equal(item.key, 'bbbbbbb');
  assert.equal(item.topic, 'infra');
  assert.match(item.evidence.lines.join('\n'), /100\.0 per 1,000/);
  assert.match(item.evidence.lines.join('\n'), /25\.0 per 1,000/);
  assert.match(item.evidence.lines.join('\n'), /Release it started with: bbbbbbb/);
});

test('the release jump needs 10 reads, 200 loads on both builds, and a doubling', () => {
  const base = () => {
    const rows = [];
    for (let i = 0; i < 200; i += 1) rows.push(loadRow({ build: 'aaaaaaa', minutesAgo: 60 + i / 10 }));
    for (let i = 0; i < 200; i += 1) rows.push(loadRow({ build: 'bbbbbbb', minutesAgo: 10 + i / 100 }));
    return rows;
  };
  const jump = (count) => itemsFrom([...base(), fenceRow({ build: 'bbbbbbb', signedIn: true, path: '/api/private', userId: 1, count })], { now })
    .some((i) => i.kind === 'session_fence_jump');
  assert.equal(jump(9), false, 'nine reads is below the minimum');
  assert.equal(jump(11), true);

  const fewLoads = [fenceRow({ build: 'bbbbbbb', signedIn: true, path: '/api/private', userId: 1, count: 50 })];
  for (let i = 0; i < 199; i += 1) fewLoads.push(loadRow({ build: 'bbbbbbb', minutesAgo: 10 + i / 100 }));
  assert.equal(itemsFrom(fewLoads, { now }).some((i) => i.kind === 'session_fence_jump'), false,
    'a build with fewer than 200 page loads is not compared');
});

test('invite pages that fall back to the pitch file at 3 and 2% in a day', () => {
  const failed = (n, total) => {
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push(settlementRow({ settled: 'failed', visit: `f${i}` }));
    for (let i = 0; i < total - n; i += 1) rows.push(settlementRow({ settled: 'card', visit: `c${i}` }));
    return rows;
  };
  const item = itemsFrom(failed(3, 10), { now }).find((i) => i.kind === 'invite_pitch_failed');
  assert.ok(item, '3 of 10 is well over 2%');
  assert.equal(item.key, 'invite');
  assert.match(item.evidence.lines.join('\n'), /3 failed of 10 landings/);
  assert.equal(itemsFrom(failed(2, 10), { now }).some((i) => i.kind === 'invite_pitch_failed'), false);
  assert.equal(itemsFrom(failed(3, 200), { now }).some((i) => i.kind === 'invite_pitch_failed'), false,
    '3 of 200 is below 2%');
});

test('an invite failure names the fenced invite reads on the same visits', () => {
  const rows = [
    settlementRow({ settled: 'failed', visit: 'same', minutesAgo: 5 }),
    settlementRow({ settled: 'failed', visit: 'f2', minutesAgo: 6 }),
    settlementRow({ settled: 'failed', visit: 'f3', minutesAgo: 7 }),
    settlementRow({ settled: 'card', visit: 'c1', minutesAgo: 8 }),
    fenceRow({ visit: 'same', path: '/api/public/invites/:token', reason: 'epoch' }),
  ];
  const item = itemsFrom(rows, { now }).find((i) => i.kind === 'invite_pitch_failed');
  assert.ok(item);
  assert.match(item.evidence.lines.join('\n'), /Fenced invite reads on those visits: \/api\/public\/invites\/:token/);
});
