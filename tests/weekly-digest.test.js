'use strict';

// #1688: the Friday card (src/services/weekly-digest.js).
//
//   1. nothing happens outside Friday's posting hours;
//   2. on Friday a due app with something to say gets ONE card, recorded as
//      a `weekly_digest` event carrying the data (a project's Workshop shows
//      it; a channel carries no activity), and its active members a
//      notification;
//   3. a quiet app — nothing merged, nothing open — gets no card at all;
//   4. the claim is the stamp: an app another instance stamped first is
//      left alone;
//   5. the plain-text line reads as a sentence, lists the three newest
//      changes and the three longest-waiting proposals, counts the rest,
//      and names nobody (#3678) — not even from a card stored while it
//      still carried each change's author and backers.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

// Still stubbed, so a stray chat line would be seen: the card writes none.
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
  { id: 41, pr_number: 41, pr_title: 'Custom tier colors', merged_at: '2026-09-16T10:00:00Z' },
  { id: 42, pr_number: 42, pr_title: 'Mobile drag fix', merged_at: '2026-09-15T10:00:00Z' },
];
const waiting = [
  { id: 44, pr_number: 44, pr_title: 'Dark mode toggle' },
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

  assert.equal(sent.length, 0, 'no chat line: a channel carries no activity');
  const cards = pool.queries.filter((q) => /INSERT INTO events/.test(q.sql));
  assert.equal(cards.length, 1, 'one card');
  const [userId, appId, sessionId, type, json] = cards[0].params;
  assert.deepEqual([userId, appId, sessionId, type], [null, 3, null, 'weekly_digest']);
  const weekly = JSON.parse(json);
  assert.equal(weekly.app, 'Community Tier Lists');
  assert.equal(weekly.slug, 'tiers');
  assert.equal(weekly.mergedTotal, 2);
  assert.equal(weekly.openTotal, 1);
  assert.deepEqual(weekly.merged, [
    { id: 41, prNumber: 41, title: 'Custom tier colors' },
    { id: 42, prNumber: 42, title: 'Mobile drag fix' },
  ], 'newest first, and nobody named: no author, no backers (#3678)');
  assert.deepEqual(weekly.open, [{ id: 44, prNumber: 44, title: 'Dark mode toggle' }]);

  // #3678: the card names nobody, so neither read fetches a name: no join to
  // users for the author, and no walk of the votes for the backers.
  const reads = pool.queries.filter((q) => /cs\.status = '(merged|promoted)'/.test(q.sql));
  assert.equal(reads.length, 2);
  for (const q of reads) assert.doesNotMatch(q.sql, /username|JOIN users|pr_votes/);

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
  assert.ok(!pool.queries.some((q) => /INSERT INTO events/.test(q.sql)), 'no card recorded');
  assert.ok(!pool.queries.some((q) => /UPDATE apps/.test(q.sql)), 'and is not stamped, so a later merge this week still earns one');
});

test('an app another instance stamped first is left alone', async () => {
  sent.length = 0;
  const pool = makePool({ apps: [tiers], merged: { 3: landed }, claimable: false });
  const r = await digest.sweep(pool, FRIDAY_16_UTC);
  assert.equal(r.posted, 0);
  assert.equal(sent.length, 0);
  assert.ok(!pool.queries.some((q) => /INSERT INTO events/.test(q.sql)), 'no card recorded');
});

test('the plain line lists three of each, counts the rest, and names nobody', () => {
  assert.equal(digest.MAX_LISTED, 3, 'one short sentence, not a changelog');

  // A new card: gather() keeps the three newest changes and the three
  // longest-waiting proposals; the totals say how many there were.
  const line = digest.contentLine({
    app: 'Community Tier Lists',
    merged: [0, 1, 2].map((i) => ({ id: i, prNumber: 100 + i, title: `Change ${i}` })),
    mergedTotal: 11,
    open: [{ id: 44, prNumber: 44, title: 'Dark mode toggle' }],
    openTotal: 1,
  });
  assert.equal(line, 'This week on Community Tier Lists: 11 changes went live: Change 0; Change 1; Change 2; and 8 more. '
    + 'One proposal is waiting for eyes: Dark mode toggle (PR #44).');

  const one = digest.contentLine({
    app: 'Tiers', merged: [{ id: 1, prNumber: 41, title: 'Custom tier colors' }],
    mergedTotal: 1, open: [], openTotal: 0,
  });
  assert.equal(one, 'This week on Tiers: 1 change went live: Custom tier colors.');

  assert.equal(digest.contentLine({ app: 'Tiers', merged: [], mergedTotal: 0, open: [{ id: 9, prNumber: null, title: 'Untitled idea' }], openTotal: 1 }),
    'This week on Tiers: Nothing landed this week. One proposal is waiting for eyes: Untitled idea.');
});

test('a card stored before #3678, eight entries with their people, reads short and names nobody', () => {
  // The card is drawn from the record (app-notices.js), so the one already
  // on a project's Workshop is what the request quoted: eight changes, each
  // with its author and backers, and every open proposal.
  const people = ['Bruno', 'evan', 'flushthefashion', 'madza', 'panse08', 'staples270_50098', 'snait', 'cyrcle_0', 'ocank14'];
  const stored = {
    app: 'Homeroom',
    merged: Array.from({ length: 8 }, (_, i) => ({
      id: i, prNumber: 3600 + i, title: `Change ${i}`, author: people[i], backers: people.slice(i + 1, i + 4),
    })),
    mergedTotal: 312,
    open: Array.from({ length: 5 }, (_, i) => ({ id: 90 + i, prNumber: 3670 + i, title: `Proposal ${i}`, author: people[i] })),
    openTotal: 5,
  };
  const line = digest.contentLine(stored);
  assert.equal(line, 'This week on Homeroom: 312 changes went live: Change 0; Change 1; Change 2; and 309 more. '
    + '5 proposals are waiting for eyes: Proposal 0 (PR #3670); Proposal 1 (PR #3671); Proposal 2 (PR #3672); and 2 more.');
  for (const name of people) assert.ok(!line.includes(name), `${name} is not named`);
  assert.doesNotMatch(line, /backed by|\((?!PR #)/, 'no credit, and no bracket but a PR number');
});
