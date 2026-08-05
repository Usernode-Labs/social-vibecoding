// Tests for src/services/bounties.js (#964) — the shared bounty-placement
// service extracted from POST /api/apps/:slug/issues/:number/bounty so the
// Send Feedback dialog can pledge on the issue it just filed.
//
// Two things are asserted here:
//   1. placeBounty's discriminated result — success, 'quota', 'duplicate' —
//      since its two callers map those codes onto different HTTP semantics
//      (the standalone route 429s/409s; the feedback path never fails the
//      request and just reports the reason beside the filed issue).
//   2. That src/routes/kudos.js still RE-EXPORTS WEEKLY_KUDOS_LIMIT and
//      countWeeklyAllowanceUsed after the move. src/routes/issues.js and
//      tests/kudos.test.js both import them from there, so the re-export is
//      load-bearing backwards compatibility, not decoration.
//
// Run with: node --test tests/bounties-service.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ws.js is required lazily inside placeBounty (it pulls in a wide slice of
// the server). Stub it in require.cache BEFORE the service is loaded so the
// chat posts and the WS push become no-ops the test can observe.
const wsPath = require.resolve('../src/services/ws');
let systemMessages = [];
let issuePushes = [];
require.cache[wsPath] = {
  exports: {
    sendSystemMessage: async (pool, appId, text, kind, extra, thread) => {
      systemMessages.push({ appId, text, thread: thread || null });
    },
    pushIssueUpdate: (payload) => { issuePushes.push(payload); },
    pushNotificationToUser: () => 0,
    pushKudosUpdate: () => {},
  },
  loaded: true,
  id: wsPath,
  filename: wsPath,
  paths: [],
};

// events.record fires and forgets against the pool; keep it out of the
// query log so the assertions below read cleanly.
const events = require('../src/services/events');
let recorded = [];
events.record = (pool, e) => { recorded.push(e); };

const {
  WEEKLY_KUDOS_LIMIT,
  countWeeklyAllowanceUsed,
  placeBounty,
} = require('../src/services/bounties');

// Minimal mock pool: `used` drives the allowance query, `insertError` makes
// the INSERT reject with a given PG error code, and every query is logged.
function makePool({ used = 0, insertError = null } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/FROM issue_bounties\s+WHERE giver_user_id = \$1 AND week_start = \$2/i.test(s)) {
        return { rows: [{ c: String(used) }] };
      }
      if (/INSERT INTO issue_bounties/i.test(s)) {
        if (insertError) {
          const err = new Error('insert failed');
          err.code = insertError;
          throw err;
        }
        return { rows: [{ id: 555, created_at: '2026-08-05T00:00:00.000Z' }] };
      }
      if (/SELECT COUNT\(\*\)::int AS c FROM issue_bounties/i.test(s)) {
        return { rows: [{ c: 3 }] };
      }
      return { rows: [] };
    },
  };
}

function reset() {
  systemMessages = [];
  issuePushes = [];
  recorded = [];
}

const APP = { id: 42, slug: 'demo-app' };
const USER = { id: 7, username: 'tester' };

test('placeBounty: success returns the id, the new count and the remaining allowance', async () => {
  reset();
  const pool = makePool({ used: 4 });
  const result = await placeBounty(pool, { app: APP, user: USER, issueNumber: 101 });

  assert.equal(result.ok, true);
  assert.equal(result.bountyId, 555);
  assert.equal(result.bountyCount, 3);
  assert.equal(result.limit, WEEKLY_KUDOS_LIMIT);
  // 4 already spent + this one.
  assert.equal(result.remaining, WEEKLY_KUDOS_LIMIT - 5);

  // The insert carries the app, the issue number, the giver and an
  // 'open' status — the shape resolveIssueBounty later reads on merge.
  const insert = pool.queries.find((q) => /INSERT INTO issue_bounties/i.test(q.sql));
  assert.ok(insert, 'a row was inserted');
  assert.deepEqual(insert.params.slice(0, 3), [42, 101, 7]);
  assert.match(insert.sql, /'open'/);

  // Both system messages are posted: the app's group chat and the issue's
  // own discussion thread, with identical wording.
  assert.equal(systemMessages.length, 2);
  assert.match(systemMessages[0].text, /tester placed a bounty \(kudos\) on issue #101/);
  assert.equal(systemMessages[0].thread, null, 'first post is the app chat');
  assert.deepEqual(systemMessages[1].thread, { type: 'issue', ref: 101 });
  assert.equal(systemMessages[1].text, systemMessages[0].text, 'same wording in both surfaces');

  // And the live update other clients repaint from.
  assert.equal(issuePushes.length, 1);
  assert.equal(issuePushes[0].action, 'bounty');
  assert.equal(issuePushes[0].appSlug, 'demo-app');
  assert.equal(issuePushes[0].issueNumber, 101);
  assert.equal(issuePushes[0].bountyCount, 3);

  assert.equal(recorded.length, 1, 'one BOUNTY_CREATED event');
});

test("placeBounty: a spent allowance returns code 'quota' and inserts nothing", async () => {
  reset();
  const pool = makePool({ used: WEEKLY_KUDOS_LIMIT });
  const result = await placeBounty(pool, { app: APP, user: USER, issueNumber: 102 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'quota');
  assert.equal(result.remaining, 0);
  assert.equal(result.limit, WEEKLY_KUDOS_LIMIT);
  // The user-facing string names the live cap rather than a baked-in number.
  assert.match(result.error, new RegExp(String(WEEKLY_KUDOS_LIMIT)));

  assert.ok(
    !pool.queries.some((q) => /INSERT INTO issue_bounties/i.test(q.sql)),
    'no row is written once the allowance is spent'
  );
  assert.equal(systemMessages.length, 0, 'and nothing is announced');
  assert.equal(issuePushes.length, 0);
});

test("placeBounty: a unique violation returns code 'duplicate', not a throw", async () => {
  reset();
  // 23505 = the partial unique index on (app, issue, giver) WHERE open.
  const pool = makePool({ used: 1, insertError: '23505' });
  const result = await placeBounty(pool, { app: APP, user: USER, issueNumber: 103 });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'duplicate');
  assert.match(result.error, /already placed a bounty/i);
  assert.equal(result.limit, WEEKLY_KUDOS_LIMIT);
  // The slot is NOT consumed by a refused duplicate.
  assert.equal(result.remaining, WEEKLY_KUDOS_LIMIT - 1);
  assert.equal(systemMessages.length, 0, 'a refused pledge announces nothing');
});

test('placeBounty: a genuine DB error propagates (callers decide what to do)', async () => {
  reset();
  // Any code other than 23505 is a real failure — the standalone route turns
  // it into a 500, and the feedback path catches it so the filed issue
  // survives. Swallowing it here would hide both.
  const pool = makePool({ used: 0, insertError: '08006' });
  await assert.rejects(
    () => placeBounty(pool, { app: APP, user: USER, issueNumber: 104 }),
    /insert failed/
  );
});

test('countWeeklyAllowanceUsed: sums both ledgers and excludes voided bounties', async () => {
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql: String(sql), params });
      return { rows: [{ c: '6' }] };
    },
  };
  const used = await countWeeklyAllowanceUsed(pool, 7, '2026-08-03');
  assert.equal(used, 6, 'the count is returned as a number, not a string');
  assert.deepEqual(seen[0].params, [7, '2026-08-03']);
  // One shared pool across both ledgers…
  assert.match(seen[0].sql, /FROM pr_kudos/);
  assert.match(seen[0].sql, /FROM issue_bounties/);
  // …with voided (self-awarded, system-refunded) pledges excluded.
  assert.match(seen[0].sql, /status <> 'voided'/);
});

test('routes/kudos.js still re-exports the constant and the counter', () => {
  // The move into services/bounties.js must stay invisible to importers:
  // src/routes/issues.js and tests/kudos.test.js both read these from the
  // route, and a silent drop would break them at require time.
  const kudosRoute = require('../src/routes/kudos');
  assert.equal(kudosRoute.WEEKLY_KUDOS_LIMIT, WEEKLY_KUDOS_LIMIT);
  assert.equal(kudosRoute.countWeeklyAllowanceUsed, countWeeklyAllowanceUsed,
    're-exported by reference, not re-implemented');
  // weekStartUtc keeps its own long-standing re-export from the same file.
  assert.equal(typeof kudosRoute.weekStartUtc, 'function');
});

test('WEEKLY_KUDOS_LIMIT is 20', () => {
  // #964 raised the weekly allowance from 5. Asserted once, here and in
  // tests/kudos.test.js, so the number can't drift from the product copy
  // ("20 of 20 kudos left this week") without a test saying so.
  assert.equal(WEEKLY_KUDOS_LIMIT, 20);
});
