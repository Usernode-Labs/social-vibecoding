'use strict';

// #1688: the Friday card (src/services/weekly-digest.js).
//
//   1. nothing happens outside Friday's posting hours;
//   2. on Friday a due app with something to say gets ONE card in its chat,
//      carrying the data as metadata, and its active members a notification;
//   3. a quiet app — nothing merged, nothing open — gets no card at all;
//   4. the claim is the stamp: an app another instance stamped first is
//      left alone;
//   5. the plain-text line reads as a sentence, names people, and counts
//      what the card does not list.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const sent = [];
stubModule('../src/services/ws', {
  sendSystemMessage: async (pool, appId, content, msgType, metadata, thread) => {
    sent.push({ appId, content, msgType, metadata, thread });
    return { id: 900 + sent.length, createdAt: new Date().toISOString() };
  },
});
stubModule('../src/services/active-users', {
  listActiveUserIds: async () => [1, 2, 3],
});
stubModule('../src/services/notification-preferences', {
  filterUsersByCategory: async (pool, { userIds, categoryKey }) => {
    assert.equal(categoryKey, 'weekly_digest');
    return userIds.filter((id) => id !== 2); // 2 muted the category
  },
});
const pushed = [];
stubModule('../src/services/notifications', {
  hydrateAndPush: async (pool, row) => { pushed.push(row); },
});

const digest = require('../src/services/weekly-digest');

const FRIDAY_16_UTC = new Date('2026-09-18T16:00:00.000Z'); // a Friday
const THURSDAY = new Date('2026-09-17T16:00:00.000Z');
const FRIDAY_EARLY = new Date('2026-09-18T09:00:00.000Z');

function makePool({ apps = [], merged = {}, open = {}, claimable = true } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/pg_try_advisory_lock/.test(s)) return { rows: [{ acquired: true }] };
    if (/pg_advisory_unlock/.test(s)) return { rows: [] };
    if (/FROM apps\s+WHERE weekly_digest_at IS NULL/.test(s)) return { rows: apps };
    if (/cs\.status = 'merged'/.test(s)) return { rows: merged[params[0]] || [] };
    if (/cs\.status = 'promoted'/.test(s)) return { rows: open[params[0]] || [] };
    if (/UPDATE apps\s+SET weekly_digest_at/.test(s)) return { rows: claimable ? [{ id: params[0] }] : [] };
    if (/INSERT INTO notifications/.test(s)) {
      return { rows: [{ id: 1000 + queries.length, user_id: params[0], app_id: params[1], kind: 'weekly_digest', detail: params[2] }] };
    }
    return { rows: [] };
  };
  return {
    queries,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

const tiers = { id: 3, slug: 'tiers', name: 'Community Tier Lists' };
const landed = [
  { id: 41, pr_number: 41, pr_title: 'Custom tier colors', merged_at: '2026-09-16T10:00:00Z', author: 'evan', backers: ['alice', 'bob'] },
  { id: 42, pr_number: 42, pr_title: 'Mobile drag fix', merged_at: '2026-09-15T10:00:00Z', author: 'carol', backers: [] },
];
const waiting = [
  { id: 44, pr_number: 44, pr_title: 'Dark mode toggle', author: 'dave' },
];

test('nothing happens outside Friday from the posting hour', async () => {
  assert.equal(digest.isPostingTime(THURSDAY), false);
  assert.equal(digest.isPostingTime(FRIDAY_EARLY), false);
  assert.equal(digest.isPostingTime(FRIDAY_16_UTC), true);
  const pool = makePool({ apps: [tiers], merged: { 3: landed } });
  const r = await digest.sweep(pool, THURSDAY);
  assert.equal(r.skipped, true);
  assert.equal(pool.queries.length, 0, 'not even the lock is taken');
});

test('on Friday a due app gets one card with its data, and its active members a notification', async () => {
  sent.length = 0;
  pushed.length = 0;
  const pool = makePool({ apps: [tiers], merged: { 3: landed }, open: { 3: waiting } });
  const r = await digest.sweep(pool, FRIDAY_16_UTC);
  assert.equal(r.due, 1);
  assert.equal(r.posted, 1);
  assert.equal(r.quiet, 0);

  assert.equal(sent.length, 1, 'one message');
  const card = sent[0];
  assert.equal(card.appId, 3);
  assert.equal(card.msgType, 'system');
  assert.equal(card.thread, null, 'general chat, not a thread');
  assert.equal(card.metadata.weekly.app, 'Community Tier Lists');
  assert.equal(card.metadata.weekly.slug, 'tiers');
  assert.equal(card.metadata.weekly.mergedTotal, 2);
  assert.equal(card.metadata.weekly.openTotal, 1);
  assert.deepEqual(card.metadata.weekly.merged[0], {
    id: 41, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: ['alice', 'bob'],
  });
  assert.equal(card.metadata.weekly.open[0].title, 'Dark mode toggle');
  assert.equal(card.metadata.weekly.open[0].backers, undefined, 'an open proposal has no backers yet');

  const claim = pool.queries.find((q) => /UPDATE apps\s+SET weekly_digest_at/.test(q.sql));
  assert.ok(claim, 'the stamp is the claim');
  assert.equal(claim.params[0], 3);
  assert.match(claim.sql, /weekly_digest_at IS NULL OR weekly_digest_at </, 'guarded on the last card being old');

  const inserts = pool.queries.filter((q) => /INSERT INTO notifications/.test(q.sql));
  assert.deepEqual(inserts.map((q) => q.params[0]), [1, 3], 'active members, minus the one who muted the category');
  assert.equal(inserts[0].params[2], '2:1', 'detail carries merged:open');
  assert.match(inserts[0].sql, /kind = 'weekly_digest'[\s\S]*created_at >/, 'never twice in a week');
  assert.equal(r.notified, 2);
  assert.equal(pushed.length, 2, 'every row is pushed live');
});

test('a quiet app gets no card', async () => {
  sent.length = 0;
  const pool = makePool({ apps: [tiers] });
  const r = await digest.sweep(pool, FRIDAY_16_UTC);
  assert.equal(r.due, 1);
  assert.equal(r.quiet, 1);
  assert.equal(r.posted, 0);
  assert.equal(sent.length, 0);
  assert.ok(!pool.queries.some((q) => /UPDATE apps/.test(q.sql)), 'and is not stamped, so a later merge this week still earns one');
});

test('an app another instance stamped first is left alone', async () => {
  sent.length = 0;
  const pool = makePool({ apps: [tiers], merged: { 3: landed }, claimable: false });
  const r = await digest.sweep(pool, FRIDAY_16_UTC);
  assert.equal(r.posted, 0);
  assert.equal(sent.length, 0);
});

test('the plain line reads as a sentence and counts what it does not list', () => {
  const many = Array.from({ length: digest.MAX_LISTED + 3 }, (_, i) => ({
    id: i, prNumber: 100 + i, title: `Change ${i}`, author: 'evan', backers: [],
  }));
  const line = digest.contentLine({
    app: 'Community Tier Lists',
    merged: many.slice(0, digest.MAX_LISTED),
    mergedTotal: many.length,
    open: [{ id: 44, prNumber: 44, title: 'Dark mode toggle', author: 'dave' }],
    openTotal: 1,
  });
  assert.match(line, /^This week on Community Tier Lists: 11 changes went live: Change 0 \(evan\); /);
  assert.match(line, /; and 3 more\. One proposal is waiting for eyes: Dark mode toggle \(PR #44\)\.$/);

  const named = digest.contentLine({
    app: 'Tiers', merged: [{ id: 1, prNumber: 41, title: 'Custom tier colors', author: 'evan', backers: ['alice', 'bob'] }],
    mergedTotal: 1, open: [], openTotal: 0,
  });
  assert.equal(named, 'This week on Tiers: 1 change went live: Custom tier colors (evan, backed by alice and bob).');
});
