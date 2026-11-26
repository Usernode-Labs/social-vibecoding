'use strict';

// When a linked GitHub or X account was made on its provider
// (src/services/social-account-age.js), for Homeroom bot's github_x_age
// signal. Pinned here with no database: the X id derivation against dates X
// itself reported, the sequential ids left unknown, provider dates checked,
// and the backfill's paging and budget. The real tables are in
// tests/social-account-age-postgres.test.js.
//
// Run with: node --test tests/social-account-age.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const age = require('../src/services/social-account-age');

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

test('an X snowflake id gives the moment it was made: (id >> 22) + 1288834974657', () => {
  assert.equal(age.X_EPOCH_MS, 1288834974657);
  assert.equal(new Date(age.X_EPOCH_MS).toISOString(), '2010-11-04T01:42:54.657Z', 'X\'s epoch');
  // Ids with the created_at X's own API documentation reports for them
  // (its v2 examples, whose dates are to the second). X's ids are one
  // snowflake sequence for posts, users and the rest, so the same holds for
  // an account's id.
  for (const [id, reported] of [
    ['1212092628029698048', '2019-12-31T19:26:16.000Z'],
    ['1228393702244134912', '2020-02-14T19:00:55.000Z'],
  ]) {
    const derived = age.xCreatedAtFromId(id, { now: NOW });
    assert.ok(derived, id);
    const off = Date.parse(derived) - Date.parse(reported);
    assert.ok(off >= 0 && off < 1000, `${id}: ${derived} is within the second X reported (${reported})`);
  }
  // Exact by construction: an id built from a moment decodes to it.
  const at = Date.parse('2024-06-01T08:30:00.123Z');
  const built = ((BigInt(at - age.X_EPOCH_MS) << 22n) | 0x1fn).toString();
  assert.equal(age.xCreatedAtFromId(built, { now: NOW }), '2024-06-01T08:30:00.123Z');
});

test('a sequential (pre-snowflake) X id carries no date and stays unknown', () => {
  // X numbered accounts in sequence before snowflakes: @jack is 12, and X's
  // documentation gives 2244994945 (@XDevelopers, made 14 Dec 2013) as an
  // older, shorter id. X ran past 32 bits in sequence after 2013, so the
  // order of an id says nothing certain about its year: none is guessed.
  for (const id of ['12', '783214', '2244994945', String(2 ** 32 + 5), '4999999999']) {
    assert.equal(age.xCreatedAtFromId(id, { now: NOW }), null, id);
  }
  // The floor sits between any sequential id and the first snowflakes read
  // as one: 1 Jan 2014.
  const floor = ((BigInt(age.X_SNOWFLAKE_FLOOR_MS - age.X_EPOCH_MS)) << 22n).toString();
  assert.equal(age.xCreatedAtFromId(floor, { now: NOW }), '2014-01-01T00:00:00.000Z');
  assert.equal(age.xCreatedAtFromId((BigInt(floor) - (1n << 22n)).toString(), { now: NOW }), null);
});

test('anything that is not an id, or decodes to the future, is no date', () => {
  for (const bad of [null, undefined, '', '0', '-5', 'abc', '1e18', '18446744073709551616', ' 1212092628029698048']) {
    assert.equal(age.xCreatedAtFromId(bad, { now: NOW }), null, String(bad));
  }
  const future = ((BigInt(NOW + 7 * 86400000 - age.X_EPOCH_MS)) << 22n).toString();
  assert.equal(age.xCreatedAtFromId(future, { now: NOW }), null);
});

test('a provider\'s created_at is kept only when it is a plausible date', () => {
  assert.equal(age.parseProviderDate('2011-01-25T18:44:36Z', { now: NOW }), '2011-01-25T18:44:36.000Z');
  assert.equal(age.parseProviderDate('2013-12-14T04:35:55.000Z', { now: NOW }), '2013-12-14T04:35:55.000Z');
  for (const bad of [null, undefined, '', 'yesterday', 12345, '2005-12-31T23:59:59Z', '2027-01-01T00:00:00Z']) {
    assert.equal(age.parseProviderDate(bad, { now: NOW }), null, String(bad));
  }
});

// A pool holding user_social_identities rows: the two queries the backfill makes.
function poolOf(rows) {
  const writes = [];
  return {
    rows, writes,
    async query(sql, params) {
      if (/SELECT id, provider_subject FROM user_social_identities/.test(sql)) {
        const [provider, after, limit] = params;
        return { rows: rows.filter((r) => r.provider === provider && r.account_created_at == null && r.id > after)
          .sort((a, b) => a.id - b.id).slice(0, limit).map((r) => ({ id: r.id, provider_subject: r.subject })) };
      }
      if (/UPDATE user_social_identities/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.account_created_at == null);
        if (!row) return { rowCount: 0 };
        row.account_created_at = params[1];
        row.account_created_source = params[2];
        writes.push(params);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

test('the backfill dates X from snowflake ids, leaves sequential ones unknown, and asks GitHub a page at a time', async () => {
  const pool = poolOf([
    { id: 1, provider: 'x', subject: '1212092628029698048' },
    { id: 2, provider: 'x', subject: '2244994945' },
    { id: 3, provider: 'github', subject: '583231' },
    { id: 4, provider: 'github', subject: '9919' },
    { id: 5, provider: 'github', subject: '404404' },
    { id: 6, provider: 'x', subject: '1228393702244134912', account_created_at: '2020-02-14T19:00:55.000Z' },
  ]);
  const asked = [];
  const reader = {
    allows: () => true,
    async createdAt(subject) {
      asked.push(subject);
      if (subject === '404404') throw Object.assign(new Error('Not Found'), { status: 404 });
      return { 583231: '2011-01-25T18:44:36Z', 9919: '2008-04-03T21:23:35Z' }[subject];
    },
  };
  const first = await age.backfill(pool, { githubLimit: 2, reader });
  assert.deepEqual(first.x, { dated: 1, unknown: 1 });
  assert.deepEqual([first.github.dated, first.github.asked, first.after], [2, 2, 4], 'a full page: carried on from its last row');
  assert.equal(pool.rows[0].account_created_source, 'derived');
  assert.equal(pool.rows[1].account_created_at, undefined, 'sequential: unknown');
  assert.deepEqual([pool.rows[2].account_created_at, pool.rows[2].account_created_source], ['2011-01-25T18:44:36.000Z', 'provider']);
  assert.equal(pool.rows[5].account_created_at, '2020-02-14T19:00:55.000Z', 'a dated row is not read or written');
  const second = await age.backfill(pool, { previous: first, githubLimit: 2, reader });
  assert.deepEqual([second.github.dated, second.github.asked, second.after], [0, 1, null], 'a short page starts over next time');
  assert.equal(pool.rows[4].account_created_at, undefined, 'a deleted account stays unknown');
  assert.deepEqual(asked, ['583231', '9919', '404404']);
});

test('the GitHub backfill stops while the background budget holds, and on a rate-limit answer', async () => {
  const pool = poolOf([{ id: 1, provider: 'github', subject: '1' }, { id: 2, provider: 'github', subject: '2' }]);
  let calls = 0;
  const held = await age.backfillGithub(pool, { after: 0, limit: 10, reader: { allows: () => false, createdAt: async () => { calls++; } } });
  assert.deepEqual([held.held, held.asked, held.after, calls], [true, 0, 0, 0]);
  const limited = await age.backfillGithub(pool, {
    after: 0, limit: 10,
    reader: { allows: () => true, createdAt: async () => { calls++; throw Object.assign(new Error('rate limited'), { status: 403 }); } },
  });
  assert.deepEqual([limited.held, limited.asked, limited.after, calls], [true, 1, 0, 1], 'not past the row it could not read');
  const none = await age.backfillGithub(poolOf([]), { reader: { allows: () => true, createdAt: async () => '2010-01-01T00:00:00Z' } });
  assert.deepEqual(none, { dated: 0, asked: 0, after: null });
});

test('the clock runs it every ten minutes, twenty GitHub reads at most, and the dates stay out of the logs', () => {
  const clocks = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/clock/services.ts'), 'utf8');
  assert.match(clocks, /name: 'social-account-age', everyMs: 10 \* MIN, newestOnly: true,\s*run: \(ctx: WorkContext, \{ pool \}: JobDeps\) => legacy\('services\/social-account-age'\)\.backfill\(pool, \{/);
  assert.match(clocks, /githubLimit: 20,/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/social-account-age.js'), 'utf8');
  for (const line of src.split('\n').filter((l) => /log\.(warn|info|error)/.test(l))) {
    assert.doesNotMatch(line, /created|subject|_at\b/i, line.trim());
  }
  const scope = fs.readFileSync(path.join(__dirname, '..', 'src/services/topochain/db-console-scope.js'), 'utf8');
  assert.match(scope, /user_social_identities: \['provider_subject', 'handle', 'account_created_at'\]/, 'masked in the admin database console');
});
