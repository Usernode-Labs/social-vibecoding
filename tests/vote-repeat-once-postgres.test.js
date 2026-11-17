'use strict';

// #6736: "voted while the signal was gone, the queue badge showed 1, then
// wifi returned and the proposal counted 2 from me". The offline queue's
// replay of a vote whose answer was lost, and a vote sent from two tabs
// (#6728), both put two requests for the same vote in flight. The tally
// could only ever hold one row (UNIQUE(session_id, user_id)); what people
// saw twice was the second request's vote line, author notification and
// bot-change event.
//
// The route used to read the previous vote in its own statement BEFORE
// recordVote took the row lock, so two overlapping requests both saw none
// and both took the "new vote" path. recordVote now decides new-vs-repeat
// inside its transaction, from a read made its own statement AFTER the row
// lock is held: the second request sees the first one's committed vote and
// answers `unchanged`, so only one of them announces anything.
//
// Against the REAL schema and two real connections, so the row lock and the
// READ COMMITTED snapshot are the ones that ship.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/vote-repeat-once-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HEAD = 'a'.repeat(40);
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the route decides new-vs-repeat inside recordVote, before anything is announced', () => {
  const src = read('src/routes/votes.js');
  const handler = src.slice(
    src.indexOf("router.post('/api/sessions/:id/vote'"),
    src.indexOf("router.delete('/api/sessions/:id/vote'")
  );
  assert.doesNotMatch(handler, /prevRows/, 'the handler no longer reads the previous vote itself');
  assert.match(handler, /const \{ unchanged, reasonOnly \} = recorded;/,
    'both answers come from the write that holds the row lock');
  const unchangedAt = handler.indexOf('if (unchanged) {');
  assert.ok(unchangedAt > -1);
  const recordedAt = handler.indexOf('const recorded = await recordVote(');
  assert.ok(recordedAt > -1 && recordedAt < unchangedAt, 'recorded before the answer is decided');
  for (const call of ['sendSystemMessage(', 'createProposalVoteNotification', 'PR_VOTE_CAST', 'settleVoteInBackground({']) {
    assert.ok(handler.indexOf(call) > unchangedAt, `${call} runs only for a real new vote or flip`);
  }

  const record = src.slice(src.indexOf('async function recordVote('), src.indexOf('async function retractVote('));
  const lockAt = record.indexOf('FOR UPDATE');
  const previousAt = record.indexOf('SELECT vote, reason, approval_epoch');
  assert.ok(lockAt > -1 && previousAt > lockAt,
    'the previous vote is read in its own statement after the row is locked');
  assert.doesNotMatch(record, /pool\.query\(/, 'the lock, the read and the upsert share one transaction');
  assert.match(record, /!unchanged && !reasonOnly/, 'a repeat and a same-side new sentence tell the bot nothing');
});

test('two overlapping requests for one vote record and announce it once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `vote_repeat_once_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { recordVote } = require('../src/routes/votes.js');
  let seq = 0;
  // A proposal up for a vote, with the bot's change machine following it, so
  // a "Voted" event is there to count when the vote is really new.
  async function seed() {
    const tag = `${crypto.randomBytes(4).toString('hex')}_${++seq}`;
    const { rows: [ada] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`ada_vote_${tag}`]
    );
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
       VALUES ('vote once', $1, 'running', $2, 'private', 'private', 'https://github.com/example/vote-once')
       RETURNING id, slug`,
      [`vote-once-${tag}`, ada.id]
    );
    const { rows: [session] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number, check_state, approval_epoch)
       VALUES ($1, $2, 'promoted', NOW(), $3, $4, 'passing', 1) RETURNING id`,
      [app.id, ada.id, `test/${tag}`, 6700 + seq]
    );
    await pool.query('BEGIN');
    await pool.query(`SET LOCAL app.wf_writer = 'transition'`);
    await pool.query(
      `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version)
       VALUES ('bot-change', $1, $2, 'proposed', '{}'::jsonb, 1)`,
      [`session:${session.id}`, app.id]
    );
    await pool.query('COMMIT');
    return {
      ada,
      session,
      cast: (vote, reason = null) => recordVote({
        pool, session: { id: session.id }, userId: ada.id, vote, headSha: HEAD,
        revisionEnforced: false, reason, voter: ada.username,
      }),
      votes: async () => (await pool.query(
        'SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2',
        [session.id, ada.id]
      )).rows,
      told: async () => (await pool.query(
        `SELECT COUNT(*)::int AS n FROM wf_events WHERE type = 'Voted' AND key = $1`,
        [`session:${session.id}`]
      )).rows[0].n,
    };
  }

  await t.test('two tabs: a second connection holds the row while both requests queue', async () => {
    const s = await seed();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE', [s.session.id]);
      const first = s.cast('yes');
      const second = s.cast('yes');
      // Let both requests reach their own row lock and wait there.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await holder.query('COMMIT');
      const results = await Promise.all([first, second]);
      assert.equal(results.filter((r) => r.unchanged === false).length, 1,
        'exactly one request recorded the vote as new');
      assert.equal(results.filter((r) => r.unchanged === true).length, 1,
        'the other waited on the lock and answered unchanged');
      assert.deepEqual(await s.votes(), [{ vote: 'yes' }], 'one row, one vote');
      assert.equal(await s.told(), 1, 'the bot heard one real vote, not two');
    } finally {
      holder.release();
    }
  });

  await t.test('a replay after the first answer was lost is unchanged; a flip is still a real vote', async () => {
    const s = await seed();
    const first = await s.cast('yes');
    assert.equal(first.unchanged, false);
    assert.equal(first.rowCount, 1);
    // The first request committed but its answer never reached the device;
    // the offline queue replays the same vote.
    const replay = await s.cast('yes');
    assert.equal(replay.rowCount, 1, 'the repeat still answers success');
    assert.equal(replay.unchanged, true, 'with nothing to announce');
    assert.equal(await s.told(), 1, 'the bot heard only the first');
    // Changing the vote is not a repeat: yes, then no.
    const flip = await s.cast('no');
    assert.equal(flip.unchanged, false, 'a flip is a real vote');
    assert.deepEqual(await s.votes(), [{ vote: 'no' }]);
    assert.equal(await s.told(), 2, 'the flip is told too');
    // And a same-side vote with new words is a change to the row only.
    const words = await s.cast('no', 'This breaks the list.');
    assert.equal(words.reasonOnly, true);
    assert.equal(await s.told(), 2, 'new words on the same side tell the bot nothing');
  });
});
