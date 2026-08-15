// The connector's own caps — specifically, what they MEASURE.
//
// #1248 follow-up. The connector-authored proposal cap used to count
// proposals created in the last 24 hours. That measured a flow, when the thing
// being protected is a stock: the vote queue is harmed by how many proposals
// sit in it unreviewed, not by how many were opened yesterday. The window was
// wrong in both directions — it refused a submission on a day whose earlier
// proposals had all merged (queue empty, work reviewed, still locked out for
// hours), and it permitted five simultaneous unreviewed proposals.
//
// So the cap counts OPEN proposals, and a slot comes back the moment one
// merges or closes. These tests pin the semantics rather than the number.
//
// Run with: node --test tests/connector-limits.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = require('../src/services/connector-limits');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src/services/connector-limits.js'), 'utf8'
);

// A pool that answers every count with the same number and records the SQL it
// was asked, so a test can assert on what the cap actually queries.
function poolCounting(n) {
  const asked = [];
  return {
    asked,
    query: async (sql, params) => {
      asked.push({ sql, params });
      return { rows: [{ cnt: String(n) }] };
    },
  };
}

test('the cap counts proposals that are open, not proposals that are recent', async () => {
  const pool = poolCounting(0);
  await limits.checkOpenProposals(pool, 7);
  const { sql, params } = pool.asked[0];
  assert.deepEqual(params, [7], 'scoped to the one user');
  assert.match(sql, /status IN \('promoted', 'merging'\)/, 'counts what is up for a vote');
  assert.match(sql, /external_agent IS NOT NULL/, 'and only connector-authored rows');
  assert.doesNotMatch(
    sql, /INTERVAL/,
    'a time window is what this cap stopped using — a merged proposal must free its slot at once'
  );
});

test('a full queue is refused, and the refusal says how a slot comes back', async () => {
  const result = await limits.checkOpenProposals(poolCounting(limits.LIMITS.openProposals), 7);
  assert.equal(result.code, 'at_capacity');
  assert.match(result.message, /up for a vote/);
  assert.match(result.message, /merge or close/, 'names the event that frees a slot');
  // The old wording sent an agent away for a fixed period with nothing to do.
  assert.doesNotMatch(result.message, /24 hours|daily limit/);
  // A finished branch must not be rebuilt while its author waits.
  assert.match(result.message, /task stays open/);
});

test('one slot short of the cap still goes through', async () => {
  const result = await limits.checkOpenProposals(
    poolCounting(limits.LIMITS.openProposals - 1), 7
  );
  assert.equal(result, null);
});

test('a cap that cannot be measured refuses rather than waves through', async () => {
  // Same posture as the rest of this module: these bound writes to the vote
  // queue, so an unavailable database is a reason to stop.
  const pool = { query: async () => { throw new Error('db down'); } };
  const result = await limits.checkOpenProposals(pool, 7);
  assert.equal(result.code, 'platform_unavailable');
});

test('the open-proposal cap and the promoted-session cap agree on what open means', () => {
  // They bound the same queue from two directions, so a proposal counted by
  // one and not the other would make the pair incoherent.
  const promoted = SRC.slice(
    SRC.indexOf('async function checkPromotedCap'),
    SRC.indexOf('async function checkOpenProposals')
  );
  const open = SRC.slice(
    SRC.indexOf('async function checkOpenProposals'),
    SRC.indexOf('async function checkPrepareRate')
  );
  for (const block of [promoted, open]) {
    assert.match(block, /status IN \('promoted', 'merging'\)/);
  }
});

test('the remaining daily quota is the one that spends platform credits', () => {
  // fallbackPerDay stays a per-day cap on purpose: it meters the platform's
  // OWN credits, where the thing being conserved really is a flow. Only the
  // vote-queue cap changed.
  assert.ok(limits.LIMITS.fallbackPerDay > 0);
  assert.match(SRC, /fallbackPerDay[\s\S]*?INTERVAL '24 hours'/);
  assert.equal(limits.LIMITS.proposalsPerDay, undefined, 'the daily proposal quota is gone');
});
