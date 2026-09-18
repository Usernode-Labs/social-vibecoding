'use strict';

// #1688: thanks and bounties draw from separate weekly allowances
// (src/services/bounties.js), so "Thank <author>" being the first thing on
// every fresh proposal card can never drain an issue's bounties.

const test = require('node:test');
const assert = require('node:assert/strict');

const events = require('../src/services/events');
events.record = () => {};

const bounties = require('../src/services/bounties');

function makePool({ used = 0 } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/FROM issue_bounties\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
        return { rows: [{ c: String(used) }] };
      }
      if (/FROM pr_kudos\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
        return { rows: [{ c: '3' }] };
      }
      return { rows: [] };
    },
  };
}

test('the two counters each read one ledger', async () => {
  const pool = makePool({ used: 4 });
  assert.equal(await bounties.countWeeklyKudosUsed(pool, 7, '2026-09-14'), 3);
  assert.equal(await bounties.countWeeklyBountiesUsed(pool, 7, '2026-09-14'), 4);
  const [kudos, bountyCount] = pool.queries;
  assert.match(kudos.sql, /FROM pr_kudos/);
  assert.doesNotMatch(kudos.sql, /issue_bounties/);
  assert.match(bountyCount.sql, /FROM issue_bounties/);
  assert.doesNotMatch(bountyCount.sql, /pr_kudos/);
  assert.match(bountyCount.sql, /status <> 'voided'/, 'a voided self-bounty is refunded');
});

test('the combined figure is still there for the readers that want one number', async () => {
  const seen = [];
  const pool = { query: async (sql) => { seen.push(String(sql)); return { rows: [{ c: '5' }] }; } };
  assert.equal(await bounties.countWeeklyAllowanceUsed(pool, 7, '2026-09-14'), 5);
  assert.match(seen[0], /FROM pr_kudos/);
  assert.match(seen[0], /FROM issue_bounties/);
});

test('placeBounty gates on the bounty allowance, and says so', async () => {
  const pool = makePool({ used: bounties.WEEKLY_BOUNTY_LIMIT });
  const r = await bounties.placeBounty(pool, { app: { id: 3, slug: 'tiers' }, user: { id: 7, username: 'evan' }, issueNumber: 12 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'quota');
  assert.equal(r.limit, bounties.WEEKLY_BOUNTY_LIMIT);
  assert.match(r.error, /bounty quota/);
  assert.ok(!pool.queries.some((q) => /INSERT INTO issue_bounties/.test(q.sql)));
});

test('nobody lost budget: both allowances are the old shared number', () => {
  assert.equal(bounties.WEEKLY_KUDOS_LIMIT, 20);
  assert.equal(bounties.WEEKLY_BOUNTY_LIMIT, 20);
});

test('routes/kudos.js re-exports the split, for the routes that read it', () => {
  const kudosRoute = require('../src/routes/kudos');
  assert.equal(kudosRoute.WEEKLY_BOUNTY_LIMIT, bounties.WEEKLY_BOUNTY_LIMIT);
  assert.equal(kudosRoute.countWeeklyKudosUsed, bounties.countWeeklyKudosUsed);
  assert.equal(kudosRoute.countWeeklyBountiesUsed, bounties.countWeeklyBountiesUsed);
});
