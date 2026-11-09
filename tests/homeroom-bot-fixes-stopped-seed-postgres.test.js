'use strict';

// #6284: the staging fixture the before & after shots need.
//
// A change Homeroom bot built for the shots' member fixture, whose checks are
// failing after the bot stopped at its own limit of three fixes. A fresh
// staging copy cannot reach that state on its own (nothing there runs checks
// or a model), so src/db/migrate.js seeds it. This pins what the seed writes
// and what the two screens read back: the change's Testing card
// (changeBotFix) and the Homeroom bot page's Needs you (requestStates).
//
// The fixture's id is fixed because the declared start path names it, and it
// sits above every real session id: a production clone that already held the
// old id silently skipped the whole fixture.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-fixes-stopped-seed-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the staging stopped-fix fixture reaches the state the shots need', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_stopped_seed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const previousEnv = process.env.USERNODE_ENV;
  t.after(async () => {
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  // What a preview already holds before the seed runs: the platform's app and
  // the member the shots sign in as.
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, self_hosted) VALUES ('Homeroom', 'usernode-2d5619', TRUE) RETURNING id",
  );
  const { rows: [member] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('usernode-capture', 'staging-demo-not-a-login') RETURNING id",
  );

  process.env.USERNODE_ENV = 'staging';
  const migrate = require('../src/db/migrate');
  await migrate.seedStagingBotFixesStopped(pool);

  const { rows: [change] } = await pool.query(
    `SELECT id, app_id, status, check_state, reviewed_head_sha, linked_issues
       FROM chat_sessions WHERE branch_name = 'staging-fixture/bot-fixes-stopped'`,
  );
  assert.ok(change, 'the fixture change exists');
  assert.equal(change.app_id, app.id, 'on the self-hosted platform app');
  assert.equal(change.status, 'promoted');
  assert.equal(change.check_state, 'failing');
  assert.deepEqual(change.linked_issues, [900095], 'answers the fixture request');
  assert.equal(Number(change.id), 999_999_999, 'a reserved id no real session can reach');

  const { rows: runs } = await pool.query(
    `SELECT verdict, asked, limit_stop FROM homeroom_bot_runs
      WHERE proposal_session_id = $1 ORDER BY id`, [change.id],
  );
  assert.deepEqual(runs.map((r) => [r.verdict, r.asked, r.limit_stop]), [
    ['revise', false, null], ['revise', false, null], ['revise', false, null], ['person', false, 'own_revisions'],
  ], 'three own rounds, then the stop at the limit');

  // The Testing card: stopped, and the member may let it try again.
  const progress = require('../src/services/homeroom-bot-progress');
  const fix = await progress.changeBotFix(pool, change.id, { viewer: { id: member.id } });
  assert.deepEqual(fix, {
    state: 'stopped', since: null, reason: null, head: 'staging-fixture-head', tries: 3, canTryAgain: true,
  });

  // The Homeroom bot page's Needs you: the stopped state, not "checking".
  const states = await progress.requestStates(pool, { userId: member.id });
  assert.deepEqual(states.map((s) => [s.row.issue_number, s.state?.stage, s.row.fix_stopped]), [
    [900095, 'fix_stopped', true],
  ]);

  // The bot's own stop message in the change's discussion, with Let it try
  // again and Not now under it, bound to the open offer a tap decides.
  const { rows: [stop] } = await pool.query(
    `SELECT id, user_id, metadata FROM chat_messages
      WHERE app_id = $1 AND thread_type = 'session' AND thread_ref = $2
        AND content LIKE 'I stopped after 3 tries%'`,
    [app.id, change.id],
  );
  assert.ok(stop, 'the stop message is in the change\'s discussion');
  assert.equal(stop.user_id, (await pool.query("SELECT id FROM users WHERE username = 'homeroom_bot'")).rows[0].id);
  assert.deepEqual(stop.metadata.homeroomBot.actions.map((a) => a.label), ['Let it try again', 'Not now']);
  assert.equal(stop.metadata.homeroomBot.offer.forUserId, Number(member.id));
  const { rows: [offer] } = await pool.query(
    "SELECT id, chat_message_id AS message_id, status FROM bot_cards WHERE place = 'thread' AND app_id = $1 AND kind = 'try_again'", [app.id],
  );
  assert.equal(offer.message_id, stop.id, 'a tap on the message finds the offer');
  assert.equal(offer.status, 'open');

  // A second boot adds nothing.
  await migrate.seedStagingBotFixesStopped(pool);
  const { rows: [{ n }] } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM homeroom_bot_runs WHERE proposal_session_id = $1', [change.id],
  );
  assert.equal(n, 4, 'idempotent');
  const { rows: [{ m }] } = await pool.query(
    "SELECT COUNT(*)::int AS m FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 AND content LIKE 'I stopped after 3 tries%'",
    [change.id],
  );
  assert.equal(m, 1, 'one stop message');

  // #6388's sibling fixture: a bot change whose one failing check reports the
  // preview answering 503. The card reads it as the platform's, not the
  // bot's (and never as "Its author needs to fix this").
  await migrate.seedStagingBotFixesPlatform(pool);
  const { rows: [platform] } = await pool.query(
    `SELECT id, app_id, status, check_state FROM chat_sessions
      WHERE branch_name = 'staging-fixture/bot-fixes-platform'`,
  );
  assert.ok(platform, 'the platform fixture change exists');
  assert.equal(Number(platform.id), 999_999_998, 'a reserved id no real session can reach');
  assert.equal(Number(platform.app_id), app.id);
  assert.deepEqual([platform.status, platform.check_state], ['promoted', 'failing']);
  assert.deepEqual(await progress.changeBotFix(pool, platform.id), { state: 'platform', since: null, reason: null });
  await migrate.seedStagingBotFixesPlatform(pool);
  const { rows: [{ pn }] } = await pool.query(
    "SELECT COUNT(*)::int AS pn FROM chat_sessions WHERE branch_name = 'staging-fixture/bot-fixes-platform'",
  );
  assert.equal(pn, 1, 'idempotent');
  // And a person's failing change, for the card that names who must fix it.
  const { rows: [person] } = await pool.query(
    `SELECT cs.id, cs.app_id, u.username FROM chat_sessions cs JOIN users u ON u.id = cs.user_id
      WHERE branch_name = 'staging-fixture/person-checks-failing'`,
  );
  assert.ok(person, 'the person fixture change exists');
  assert.equal(Number(person.id), 999_999_997);
  assert.equal(person.username, 'usernode-capture');
});
