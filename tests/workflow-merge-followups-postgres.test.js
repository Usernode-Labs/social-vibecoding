'use strict';

// The merge-followups machine (src/workflow/merge-followups/) against the
// full PostgreSQL schema: one subtest per guarantee F1-F9 in the workflow
// foundation's guarantee list (machine-merge-followups.md §11), plus the
// fixes it makes to [main]'s merge tail. Work kinds are faked here, each
// recording what it was asked; services.ts has its own tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { mergeFollowups, sessionKey, MACHINE, NOTIFIERS, WORK } = require('../src/workflow/merge-followups/machine.ts');
const secrets = require('../src/services/secrets');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DATA_KEY = 'synthetic-merge-followups-key';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('merge-followups machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_merge_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  // The flag, as platform.ts syncSettings records it at boot.
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:merge-followups', '1') ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`mf_${++seq}`]);
    return u;
  }
  async function app({ selfHosted = false } = {}) {
    const owner = await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url)
       VALUES ($1::text, $1::text, $2, $3, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`mf-app-${++seq}`, owner.id, selfHosted]);
    return a;
  }
  async function proposal(a, { author, status = 'merging', pr = ++seq, linked = [], title = `Change ${seq}`, extra = {} } = {}) {
    const by = author || await user();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues, reviewed_head_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [a.id, by.id, status, pr, title, linked, extra.head || null]);
    return { ...s, author: by };
  }
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const lines = async (s) => (await pool.query(
    `SELECT content, metadata FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1 ORDER BY id`, [s.id])).rows;
  const events = async (s, type) => (await pool.query(
    'SELECT * FROM events WHERE session_id = $1 AND event_type = $2 ORDER BY id', [s.id, type])).rows;
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const workOf = async (s) => (await pool.query(
    'SELECT kind, work_key, input, status FROM wf_work WHERE machine = $1 AND key = $2 ORDER BY created_at, work_key',
    [MACHINE, sessionKey(s.id)])).rows;

  const notified = [];
  const notifiers = Object.fromEntries(NOTIFIERS.map((n) => [n, (x) => { notified.push(x); }]));
  // What browsers hear: published in the transition's transaction.
  const pushed = [];
  // Fake work: records each call; `results` answers per kind, `fail` makes
  // a kind throw (permanently when asked).
  const work = { calls: [], results: new Map(), fail: new Map(), seen: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (kind === WORK.teardown) work.seen.set(input.sessionId, (await row(input.sessionId)).status);
      const failure = work.fail.get(kind);
      if (failure) throw Object.assign(new Error(`${kind} down`), { permanent: failure === 'permanent' });
      const r = work.results.get(kind);
      return typeof r === 'function' ? r(input) : (r || { ok: true });
    },
  });
  const machine = mergeFollowups({ dataKey: DATA_KEY, notifiers });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);

  let rk = 0;
  const send = (s, type, payload, source = { kind: 'system' }) => rt.append(machine, sessionKey(s.id), { type, payload },
    { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after FROM wf_events WHERE id = $1', [id])).rows[0];
  const merge = async (s, extra = {}) => {
    const id = await send(s, 'Merged', {
      sessionId: s.id, mergeSha: SHA('a'), mergedAt: new Date().toISOString(),
      tally: { yes: 2, required: 2, active: 3 }, observedBy: 'merge', ...extra,
    });
    await rt.drain();
    return outcome(id);
  };

  await t.test('F1: the merge commits with its writes and its follow-up set', async () => {
    const a = await app();
    const giver = await user();
    const s = await proposal(a, { linked: [7] });
    await pool.query(`INSERT INTO issue_bounties (app_id, github_issue_number, giver_user_id, week_start) VALUES ($1, 7, $2, CURRENT_DATE)`, [a.id, giver.id]);
    await pool.query(
      `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, value_enc, created_by)
       VALUES ($1, $2, 'app', 'API_TOKEN', '{"private": true}', $3, $4)`,
      [a.id, s.id, secrets.encrypt('tok-123', DATA_KEY), s.author.id]);
    assert.equal((await merge(s)).result, 'accepted');

    const r = await row(s.id);
    assert.equal(r.status, 'merged');
    assert.equal(r.merge_commit_sha, SHA('a'));
    assert.equal(r.votes_required, 2);
    assert.equal(r.active_users_at_merge, 3);
    assert.equal(r.live_at, null, 'merged is not live yet');
    const { rows: [secret] } = await pool.query('SELECT value_enc FROM app_secrets WHERE app_id = $1 AND key = $2', [a.id, 'API_TOKEN']);
    assert.equal(secrets.decrypt(secret.value_enc, DATA_KEY), 'tok-123');
    const { rows: [decl] } = await pool.query('SELECT status, value_enc FROM pending_secret_declarations WHERE session_id = $1', [s.id]);
    assert.deepEqual({ ...decl }, { status: 'applied', value_enc: null });
    assert.equal((await events(s, 'pr_merged')).length, 1);
    assert.equal((await events(s, 'bounty_awarded')).length, 1);
    const { rows: [bounty] } = await pool.query('SELECT status, awarded_user_id FROM issue_bounties WHERE app_id = $1', [a.id]);
    assert.deepEqual({ ...bounty }, { status: 'awarded', awarded_user_id: s.author.id });
    const said = (await lines(s)).map((l) => l.content);
    assert.ok(said.some((c) => /Secret "API_TOKEN" was declared and set/.test(c)));
    assert.ok(said.some((c) => /Bounty on issue #7/.test(c)));
    assert.ok(!said.some((c) => /is live/.test(c)), 'nothing says live yet');
    // The preview waits for the delivery's result (demo mode deploys its build).
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.deliver, WORK.bot, WORK.find, WORK.issues, WORK.mainCheck, WORK.retire].sort());
  });

  await t.test('F2: a merge observed by recovery gets the same follow-ups', async () => {
    const a = await app();
    const s = await proposal(a, { status: 'promoted', linked: [3] });
    assert.equal((await merge(s, { observedBy: 'recovery', tally: null })).result, 'accepted');
    assert.equal((await row(s.id)).status, 'merged');
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.deliver, WORK.bot, WORK.find, WORK.issues, WORK.mainCheck, WORK.retire].sort());
    assert.equal((await events(s, 'pr_merged')).length, 1);
  });

  await t.test('F3: follow-ups survive until a service runs them', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    // Nothing ran yet (a crash right after the merge leaves exactly this).
    assert.ok((await workOf(s)).every((w) => w.status === 'queued'));
    work.results.set(WORK.deliver, { sha: SHA('a') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    const statuses = Object.values((await instance(s)).data.followups).map((f) => f.status);
    assert.ok(statuses.every((st) => st === 'done'), statuses.join());
  });

  await t.test('F4: once per merge, however often it is observed', async () => {
    const a = await app();
    const s = await proposal(a, { linked: [9] });
    await merge(s);
    const again = await merge(s, { observedBy: 'recovery' });
    assert.deepEqual({ result: again.result, reason: again.reason }, { result: 'rejected', reason: 'already_merged' });
    assert.equal((await events(s, 'pr_merged')).length, 1);
    work.results.set(WORK.deliver, { sha: SHA('a') });
    await settle();
    // A second delivery report (the rebuild's own Deployed) changes nothing.
    const late = await send(s, 'Deployed', { sha: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(late)).reason, 'already_live');
    assert.equal((await lines(s)).filter((l) => /is live/.test(l.content)).length, 1);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [s.id]);
    assert.equal(rows[0].n, 1);
  });

  await t.test('F5: merged before live; "is live" only after the deploy', async () => {
    const a = await app();
    const voter = await user();
    const s = await proposal(a, { title: 'Dark mode' });
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [s.id, voter.id]);
    // The voter was asked to vote: a bell row about the change.
    await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`, [voter.id, a.id, s.id]);
    await merge(s);
    assert.ok(pushed.some((p) => p.kind === 'user' && p.routing.userId === voter.id && p.data.type === 'notifications_changed'),
      'everyone with a bell row about it re-reads their bell when it merges');
    assert.equal((await row(s.id)).live_at, null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [s.id])).rows[0].n, 0);
    work.results.set(WORK.deliver, { sha: SHA('a') });
    await settle();
    const r = await row(s.id);
    assert.ok(r.live_at, 'live once delivered');
    const live = (await lines(s)).find((l) => /is live/.test(l.content));
    assert.match(live.content, /^Dark mode is live \(PR #\d+\)\. Built by mf_\d+, backed by mf_\d+\. \(2\/3 votes\)$/);
    assert.equal(live.metadata.merged.votes, '2/3');
    assert.equal(live.metadata.wfEvent > 0, true);
    const kinds = work.calls.filter((c) => c.input.sessionId === s.id).map((c) => c.kind);
    assert.ok(kinds.includes(WORK.dm) && kinds.includes(WORK.journey), 'the DM and the journey record follow live');
    const dm = work.calls.find((c) => c.kind === WORK.dm && c.input.sessionId === s.id);
    assert.equal(dm.input.sha, SHA('a'));
    const heard = pushed.filter((p) => p.routing.appId === a.id);
    assert.ok(heard.some((p) => p.kind === 'scoped' && p.data.type === 'app_version_changed' && p.data.sha === SHA('a')), 'the version pill');
    assert.ok(heard.some((p) => p.kind === 'room' && p.data.type === 'chat' && p.data.content === live.content && p.data.id > 0
      && p.data.metadata.merged.votes === '2/3' && !('wfEvent' in p.data.metadata)), 'the line, as the room shows it');
    assert.ok(pushed.some((p) => p.data.type === 'vote_update' && p.data.sessionId === s.id && p.data.live === true), 'the vote card');
    // The author's "your change is live", named for the relaying web process to read.
    const { rows: [n] } = await pool.query(`SELECT id FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [s.id]);
    const toAuthor = pushed.filter((p) => p.kind === 'user' && p.routing.userId === s.author.id);
    assert.ok(toAuthor.some((p) => p.data.type === 'notification_new' && p.data.notificationId === n.id && !p.data.notification));
    // The requests it closed: the issue lists re-read once that work ended.
    assert.ok(heard.some((p) => p.data.type === 'issue_update' && p.data.action === 'github_synced' && p.data.source === 'pr_merged'));
    // Kicks into flows not migrated yet, once, where it decided.
    assert.ok(notified.some((x) => x.type === 'badgeSync' && x.sessionId === s.id), 'the phone badges of everyone with a bell row');
    assert.ok(notified.some((x) => x.type === 'boardChange' && x.appId === a.id), 'the Workshop re-places the requests it closed');
  });

  await t.test('F6: a failed deploy is visible, and a later deploy makes it live', async () => {
    const a = await app();
    const s = await proposal(a);
    work.fail.set(WORK.deliver, 'permanent');
    await merge(s);
    await settle();
    work.fail.delete(WORK.deliver);
    assert.equal((await instance(s)).state, 'deploy_failed');
    assert.ok((await lines(s)).some((l) => /production deploy failed: app\.deliver down/.test(l.content)));
    assert.equal((await row(s.id)).live_at, null);
    // The drift poller later deploys main's tip, which GitHub says contains it.
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.sha === SHA('c') }));
    await send(s, 'Deployed', { sha: SHA('b') });
    await settle();
    assert.equal((await instance(s)).state, 'deploy_failed', 'a build without the merge is not live');
    await send(s, 'Deployed', { sha: SHA('c') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    assert.equal((await instance(s)).data.deliveredSha, SHA('c'));
    assert.ok((await row(s.id)).live_at);
    assert.ok((await lines(s)).some((l) => /is live/.test(l.content)));

    // An admin's retry re-delivers under a new work key.
    const s2 = await proposal(a);
    work.fail.set(WORK.deliver, 'permanent');
    await merge(s2);
    await settle();
    work.fail.delete(WORK.deliver);
    const retry = await send(s2, 'RetryDelivery', {}, { kind: 'admin' });
    await rt.drain();
    assert.equal((await outcome(retry)).state_after, 'delivering');
    work.results.set(WORK.deliver, { sha: SHA('a') });
    await settle();
    assert.equal((await instance(s2)).state, 'live');
    assert.ok((await workOf(s2)).some((w) => w.work_key === 'deliver~2'));
    // Only an admin may.
    const refused = await send(s2, 'RetryDelivery', {}, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(refused)).reason, 'admin_only');
  });

  await t.test('F7: declared secret values are applied with the merge, never discarded', async () => {
    const a = await app();
    const s = await proposal(a, { status: 'promoted' });
    await pool.query(
      `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, value_enc, created_by)
       VALUES ($1, $2, 'app', 'GOOD', '{}', $3, $4), ($1, $2, 'platform', 'DATABASE_URL', '{}', $3, $4)`,
      [a.id, s.id, secrets.encrypt('v', DATA_KEY), s.author.id]);
    // Observed late by recovery, as after a crash.
    await merge(s, { observedBy: 'recovery' });
    const { rows } = await pool.query('SELECT key, status, value_enc FROM pending_secret_declarations WHERE session_id = $1 ORDER BY key', [s.id]);
    assert.deepEqual(rows.map((r) => [r.key, r.status, r.value_enc]), [['DATABASE_URL', 'discarded', null], ['GOOD', 'applied', null]]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_secrets WHERE app_id = $1 AND key = $2', [a.id, 'GOOD'])).rows[0].n, 1);
    assert.ok((await lines(s)).some((l) => /Couldn't apply the value declared with this proposal for DATABASE_URL/.test(l.content)));
  });

  await t.test('F8: included changes are marked under their own lock and go live with their carrier', async () => {
    const a = await app();
    const carrier = await proposal(a, { title: 'Fix' });
    const carried = await proposal(a, { status: 'promoted', linked: [4], title: 'First version' });
    const busy = await proposal(a, { status: 'promoted' });
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"id":"t"}'::jsonb WHERE id = $1`, [busy.id]);
    work.results.set(WORK.find, (input) => ({ ids: input.sessionId === carrier.id ? [carried.id, busy.id] : [] }));
    await merge(carrier);
    // Run everything but the carrier's delivery: its deploy is still running.
    await pool.query(`UPDATE wf_work SET status = 'settled' WHERE key = $1 AND kind = $2`, [sessionKey(carrier.id), WORK.deliver]);
    await settle();
    const r = await row(carried.id);
    assert.equal(r.status, 'merged');
    assert.equal(r.included_in_session_id, carrier.id);
    assert.equal(r.merge_commit_sha, SHA('a'));
    assert.equal(r.live_at, null, 'not live before its carrier');
    assert.equal((await instance(carried)).state, 'delivering');
    assert.equal((await events(carried, 'pr_merged'))[0].metadata.includedIn, carrier.id);
    // Not "went live" while its carrier is not live (review finding 6).
    const said = (await lines(carried)).map((l) => l.content);
    assert.ok(said.some((c) => /was merged as part of PR #\d+: Fix, which was built on it, and goes live with it/.test(c)), said.join(' | '));
    assert.ok(!said.some((c) => /went live|is live/.test(c)));
    const closePr = (await workOf(carried)).find((w) => w.kind === WORK.closePr);
    assert.match(closePr.input.comment, /^Included in #\d+, which merged\.$/);
    assert.ok(!(await workOf(carried)).some((w) => w.kind === WORK.deliver), 'its carrier delivers it');
    // The busy one moved on: left as it was, and free to merge on its own later.
    assert.equal(await instance(busy), undefined);
    assert.equal((await row(busy.id)).status, 'promoted');
    const { rows: [refusal] } = await pool.query(
      `SELECT result, reason FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'Included'`, [MACHINE, sessionKey(busy.id)]);
    assert.deepEqual({ ...refusal }, { result: 'rejected', reason: 'turn_running' });
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [busy.id]);
    assert.equal((await merge(busy)).result, 'accepted');
    // The carrier goes live (its own rebuild reports the merge commit), and so does what it carried.
    await send(carrier, 'Deployed', { sha: SHA('a') });
    await settle();
    assert.equal((await instance(carrier)).state, 'live');
    assert.equal((await instance(carried)).state, 'live');
    assert.ok((await row(carried.id)).live_at);
    assert.ok((await lines(carried)).some((l) => /is live, as part of PR #\d+: Fix\./.test(l.content)), 'and now it says so');
    const { rows: [n] } = await pool.query(`SELECT detail FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [carried.id]);
    assert.match(n.detail, /^Included in #\d+, which went live\.$/);
  });

  await t.test('F9: the preview teardown reads the row as merged', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    await settle();
    assert.equal(work.seen.get(s.id), 'merged');
  });

  await t.test('a delivery is live only if what it deployed contains the merge (review finding 1)', async () => {
    const a = await app();
    const s = await proposal(a);
    // The rebuild deployed main's tip, which (main rewritten) does not contain the merge.
    work.results.set(WORK.deliver, { sha: SHA('b') });
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: false }));
    await merge(s);
    await settle();
    assert.equal((await instance(s)).state, 'delivering', 'not live on the rebuild\'s word');
    assert.equal((await row(s.id)).live_at, null);
    assert.ok((await workOf(s)).some((w) => w.work_key === `verify:${SHA('b')}`), 'checked against GitHub');
    assert.ok(!(await lines(s)).some((l) => /is live/.test(l.content)));
    // A later deploy that does contain it makes it live.
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: true }));
    await send(s, 'Deployed', { sha: SHA('c') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    assert.equal((await instance(s)).data.deliveredSha, SHA('c'));
    work.results.set(WORK.deliver, { sha: SHA('a') });
  });

  await t.test('a platform merge recorded after its release booted checks the running build (review finding 2)', async () => {
    const a = await app({ selfHosted: true });
    // The release that contains the merge already booted when recovery records it.
    const booted = (...entries) => JSON.stringify(entries.map(([sha, ago]) => ({ sha, at: new Date(Date.now() - ago).toISOString() })));
    await pool.query('UPDATE apps SET booted_shas = $1 WHERE id = $2', [booted([SHA('a'), 0]), a.id]);
    const s = await proposal(a);
    await merge(s, { observedBy: 'recovery' });
    assert.equal((await instance(s)).state, 'live');
    assert.ok((await row(s.id)).live_at);
    // A running build that is not the merge commit is checked against GitHub.
    const b = await app({ selfHosted: true });
    await pool.query('UPDATE apps SET booted_shas = $1 WHERE id = $2', [booted([SHA('d'), 0]), b.id]);
    const s2 = await proposal(b);
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.sha === SHA('d') }));
    await merge(s2, { observedBy: 'recovery' });
    assert.ok((await workOf(s2)).some((w) => w.work_key === `verify:${SHA('d')}`));
    await settle();
    assert.equal((await instance(s2)).state, 'live');
    // main_sha is the migration's word for the incoming release, before it
    // serves (review finding, second pass): it is never taken for live.
    const c = await app({ selfHosted: true });
    await pool.query('UPDATE apps SET main_sha = $1 WHERE id = $2', [SHA('a'), c.id]);
    const s3 = await proposal(c);
    await merge(s3, { observedBy: 'recovery' });
    assert.equal((await instance(s3)).state, 'delivering');
    assert.equal((await row(s3.id)).live_at, null);

    // A rollout: build A (it contains the merge) booted, then an older Pod of
    // build C booted after it. Both ran since the merge; A makes it live
    // (review finding, third pass: a single last-boot column lost A).
    const r = await app({ selfHosted: true });
    await pool.query('UPDATE apps SET booted_shas = $1 WHERE id = $2',
      [booted([SHA('c'), 60 * 1000], [SHA('b'), 2 * 60 * 1000], [SHA('e'), 3 * 60 * 60 * 1000]), r.id]);
    const s4 = await proposal(r);
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.sha === SHA('b') }));
    await merge(s4, { observedBy: 'recovery', mergedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const keys = (await workOf(s4)).filter((w) => w.kind === WORK.verify).map((w) => w.work_key).sort();
    assert.deepEqual(keys, [`verify:${SHA('b')}`, `verify:${SHA('c')}`], 'every build booted since the merge; not one booted hours before it');
    await settle();
    assert.equal((await instance(s4)).state, 'live');
    assert.equal((await instance(s4)).data.deliveredSha, SHA('b'));
  });

  await t.test('the platform\'s own app is live when its release boots', async () => {
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    await merge(s);
    assert.ok(!(await workOf(s)).some((w) => w.kind === WORK.deliver), 'no rebuild for the self-hosted app');
    assert.ok(notified.some((n) => n.type === 'nudgeDeployer' && n.sha === SHA('a')));
    await settle();
    assert.equal((await instance(s)).state, 'delivering');
    await send(s, 'Deployed', { sha: SHA('a') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    assert.ok((await lines(s)).some((l) => /is live/.test(l.content)));
  });

  await t.test('only a promoted or merging proposal can be merged, and only the machine moves it', async () => {
    const a = await app();
    const s = await proposal(a, { status: 'active' });
    assert.equal((await merge(s)).reason, 'not_merging');
    assert.equal(await instance(s), undefined, 'a refused creation leaves no instance');
    const m = await proposal(a, { status: 'promoted' });
    await assert.rejects(pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [m.id]), /WF_OWNERSHIP_VIOLATION/);
    await merge(m);
    await assert.rejects(pool.query('UPDATE chat_sessions SET merge_commit_sha = NULL WHERE id = $1', [m.id]), /WF_OWNERSHIP_VIOLATION/);
    // Outside sources cannot append the internal events.
    const forged = await send(m, 'Deployed', { sha: SHA('a') }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(forged)).reason, 'internal_only');
  });

  // ── Fixed in the steps 1-2 fix (workflow-foundation design-fix-steps-1-2.md) ──

  await t.test('the preview goes once its delivery has a result: demo mode deploys the preview\'s build', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    assert.ok(!(await workOf(s)).some((w) => w.kind === WORK.teardown), 'not while the delivery may still reuse it');
    work.calls.length = 0;
    await settle();
    const order = work.calls.filter((c) => c.input.sessionId === s.id).map((c) => c.kind);
    assert.ok(order.includes(WORK.teardown), 'requested by the delivery\'s result');
    assert.ok(order.indexOf(WORK.deliver) < order.indexOf(WORK.teardown), order.join(', '));
    // A delivery that failed for good lets it go too.
    const failed = await proposal(a);
    work.fail.set(WORK.deliver, 'permanent');
    try {
      await merge(failed);
      await settle();
    } finally { work.fail.delete(WORK.deliver); }
    assert.equal((await instance(failed)).state, 'deploy_failed');
    assert.ok((await workOf(failed)).some((w) => w.kind === WORK.teardown));
    // The platform's own app has no delivery here: its preview goes at once.
    const own = await proposal(await app({ selfHosted: true }));
    await merge(own);
    assert.ok((await workOf(own)).some((w) => w.kind === WORK.teardown));
  });

  await t.test('a shots run still in the worker: its retire is asked again later, never used up', async () => {
    const a = await app();
    const s = await proposal(a);
    work.results.set(WORK.retire, { waiting: 'a'.repeat(32) });
    try {
      await merge(s);
      await settle();
    } finally { work.results.delete(WORK.retire); }
    const { rows } = await pool.query(
      `SELECT work_key, status, due_at > NOW() + INTERVAL '90 seconds' AS later
         FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at`,
      [MACHINE, sessionKey(s.id), WORK.retire]);
    assert.equal(rows.length, 2, 'the first answer named the run; a second retire waits');
    assert.equal(rows[0].status, 'settled');
    assert.match(rows[1].work_key, /^worker~\d+$/);
    assert.deepEqual([rows[1].status, rows[1].later], ['queued', true], 'about two minutes later');
    assert.equal((await instance(s)).data.followups[rows[1].work_key].status, 'pending');
  });

  await t.test('a carried change is left alone when its head moved, or shots or checks are running on it', async () => {
    const a = await app();
    const carrier = await proposal(a, { title: 'Carrier' });
    const moved = await proposal(a, { status: 'promoted', extra: { head: SHA('1') } });
    const shooting = await proposal(a, { status: 'promoted', extra: { head: SHA('2') } });
    const checking = await proposal(a, { status: 'promoted', extra: { head: SHA('3') } });
    const idle = await proposal(a, { status: 'promoted', extra: { head: SHA('4') } });
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trace_summary)
       VALUES ($1, $2, $3, $4, '{}', 'exploring', '{"progress": {}}')`,
      [crypto.randomBytes(16).toString('hex'), shooting.id, SHA('0'), SHA('2')]);
    await pool.query(`INSERT INTO check_runs (run_id, session_id, owner, manifest) VALUES ($1, $2, 'pod-a', '{}')`,
      [crypto.randomUUID(), checking.id]);
    work.results.set(WORK.find, (input) => (input.sessionId === carrier.id ? { found: [
      { id: moved.id, head: SHA('9') }, { id: shooting.id, head: SHA('2') },
      { id: checking.id, head: SHA('3') }, { id: idle.id, head: SHA('4') },
    ] } : { found: [] }));
    try {
      await merge(carrier);
      await pool.query(`UPDATE wf_work SET status = 'settled' WHERE key = $1 AND kind = $2`, [sessionKey(carrier.id), WORK.deliver]);
      await settle();
    } finally { work.results.delete(WORK.find); }
    const reason = async (c) => (await pool.query(
      `SELECT result, reason FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'Included'`, [MACHINE, sessionKey(c.id)])).rows[0];
    assert.deepEqual({ ...await reason(moved) }, { result: 'rejected', reason: 'head_moved' });
    assert.deepEqual({ ...await reason(shooting) }, { result: 'rejected', reason: 'shots_running' });
    assert.deepEqual({ ...await reason(checking) }, { result: 'rejected', reason: 'checks_running' });
    for (const c of [moved, shooting, checking]) assert.equal((await row(c.id)).status, 'promoted');
    assert.equal((await row(idle.id)).included_in_session_id, carrier.id, 'the idle one is carried');
  });

  await t.test('the bell settles what the decision answered, and tells the people it settled and everyone with a row about the change', async () => {
    const a = await app();
    const [digested, asked, read] = [await user(), await user(), await user()];
    const s = await proposal(a, { status: 'promoted' });
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)', [a.id, digested.id]);
    // A one-change digest that counted only this change (no session: a digest names none).
    await pool.query(`INSERT INTO notifications (user_id, app_id, kind, detail, created_at) VALUES ($1, $2, 'vote_digest', '1', NOW() + INTERVAL '1 second')`,
      [digested.id, a.id]);
    await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind) VALUES ($1, $2, $3, 'pr_proposed')`, [asked.id, a.id, s.id]);
    await pool.query(`INSERT INTO notifications (user_id, app_id, session_id, kind, read_at) VALUES ($1, $2, $3, 'pr_proposed', NOW())`, [read.id, a.id, s.id]);
    pushed.length = 0;
    await merge(s);
    const { rows: [digest] } = await pool.query(`SELECT read_at FROM notifications WHERE user_id = $1 AND kind = 'vote_digest'`, [digested.id]);
    assert.ok(digest.read_at, 'its one waiting change is decided, though the row still read promoted when it settled');
    const told = pushed.filter((p) => p.kind === 'user' && p.data.type === 'notifications_changed').map((p) => p.routing.userId).sort();
    // And everyone with a row about the change: its wording follows the change's status.
    assert.deepEqual(told, [digested.id, asked.id, read.id].sort());
  });

  await t.test('every web process stops listing the requests a merge closes, and re-reads when they close', async () => {
    const a = await app();
    const s = await proposal(a, { linked: [5, 6] });
    pushed.length = 0;
    await merge(s);
    const closed = pushed.filter((p) => p.kind === 'issues_closed');
    assert.deepEqual(closed.map((p) => [p.routing, p.data.numbers]), [[{ owner: 'acme', repo: a.slug }, [5, 6]]]);
    work.results.set(WORK.issues, { closed: [5], skipped: [], stillOpen: [9] });
    try { await settle(); } finally { work.results.delete(WORK.issues); }
    const ended = pushed.filter((p) => p.kind === 'issues_closed').at(-1);
    assert.deepEqual(ended.data, { numbers: [5], open: [9] }, 'what the work closed, and what it found still open, in every process');
  });

  await t.test('the merge's secret apply without the data key throws (failing its transition) instead of discarding held values', async () => {
    const { applyInTransaction } = require('../src/workflow/rules/pending-secret-apply.ts');
    const a = await app();
    const s = await proposal(a);
    await pool.query(
      `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, value_enc, created_by)
       VALUES ($1, $2, 'app', 'KEPT', '{}', $3, $4)`, [a.id, s.id, secrets.encrypt('v', DATA_KEY), s.author.id]);
    await assert.rejects(applyInTransaction(pool, { sessionId: s.id, dataKey: '' }), /data encryption key is not configured/);
    // A merge that declared nothing needs no key.
    const plain = await proposal(a);
    assert.deepEqual(await applyInTransaction(pool, { sessionId: plain.id, dataKey: '' }), { applied: [], refused: [] });
    const { rows: [held] } = await pool.query('SELECT status FROM pending_secret_declarations WHERE session_id = $1', [s.id]);
    assert.equal(held.status, 'pending', 'kept for a process that can read it');
  });

  await t.test('what counts as a shots run still using the worker: heard from lately, or a planned row just made', async () => {
    const { liveShotsRun } = require('../src/workflow/merge-followups/facts.ts');
    const a = await app();
    const run = async (state, { ago, progress = true } = {}) => {
      const s = await proposal(a);
      const id = crypto.randomBytes(16).toString('hex');
      await pool.query(
        `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trace_summary, updated_at)
         VALUES ($1, $2, $3, $4, '{}', $5, $6, NOW() - make_interval(secs => $7))`,
        [id, s.id, SHA('0'), SHA('1'), state, progress ? '{"progress": {}}' : null, ago]);
      return (await liveShotsRun(pool, s.id)) === id;
    };
    assert.equal(await run('exploring', { ago: 4 * 60 }), true, 'heartbeated four minutes ago');
    assert.equal(await run('exploring', { ago: 6 * 60 }), false, 'silent past five minutes: interrupted');
    assert.equal(await run('provisioning', { ago: 30 * 60, progress: false }), true, 'never reported progress: forty-five minutes');
    assert.equal(await run('planned', { ago: 30 }), true, 'just made, about to be claimed');
    assert.equal(await run('planned', { ago: 3 * 60 }), false, 'a planned row nobody claimed will never start');
    assert.equal(await run('failed', { ago: 0 }), false, 'finished');
  });
});
