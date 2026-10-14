'use strict';

// recoverStuckMerges (server.js) on the legacy path, WF_MERGE_FOLLOWUPS_ENABLED
// off, against the full PostgreSQL schema.
//
// The platform restarts many times a day, and a child app's finalizeMerge
// spends minutes in its production rebuild, so a restart cut it off there.
// The boot heal used to move the row to 'merged' and nothing else: the values
// the proposal declared never reached the redelivery, PR_MERGED was never
// recorded, a change built on it stayed up for a vote, the bell kept asking,
// the agent session, the bounties and the announcement never heard, and the
// request watch (#144) never started, because resumeIssueCloseWatches had
// read the merged rows before the heal's GitHub round trips ended.
//
// Now the heal runs what the merge owed (routes/votes.js runMergeFollowups),
// and a merge recorded as merged whose follow-ups a restart cut off is
// resumed without doing anything a person sees twice. Delivery and the main
// check are services/merge-followup-recovery.js's (its own tests).
//
// Skips when no postgres is reachable; set TEST_DATABASE_URL to require it.
//
// Run with: node --test tests/recover-stuck-merges-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DATA_KEY = 'synthetic-recover-merges-key';
const SHA = (c) => c.repeat(40).slice(0, 40);

// loadConfig() (module level in server.js) hard-exits when these are missing.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
delete process.env.WF_MERGE_FOLLOWUPS_ENABLED;
require('./platform-keys').setPlatformKeys();

function loadServer() {
  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
  global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
  try {
    return require('../server');
  } finally {
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
  }
}

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

test('the legacy heal and resume run a cut-off merge\'s follow-ups, once', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'recover_merges_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  // The process-wide pool (db/pool.js) is this database's: every module that
  // asks for it, and recoverStuckMerges, gets it.
  const pool = require('../src/db/pool').getPool({ databaseUrl: String(url), dbPoolMax: 10 });
  admin.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { recoverStuckMerges, resumeIssueCloseWatches } = loadServer();
  const secrets = require('../src/services/secrets');
  const github = require('../src/services/github');
  const watcher = require('../src/services/issue-close-watcher');
  const worker = require('../src/services/worker');
  const config = { dataEncryptionKey: DATA_KEY };

  // GitHub, as the fixture below has it: PR 41 merged (cut off in its
  // rebuild), PR 40 still open but its head is one of 41's commits.
  const lookedUp = [];
  const watched = [];
  const retired = [];
  stub(t, github, {
    isEnabled: () => true,
    getPR: async (_owner, _repo, number) => {
      lookedUp.push(number);
      return number === 41
        ? { merged: true, merged_at: '2026-10-14T09:00:00Z', merge_commit_sha: SHA('m') }
        : { merged: false };
    },
    listPullRequestCommitShas: async (_owner, _repo, number) => (number === 41
      ? { shas: [SHA('b'), SHA('c')], complete: true } : { shas: [], complete: true }),
    createIssueComment: async () => ({}),
    closePR: async () => ({}),
  });
  stub(t, watcher, {
    watchIssuesClosedAfterMerge: async (args) => { watched.push(args.prNumber); return { closed: [], skipped: [], stillOpen: [] }; },
  });
  stub(t, worker, { retireWorker: async (id) => { retired.push(Number(id)); } });

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const user = async () => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`rsm_${++seq}`])).rows[0];
  const author = await user();
  const voter = await user();
  const giver = await user();
  const { rows: [a] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, main_sha)
     VALUES ('Garden', 'garden', $1, false, 'https://github.com/acme/garden', $2) RETURNING *`,
    [author.id, SHA('0')]);
  const { rows: [conversation] } = await pool.query(
    `INSERT INTO agent_sessions (user_id) VALUES ($1) RETURNING id`, [author.id]);
  const proposal = async ({ status, pr, title, head, linked = [], extra = '', extraValues = [] }) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues, reviewed_head_sha,
                                promoted_at, merge_attempt_at, agent_session_id ${extra})
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes', $8
             ${extraValues.map((_, i) => `, $${9 + i}`).join('')})
     RETURNING *`,
    [a.id, author.id, status, pr, title, linked, head, conversation.id, ...extraValues])).rows[0];

  // The merge a restart cut off in its rebuild: GitHub merged it, the row
  // still says 'merging'. The declared value was applied before the rebuild
  // on a finalizer that got that far; this one did not.
  const cut = await proposal({ status: 'merging', pr: 41, title: 'Add a dark mode', head: SHA('c'), linked: [7] });
  // Built on it, up for a vote: its head is one of 41's commits.
  const stacked = await proposal({ status: 'promoted', pr: 40, title: 'Darker buttons', head: SHA('b') });
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [cut.id, voter.id]);
  await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`,
    [voter.id, a.id, cut.id]);
  await pool.query(`INSERT INTO issue_bounties (app_id, github_issue_number, giver_user_id, week_start) VALUES ($1, 7, $2, CURRENT_DATE)`,
    [a.id, giver.id]);
  await pool.query(
    `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, value_enc, created_by)
     VALUES ($1, $2, 'app', 'API_TOKEN', '{"private": true}', $3, $4)`,
    [a.id, cut.id, secrets.encrypt('tok-123', DATA_KEY), author.id]);

  // A merge recorded as merged whose finalizer died part-way through its
  // follow-ups: the funnel event was recorded, nothing after it.
  const resumed = await proposal({
    status: 'merged', pr: 42, title: 'Bigger seeds', head: SHA('d'),
    extra: ', merged_at, merge_commit_sha, merge_followups_due_at, merge_followups_done',
    extraValues: [new Date(Date.now() - 3 * 60 * 1000), SHA('e'), new Date(Date.now() - 3 * 60 * 1000), ['pr_merged']],
  });
  await pool.query(`INSERT INTO events (user_id, app_id, session_id, event_type) VALUES ($1, $2, $3, 'pr_merged')`,
    [author.id, a.id, resumed.id]);
  await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`,
    [voter.id, a.id, resumed.id]);

  // An ordinary merge a few minutes ago that owes nothing: only the boot's
  // issue-close resume watches it.
  const finished = await proposal({
    status: 'merged', pr: 43, title: 'Watering can', head: SHA('f'),
    extra: ', merged_at, merge_commit_sha', extraValues: [new Date(Date.now() - 5 * 60 * 1000), SHA('9')],
  });

  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
  const events = (s, type) => count('SELECT COUNT(*) AS n FROM events WHERE session_id = $1 AND event_type = $2', [s.id, type]);
  const lines = async (s) => (await pool.query(
    `SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`, [s.id])).rows.map((r) => r.content);
  const notes = (s) => count(
    `SELECT COUNT(*) AS n FROM chat_session_messages
      WHERE agent_session_id = $1 AND metadata->>'agentSessionEvent' = 'change_closed' AND (metadata->>'changeId')::int = $2`,
    [conversation.id, s.id]);
  const unreadAsks = (s) => count(
    `SELECT COUNT(*) AS n FROM notifications WHERE session_id = $1 AND kind = 'pr_proposed' AND read_at IS NULL`, [s.id]);

  // ── The boot sweep ──────────────────────────────────────────────────
  const out = await recoverStuckMerges(config);

  await t.test('the heal records the merge and runs what the merge still owed', async () => {
    const r = await row(cut.id);
    assert.equal(r.status, 'merged');
    assert.equal(r.merge_commit_sha, SHA('m'));
    assert.equal(r.merge_followups_due_at, null, 'nothing is owed once they have run');
    assert.deepEqual([...r.merge_followups_done].sort(), ['agent_note', 'merged_line', 'pr_merged']);
    assert.equal(r.active_users_at_merge != null, true, 'the tally read now is snapshotted for the pill');

    // The declared value is in place for the redelivery that follows.
    const { rows: [secret] } = await pool.query('SELECT value_enc FROM app_secrets WHERE app_id = $1 AND key = $2', [a.id, 'API_TOKEN']);
    assert.equal(secrets.decrypt(secret.value_enc, DATA_KEY), 'tok-123');
    const { rows: [decl] } = await pool.query('SELECT status FROM pending_secret_declarations WHERE session_id = $1', [cut.id]);
    assert.equal(decl.status, 'applied');

    assert.equal(await events(cut, 'pr_merged'), 1, 'the funnel event');
    const s = await row(stacked.id);
    assert.deepEqual([s.status, s.included_in_session_id], ['merged', cut.id], 'the change built on it is not up for a vote any more');
    assert.equal(await unreadAsks(cut), 0, 'the bell stops asking');
    assert.equal(await notes(cut), 1, 'the agent session hears it merged');
    assert.equal(await count(`SELECT COUNT(*) AS n FROM notifications WHERE session_id = $1 AND user_id = $2 AND kind = 'pr_merged'`,
      [cut.id, author.id]), 1, 'the author is told');
    const { rows: [bounty] } = await pool.query('SELECT status, awarded_user_id FROM issue_bounties WHERE app_id = $1', [a.id]);
    assert.deepEqual({ ...bounty }, { status: 'awarded', awarded_user_id: author.id });

    // Production does not run it yet (main_sha is the old build): the
    // announcement says it will be live, not that it is.
    const said = await lines(cut);
    const merged = said.filter((c) => /^Add a dark mode (merged|is live)/.test(c));
    assert.equal(merged.length, 1);
    assert.match(merged[0], /^Add a dark mode merged \(PR #41\) and will be live in a few minutes\. /);
    assert.ok(said.some((c) => /Secret "API_TOKEN" was declared and set/.test(c)), 'the declared value is said in its thread');
    assert.ok(said.some((c) => /^Bounty on issue #7/.test(c)));

    assert.ok(watched.includes(41), 'the heal starts the request watch itself');
    assert.ok(retired.includes(cut.id));
    assert.ok(out.followedUp.includes(cut.id));
  });

  await t.test('a merge whose follow-ups a restart cut off is resumed without repeating what it did', async () => {
    const r = await row(resumed.id);
    assert.equal(r.merge_followups_due_at, null);
    assert.equal(await events(resumed, 'pr_merged'), 1, 'recorded before the restart, not again');
    assert.equal(await notes(resumed), 1);
    assert.equal(await unreadAsks(resumed), 0);
    assert.equal((await lines(resumed)).filter((c) => /^Bigger seeds /.test(c)).length, 1);
    assert.ok(watched.includes(42));
    assert.ok(!lookedUp.includes(42), 'a merge already recorded needs no GitHub lookup');
    assert.ok(out.followedUp.includes(resumed.id));
  });

  await t.test('the boot\'s issue-close resume leaves the ones the heal watched, and watches the rest', async () => {
    watched.length = 0;
    await resumeIssueCloseWatches(config, { skip: out.followedUp });
    assert.deepEqual(watched, [43], `only #${finished.pr_number}: #41 and #42 are already watched`);
  });

  await t.test('a second sweep finds nothing owed and repeats nothing', async () => {
    watched.length = 0;
    const again = await recoverStuckMerges(config);
    assert.deepEqual(again.followedUp, []);
    assert.equal(await events(cut, 'pr_merged'), 1);
    assert.equal(await notes(cut), 1);
    assert.equal((await lines(cut)).filter((c) => /^Add a dark mode (merged|is live)/.test(c)).length, 1);
    assert.equal((await lines(resumed)).filter((c) => /^Bigger seeds /.test(c)).length, 1);
    assert.deepEqual(watched, []);
  });

  await t.test('follow-ups a live finalizer is still running are left to it', async () => {
    await pool.query(
      `UPDATE chat_sessions SET merge_followups_due_at = NOW(), merge_followups_done = '{pr_merged,agent_note}'
        WHERE id = $1`, [finished.id]);
    const mergeLock = require('../src/services/merge-finalization-lock');
    const release = await mergeLock.acquire(pool, finished.id);
    try {
      const held = await recoverStuckMerges(config);
      assert.deepEqual(held.followedUp, []);
      assert.notEqual((await row(finished.id)).merge_followups_due_at, null, 'still owed');
    } finally {
      await release();
    }
    const freed = await recoverStuckMerges(config);
    assert.deepEqual(freed.followedUp, [finished.id], 'once the lock is free, the next sweep runs them');
    assert.equal((await lines(finished)).filter((c) => /^Watering can /.test(c)).length, 1);
    assert.equal(await notes(finished), 0, 'the note it had sent is not sent again');
  });
});
