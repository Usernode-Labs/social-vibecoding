'use strict';

// Ordered funnel semantics against PostgreSQL. This intentionally uses a
// compact schema: the service query itself is the subject, while schema.sql
// compatibility is covered by SQL lint and the full hosted suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const { fetchFunnels } = require('../src/services/analytics-funnels');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const AS_OF = new Date('2026-10-01T12:00:00.000Z');

test('funnels keep chronology, subjects, coverage and maturity honest in PostgreSQL',
  { timeout: 180000 }, async (t) => {
    const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await client.connect(); } catch (err) {
      await client.end().catch(() => {});
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }

    const schema = `analytics_funnels_${crypto.randomBytes(6).toString('hex')}`;
    t.after(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    });
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path = ${schema}`);
    await client.query(`
      CREATE TABLE users (
        id integer PRIMARY KEY,
        is_admin boolean NOT NULL DEFAULT false,
        test_account_created_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE chat_sessions (
        id integer PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id),
        pr_number integer,
        status text NOT NULL DEFAULT 'active',
        promoted_at timestamptz,
        merged_at timestamptz,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE pr_votes (
        session_id integer NOT NULL REFERENCES chat_sessions(id),
        user_id integer,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE events (
        id bigserial PRIMARY KEY,
        user_id integer,
        session_id integer,
        event_type text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL
      );
    `);

    const users = [
      [1, false, '2026-08-02T10:00Z'], [2, false, '2026-08-03T10:00Z'],
      [3, false, '2026-08-04T10:00Z'], [4, false, '2026-08-05T10:00Z'],
      [5, false, '2026-07-01T10:00Z'], [6, false, '2026-09-15T10:00Z'],
      [7, true, '2026-08-06T10:00Z'], [8, false, '2026-08-07T10:00Z'],
      [9, false, '2026-08-08T10:00Z'], [10, false, '2026-08-09T10:00Z'],
      [11, false, '2026-08-10T10:00Z'], [12, false, '2026-08-11T10:00Z'],
      [13, false, '2026-07-02T10:00Z'], [14, false, '2026-09-20T10:00Z'],
      [15, true, '2026-08-12T10:00Z'],
    ];
    for (const row of users) {
      await client.query('INSERT INTO users (id, is_admin, created_at) VALUES ($1, $2, $3)', row);
    }

    const event = (userId, sessionId, type, at, metadata = {}) => client.query(
      `INSERT INTO events (user_id, session_id, event_type, created_at, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [userId, sessionId, type, at, JSON.stringify(metadata)],
    );
    // Global observed-reporting boundaries. Empty selected cohorts must keep
    // these timestamps rather than reverting to awaiting_events.
    await event(null, null, 'dapp_opened', '2026-08-01T00:00Z', { source: 'app_tab' });
    await event(null, null, 'pr_opened', '2026-08-01T00:00Z', { prNumber: 1 });

    // Same-user ordered path. Early social activity and a same-day second
    // opening cannot satisfy later stages; valid later occurrences can.
    await event(1, null, 'dapp_opened', '2026-08-03T09:00Z', { source: 'app_tab' });
    await event(1, null, 'chat_message_sent', '2026-08-03T12:00Z');
    await event(1, null, 'dapp_opened', '2026-08-03T15:00Z', { source: 'app_tab' });
    await event(1, null, 'dapp_opened', '2026-08-05T09:00Z', { source: 'app_tab' });
    await event(1, null, 'app_favorited', '2026-08-06T09:00Z'); // backfill: ignored
    await event(1, null, 'chat_message_sent', '2026-08-07T09:00Z');
    await event(1, null, 'app_created', '2026-08-08T09:00Z');

    // Social action occurs only before the return: independent reach yes,
    // ordered post-return engagement no.
    await event(2, null, 'chat_message_sent', '2026-08-04T09:00Z');
    await event(2, null, 'dapp_opened', '2026-08-05T09:00Z', { source: 'app_tab' });
    await event(2, null, 'dapp_opened', '2026-08-06T09:00Z', { source: 'app_tab' });

    // A tied timestamp is not an order.
    await event(3, null, 'dapp_opened', '2026-08-05T09:00Z', { source: 'app_tab' });
    await event(3, null, 'dapp_opened', '2026-08-06T10:00Z', { source: 'app_tab' });
    await event(3, null, 'chat_message_sent', '2026-08-06T10:00Z');

    // The inclusive conversion-window boundary counts.
    await event(4, null, 'dapp_opened', '2026-09-04T10:00Z', { source: 'app_tab' });

    // A complete maturing path is visible only as provisional progress.
    await event(6, null, 'dapp_opened', '2026-09-16T09:00Z', { source: 'app_tab' });
    await event(6, null, 'dapp_opened', '2026-09-17T09:00Z', { source: 'app_tab' });
    await event(6, null, 'app_favorited', '2026-09-18T09:00Z', { source: 'user_favorite_toggle' });
    await event(6, null, 'app_created', '2026-09-19T09:00Z');
    // Future/skewed receipt: neither mature nor provisional progress yet.
    await event(14, null, 'dapp_opened', '2026-10-02T09:00Z', { source: 'app_tab' });

    // Admin path proves view-only/full admins remain in the same split.
    await event(7, null, 'dapp_opened', '2026-08-07T09:00Z', { source: 'app_tab' });
    await event(7, null, 'dapp_opened', '2026-08-08T09:00Z', { source: 'app_tab' });
    await event(7, null, 'chat_message_sent', '2026-08-09T09:00Z');
    await event(7, null, 'app_created', '2026-08-10T09:00Z');

    const session = (id, userId, createdAt, opts = {}) => client.query(
      `INSERT INTO chat_sessions
         (id, user_id, created_at, pr_number, status, promoted_at, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, userId, createdAt, opts.pr ?? null, opts.status || 'active',
        opts.promoted || null, opts.merged || null],
    );
    await session(101, 8, '2026-08-02T10:00Z', {
      pr: 101, status: 'merged', promoted: '2026-08-02T18:00Z', merged: '2026-08-06T10:00Z',
    });
    await event(8, 101, 'pr_promoted', '2026-08-02T18:00Z'); // too early
    await event(8, 101, 'pr_opened', '2026-08-03T10:00Z', { prNumber: 101 });
    await event(8, 101, 'pr_vote_cast', '2026-08-03T18:00Z'); // too early
    await event(8, 101, 'pr_promoted', '2026-08-04T10:00Z'); // valid later occurrence
    await event(null, 101, 'pr_vote_cast', '2026-08-05T10:00Z'); // survives deleted vote row

    await session(102, 8, '2026-08-07T10:00Z', { pr: 102 });
    await event(8, 102, 'pr_opened', '2026-08-08T10:00Z', { prNumber: 102 });
    await session(103, 8, '2026-08-09T10:00Z', {
      status: 'promoted', promoted: '2026-08-10T10:00Z',
    }); // a different session cannot borrow 102's PR opening

    await session(105, 9, '2026-08-10T10:00Z', {
      pr: 105, status: 'promoted', promoted: '2026-08-11T10:00Z',
    });
    await event(9, 105, 'pr_opened', '2026-08-11T10:00Z', { prNumber: 105 }); // tied

    await session(106, 10, '2026-08-12T10:00Z', {
      pr: 106, status: 'merged', merged: '2026-08-14T10:00Z',
    });
    await event(10, 106, 'pr_opened', '2026-08-13T10:00Z', { prNumber: 106 });

    await session(107, 11, '2026-08-14T10:00Z', {
      pr: 107, status: 'merged', promoted: '2026-08-16T10:00Z',
    });
    await event(11, 107, 'pr_opened', '2026-08-15T10:00Z', { prNumber: 107 });
    await event(11, 107, 'pr_merged', '2026-08-17T10:00Z'); // coarse backfill: ignored

    await session(108, 12, '2026-08-18T10:00Z', {
      pr: 108, status: 'merged', promoted: '2026-08-20T10:00Z', merged: '2026-08-21T10:00Z',
    });
    await event(12, 108, 'pr_opened', '2026-08-19T10:00Z', { prNumber: 108 });

    await session(109, 9, '2026-08-20T10:00Z', {
      pr: 109, status: 'promoted', promoted: '2026-09-20T10:00Z',
    });
    await event(9, 109, 'pr_opened', '2026-09-19T10:00Z', { prNumber: 109 }); // exact +30d

    await session(110, 9, '2026-08-21T10:00Z', { pr: 110 });
    await event(9, 110, 'pr_opened', '2026-09-21T10:00Z', { prNumber: 110 }); // known late

    await session(111, 10, '2026-08-22T10:00Z', { pr: 111 });
    await event(10, 111, 'pr_opened', '2026-08-22T10:00Z'); // historical `{}` + tie

    await session(112, 14, '2026-09-20T10:00Z', {
      pr: 112, status: 'merged', promoted: '2026-09-22T10:00Z', merged: '2026-09-23T10:00Z',
    });
    await event(14, 112, 'pr_opened', '2026-09-21T10:00Z', { prNumber: 112 });
    await session(114, 13, '2026-07-02T10:00Z', { pr: 114 });
    await event(13, 114, 'pr_opened', '2026-07-03T10:00Z'); // backfilled, not coverage
    await session(115, 14, '2026-09-25T10:00Z');
    await event(14, 115, 'pr_opened', '2026-10-02T10:00Z', { prNumber: 115 }); // future

    await session(113, 15, '2026-08-23T10:00Z', {
      pr: 113, status: 'merged', promoted: '2026-08-25T10:00Z', merged: '2026-08-27T10:00Z',
    });
    await event(15, 113, 'pr_opened', '2026-08-24T10:00Z', { prNumber: 113 });

    // A test account (services/test-accounts.js) walks both funnels end to
    // end. It is nobody's real use, so it is in neither, with or without
    // admins: every count below is the same as without it.
    await client.query(
      "INSERT INTO users (id, is_admin, test_account_created_at, created_at) VALUES (16, false, '2026-08-13T10:00Z', '2026-08-13T10:00Z')");
    await event(16, null, 'dapp_opened', '2026-08-14T09:00Z', { source: 'app_tab' });
    await event(16, null, 'dapp_opened', '2026-08-15T09:00Z', { source: 'app_tab' });
    await event(16, null, 'chat_message_sent', '2026-08-16T09:00Z');
    await event(16, null, 'app_created', '2026-08-17T09:00Z');
    await session(116, 16, '2026-08-13T11:00Z', {
      pr: 116, status: 'merged', promoted: '2026-08-14T10:00Z', merged: '2026-08-15T10:00Z',
    });
    await event(16, 116, 'pr_opened', '2026-08-13T12:00Z', { prNumber: 116 });

    const withoutAdmins = await fetchFunnels(client, { now: AS_OF, includeAdmins: false });
    assert.equal(withoutAdmins.dappUsage.coverage.startsAt.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(withoutAdmins.dappUsage.coverage.unknown_coverage, 2);
    assert.deepEqual([
      withoutAdmins.dappUsage.signed_up,
      withoutAdmins.dappUsage.opened_dapp,
      withoutAdmins.dappUsage.returned,
      withoutAdmins.dappUsage.engaged,
      withoutAdmins.dappUsage.creators,
    ], [9, 4, 3, 1, 1]);
    assert.deepEqual([
      withoutAdmins.dappUsage.provisional.signed_up_provisional,
      withoutAdmins.dappUsage.provisional.opened_dapp_provisional,
      withoutAdmins.dappUsage.provisional.returned_provisional,
      withoutAdmins.dappUsage.provisional.engaged_provisional,
      withoutAdmins.dappUsage.provisional.creators_provisional,
    ], [2, 1, 1, 1, 1]);
    assert.equal(withoutAdmins.dappReach.engaged, 3,
      'independent social reach remains useful without pretending it followed a return');

    assert.deepEqual([
      withoutAdmins.prSessions.started,
      withoutAdmins.prSessions.produced_pr,
      withoutAdmins.prSessions.promoted,
      withoutAdmins.prSessions.merged,
    ], [5, 4, 2, 2]);
    assert.equal(withoutAdmins.prSessions.received_vote, 1,
      'append-only vote evidence survives a missing/deleted pr_votes row');
    assert.equal(withoutAdmins.prSessions.merged_without_vote, 1);
    assert.equal(withoutAdmins.prSessions.coverage.excluded, 5);
    assert.equal(withoutAdmins.prSessions.coverage.opening_unknown, 2);
    assert.equal(withoutAdmins.prSessions.coverage.promotion_bypassed, 2);
    assert.equal(withoutAdmins.prSessions.coverage.merge_time_unknown, 1);
    assert.deepEqual([
      withoutAdmins.prSessions.provisional.started_provisional,
      withoutAdmins.prSessions.provisional.produced_pr_provisional,
      withoutAdmins.prSessions.provisional.promoted_provisional,
      withoutAdmins.prSessions.provisional.merged_provisional,
    ], [2, 1, 1, 1]);
    assert.deepEqual([
      withoutAdmins.prUsers.started,
      withoutAdmins.prUsers.produced_pr,
      withoutAdmins.prUsers.promoted,
      withoutAdmins.prUsers.received_vote,
      withoutAdmins.prUsers.merged,
    ], [5, 5, 4, 1, 3]);

    for (const stages of [
      ['signed_up', 'opened_dapp', 'returned', 'engaged', 'creators'],
      ['started', 'produced_pr', 'promoted', 'merged'],
    ]) {
      const row = stages[0] === 'signed_up' ? withoutAdmins.dappUsage : withoutAdmins.prSessions;
      const values = stages.map((key) => row[key]);
      assert.ok(values.every((n, i) => i === 0 || n <= values[i - 1]), values.join(' >= '));
    }
    assert.equal(withoutAdmins.dappUsage.signed_up_admin, 0);
    assert.equal(withoutAdmins.prSessions.started_admin, 0);

    const withAdmins = await fetchFunnels(client, { now: AS_OF, includeAdmins: true });
    assert.deepEqual([
      withAdmins.dappUsage.signed_up_admin, withAdmins.dappUsage.opened_dapp_admin,
      withAdmins.dappUsage.returned_admin, withAdmins.dappUsage.engaged_admin,
      withAdmins.dappUsage.creators_admin,
    ], [2, 1, 1, 1, 1]);
    assert.deepEqual([
      withAdmins.prSessions.started_admin, withAdmins.prSessions.produced_pr_admin,
      withAdmins.prSessions.promoted_admin, withAdmins.prSessions.merged_admin,
    ], [1, 1, 1, 1]);

    const emptyRecent = await fetchFunnels(client, { cohort: '1d', now: AS_OF });
    assert.equal(emptyRecent.dappUsage.coverage.startsAt.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(emptyRecent.prSessions.coverage.startsAt.toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(emptyRecent.dappUsage.coverage.status, 'observed_receipts');

    await client.query("DELETE FROM events WHERE event_type = 'dapp_opened'");
    const beforeOpeningCollector = await fetchFunnels(client, { now: AS_OF });
    assert.equal(beforeOpeningCollector.dappUsage.coverage.status, 'awaiting_events');
    assert.equal(beforeOpeningCollector.dappUsage.signed_up, 0);
    assert.ok(beforeOpeningCollector.dappUsage.coverage.unknown_coverage > 0,
      'missing collector history is coverage unknown, never zero-percent abandonment');
  });
