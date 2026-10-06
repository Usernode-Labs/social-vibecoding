// `backfillWaitlistRowsForEmailAccounts` in src/db/migrate.js — the
// boot-time backfill that gives every email-bearing account without
// platform access its waitlist spot (#4083).
//
// WHY THIS FILE EXISTS. Only the public join form used to make a
// `waitlist_signups` row, so an account made with an email code — or
// through Apple or Google, which make the same account — never showed in
// Admin › Waitlist and could not be let in from there. The backfill adds
// the missing rows once, when the platform next starts.
//
// Two properties matter and neither is visible in a rendered screen:
//
//   1. It adds nothing twice. It runs on every boot, so it must only ever
//      add the rows that are missing: the NOT EXISTS guard skips an
//      address that already holds a row, and `ON CONFLICT (email) DO
//      NOTHING` backstops the race between the two.
//   2. It touches only accounts that can actually wait. Admins and
//      accounts already in are excluded (never gated, never waited), and
//      the address filter is the join form's own rule, so a junk address
//      on an account cannot mint a row the join endpoint would have
//      refused.
//
// Same two layers as tests/waitlist-country-migration.test.js: the real
// function against a mock pool that records every query, plus static
// assertions over the SQL text. No live Postgres.
//
// Run with: node --test tests/waitlist-spot-backfill.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { backfillWaitlistRowsForEmailAccounts } = require('../src/db/migrate');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

function mockPool({ rowCount = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (fail && fail.test(sql)) throw new Error('boom');
      return { rows: [], rowCount };
    },
  };
}

// ─── 1. Behaviour ─────────────────────────────────────────────────────

test('it is one INSERT ... SELECT, and reports what it added', async () => {
  const pool = mockPool({ rowCount: 4 });
  const added = await backfillWaitlistRowsForEmailAccounts(pool);

  assert.equal(added, 4, 'the row count travels back to migrate()');
  assert.equal(pool.calls.length, 1, 'one statement, nothing else');
  assert.match(pool.calls[0].sql, /^\s*INSERT INTO waitlist_signups/);
  assert.deepEqual(pool.calls[0].params ?? [], [], 'nothing is interpolated; the statement is fixed text');
});

test('a boot that adds nobody still reports zero and runs the same statement', async () => {
  const pool = mockPool({ rowCount: 0 });
  const added = await backfillWaitlistRowsForEmailAccounts(pool);

  assert.equal(added, 0);
  assert.equal(pool.calls.length, 1, 'the statement runs again; idempotence is its guard, not a marker row');
});

// ─── 2. The statement's own guarantees (static, over the SQL) ─────────

test('the SQL is pinned', async () => {
  const pool = mockPool();
  await backfillWaitlistRowsForEmailAccounts(pool);
  const sql = pool.calls[0].sql;

  // Only accounts that can actually wait.
  assert.match(sql, /u\.email IS NOT NULL/, 'email-bearing accounts only: the waitlist is a list of addresses');
  assert.match(sql, /u\.has_platform_access = FALSE/, 'accounts already in are skipped');
  assert.match(sql, /u\.is_admin = FALSE/, 'admins are skipped: they are never gated');

  // The address rule is the join form's own, so a junk address cannot
  // mint a row the join endpoint would have refused.
  assert.match(sql, /lower\(u\.email\) ~ '\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$'/);

  // Adds nothing twice, on the re-run and on the concurrent insert.
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM waitlist_signups w\s*WHERE w\.email = lower\(u\.email\)\)/);
  assert.match(sql, /ON CONFLICT \(email\) DO NOTHING/);

  // A backfilled spot is dated from the day the account was created, so
  // nobody already here is sent to the back of the line behind yesterday's
  // join-form signups (submitted_at is the queue's only order).
  assert.match(sql, /SELECT lower\(u\.email\), u\.created_at,/);

  // The confirmed mark is the account's own proof, and only that: an
  // address the account never proved shows as unconfirmed.
  assert.match(sql, /CASE WHEN u\.email_confirmed\s*THEN COALESCE\(u\.email_confirmed_at, NOW\(\)\) END/);

  // The row is linked to the account, so Admin › Waitlist shows its name.
  assert.match(sql, /u\.id\s+FROM users u/);
});

test('it is wired into the maintenance phase, after the username-choice backfill', () => {
  const call = src.indexOf('await backfillWaitlistRowsForEmailAccounts(pool);');
  const before = src.indexOf('await backfillUsernameChoiceForEmailHandles(pool);');
  assert.ok(call > 0, 'the backfill runs on boot');
  assert.ok(before > 0);
  assert.ok(call > before, 'it sits after backfillUsernameChoiceForEmailHandles, among the backfills');
});