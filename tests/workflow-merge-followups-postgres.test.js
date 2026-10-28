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
const { mergeFollowups, sessionKey, MACHINE, WORK } = require('../src/workflow/merge-followups/machine.ts');
// Kinds only older releases queued: none has a handler now, and none is
// queued again.
const OLD = Object.freeze({ deliver: 'app.deliver', bot: 'bot.requestMerged', dm: 'bot.dmMerged', live: 'bot.announceLive' });
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
  async function app({ selfHosted = false, demoMode = false } = {}) {
    const owner = await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, self_hosted, repo_url, demo_mode)
       VALUES ($1::text, $1::text, $2, $3, 'https://github.com/acme/' || $1::text, $4) RETURNING *`,
      [`mf-app-${++seq}`, owner.id, selfHosted, demoMode]);
    return a;
  }
  // `extra.preview`: the proposal has a built preview (its image and the
  // commit it ran), which a demo-mode deploy reuses.
  async function proposal(a, { author, status = 'merging', pr = ++seq, linked = [], title = `Change ${seq}`, extra = {} } = {}) {
    const by = author || await user();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues, reviewed_head_sha,
                                  staging_image_ref, staging_commit_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [a.id, by.id, status, pr, title, linked, extra.head || null,
        extra.preview ? `registry.example/preview:${seq}` : null, extra.preview ? SHA('a') : null]);
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

  // What browsers hear: published in the transition's transaction.
  const pushed = [];
  // Fake work: records each call; `results` answers per kind, `fail` makes
  // a kind throw (permanently when asked).
  const work = { calls: [], results: new Map(), fail: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      const failure = work.fail.get(kind);
      if (failure) throw Object.assign(new Error(`${kind} down`), { permanent: failure === 'permanent' });
      const r = work.results.get(kind);
      return typeof r === 'function' ? r(input) : (r || { ok: true });
    },
  });
  const machine = mergeFollowups({ dataKey: DATA_KEY });
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
  // A merge's deploy is asked of app-delivery by message. Its answers are
  // appended here as app-delivery's messages; the two machines together run
  // in tests/workflow-processes-postgres.test.js.
  const deliveryAnswer = (s, type, payload) => rt.append(machine, sessionKey(s.id), { type, payload },
    { requestKey: `t-${++rk}`, appId: s.app_id, source: { kind: 'message', from: { machine: 'app-delivery', key: `app:${s.app_id}`, eventId: 1 } } });
  const asked = async (a) => (await pool.query(
    `SELECT payload, source FROM wf_events WHERE machine = 'app-delivery' AND key = $1 ORDER BY id`, [`app:${a.id}`])).rows;
  // Its preview goes: the preview machine is asked, by a message from this
  // machine (src/workflow/preview/ retires it; not registered here).
  const retireAsked = async (s) => (await pool.query(
    `SELECT payload, source FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RetireRequested' ORDER BY id`,
    [`session:${s.id}`])).rows;
  // main's unit suite on the merge commit: the app's main-check machine is
  // asked, by a message from this machine (src/workflow/main-check/; not
  // registered here).
  const checkAsked = async (a) => (await pool.query(
    `SELECT payload, source FROM wf_events WHERE machine = 'main-check' AND key = $1 AND type = 'CheckRequested' ORDER BY id`,
    [`app:${a.id}`])).rows;
  // What it told the governance machine about a close proposal.
  const toldProposal = async (issueId) => (await pool.query(
    `SELECT type, payload, source FROM wf_events WHERE machine = 'governance-proposal' AND key = $1 ORDER BY id`,
    [`issue:${issueId}`])).rows;
  // Its deploy answered: production runs `sha`.
  const delivered = async (s, sha = SHA('a')) => { await settle(); await deliveryAnswer(s, 'Delivered', { sha }); await settle(); };
  const failedDelivery = async (s, message = 'the build broke') => {
    await settle(); await deliveryAnswer(s, 'DeliveryFailed', { message, missingSecrets: null }); await settle();
  };

  // A run of a proposal's shots in the shots machine's state, as its
  // transition would write it (src/workflow/shots/).
  const shotsUnderWay = async (sessionId, state) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(
        `INSERT INTO wf_instances (machine, key, state, data, version, machine_version) VALUES ('shots', $1, $2, $3::jsonb, 1, 1)
         ON CONFLICT (machine, key) DO UPDATE SET state = EXCLUDED.state`,
        [`session:${sessionId}`, state, JSON.stringify({ sessionId, run: { id: 'r'.repeat(32) } })]);
      await c.query('COMMIT');
    } finally { c.release(); }
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
    // #5249: kudos is parked, so the bounty is paid quietly: no line says so.
    assert.ok(!said.some((c) => /Bounty on issue #7/.test(c)), 'a parked bounty is paid without a line');
    assert.ok(!said.some((c) => /is live/.test(c)), 'nothing says live yet');
    // The deploy is asked of app-delivery; the preview waits for its answer
    // (demo mode deploys its build).
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.find, WORK.issues, WORK.retire].sort());
    assert.equal((await asked(a)).length, 1);
    // The merge commit's unit suite is the main-check machine's, asked in the
    // merge's own transaction.
    const [check] = await checkAsked(a);
    assert.deepEqual(check.payload, { appId: a.id, sha: SHA('a'), sessionId: s.id, prNumber: s.pr_number });
    assert.deepEqual([check.source.kind, check.source.from.machine, check.source.from.key], ['message', MACHINE, sessionKey(s.id)]);
  });

  await t.test('F2: a merge observed by recovery gets the same follow-ups', async () => {
    const a = await app();
    const s = await proposal(a, { status: 'promoted', linked: [3] });
    assert.equal((await merge(s, { observedBy: 'recovery', tally: null })).result, 'accepted');
    assert.equal((await row(s.id)).status, 'merged');
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.find, WORK.issues, WORK.retire].sort());
    assert.equal((await asked(a)).length, 1);
    assert.equal((await checkAsked(a)).length, 1);
    assert.equal((await events(s, 'pr_merged')).length, 1);
  });

  await t.test('F3: follow-ups survive until a service runs them', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    // Nothing ran yet (a crash right after the merge leaves exactly this).
    assert.ok((await workOf(s)).every((w) => w.status === 'queued'));
    await delivered(s);
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
    await delivered(s);
    // A second delivery report (a later deploy's Deployed) changes nothing.
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
    await delivered(s);
    const r = await row(s.id);
    assert.ok(r.live_at, 'live once delivered');
    const live = (await lines(s)).find((l) => /is live/.test(l.content));
    assert.match(live.content, /^Dark mode is live \(PR #\d+\)\. Built by mf_\d+, backed by mf_\d+\. \(2\/3 votes\)$/);
    assert.equal(live.metadata.merged.votes, '2/3');
    assert.equal(live.metadata.wfEvent > 0, true);
    const kinds = work.calls.filter((c) => c.input.sessionId === s.id).map((c) => c.kind);
    assert.ok(kinds.includes(WORK.journey), 'the journey record follows live');
    // The bot's DM and "It's live" are its change machine's, told by the
    // live's own write for a change of the bot's (workflow-bot-change-postgres).
    assert.ok(!kinds.includes(OLD.dm) && !kinds.includes(OLD.live) && !kinds.includes(OLD.bot));
    const heard = pushed.filter((p) => p.routing.appId === a.id);
    assert.ok(heard.some((p) => p.kind === 'scoped' && p.data.type === 'app_version_changed' && p.data.sha === SHA('a')), 'the version pill');
    assert.ok(heard.some((p) => p.kind === 'room' && p.data.type === 'chat' && p.data.content === live.content && p.data.id > 0
      && p.data.metadata.merged.votes === '2/3' && !('wfEvent' in p.data.metadata)), 'the line, as the room shows it');
    assert.ok(pushed.some((p) => p.data.type === 'vote_update' && p.data.sessionId === s.id && p.data.live === true), 'the vote card');
    // The author's "your change is live" row is still written (the phone push
    // rides it), but it is not pushed to open tabs (#5487): the bell hides a
    // merged change's rows, so prepending it live would flash a row the next
    // fetch drops and bump the badge for it.
    const { rows: [n] } = await pool.query(`SELECT id FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [s.id]);
    assert.ok(n, 'the author\'s went-live row is written');
    const toAuthor = pushed.filter((p) => p.kind === 'user' && p.routing.userId === s.author.id);
    assert.ok(toAuthor.every((p) => !(p.data.type === 'notification_new' && p.data.notificationId === n.id)),
      'no notification_new for the went-live row reaches the author');
    // The requests it closed: the issue lists re-read once that work ended.
    assert.ok(heard.some((p) => p.data.type === 'issue_update' && p.data.action === 'github_synced' && p.data.source === 'pr_merged'));
    // The Workshop re-places the requests it closed: the board change rides
    // the push every web process relays (no post-commit notifier).
    assert.ok(heard.some((p) => p.routing.boardChange === true && p.data.type === 'issue_update'), 'the board change, on the push');
  });

  await t.test('F6: a failed deploy is visible, and a later deploy makes it live', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    await failedDelivery(s);
    assert.equal((await instance(s)).state, 'deploy_failed');
    assert.ok((await lines(s)).some((l) => /production deploy failed: the build broke/.test(l.content)));
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

    // An admin's retry asks app-delivery again.
    const b = await app();
    const s2 = await proposal(b);
    await merge(s2);
    await failedDelivery(s2);
    const retry = await send(s2, 'RetryDelivery', {}, { kind: 'admin' });
    await rt.drain();
    assert.equal((await outcome(retry)).state_after, 'delivering');
    assert.equal((await asked(b)).length, 2);
    await delivered(s2);
    assert.equal((await instance(s2)).state, 'live');
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
    work.results.set(WORK.find, (input) => ({ found: input.sessionId === carrier.id ? [{ id: carried.id, head: null }, { id: busy.id, head: null }] : [] }));
    await merge(carrier);
    // Everything runs but the carrier's deploy, which app-delivery has not answered.
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
    assert.ok(!(await workOf(carried)).some((w) => w.kind === OLD.deliver), 'its carrier delivers it');
    // The busy one moved on: left as it was, and free to merge on its own later.
    assert.equal(await instance(busy), undefined);
    assert.equal((await row(busy.id)).status, 'promoted');
    const { rows: [refusal] } = await pool.query(
      `SELECT result, reason FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'Included'`, [MACHINE, sessionKey(busy.id)]);
    assert.deepEqual({ ...refusal }, { result: 'rejected', reason: 'turn_running' });
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [busy.id]);
    assert.equal((await merge(busy)).result, 'accepted');
    // The carrier goes live (its own deploy runs the merge commit), and so does what it carried.
    await delivered(carrier);
    assert.equal((await instance(carrier)).state, 'live');
    assert.equal((await instance(carried)).state, 'live');
    assert.ok((await row(carried.id)).live_at);
    assert.ok((await lines(carried)).some((l) => /is live, as part of PR #\d+: Fix\./.test(l.content)), 'and now it says so');
    const { rows: [n] } = await pool.query(`SELECT detail FROM notifications WHERE session_id = $1 AND kind = 'pr_merged'`, [carried.id]);
    assert.match(n.detail, /^Included in #\d+, which went live\.$/);
    // Who carried it is the machine's; only the foreign key's own SET NULL,
    // when the carrier is deleted (a demo reset), gets past the guard.
    await assert.rejects(pool.query('UPDATE chat_sessions SET included_in_session_id = $2 WHERE id = $1', [carried.id, busy.id]),
      /WF_OWNERSHIP_VIOLATION: chat_sessions.included_in_session_id/);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [carrier.id]);
    assert.equal((await row(carried.id)).included_in_session_id, null);
  });

  await t.test('F9: the preview is retired by the preview machine, asked once by message', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    await delivered(s);
    const asks = await retireAsked(s);
    assert.equal(asks.length, 1);
    assert.deepEqual(asks[0].payload, { sessionId: s.id, reason: 'merged', terminal: true });
    assert.equal(asks[0].source.kind, 'message');
    assert.deepEqual([asks[0].source.from.machine, asks[0].source.from.key], [MACHINE, sessionKey(s.id)]);
    assert.deepEqual((await instance(s)).data.followups.teardown, { kind: 'preview.retire', input: { sessionId: s.id }, status: 'done' },
      'recorded done, so no later answer asks again');
    assert.ok(!(await workOf(s)).some((w) => w.kind === 'preview.teardown'), 'no teardown work of its own');
    // A later deploy's report changes nothing.
    await send(s, 'Deployed', { sha: SHA('a') });
    await settle();
    assert.equal((await retireAsked(s)).length, 1);
  });

  await t.test('a delivery is live only if what it deployed contains the merge (review finding 1)', async () => {
    const a = await app();
    const s = await proposal(a);
    // The deploy ran main's tip, which (main rewritten) does not contain the merge.
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: false }));
    await merge(s);
    await delivered(s, SHA('b'));
    assert.equal((await instance(s)).state, 'delivering', 'not live on the deploy\'s word');
    assert.equal((await row(s.id)).live_at, null);
    assert.ok((await workOf(s)).some((w) => w.work_key === `verify:${SHA('b')}`), 'checked against GitHub');
    assert.ok(!(await lines(s)).some((l) => /is live/.test(l.content)));
    // A later deploy that does contain it makes it live.
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: true }));
    await send(s, 'Deployed', { sha: SHA('c') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    assert.equal((await instance(s)).data.deliveredSha, SHA('c'));
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
    assert.ok(!(await workOf(s)).some((w) => w.kind === OLD.deliver), 'no rebuild for the self-hosted app');
    // The host deployer's nudge is durable work now, not a notifier.
    assert.equal((await workOf(s)).find((w) => w.kind === WORK.nudge)?.input?.sha, SHA('a'));
    await settle();
    assert.equal((await instance(s)).state, 'delivering');
    await send(s, 'Deployed', { sha: SHA('a') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
    assert.ok((await lines(s)).some((l) => /is live/.test(l.content)));
  });

  await t.test('a merge into another pull request\'s branch goes live with the merge that carried it to main', async () => {
    // #5957 merged into #5956's branch (its commit never reached main), then
    // #5956's squash brought both to main.
    const a = await app({ selfHosted: true });
    const carrier = await proposal(a);
    const stacked = await proposal(a);
    // An open change built on the stacked one went in with its merge.
    const built = await proposal(a, { status: 'promoted' });
    work.results.set(WORK.find, (input) => ({ found: input.sessionId === stacked.id ? [{ id: built.id, head: null }] : [] }));
    await merge(stacked, { mergeSha: SHA('b') });
    await settle();
    assert.equal((await row(built.id)).included_in_session_id, stacked.id);
    work.results.delete(WORK.find);
    await merge(carrier, { mergeSha: SHA('c') });
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.mergeSha === input.sha,
      status: input.mergeSha === input.sha ? 'identical' : 'diverged' }));
    work.results.set(WORK.carrier, (input) => (input.sessionId === stacked.id && input.release === SHA('c')
      ? { carrier: { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title, mergeSha: SHA('c') } }
      : { carrier: null }));
    try {
      await settle();
      for (const s of [carrier, stacked]) await send(s, 'Deployed', { sha: SHA('c') });
      await settle();
      assert.equal((await instance(carrier)).state, 'live');
      assert.ok(!(await workOf(carrier)).some((w) => w.kind === WORK.carrier), 'a merge in the build looks for no carrier');
      const looked = (await workOf(stacked)).filter((w) => w.kind === WORK.carrier);
      assert.deepEqual(looked.map((w) => [w.work_key, w.input.mergeSha, w.input.release]), [[`carrier:${SHA('c')}`, SHA('b'), SHA('c')]]);
      const i = await instance(stacked);
      assert.equal(i.state, 'live');
      assert.equal(i.data.deliveredSha, SHA('c'));
      assert.deepEqual(i.data.carriedBy, { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title });
      // Its page reads "Live, included in" the carrier, whose Undo is its own.
      const r = await row(stacked.id);
      assert.ok(r.live_at);
      assert.equal(r.merge_commit_sha, SHA('c'));
      assert.equal(r.included_in_session_id, carrier.id);
      assert.ok((await lines(stacked)).some((l) => /is live/.test(l.content)));
      // What the stacked merge carried names the commit on main too.
      assert.equal((await instance(built)).state, 'live');
      assert.equal((await row(built.id)).merge_commit_sha, SHA('c'));

      // No carrier in a build: it waits, and looks again in the next build,
      // once each, from where the last look got to.
      const lone = await proposal(a);
      await merge(lone, { mergeSha: SHA('e') });
      await settle();
      const scan = { mergedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), id: carrier.id, recheck: [carrier.id] };
      work.results.set(WORK.carrier, (input) => (input.sessionId === lone.id ? { carrier: null, scanned: scan } : { carrier: null }));
      for (const sha of [SHA('f'), SHA('f'), SHA('9')]) { await send(lone, 'Deployed', { sha }); await settle(); }
      assert.equal((await instance(lone)).state, 'delivering');
      const looks = (await workOf(lone)).filter((w) => w.kind === WORK.carrier);
      assert.deepEqual(looks.map((w) => w.work_key).sort(), [`carrier:${SHA('9')}`, `carrier:${SHA('f')}`]);
      assert.deepEqual((await instance(lone)).data.carrierScan, scan);
      assert.deepEqual(looks.find((w) => w.work_key === `carrier:${SHA('9')}`).input.after, scan);
      // A build behind the merge (older than it) is no reason to look.
      work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: false, status: 'behind' }));
      await send(lone, 'Deployed', { sha: SHA('6') });
      await settle();
      assert.ok((await workOf(lone)).some((w) => w.work_key === `verify:${SHA('6')}`));
      assert.ok(!(await workOf(lone)).some((w) => w.work_key === `carrier:${SHA('6')}`));
      work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.mergeSha === input.sha,
        status: input.mergeSha === input.sha ? 'identical' : 'diverged' }));
      assert.equal((await row(lone.id)).included_in_session_id, null);

      // A merge more than a month old stuck for good asks GitHub nothing more.
      const old = await proposal(a);
      await merge(old, { mergeSha: SHA('7'), mergedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() });
      await settle();
      await send(old, 'Deployed', { sha: SHA('8') });
      await settle();
      assert.ok((await workOf(old)).some((w) => w.work_key === `verify:${SHA('8')}`), 'its own commit is still checked');
      assert.ok(!(await workOf(old)).some((w) => w.kind === WORK.carrier));
    } finally {
      work.results.delete(WORK.verify);
      work.results.delete(WORK.carrier);
    }
  });

  await t.test('carried.find reads the app\'s later merges from the database, a page at a time from the last ruled out', async (t2) => {
    const github = require('../src/services/github');
    const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
    const handler = mergeFollowupsServices({ config: {}, pool })[WORK.carrier];
    const at = (minutes) => new Date(Date.now() - 3 * 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();
    const a = await app();
    const other = await app();
    const before = await proposal(a);
    const stacked = await proposal(a);
    const unrelated = await proposal(a);
    const carrier = await proposal(a);
    const elsewhere = await proposal(other);
    await merge(before, { mergeSha: SHA('1'), mergedAt: at(0) });
    await merge(stacked, { mergeSha: SHA('2'), mergedAt: at(1) });
    await merge(unrelated, { mergeSha: SHA('3'), mergedAt: at(2) });
    await merge(elsewhere, { mergeSha: SHA('4'), mergedAt: at(3) });
    await merge(carrier, { mergeSha: SHA('5'), mergedAt: at(4) });
    await settle();
    // Every pull request but the unrelated one lists the stacked commit; only
    // the carrier's merge is in the build.
    const listed = [];
    t2.mock.method(github, 'isEnabled', () => true);
    t2.mock.method(github, 'listPullRequestCommitShas', async (_o, _r, n) => {
      listed.push(n);
      return { shas: n === unrelated.pr_number ? [SHA('9')] : [SHA('2')], complete: true };
    });
    let inBuild = SHA('5');
    t2.mock.method(github, 'compareCommitAncestry', async (_o, _r, base) => ({ status: base === inBuild ? 'ahead' : 'diverged' }));
    const run = (after = null) => handler.run({ key: 'carrier', attempt: 1, resumeFrom: null, checkpoint: async () => {}, input: {
      owner: 'acme', repo: 'shop', appId: a.id, sessionId: stacked.id, mergeSha: SHA('2'), mergedAt: at(1), release: SHA('e'), after,
    } });
    // Its own app's merges since it, oldest first: not one before it, not
    // itself, not another app's.
    assert.deepEqual((await run()).carrier,
      { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title, mergeSha: SHA('5') });
    assert.deepEqual(listed, [unrelated.pr_number, carrier.pr_number]);
    // Not in this build: the unrelated one is ruled out; the carrier lists
    // it, so the next look reads it again and nothing before it.
    inBuild = SHA('0');
    const none = await run();
    assert.equal(none.carrier, null);
    assert.deepEqual([none.scanned.id, none.scanned.recheck], [carrier.id, [carrier.id]]);
    listed.length = 0;
    inBuild = SHA('5');
    assert.equal((await run(none.scanned)).carrier.sessionId, carrier.id);
    assert.deepEqual(listed, [carrier.pr_number]);

    // A merge carried to main inside the carrier is named by it: the change
    // that merged to main (a chain of stacked pull requests ends there).
    const middle = await proposal(a);
    await merge(middle, { mergeSha: SHA('6'), mergedAt: at(2) });
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: false, status: 'diverged' }));
    work.results.set(WORK.carrier, (input) => (input.sessionId === middle.id
      ? { carrier: { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title, mergeSha: SHA('5') } } : { carrier: null }));
    try { await delivered(middle, SHA('5')); } finally { work.results.delete(WORK.verify); work.results.delete(WORK.carrier); }
    assert.equal((await row(middle.id)).included_in_session_id, carrier.id);
    listed.length = 0;
    const viaMiddle = await run();
    assert.deepEqual(listed, [unrelated.pr_number, middle.pr_number], 'the unrelated one first: same time, lower id');
    assert.deepEqual(viaMiddle.carrier, { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title, mergeSha: SHA('5') });
  });

  await t.test('a child app\'s stacked merge goes live with the deploy of the merge that carried it', async () => {
    const a = await app();
    const carrier = await proposal(a);
    const stacked = await proposal(a);
    await merge(stacked, { mergeSha: SHA('b') });
    await merge(carrier, { mergeSha: SHA('c') });
    work.results.set(WORK.verify, (input) => ({ sha: input.sha, contains: input.mergeSha === input.sha,
      status: input.mergeSha === input.sha ? 'identical' : 'diverged' }));
    work.results.set(WORK.carrier, (input) => (input.sessionId === stacked.id
      ? { carrier: { sessionId: carrier.id, prNumber: carrier.pr_number, prTitle: carrier.pr_title, mergeSha: SHA('c') } }
      : { carrier: null }));
    try {
      // app-delivery deploys main's tip and tells every merge waiting on it.
      await delivered(carrier, SHA('c'));
      await delivered(stacked, SHA('c'));
      assert.equal((await instance(carrier)).state, 'live');
      const i = await instance(stacked);
      assert.equal(i.state, 'live');
      assert.equal(i.data.deliveredSha, SHA('c'));
      assert.equal((await row(stacked.id)).included_in_session_id, carrier.id);
    } finally {
      work.results.delete(WORK.verify);
      work.results.delete(WORK.carrier);
    }
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

  await t.test('the preview goes once its deploy is answered: demo mode deploys the preview\'s build', async () => {
    const a = await app({ demoMode: true });
    const s = await proposal(a, { extra: { preview: true } });
    await merge(s);
    await settle();
    assert.equal((await retireAsked(s)).length, 0, 'not while the deploy may still reuse it');
    await deliveryAnswer(s, 'Delivered', { sha: SHA('a') });
    await settle();
    assert.equal((await retireAsked(s)).length, 1, 'its answer lets it go');
    // A deploy that failed lets it go too.
    const failed = await proposal(a, { extra: { preview: true } });
    await merge(failed);
    await failedDelivery(failed);
    assert.equal((await instance(failed)).state, 'deploy_failed');
    assert.equal((await retireAsked(failed)).length, 1);
    // The platform's own app has no deploy here: its preview goes at once,
    // in the merge's own transaction.
    const own = await proposal(await app({ selfHosted: true }));
    await merge(own);
    assert.equal((await retireAsked(own)).length, 1);
    await send(own, 'Deployed', { sha: SHA('a') });
    await settle();
    assert.equal((await instance(own)).state, 'live');
    assert.equal((await retireAsked(own)).length, 1, 'asked once');
    // Any other deploy builds its own image: the preview goes at the merge.
    // Waiting for every deploy held a full quota shut on 19 Oct 2026 (the
    // previews waited for the deploys, the deploys for the previews' pods).
    const plain = await proposal(await app(), { extra: { preview: true } });
    await merge(plain);
    assert.equal((await retireAsked(plain)).length, 1, 'asked in the merge');
    await deliveryAnswer(plain, 'Delivered', { sha: SHA('a') });
    await settle();
    assert.equal((await retireAsked(plain)).length, 1, 'and not again on the answer');
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
    await shotsUnderWay(shooting.id, 'taking_shots');
    await pool.query(`INSERT INTO check_runs (run_id, session_id, owner, manifest) VALUES ($1, $2, 'pod-a', '{}')`,
      [crypto.randomUUID(), checking.id]);
    work.results.set(WORK.find, (input) => (input.sessionId === carrier.id ? { found: [
      { id: moved.id, head: SHA('9') }, { id: shooting.id, head: SHA('2') },
      { id: checking.id, head: SHA('3') }, { id: idle.id, head: SHA('4') },
    ] } : { found: [] }));
    try {
      await merge(carrier);
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
    // And the lists re-read at once, not only once the close work ends.
    assert.ok(pushed.some((p) => p.data.type === 'issue_update' && p.data.action === 'github_synced' && p.data.source === 'pr_merged'
      && p.routing.boardChange === true), 'and the Workshop re-places them, from the push');
    work.results.set(WORK.issues, { closed: [5], skipped: [], stillOpen: [9] });
    try { await settle(); } finally { work.results.delete(WORK.issues); }
    assert.ok(pushed.some(p => p.data.type === 'issue_update' && p.data.action === 'github_synced'));
  });

  // GitHub closes `Closes #N` a few seconds after the merge, or not at all
  // (2026-09-30): the first look leaves a linked request still open to it,
  // and the machine looks again 30 seconds later, when the platform closes
  // it (services/issue-close-watcher.js closeAfterMerge).
  await t.test('a request still open at the first look is looked at again 30 seconds later, once', async () => {
    const a = await app();
    const s = await proposal(a, { linked: [5, 6] });
    await merge(s);
    const [first] = (await workOf(s)).filter((w) => w.kind === WORK.issues);
    assert.deepEqual([first.work_key, first.input.look, first.input.linkedIssues], ['issues', 1, [5, 6]]);
    work.results.set(WORK.issues, (input) => (input.look === 1
      ? { closed: [5], skipped: [], stillOpen: [6], waiting: true, targets: [] }
      : { closed: [6], skipped: [], stillOpen: [], waiting: false, targets: [] }));
    try {
      await settle();
      const items = async () => (await pool.query(
        `SELECT work_key, input, status, due_at > NOW() + INTERVAL '20 seconds' AND due_at <= NOW() + INTERVAL '31 seconds' AS later
           FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at`,
        [MACHINE, sessionKey(s.id), WORK.issues])).rows;
      let rows = await items();
      assert.equal(rows.length, 2, 'the first look asked for a second');
      assert.equal(rows[0].status, 'settled');
      assert.match(rows[1].work_key, /^issues~\d+$/);
      assert.deepEqual([rows[1].status, rows[1].later], ['queued', true], 'about 30 seconds later');
      assert.deepEqual(rows[1].input, { ...first.input, look: 2 }, 'the same requests, the second look');
      assert.equal((await instance(s)).data.followups[rows[1].work_key].status, 'pending');
      // #6 is linked and the second look closes it: it stays hidden from the
      // boards meanwhile (the first look once showed it open again, review
      // 2026-10-17).
      // Its time comes.
      await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
        UPDATE wf_work SET due_at = NOW() WHERE machine = '${MACHINE}' AND key = '${sessionKey(s.id)}' AND work_key = '${rows[1].work_key}'; COMMIT`);
      await settle();
      rows = await items();
      assert.deepEqual(rows.map((r) => r.status), ['settled', 'settled'], 'and the second look is the last');
      assert.equal((await instance(s)).data.followups[rows[1].work_key].status, 'done');
    } finally { work.results.delete(WORK.issues); }
  });

  // The close proposals for the requests a look saw closed (or gone) are
  // the governance machine's to supersede: each hears it by message, filed
  // first (one filed before the governance machine ran is adopted from its
  // row). A proposal for a request still open hears nothing: before, the
  // work superseded every linked request's proposal before it had seen the
  // request close.
  await t.test('the close proposals a look names are filed and told their target closed, and no others', async () => {
    const a = await app();
    const s = await proposal(a, { linked: [5, 6] });
    const [p5, p6] = [700000 + s.id * 2, 700001 + s.id * 2];
    work.results.set(WORK.issues, (input) => (input.look === 1
      ? { closed: [5], skipped: [], stillOpen: [6], waiting: true, targets: [{ issueId: p5, number: 5 }] }
      : { closed: [6], skipped: [], stillOpen: [], waiting: false, targets: [{ issueId: p6, number: 6 }] }));
    try {
      await merge(s);
      await settle();
      const told = await toldProposal(p5);
      assert.deepEqual(told.map((e) => [e.type, e.payload]), [
        ['Filed', { issueId: p5 }],
        ['TargetClosed', { issueNumber: 5, cause: { kind: 'pr-merge', prNumber: s.pr_number } }],
      ]);
      assert.ok(told.every((e) => e.source.kind === 'message' && e.source.from.machine === MACHINE && e.source.from.key === sessionKey(s.id)),
        'from this machine, which the governance machine takes them from');
      assert.deepEqual(await toldProposal(p6), [], 'not while its request is still open');
      await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
        UPDATE wf_work SET due_at = NOW() WHERE machine = '${MACHINE}' AND key = '${sessionKey(s.id)}' AND kind = '${WORK.issues}' AND status = 'queued'; COMMIT`);
      await settle();
      assert.deepEqual((await toldProposal(p6)).map((e) => [e.type, e.payload]), [
        ['Filed', { issueId: p6 }],
        ['TargetClosed', { issueNumber: 6, cause: { kind: 'pr-merge', prNumber: s.pr_number } }],
      ], 'once the second look closed it');
      assert.equal((await toldProposal(p5)).length, 2, 'the first is told once');
    } finally { work.results.delete(WORK.issues); }
  });

  await t.test('an included change\'s close proposals are superseded by its carrier\'s pull request, at once', async () => {
    const a = await app();
    const carrier = await proposal(a, { title: 'Carrier' });
    const carried = await proposal(a, { status: 'promoted', linked: [4] });
    const p4 = 800000 + carried.id;
    work.results.set(WORK.find, (input) => ({ found: input.sessionId === carrier.id ? [{ id: carried.id, head: null }] : [] }));
    work.results.set(WORK.issues, (input) => (input.sessionId === carried.id
      ? { closed: [4], failed: [], targets: [{ issueId: p4, number: 4 }] }
      : { closed: [], skipped: [], stillOpen: [], waiting: false, targets: [] }));
    try {
      await merge(carrier);
      await settle();
    } finally { work.results.delete(WORK.find); work.results.delete(WORK.issues); }
    const items = (await workOf(carried)).filter((w) => w.kind === WORK.issues);
    assert.equal(items.length, 1, 'its requests are closed, not looked at twice');
    assert.deepEqual([items[0].input.closeOnly, items[0].input.carrierPrNumber, items[0].input.look], [true, carrier.pr_number, 1]);
    assert.deepEqual((await toldProposal(p4)).map((e) => [e.type, e.payload]), [
      ['Filed', { issueId: p4 }],
      ['TargetClosed', { issueNumber: 4, cause: { kind: 'pr-merge', prNumber: carrier.pr_number } }],
    ]);
    // Its preview goes with the inclusion.
    assert.equal((await retireAsked(carried)).length, 1);
  });

  await t.test('the merge\'s secret apply without the data key throws (failing its transition) instead of discarding held values', async () => {
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

  await t.test('what counts as a shots run still using the worker: the shots machine has one under way', async () => {
    const { liveShotsRun } = require('../src/workflow/merge-followups/facts.ts');
    const a = await app();
    const run = async (state) => {
      const s = await proposal(a);
      await shotsUnderWay(s.id, state);
      return (await liveShotsRun(pool, s.id)) === 'r'.repeat(32);
    };
    for (const state of ['building_copies', 'waiting_for_agent', 'taking_shots', 'publishing']) {
      assert.equal(await run(state), true, state);
    }
    for (const state of ['waiting_for_preview', 'published', 'failed', 'waived', 'closed']) {
      assert.equal(await run(state), false, state);
    }
    const none = await proposal(a);
    assert.equal(await liveShotsRun(pool, none.id), null, 'no instance, no run');
  });

  // ── The deploy, asked of app-delivery ──────────────────────────────

  await t.test('a merge asks app-delivery for the deploy and goes live on its answer', async () => {
    {
      const a = await app();
      const s = await proposal(a);
      await merge(s);
      assert.ok(!(await workOf(s)).some((w) => w.kind === OLD.deliver), 'no deploy of its own');
      assert.equal((await retireAsked(s)).length, 1, 'its preview goes at the merge: this deploy builds its own image');
      const [req] = await asked(a);
      assert.deepEqual(req.payload, { appId: a.id, reason: 'merge', prNumber: s.pr_number, revision: SHA('a'), reuse: null });
      assert.equal(req.source.from.key, sessionKey(s.id), 'from this merge, which the answer comes back to');
      assert.equal((await instance(s)).data.delivery, 'app-delivery');
      await deliveryAnswer(s, 'Delivered', { sha: SHA('a') });
      await settle();
      assert.equal((await instance(s)).state, 'live');
      assert.equal((await retireAsked(s)).length, 1, 'the answer does not ask again');
    }
  });

  await t.test('a failed deploy is deploy_failed, and its later answer still makes it live', async () => {
    {
      const a = await app();
      const s = await proposal(a);
      await merge(s);
      await deliveryAnswer(s, 'DeliveryFailed', { message: 'the build failed', missingSecrets: null });
      await settle();
      assert.equal((await instance(s)).state, 'deploy_failed');
      assert.ok((await lines(s)).some((l) => /the build failed/.test(l.content)));
      assert.equal((await retireAsked(s)).length, 1);
      // An admin's retry asks again, where it asked first.
      await send(s, 'RetryDelivery', {}, { kind: 'admin' });
      await settle();
      assert.equal((await instance(s)).state, 'delivering');
      assert.equal((await asked(a)).length, 2);
      await deliveryAnswer(s, 'Delivered', { sha: SHA('b') });
      await settle();
      assert.ok((await workOf(s)).some((w) => w.kind === WORK.verify && w.input.sha === SHA('b')),
        'a build that is not the merge commit is checked for it, as any deploy is');
    }
  });

  await t.test('a merge counts no other deploy before its own request is answered, whatever the order', async () => {
    {
      const a = await app();
      const s = await proposal(a);
      await merge(s);
      // An earlier deploy's result reaches it before its own request was
      // even recorded there (queued behind that result): that deploy started
      // before this merge applied its declared keys.
      const early = await deliveryAnswer(s, 'Deployed', { sha: SHA('a') });
      const fromRelease = await send(s, 'Deployed', { sha: SHA('a') });
      await settle();
      assert.deepEqual([(await outcome(early)).reason, (await outcome(fromRelease)).reason], ['awaiting_own_answer', 'awaiting_own_answer']);
      assert.equal((await instance(s)).state, 'delivering');
      // Its own deploy's answer counts, and the preview goes with it.
      await deliveryAnswer(s, 'DeliveryFailed', { message: 'missing required secrets: API_KEY', missingSecrets: ['API_KEY'] });
      await settle();
      assert.equal((await instance(s)).state, 'deploy_failed');
      assert.equal((await retireAsked(s)).length, 1);
      // Answered once, any later deploy that contains it makes it live.
      await deliveryAnswer(s, 'Deployed', { sha: SHA('a') });
      await settle();
      assert.equal((await instance(s)).state, 'live');
    }
  });

  // A follow-up an older release recorded, failed for good, in the
  // instance's record (no item left: every one of those kinds is settled).
  const oldFollowup = async (s, { key, kind, state = null }) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      const input = { appId: s.app_id, sessionId: s.id, mergeSha: SHA('a'), prNumber: s.pr_number, reuse: null };
      await c.query(
        `UPDATE wf_instances SET state = COALESCE($3, state),
                data = jsonb_set(data - 'delivery' - 'answered', ARRAY['followups', $4::text], $5::jsonb)
          WHERE machine = $1 AND key = $2`,
        [MACHINE, sessionKey(s.id), state, key, JSON.stringify({ kind, input, status: 'exhausted' })]);
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  };

  // A merge recorded before every deploy was app-delivery's ran its own
  // deploy (app.deliver work, none left in production). An admin's retry of
  // that follow-up is refused as any kind with no handler is; Retry
  // delivery asks app-delivery.
  await t.test('an admin\'s retry of a merge whose own deploy failed before asks app-delivery', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    await oldFollowup(s, { key: 'deliver', kind: OLD.deliver, state: 'deploy_failed' });
    const refused = await send(s, 'RetryFollowup', { workKey: 'deliver' }, { kind: 'admin' });
    await rt.drain();
    assert.equal((await outcome(refused)).reason, 'not_retryable');
    await send(s, 'RetryDelivery', {}, { kind: 'admin' });
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'delivering');
    assert.equal(i.data.delivery, 'app-delivery');
    assert.equal((await asked(a)).length, 2);
    assert.ok(!(await workOf(s)).some((w) => w.kind === OLD.deliver), 'no deploy of its own');
    await deliveryAnswer(s, 'Delivered', { sha: SHA('a') });
    await settle();
    assert.equal((await instance(s)).state, 'live');
  });

  await t.test('a retry of a follow-up whose kind has no handler is refused, and queues nothing', async () => {
    const a = await app();
    const s = await proposal(a);
    await merge(s);
    await settle();
    await oldFollowup(s, { key: 'bot', kind: OLD.bot });
    const before = (await workOf(s)).length;
    const refused = await send(s, 'RetryFollowup', { workKey: 'bot' }, { kind: 'admin' });
    await settle();
    assert.equal((await outcome(refused)).reason, 'not_retryable');
    assert.equal((await workOf(s)).length, before);
    assert.equal((await instance(s)).data.followups.bot.status, 'exhausted', 'its record is left as it was');
  });

  await t.test('an answer from anyone but app-delivery, or to a merge that did not ask it, is refused', async () => {
    // The platform's own app is released by its pipeline: it asks nothing.
    const a = await app({ selfHosted: true });
    const s = await proposal(a);
    await merge(s);
    const id = await deliveryAnswer(s, 'Delivered', { sha: SHA('a') });
    await rt.drain();
    assert.deepEqual([(await outcome(id)).result, (await outcome(id)).reason], ['rejected', 'not_asked']);
    const forged = await send(s, 'Delivered', { sha: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(forged)).reason, 'internal_only');
  });
});
