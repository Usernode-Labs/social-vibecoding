'use strict';

// The governance-proposal machine (src/workflow/governance-proposal/)
// against the full PostgreSQL schema: one subtest per guarantee G1-G13 in
// the workflow foundation's guarantee list, plus the fixes it makes to
// [main]'s apply paths. Work kinds are faked here; services.ts has its own
// tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { governanceProposal, issueKey, MACHINE, NOTIFIERS } = require('../src/workflow/governance-proposal/machine.ts');
const { GOVERNANCE_KINDS } = require('../src/services/governance-kinds');
const secrets = require('../src/services/secrets');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DATA_KEY = 'synthetic-governance-test-key';

test('governance-proposal machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_governance_' + crypto.randomBytes(6).toString('hex');
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
  // The machine's guard, as platform.ts syncSettings records it at every boot.
  const setFlag = (on) => pool.query(on
    ? `INSERT INTO wf_settings (key, value) VALUES ('enabled:governance-proposal', '1') ON CONFLICT DO NOTHING`
    : `DELETE FROM wf_settings WHERE key = 'enabled:governance-proposal'`);
  await setFlag(true);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user({ admin: isAdmin = false } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', $2) RETURNING id, username`,
      [`gov_${++seq}`, isAdmin]);
    return u;
  }
  async function app({ approvals = 1, locked = false, selfHosted = false, members = [] } = {}) {
    const owner = members[0] || await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, approvals_required, locked, self_hosted, repo_url)
       VALUES ($1::text, $1::text, $2, $3, $4, $5, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`gov-app-${++seq}`, owner.id, approvals, locked, selfHosted]);
    // The community comes from an AFTER INSERT trigger, so read the row back.
    Object.assign(a, (await pool.query('SELECT community_id FROM apps WHERE id = $1', [a.id])).rows[0]);
    for (const m of members) {
      await pool.query(`INSERT INTO community_members (community_id, user_id, source) VALUES ($1, $2, 'joined')
                        ON CONFLICT DO NOTHING`, [a.community_id, m.id]);
    }
    return a;
  }
  async function issue(a, author, kind, payload, extra = {}) {
    const { rows: [i] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by, github_issue_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [a.id, extra.title || `${kind} proposal`, kind, JSON.stringify(payload), author.id, extra.twin || null]);
    return i;
  }

  const notified = [];
  const notifiers = Object.fromEntries(NOTIFIERS.map((n) => [n, (x) => { notified.push(x); }]));
  const work = { calls: [], fail: new Set(), result: {} };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0,
    async run({ input, key, resumeFrom, checkpoint }) {
      work.calls.push({ kind, key, input, resumeFrom });
      if (work.fail.has(kind)) {
        // Progress made before the failure, as the real close-and-comment does.
        if (!resumeFrom) await checkpoint({ closed: true, commented: true });
        throw new Error(`${kind} down`);
      }
      return work.result[kind] || { ok: true };
    },
  });
  const machine = governanceProposal({ dataKey: DATA_KEY, notifiers });
  // What browsers hear: published in the transition's transaction.
  const pushed = [];
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: { 'github.closeIssue': fake('github.closeIssue'), 'app.rebuildProduction': fake('app.rebuildProduction'),
      'governance.checkTarget': fake('governance.checkTarget'), 'campaign.run': fake('campaign.run'),
      'bot.requestsClosed': fake('bot.requestsClosed') },
  });
  runtimes.push(rt);

  let rk = 0;
  const send = (i, type, payload, o = {}) => rt.append(machine, issueKey(i.id), { type, payload },
    { requestKey: `t-${++rk}`, source: o.source || { kind: 'route' }, actor: o.actor, appId: i.app_id });
  const file = async (i) => { const id = await send(i, 'Filed', { issueId: i.id }); await rt.drain(); return id; };
  const vote = async (i, u, v, reason) => {
    const id = await send(i, 'VoteCast', { userId: u.id, username: u.username, vote: v, ...(reason ? { reason } : {}) }, { actor: `user:${u.id}` });
    await rt.drain();
    return event(id);
  };
  const event = async (id) => (await pool.query('SELECT * FROM wf_events WHERE id = $1', [id])).rows[0];
  const inst = async (i) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, issueKey(i.id)])).rows[0];
  const row = async (i) => (await pool.query('SELECT * FROM issues WHERE id = $1', [i.id])).rows[0];
  const lines = async (i) => (await pool.query(
    `SELECT content FROM chat_messages WHERE thread_type = 'governance' AND thread_ref = $1 ORDER BY id`, [i.id])).rows.map((r) => r.content);
  const settle = async () => { await rt.drain(); while (await rt.runServices()) await rt.drain(); };

  await t.test('G1 the gate is read under the lock, settings uncached, the vote folded in', async () => {
    const a = await app({ approvals: 2 });
    const [author, v1, v2] = [await user(), await user(), await user()];
    const i = await issue(a, author, 'rename', { newName: 'Renamed one' });
    await file(i);
    await vote(i, v1, 'up');
    let s = await inst(i);
    assert.equal(s.state, 'open');
    assert.deepEqual([s.data.evaluation.yes, s.data.evaluation.required, s.data.evaluation.waiting], [1, 2, 'waiting_for_votes']);
    // The settings change and the next evaluation sees it at once (no 10 s cache).
    await pool.query('UPDATE apps SET approvals_required = 1 WHERE id = $1', [a.id]);
    await send(i, 'Evaluate', {}, { source: { kind: 'admin' } });
    await rt.drain();
    s = await inst(i);
    assert.equal(s.state, 'applied');
    assert.equal((await pool.query('SELECT name FROM apps WHERE id = $1', [a.id])).rows[0].name, 'Renamed one');
    void v2;
  });

  await t.test('G2 votes only while open; toggles and reasons are decided under the lock', async () => {
    const a = await app({ approvals: 3 });
    const [author, v1, v2] = [await user(), await user(), await user()];
    const i = await issue(a, author, 'close_issue', { issueNumber: 7, issueTitle: 'x' });
    await file(i);
    const noReason = await vote(i, v1, 'down');
    assert.deepEqual([noReason.result, noReason.reason], ['rejected', 'reason_required']);
    assert.equal((await vote(i, v1, 'down', 'not yet')).result, 'accepted');
    // The same side again retracts, and needs no line.
    assert.equal((await vote(i, v1, 'down')).result, 'accepted');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_votes WHERE issue_id = $1', [i.id])).rows[0].n, 0);
    assert.deepEqual(await lines(i), [`${v1.username} voted down on close proposal for issue #7: “not yet”`]);
    assert.ok(pushed.some((p) => p.kind === 'room' && p.routing.appId === a.id && p.data.type === 'chat'
      && p.data.content === `${v1.username} voted down on close proposal for issue #7: “not yet”` && p.data.thread.type === 'governance'),
    'the vote line, to the app\'s room');
    assert.ok(notified.some((n) => n.type === 'boardChange' && n.appId === a.id), 'the Workshop\'s board-change kick, once, where it decided');
    await send(i, 'Withdraw', { userId: author.id, username: author.username }, { actor: `user:${author.id}` });
    await rt.drain();
    const late = await vote(i, v2, 'up');
    assert.deepEqual([late.result, late.reason], ['rejected', 'not_open']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_votes WHERE issue_id = $1', [i.id])).rows[0].n, 0);
    const wrongActor = await send(i, 'VoteCast', { userId: v2.id, username: v2.username, vote: 'up' }, { actor: `user:${v1.id}` });
    await rt.drain();
    assert.equal((await event(wrongActor)).reason, 'not_the_voter');
  });

  await t.test('G3/G13 each kind commits its change with the transition, and the projection follows', async () => {
    const author = await user();
    const voter = await user();
    // close_issue: the target's twin closes, its bounties are voided, GitHub close is work.
    const a = await app();
    const twin = await issue(a, author, 'general', {}, { twin: 42 });
    await pool.query(`INSERT INTO issue_bounties (app_id, github_issue_number, week_start) VALUES ($1, 42, CURRENT_DATE)`, [a.id]);
    const close = await issue(a, author, 'close_issue', { issueNumber: 42, issueTitle: 'Old', reason: 'Done elsewhere' });
    await file(close);
    await vote(close, voter, 'up');
    await settle(); // the target check answers first
    assert.equal((await inst(close)).state, 'applied');
    assert.equal((await row(twin)).status, 'closed');
    assert.equal((await pool.query('SELECT status FROM issue_bounties WHERE app_id = $1', [a.id])).rows[0].status, 'voided');
    const closed = await row(close);
    assert.equal(closed.status, 'closed');
    assert.deepEqual([closed.payload.appliedBy, closed.payload.upCount, closed.payload.required, closed.payload.active],
      ['group-vote', 1, 1, 1]);
    assert.ok(closed.payload.appliedAt);
    const { rows: [ghWork] } = await pool.query(`SELECT * FROM wf_work WHERE key = $1 AND kind = 'github.closeIssue'`, [issueKey(close.id)]);
    assert.deepEqual([ghWork.work_key, ghWork.input.number, ghWork.input.bustCache], ['target', 42, true]);
    assert.match(ghWork.input.comment, /Closed by group vote \(1\/1\) on Homeroom\.\n\n.*'s reason: Done elsewhere/);
    assert.deepEqual((await pool.query(
      `SELECT content FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 42`)).rows.map((r) => r.content),
    ['Issue #42 closed by group vote (1/1)']);
    // maintenance_campaign: the campaign row, and its id in the audit payload.
    const c = await issue(a, author, 'maintenance_campaign', { title: 'Bump', instructions: 'Bump deps' });
    await file(c);
    await vote(c, voter, 'up');
    const camp = (await pool.query('SELECT * FROM maintenance_campaigns WHERE issue_id = $1', [c.id])).rows[0];
    assert.equal(camp.status, 'running');
    assert.equal((await row(c)).payload.campaignId, camp.id);
    // Started by a message committed with the apply (the campaign machine's
    // Start, naming the row the apply's write inserted), not work or a
    // post-commit kick a crash could lose.
    const { rows: [start] } = await pool.query(
      `SELECT type, payload, source FROM wf_events WHERE machine = 'campaign' AND key = $1`, [`campaign:${camp.id}`]);
    assert.deepEqual([start.type, start.payload, start.source.kind, start.source.from.machine],
      ['Start', { campaignId: camp.id }, 'message', MACHINE]);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM wf_work WHERE machine = $1 AND key = $2 AND kind = 'campaign.run'`, [MACHINE, issueKey(c.id)])).rows[0].n, 0);
    assert.ok(!notified.some((n) => n.type === 'startCampaign'));
    // secret_change: the secret, the redeploy asked of app-delivery, and no ciphertext left behind.
    const valueEnc = secrets.encrypt('hunter2-value', DATA_KEY);
    const sec = await issue(a, author, 'secret_change', { key: 'API_KEY', action: 'set', valueEnc, valueLast4: 'alue' });
    await file(sec);
    await vote(sec, voter, 'up');
    assert.equal((await inst(sec)).state, 'applied');
    const stored = (await pool.query('SELECT * FROM app_secrets WHERE app_id = $1 AND key = $2', [a.id, 'API_KEY'])).rows[0];
    assert.equal(secrets.decrypt(stored.value_enc, DATA_KEY), 'hunter2-value');
    assert.equal((await row(sec)).payload.valueEnc, undefined);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = 'app-delivery' AND key = $1`, [`app:${a.id}`])).rows[0].n, 1);
    const { rows: history } = await pool.query(`SELECT data FROM wf_instances WHERE key = $1`, [issueKey(sec.id)]);
    assert.doesNotMatch(JSON.stringify(history), /hunter2|valueEnc/, 'the instance never holds the secret');
    // featured_illustration whose image is gone: refused, not stuck.
    const ill = await issue(a, author, 'featured_illustration', { proposed: { url: '/api/illustrations/img-missing' } });
    await file(ill);
    await vote(ill, voter, 'up');
    assert.equal((await inst(ill)).state, 'refused');
    assert.match((await row(ill)).payload.appliedBy, /^refused:(no_image|image_unavailable)$/);
  });

  await t.test('a close vote asks for the bot\'s proposals on the closed request as durable work', async () => {
    const a = await app();
    const c = await issue(a, await user(), 'close_issue', { issueNumber: 77, issueTitle: 'Done' });
    await file(c);
    await vote(c, await user(), 'up');
    await settle();
    assert.equal((await inst(c)).state, 'applied');
    const { rows: [w] } = await pool.query(
      `SELECT work_key, input FROM wf_work WHERE machine = $1 AND key = $2 AND kind = 'bot.requestsClosed'`, [MACHINE, issueKey(c.id)]);
    assert.deepEqual([w.work_key, w.input], ['bot', { appId: a.id, closed: [77] }]);
    assert.ok(work.calls.some((x) => x.kind === 'bot.requestsClosed' && x.input.closed[0] === 77), 'and it ran');
  });

  await t.test('a featured illustration is published, kept or removed with the transition', async () => {
    const [author, voter] = [await user(), await user()];
    const hex = (ch) => ch.repeat(32);
    // A new image: the pending bytes move into app_illustrations under the
    // ids the card previewed, and the record is written onto the app.
    const a = await app();
    const proposed = { url: `/app-illustrations/${hex('b')}`, darkUrl: `/app-illustrations/${hex('c')}`, zoom: 1.4, x: 10, y: -5, tint: 'blue' };
    const ill = await issue(a, author, 'featured_illustration', { proposed, current: null, remove: false });
    await pool.query(
      `INSERT INTO app_illustration_proposals (issue_id, app_id, id, content_type, data, dark_id, dark_content_type, dark_data)
       VALUES ($1, $2, $3, 'image/png', $4, $5, 'image/webp', $6)`,
      [ill.id, a.id, hex('b'), Buffer.from('new-light'), hex('c'), Buffer.from('new-dark')]);
    await file(ill);
    await vote(ill, voter, 'up');
    assert.equal((await inst(ill)).state, 'applied');
    const stored = (await pool.query('SELECT * FROM app_illustrations WHERE app_id = $1', [a.id])).rows[0];
    assert.deepEqual([stored.id, stored.content_type, stored.data.toString(), stored.dark_id, stored.dark_content_type, stored.dark_data.toString()],
      [hex('b'), 'image/png', 'new-light', hex('c'), 'image/webp', 'new-dark']);
    assert.deepEqual((await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [a.id])).rows[0].featured_illustration, proposed);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_illustration_proposals WHERE issue_id = $1', [ill.id])).rows[0].n, 0);
    assert.match((await lines(ill)).at(-1), /Featured illustration changed by group vote \(1\/1\)/);
    assert.ok(pushed.some((p) => p.data?.action === 'illustration_changed' && p.data.appId === a.id), 'open clients hear the app changed');
    // A reframe keeps the app's current image: its bytes are read from the
    // app's own row.
    const reframed = { ...proposed, darkUrl: null, zoom: 2 };
    const keep = await issue(a, author, 'featured_illustration', { proposed: reframed, current: proposed, remove: false });
    await file(keep);
    await vote(keep, voter, 'up');
    assert.equal((await inst(keep)).state, 'applied');
    const kept = (await pool.query('SELECT * FROM app_illustrations WHERE app_id = $1', [a.id])).rows[0];
    assert.deepEqual([kept.id, kept.data.toString()], [hex('b'), 'new-light']);
    assert.deepEqual((await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [a.id])).rows[0].featured_illustration, reframed);
    // A removal clears the record and its bytes.
    const remove = await issue(a, author, 'featured_illustration', { proposed: null, current: reframed, remove: true });
    await file(remove);
    await vote(remove, voter, 'up');
    assert.equal((await inst(remove)).state, 'applied');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_illustrations WHERE app_id = $1', [a.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [a.id])).rows[0].featured_illustration, null);
    assert.match((await lines(remove)).at(-1), /Featured illustration removed by group vote/);
  });

  await t.test('a platform variable a vote sets goes through the platform-env store, with no rebuild', async () => {
    const platformApp = await app({ selfHosted: true });
    const v = await issue(platformApp, await user(), 'secret_change',
      { key: 'SOME_TUNABLE', action: 'set', valueEnc: secrets.encrypt('tuned', DATA_KEY), valueLast4: 'uned' });
    await file(v);
    await vote(v, await user(), 'up');
    await settle();
    assert.equal((await inst(v)).state, 'applied');
    const { rows: [stored] } = await pool.query(
      'SELECT value_enc FROM platform_env_values WHERE app_id = $1 AND key = $2', [platformApp.id, 'SOME_TUNABLE']);
    assert.equal(secrets.decrypt(stored.value_enc, DATA_KEY), 'tuned', 'written by the platform-env store');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_secrets WHERE app_id = $1', [platformApp.id])).rows[0].n, 0,
      'app_secrets is for child apps only');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE machine = 'app-delivery' AND key = $1`,
      [`app:${platformApp.id}`])).rows[0].n, 0, 'the platform is never redeployed for it');
  });

  await t.test('G4 applied at most once across concurrent votes, timers and admin force', async () => {
    const a = await app({ approvals: 1 });
    const author = await user();
    const i = await issue(a, author, 'rename', { newName: 'Once' });
    await file(i);
    const voters = await Promise.all([user(), user(), user()]);
    const adminUser = await user({ admin: true });
    await Promise.all([
      ...voters.map((v) => send(i, 'VoteCast', { userId: v.id, username: v.username, vote: 'up' }, { actor: `user:${v.id}` })),
      send(i, 'Evaluate', {}, { source: { kind: 'admin' } }),
      send(i, 'AdminApply', { userId: adminUser.id, username: adminUser.username }, { source: { kind: 'admin' }, actor: `user:${adminUser.id}` }),
    ]);
    const second = createRuntime({ pool, machines: [machine], slots: 4, pollMs: 50 });
    runtimes.push(second);
    await Promise.all([rt.drain(), second.drain()]);
    assert.equal((await inst(i)).state, 'applied');
    const applied = (await lines(i)).filter((l) => l.startsWith('App renamed'));
    assert.equal(applied.length, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE key = $1 AND state_after = 'applied' AND state_before = 'open'`, [issueKey(i.id)])).rows[0].n, 1);
  });

  await t.test('G5 follow-ups are durable work, recorded on the proposal, and retryable', async () => {
    const a = await app();
    const [author, voter, adminUser] = [await user(), await user(), await user({ admin: true })];
    const i = await issue(a, author, 'close_issue', { issueNumber: 9, issueTitle: 'y' });
    await file(i);
    work.fail.add('github.closeIssue');
    await vote(i, voter, 'up');
    await settle();
    let s = await inst(i);
    assert.equal(s.data.followups.target.status, 'exhausted');
    assert.equal(s.data.followups.target.error, 'github.closeIssue down');
    const synced = () => pushed.filter((p) => p.data.type === 'issue_update' && p.data.action === 'github_synced' && p.routing.appId === a.id);
    assert.equal(synced().length, 0, 'nothing closed on GitHub yet, so no list re-reads');
    work.fail.delete('github.closeIssue');
    const retry = await send(i, 'RetryFollowup', { workKey: 'target' }, { source: { kind: 'admin' }, actor: `user:${adminUser.id}` });
    await settle();
    assert.equal((await event(retry)).result, 'accepted');
    s = await inst(i);
    const retried = Object.entries(s.data.followups).find(([k]) => k.startsWith('target~'));
    assert.equal(s.data.followups.target.status, 'retried');
    assert.equal(retried[1].status, 'done');
    assert.equal(synced().length, 1, 'the close on GitHub tells browsers to re-read the issue list, once');
    // And every web process to stop listing it (each keeps its own copy).
    const forgotten = pushed.filter((p) => p.kind === 'issues_closed' && p.routing.repo === a.slug);
    assert.deepEqual(forgotten.map((p) => p.data.numbers), [[9]]);
    // The retry resumed from the failed attempts' checkpoint: no second comment.
    const last = work.calls.filter((c) => c.kind === 'github.closeIssue').at(-1);
    assert.equal(last.key, retried[0]);
    assert.deepEqual(last.resumeFrom, { closed: true, commented: true });
  });

  await t.test('G6 time alone applies a proposal through its own timer; the backstop is armed', async () => {
    const [author, v1] = [await user(), await user()];
    const people = [author, v1, await user(), await user(), await user()];
    const a = await app({ approvals: null, members: people });
    // An electorate of several active members: one Yes arms lazy consensus (a window).
    for (const u of people) {
      await pool.query(`INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, CURRENT_DATE, 120)`, [a.id, u.id]);
    }
    const i = await issue(a, author, 'rename', { newName: 'By time' });
    let before = Date.now();
    await file(i);
    let s = await inst(i);
    assert.equal(s.state, 'open', JSON.stringify(s));
    assert.equal(s.data.evaluation.waiting, 'waiting_for_votes');
    const backstop = Date.parse(s.deadline_at) - before;
    assert.ok(backstop > 9 * 60 * 1000 && backstop <= 10 * 60 * 1000 + 5000, 'backstop armed');
    await vote(i, v1, 'up');
    s = await inst(i);
    assert.equal(s.data.evaluation.waiting, 'waiting_for_window');
    assert.equal(new Date(s.deadline_at).toISOString() <= new Date(Date.now() + 10 * 60 * 1000).toISOString(), true);
    // Let the window pass: move the proposal's start back, and the deadline to now.
    await pool.query(`UPDATE issues SET created_at = created_at - interval '30 days' WHERE id = $1`, [i.id]);
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_instances SET deadline_at = now() - interval '1 second' WHERE key = '${issueKey(i.id)}'; COMMIT`);
    assert.equal(await rt.fireTimers(), 1);
    await rt.drain();
    assert.equal((await inst(i)).state, 'applied');
    void before;
  });

  await t.test('G7 a locked app waits for an admin Up', async () => {
    const a = await app({ locked: true });
    const [author, voter, adminUser] = [await user(), await user(), await user({ admin: true })];
    const i = await issue(a, author, 'rename', { newName: 'Locked' });
    await file(i);
    await vote(i, voter, 'up');
    const s = await inst(i);
    assert.deepEqual([s.state, s.data.evaluation.waiting], ['open', 'awaiting_admin']);
    // A view-only admin is not a privileged approver (#311): their Up counts
    // as a vote, never as the admin's.
    const viewOnly = await user({ admin: true });
    await pool.query('UPDATE users SET admin_readonly = TRUE WHERE id = $1', [viewOnly.id]);
    await vote(i, viewOnly, 'up');
    assert.deepEqual([(await inst(i)).state, (await inst(i)).data.evaluation.waiting], ['open', 'awaiting_admin']);
    await vote(i, adminUser, 'up');
    assert.equal((await inst(i)).state, 'applied');
  });

  await t.test('G8 a secret change needs a Yes from someone other than its author', async () => {
    const [author, other] = [await user(), await user()];
    const a = await app({ members: [author, other] });
    const i = await issue(a, author, 'secret_change', { key: 'TOKEN', action: 'delete' });
    await file(i);
    await vote(i, author, 'up');
    const s = await inst(i);
    assert.deepEqual([s.state, s.data.evaluation.waiting], ['open', 'awaiting_other_member']);
    await vote(i, other, 'up');
    assert.equal((await inst(i)).state, 'applied');
  });

  await t.test('#4666 a project with rules of its own is decided by them, through the rules copy', async () => {
    // One rule: a yes from the Lifeguards group. The columns alone (at least
    // one yes) would apply it on anybody's yes.
    const [author, other, lifeguard] = [await user(), await user(), await user()];
    const a = await app({ approvals: 1, members: [author, other, lifeguard] });
    await pool.query('UPDATE apps SET governance_rules = $2 WHERE id = $1', [a.id, JSON.stringify({
      preset: null,
      groups: [{ name: 'Lifeguards', people: [lifeguard.username], ids: [lifeguard.id] }],
      rules: [{ group: 'lifeguards', kind: 'atLeast', n: 1 }],
    })]);
    const i = await issue(a, author, 'rename', { newName: 'By the rules' });
    await file(i);
    await vote(i, other, 'up');
    const s = await inst(i);
    assert.deepEqual([s.state, s.data.evaluation.waiting], ['open', 'waiting_for_votes'],
      'a yes from outside the group passes no rule');
    await vote(i, lifeguard, 'up');
    assert.equal((await inst(i)).state, 'applied');
    assert.equal((await pool.query('SELECT name FROM apps WHERE id = $1', [a.id])).rows[0].name, 'By the rules');
  });

  await t.test('a secret change asks app-delivery for the redeploy and records its answer', async () => {
    {
      const [author, voter] = [await user(), await user()];
      const a = await app();
      const sec = await issue(a, author, 'secret_change', { key: 'API_KEY', action: 'set', valueEnc: secrets.encrypt('v', DATA_KEY) });
      await file(sec);
      await vote(sec, voter, 'up');
      assert.equal((await inst(sec)).state, 'applied');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_work WHERE key = $1 AND kind = 'app.rebuildProduction'`,
        [issueKey(sec.id)])).rows[0].n, 0, 'no rebuild of its own');
      const asked = async () => (await pool.query(
        `SELECT payload, source FROM wf_events WHERE machine = 'app-delivery' AND key = $1 ORDER BY id`, [`app:${a.id}`])).rows;
      const [req] = await asked();
      assert.deepEqual(req.payload, { appId: a.id, reason: 'secret_change' });
      assert.equal(req.source.from.key, issueKey(sec.id));
      const followup = async () => (await inst(sec)).data.followups;
      assert.deepEqual((await followup()).rebuild, { kind: 'app-delivery', input: { appId: a.id }, status: 'pending' });
      // Its answers, as app-delivery's messages.
      const answer = (type, payload) => rt.append(machine, issueKey(sec.id), { type, payload },
        { requestKey: `t-${++rk}`, appId: a.id, source: { kind: 'message', from: { machine: 'app-delivery', key: `app:${a.id}`, eventId: 1 } } });
      await answer('DeliveryFailed', { message: 'missing required secrets: OTHER' });
      await rt.drain();
      assert.deepEqual([(await followup()).rebuild.status, (await followup()).rebuild.error], ['failed', 'missing required secrets: OTHER']);
      // The admin's retry asks again; a later deploy answers it.
      await send(sec, 'RetryFollowup', { workKey: 'rebuild' }, { source: { kind: 'admin' } });
      await rt.drain();
      assert.equal((await asked()).length, 2);
      await answer('Delivered', { sha: 'a'.repeat(40) });
      await rt.drain();
      const done = Object.values(await followup()).filter((f) => f.kind === 'app-delivery').map((f) => f.status);
      assert.deepEqual(done, ['retried', 'done']);
      // A rebuild recorded before every deploy was app-delivery's: its item
      // left at the release hands the redeploy to app-delivery, and an admin's
      // retry of one that failed asks app-delivery too.
      const sec2 = await issue(a, author, 'secret_change', { key: 'API_KEY2', action: 'set', valueEnc: secrets.encrypt('w', DATA_KEY) });
      await file(sec2);
      await vote(sec2, voter, 'up');
      const asBefore = async (i, status) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL app.wf_writer = 'transition'");
          await c.query(`UPDATE wf_instances SET data = jsonb_set(data, '{followups,rebuild}', $3::jsonb) WHERE machine = $1 AND key = $2`,
            [MACHINE, issueKey(i.id), JSON.stringify({ kind: 'app.rebuildProduction', input: { appId: a.id }, status })]);
          if (status === 'pending') {
            await c.query(`INSERT INTO wf_work (machine, key, kind, work_key, input) VALUES ($1, $2, 'app.rebuildProduction', 'rebuild', $3)`,
              [MACHINE, issueKey(i.id), JSON.stringify({ appId: a.id })]);
          }
          await c.query('COMMIT');
        } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
      };
      await asBefore(sec2, 'pending');
      const before = (await asked()).length;
      work.result['app.rebuildProduction'] = { handOff: true };
      try { await settle(); } finally { delete work.result['app.rebuildProduction']; }
      assert.equal((await asked()).length, before + 1, 'handed to app-delivery');
      assert.deepEqual((await inst(sec2)).data.followups.rebuild, { kind: 'app-delivery', input: { appId: a.id }, status: 'pending' });
      const sec3 = await issue(a, author, 'secret_change', { key: 'API_KEY3', action: 'set', valueEnc: secrets.encrypt('x', DATA_KEY) });
      await file(sec3);
      await vote(sec3, voter, 'up');
      await asBefore(sec3, 'exhausted');
      const prior = (await asked()).length;
      await send(sec3, 'RetryFollowup', { workKey: 'rebuild' }, { source: { kind: 'admin' } });
      await rt.drain();
      assert.equal((await asked()).length, prior + 1, 'the retry asks app-delivery');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_work WHERE key = $1 AND kind = 'app.rebuildProduction' AND status = 'queued'`,
        [issueKey(sec3.id)])).rows[0].n, 0, 'no rebuild of its own');
    }
  });

  await t.test('G9 refusals close the proposal with their reason instead of leaving it open', async () => {
    const author = await user();
    const platformApp = await app({ selfHosted: true });
    const sec = await issue(platformApp, author, 'secret_change', { key: 'JWT_SECRET', action: 'set', valueEnc: secrets.encrypt('v', DATA_KEY) });
    await file(sec);
    await vote(sec, await user(), 'up');
    const r = await row(sec);
    assert.deepEqual([r.status, r.payload.appliedBy, r.payload.valueEnc], ['closed', 'refused:unwritable', undefined]);
    assert.match((await lines(sec)).at(-1), /cannot be written here/);
    // [main] left these open forever, retried every minute.
    const a = await app();
    const rename = await issue(a, author, 'rename', { newName: '  ' });
    const garbled = await issue(a, author, 'secret_change', { key: 'K', action: 'set', valueEnc: 'v1:not:a:cipher' });
    for (const i of [rename, garbled]) { await file(i); await vote(i, await user(), 'up'); }
    assert.equal((await row(rename)).payload.appliedBy, 'refused:missing_new_name');
    assert.equal((await row(garbled)).payload.appliedBy, 'refused:undecryptable');
    // Decided at enrollment (votes cast before the flag): projected all the same.
    const early = await issue(a, author, 'close_issue', {});
    await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'up')`, [early.id, (await user()).id]);
    await file(early);
    assert.equal((await inst(early)).state, 'refused');
    assert.deepEqual([(await row(early)).status, (await row(early)).payload.appliedBy], ['closed', 'refused:missing_issue_number']);
  });

  await t.test('G10 only the author withdraws, only while open; the ciphertext goes with it', async () => {
    const a = await app({ approvals: 5 });
    const [author, other] = [await user(), await user()];
    const i = await issue(a, author, 'secret_change', { key: 'K2', action: 'set', valueEnc: secrets.encrypt('w', DATA_KEY) });
    await file(i);
    const notAuthor = await send(i, 'Withdraw', { userId: other.id, username: other.username }, { actor: `user:${other.id}` });
    const byAuthor = await send(i, 'Withdraw', { userId: author.id, username: author.username }, { actor: `user:${author.id}` });
    const again = await send(i, 'Withdraw', { userId: author.id, username: author.username }, { actor: `user:${author.id}` });
    await rt.drain();
    assert.equal((await event(notAuthor)).reason, 'not_author');
    assert.equal((await event(byAuthor)).result, 'accepted');
    assert.equal((await event(again)).reason, 'not_open');
    const r = await row(i);
    assert.deepEqual([r.status, r.payload.withdrawnBy, r.payload.valueEnc], ['closed', author.username, undefined]);
    assert.ok(r.payload.withdrawnAt);
  });

  await t.test('G11 a close proposal whose target closed elsewhere is superseded', async () => {
    const a = await app({ approvals: 5 });
    const author = await user();
    const merged = await issue(a, author, 'close_issue', { issueNumber: 11, issueTitle: 'a' });
    const byHand = await issue(a, author, 'close_issue', { issueNumber: 12, issueTitle: 'b' });
    await file(merged);
    await file(byHand);
    const wrong = await send(merged, 'TargetClosed', { issueNumber: 99 }, { source: { kind: 'system' } });
    await send(merged, 'TargetClosed', { issueNumber: 11, cause: { kind: 'pr-merge', prNumber: 5 } }, { source: { kind: 'system' } });
    await rt.drain();
    assert.equal((await event(wrong)).reason, 'not_target');
    assert.equal((await row(merged)).payload.supersededBy, 'pr-merge:#5');
    // The hourly target check, as work: still open, then closed on GitHub.
    assert.equal((await inst(byHand)).data.targetCheck, 'target-check:1');
    work.result['governance.checkTarget'] = { open: true };
    await settle();
    let s = await inst(byHand);
    assert.deepEqual([s.state, s.data.targetCheck], ['open', null]);
    assert.ok(s.data.targetCheckedAt);
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_instances SET data = data || '{"targetCheckedAt": "2000-01-01T00:00:00.000Z"}' WHERE key = '${issueKey(byHand.id)}'; COMMIT`);
    work.result['governance.checkTarget'] = { open: false };
    await send(byHand, 'Evaluate', {}, { source: { kind: 'admin' } });
    await settle();
    s = await inst(byHand);
    assert.equal(s.state, 'superseded');
    assert.equal((await row(byHand)).payload.supersededBy, 'github-close');
    delete work.result['governance.checkTarget'];
  });

  await t.test('G11 a close proposal applies only after a target check finds the issue open', async () => {
    const voter = await user();
    const a = await app({ members: [voter] });
    // A dotted repository name is a repository like any other.
    await pool.query(`UPDATE apps SET repo_url = 'https://github.com/acme/my.app' WHERE id = $1`, [a.id]);
    const author = await user();
    const checks = () => work.calls.filter((c) => c.kind === 'governance.checkTarget').length;

    // Closed on GitHub before the deciding vote: superseded, never applied.
    const gone = await issue(a, author, 'close_issue', { issueNumber: 61, issueTitle: 'gone' });
    await file(gone);
    await settle();
    work.result['governance.checkTarget'] = { open: false };
    const before = checks();
    await vote(gone, voter, 'up');
    let s = await inst(gone);
    assert.deepEqual([s.state, s.data.applyAfterCheck], ['open', { admin: null }], 'the vote waits for the check');
    await settle();
    s = await inst(gone);
    assert.deepEqual([s.state, s.data.audit.supersededBy], ['superseded', 'github-close']);
    assert.equal(checks(), before + 1, 'a fresh check, started once the gate passed');
    assert.ok(!work.calls.some((c) => c.kind === 'github.closeIssue' && c.input.number === 61), 'nothing closed on GitHub');

    // Still open: applied, and the GitHub close names the dotted repository.
    work.result['governance.checkTarget'] = { open: true };
    const open = await issue(a, author, 'close_issue', { issueNumber: 62, issueTitle: 'open' });
    await file(open);
    await settle();
    await vote(open, voter, 'up');
    await settle();
    assert.equal((await inst(open)).state, 'applied');
    const close = work.calls.find((c) => c.kind === 'github.closeIssue' && c.input.number === 62);
    assert.deepEqual([close.input.owner, close.input.repo], ['acme', 'my.app']);

    // GitHub cannot say: applied anyway, as [main]'s degraded read did.
    work.fail.add('governance.checkTarget');
    const unknown = await issue(a, author, 'close_issue', { issueNumber: 63, issueTitle: 'unknown' });
    await file(unknown);
    await settle();
    await vote(unknown, voter, 'up');
    await settle();
    assert.equal((await inst(unknown)).state, 'applied');
    work.fail.delete('governance.checkTarget');
    delete work.result['governance.checkTarget'];
  });

  await t.test('G12 admin force skips the gate and the lock, is recorded as admin, and never renames', async () => {
    const a = await app({ approvals: 9, locked: true });
    const [author, adminUser] = [await user(), await user({ admin: true })];
    const c = await issue(a, author, 'close_issue', { issueNumber: 13, issueTitle: 'c' });
    const r = await issue(a, author, 'rename', { newName: 'Nope' });
    await file(c);
    await file(r);
    const force = (i) => send(i, 'AdminApply', { userId: adminUser.id, username: adminUser.username },
      { source: { kind: 'admin' }, actor: `user:${adminUser.id}` });
    const forced = await force(c);
    const notRename = await force(r);
    const notAdmin = await send(c, 'AdminApply', { userId: adminUser.id, username: adminUser.username }, { actor: `user:${adminUser.id}` });
    await settle(); // a close proposal applies once its target check answers
    assert.equal((await event(forced)).result, 'accepted');
    assert.equal((await row(c)).payload.appliedBy, `admin:${adminUser.username}`);
    assert.equal((await event(notRename)).reason, 'not_admin_appliable');
    assert.equal((await event(notAdmin)).reason, 'admin_only', 'authority is checked before state');
    // A platform variable an admin forced is recorded as theirs, as [main] recorded it.
    const platformApp = await app({ approvals: 9, selfHosted: true });
    const v = await issue(platformApp, author, 'secret_change', { key: 'SOME_TUNABLE', action: 'set', valueEnc: secrets.encrypt('on', DATA_KEY) });
    await file(v);
    const forcedValue = await force(v);
    await settle();
    assert.equal((await event(forcedValue)).result, 'accepted');
    const { rows: [changed] } = await pool.query(
      `SELECT user_id, metadata FROM events WHERE app_id = $1 AND event_type = 'platform_env_changed' ORDER BY id DESC LIMIT 1`, [platformApp.id]);
    assert.deepEqual([changed.user_id, changed.metadata.appliedBy], [adminUser.id, 'admin-force-apply']);
  });

  await t.test('a process without the data key fails the evaluation instead of refusing the secret change', async () => {
    const { readFacts } = require('../src/workflow/governance-proposal/facts.ts');
    const a = await app();
    const i = await issue(a, await user(), 'secret_change', { key: 'K9', action: 'set', valueEnc: secrets.encrypt('w', DATA_KEY) });
    await assert.rejects(readFacts(pool, i.id, { type: 'Evaluate', payload: {} }, true, ''), /data encryption key is not configured/);
    assert.equal((await readFacts(pool, i.id, { type: 'Evaluate', payload: {} }, true, DATA_KEY)).refusal, null);
  });

  await t.test('the writers outside the machine leave the rows it holds alone (wf_holds)', async () => {
    const a = await app({ approvals: 5 });
    const author = await user();
    // A legacy rename the machine holds, and the request board's twin of the same GitHub issue.
    const held = await issue(a, author, 'rename', { newName: 'Held' }, { twin: 31 });
    const { rows: [twin] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by, github_issue_number)
       VALUES ($1, 'A request', 'general', '{}', $2, 31) RETURNING *`, [a.id, author.id]);
    await file(held);
    const holds = async (key) => (await pool.query('SELECT wf_holds($1, $2) AS h', [MACHINE, key])).rows[0].h;
    assert.equal(await holds(issueKey(held.id)), true);
    assert.equal(await holds(issueKey(twin.id)), false, 'nothing enrolled the twin');
    // A request moved to Homeroom closes its own twin, never the proposal (this
    // used to fail whole in raise mode, twin included).
    const move = require('../src/services/homeroom-bot-move');
    await move.closeNow(pool, { app: { id: a.id, slug: a.slug }, repo: { owner: 'acme', repo: a.slug }, issueNumber: 31,
      user: { username: 'someone' }, newNumber: 5,
      deps: { github: { async closeIssue() {} }, ws: { async sendSystemMessage() {}, pushIssueUpdate() {} } } });
    assert.equal((await row(twin)).status, 'closed');
    assert.equal((await row(held)).status, 'open', 'decided by its vote');
    // The revert's sha backfill asks the same question.
    assert.match(require('node:fs').readFileSync(require.resolve('../src/routes/votes.js'), 'utf8'), /NOT wf_holds\('merge-followups'/);
    // With the machine off, it holds nothing.
    await pool.query(`DELETE FROM wf_settings WHERE key = 'enabled:governance-proposal'`);
    try { assert.equal(await holds(issueKey(held.id)), false); }
    finally { await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:governance-proposal', '1')`); }
  });

  await t.test('G13 an enrolled row is owned: writes from outside are refused in every mode, unenrolled rows are not', async () => {
    const a = await app({ approvals: 5 });
    const author = await user();
    const enrolled = await issue(a, author, 'rename', { newName: 'E' });
    const legacy = await issue(a, author, 'rename', { newName: 'L' });
    await file(enrolled);
    await assert.rejects(pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [enrolled.id]), /WF_OWNERSHIP_VIOLATION: issues.status/);
    await assert.rejects(pool.query(`UPDATE issues SET payload = payload || '{"appliedAt": "x"}' WHERE id = $1`, [enrolled.id]), /payload.appliedAt/);
    await pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [legacy.id]);
    await pool.query(`UPDATE issues SET title = 'retitled' WHERE id = $1`, [enrolled.id]);
    // There is no mode that lets such a write through: no log of them either.
    assert.equal((await pool.query(`SELECT to_regclass('wf_ownership_violations') AS t`)).rows[0].t, null);
    // The trigger's kinds are services/governance-kinds.js's.
    const { rows: [trg] } = await pool.query(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'issues_wf_governance_owned'`);
    const kinds = [...trg.def.matchAll(/'([a-z_]+)'::(?:character varying|text)/g)].map((m) => m[1]).filter((k) => GOVERNANCE_KINDS.includes(k));
    assert.deepEqual(kinds.sort(), [...GOVERNANCE_KINDS].sort());
  });

  await t.test('creating: only open governance rows are filed, once', async () => {
    const a = await app();
    const author = await user();
    const general = await issue(a, author, 'general', {});
    const closed = await issue(a, author, 'rename', { newName: 'x' });
    await pool.query(`UPDATE issues SET status = 'closed' WHERE id = $1`, [closed.id]);
    const open = await issue(a, author, 'close_issue', { issueNumber: 1, issueTitle: 'z' }, {});
    assert.equal((await event(await file(general))).reason, 'not_governance');
    assert.equal((await event(await file(closed))).reason, 'not_open');
    await file(open);
    assert.equal((await event(await file(open))).reason, 'already_filed');
    assert.equal(await inst(general), undefined);
  });

  await t.test('a row deleted under an open proposal (its app deleted) ends the instance when its timer fires', async () => {
    const a = await app({ approvals: 5 });
    const author = await user();
    const deleted = await issue(a, author, 'close_issue', { issueNumber: 31, issueTitle: 'q' });
    const untouched = await issue(a, author, 'close_issue', { issueNumber: 32, issueTitle: 'r' });
    for (const i of [deleted, untouched]) await file(i);
    await pool.query('DELETE FROM issues WHERE id = $1', [deleted.id]);
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE wf_instances SET deadline_at = now() - interval '1 second'
       WHERE key IN ('${issueKey(deleted.id)}', '${issueKey(untouched.id)}'); COMMIT`);
    await rt.fireTimers();
    await rt.drain();
    assert.deepEqual([(await inst(deleted)).state, (await inst(deleted)).data.audit.supersededBy], ['superseded', 'issue_gone']);
    assert.equal((await inst(untouched)).state, 'open', 'a row nobody touched carries on');
  });

  await t.test('a vote waiting on another transaction\'s lock on the row reads the votes it committed meanwhile', async () => {
    // Another transaction records a vote and holds the row. The same
    // voter's second Up on the machine must see that vote (a retraction),
    // not the votes from before it waited.
    const [author, v1, v2] = [await user(), await user(), await user()];
    const a = await app({ approvals: 2, members: [v1, v2] });
    const i = await issue(a, author, 'rename', { newName: 'Not twice' });
    await file(i);
    await vote(i, v2, 'up');
    const legacy = await pool.connect();
    try {
      await legacy.query('BEGIN');
      await legacy.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'up')`, [i.id, v1.id]);
      await legacy.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE', [i.id]);
      const id = await send(i, 'VoteCast', { userId: v1.id, username: v1.username, vote: 'up' }, { actor: `user:${v1.id}` });
      const draining = rt.drain();
      await new Promise((r) => setTimeout(r, 300));
      await legacy.query('COMMIT');
      await draining;
      assert.deepEqual((await event(id)).reply, { toggled: true }, 'the second Up takes the vote back');
    } finally { legacy.release(); }
    const s = await inst(i);
    assert.deepEqual([s.state, s.data.evaluation.yes], ['open', 1], 'still open, with one Yes');
    assert.equal((await pool.query('SELECT name FROM apps WHERE id = $1', [a.id])).rows[0].name, a.name, 'not renamed');
  });

  await t.test('a vote waiting on the row lock reads the app\'s settings as they are after it', async () => {
    // A settings change committed while the vote waited for the row lock
    // (here by a transaction holding it) decides it.
    const [author, v1] = [await user(), await user()];
    const a = await app({ approvals: 1, members: [v1] });
    const i = await issue(a, author, 'rename', { newName: 'Not yet' });
    await file(i);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE', [i.id]);
      await holder.query('UPDATE apps SET approvals_required = 2 WHERE id = $1', [a.id]);
      await send(i, 'VoteCast', { userId: v1.id, username: v1.username, vote: 'up' }, { actor: `user:${v1.id}` });
      const draining = rt.drain();
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      await draining;
    } finally { holder.release(); }
    const s = await inst(i);
    assert.deepEqual([s.state, s.data.evaluation.yes, s.data.evaluation.required], ['open', 1, 2], 'two now required');
    assert.equal((await pool.query('SELECT name FROM apps WHERE id = $1', [a.id])).rows[0].name, a.name, 'not renamed');
  });

  await t.test('the reply says what the vote did, built from the facts and the outcome', async () => {
    const a = await app({ approvals: 2 });
    const [author, v1, v2] = [await user(), await user(), await user()];
    const i = await issue(a, author, 'rename', { newName: 'Replied' });
    await file(i);
    const first = await vote(i, v1, 'up');
    assert.deepEqual(first.reply.result, { applied: false, awaitingAdmin: false, upCount: 1, required: 2, active: 1,
      windowEndsAt: first.reply.result.windowEndsAt, waitingForWindow: false, checkingTarget: false });
    assert.deepEqual((await vote(i, v1, 'up')).reply, { toggled: true }, 'the same vote again takes it back');
    await vote(i, v1, 'up');
    const deciding = await vote(i, v2, 'up');
    assert.deepEqual(deciding.reply.result, { applied: true, newName: 'Replied', illustration: null, upCount: 2, required: 2, active: 1 });
    // A campaign's id comes from the projection.
    const one = await app({ approvals: 1 });
    const c = await issue(one, author, 'maintenance_campaign', { title: 'Reply', instructions: 'Bump deps' });
    await file(c);
    const campaign = await vote(c, v1, 'up');
    const camp = (await pool.query('SELECT id FROM maintenance_campaigns WHERE issue_id = $1', [c.id])).rows[0];
    assert.equal(campaign.reply.result.campaignId, camp.id);
    // A row closed outside the machine (only the transition's own marker
    // gets past the guard now) records no vote and does not answer `toggled`.
    const outside = await issue(a, author, 'rename', { newName: 'Outside' });
    await file(outside);
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      UPDATE issues SET status = 'closed' WHERE id = ${outside.id}; COMMIT`);
    const late = await vote(outside, v1, 'up');
    assert.deepEqual(late.reply, { result: { applied: false, superseded: true } });
    assert.equal((await pool.query('SELECT 1 FROM issue_votes WHERE issue_id = $1', [outside.id])).rowCount, 0);
  });

  await t.test('a refusal answers its reason to the vote that decided it', async () => {
    const a = await app({ approvals: 1 });
    const author = await user();
    const ill = await issue(a, author, 'featured_illustration', { proposed: { url: '/api/illustrations/img-gone' } });
    await pool.query('UPDATE apps SET approvals_required = 2 WHERE id = $1', [a.id]);
    await file(ill);
    await pool.query('UPDATE apps SET approvals_required = 1 WHERE id = $1', [a.id]);
    const refused = await vote(ill, await user(), 'up');
    assert.equal((await inst(ill)).state, 'refused');
    assert.match(refused.reply.result.error, /^(no_image|image_unavailable)$/);
    assert.deepEqual([refused.reply.result.applied, refused.reply.result.refused], [false, true]);
  });
});
