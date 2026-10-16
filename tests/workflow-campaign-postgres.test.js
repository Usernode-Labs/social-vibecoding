'use strict';

// Fleet maintenance campaigns (step 7) against the full PostgreSQL schema:
// the campaign machine (src/workflow/campaign/) beside the proposal machine
// it puts each change up for a vote with, and the governance apply that
// starts it. The proposal machine's GitHub work is fake; the campaign's
// change work is fake for the machine's moves and real (its GitHub and the
// model stubbed) for what a crash in it must not repeat. Each [main] bug the
// step fixes (workflow-foundation's trace-campaigns.md §6) is named where it
// is pinned.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-campaign-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { proposal, sessionKey, MACHINE: PROPOSAL, WORK: PWORK } = require('../src/workflow/proposal/machine.ts');
const { campaign, campaignKey, MACHINE, WORK, CHECK_MS, FENCE } = require('../src/workflow/campaign/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const DEPS = { idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0, shotsEnforced: false };

test('maintenance campaigns against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_campaign_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1'), ('enabled:${PROPOSAL}', '1')
                    ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  const { rows: [platformUser] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('usernode-platform', 'x') RETURNING id`);
  const { rows: [self] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, self_hosted, status)
     VALUES ('Homeroom', 'homeroom', $1, 'https://github.com/acme/homeroom', TRUE, 'running') RETURNING *`, [owner.id]);
  async function app({ status = 'running', repo = true, suspended = false } = {}) {
    const slug = `fleet-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, status, moderation_suspended_at)
       VALUES ($1, $1, $2, $3, $4, $5) RETURNING *`,
      [slug, owner.id, repo ? `https://github.com/acme/${slug}` : null, status, suspended ? new Date() : null]);
    return a;
  }
  // A campaign as the governance apply leaves it: its issue and its row.
  async function campaignRow({ filter = null, status = 'running' } = {}) {
    const { rows: [i] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by, status)
       VALUES ($1, 'Maintenance campaign: Bump', 'maintenance_campaign', $2, $3, 'closed') RETURNING id`,
      [self.id, JSON.stringify({ title: 'Bump', instructions: 'Bump deps' }), owner.id]);
    const { rows: [c] } = await pool.query(
      `INSERT INTO maintenance_campaigns (issue_id, title, instructions, target_filter, status, created_by)
       VALUES ($1, 'Bump', 'Bump deps', $2, $3, $4) RETURNING *`,
      [i.id, filter ? JSON.stringify(filter) : null, status, owner.id]);
    return c;
  }
  const inst = async (machine, key) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  const cInst = (c) => inst(MACHINE, campaignKey(c.id));
  const rows = async (c) => (await pool.query(
    `SELECT mca.app_id, mca.state, mca.error, mca.session_id, mca.runner_id FROM maintenance_campaign_apps mca
      WHERE mca.campaign_id = $1 ORDER BY mca.id`, [c.id])).rows;
  const stateOf = async (c, a) => (await rows(c)).find((r) => r.app_id === a.id);
  const lines = async (c) => (await pool.query(
    `SELECT content FROM chat_messages WHERE thread_type = 'governance' AND thread_ref = $1 ORDER BY id`, [c.issue_id])).rows.map((r) => r.content);
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try { await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT'); } finally { cl.release(); }
  };

  // Fake work: each call recorded; `answer` per kind (a value, or a function
  // of the input, which may throw); `hold` keeps an item running.
  const work = { calls: [], answer: new Map(), hold: new Map() };
  const fake = (kind, extra = {}) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, ...extra,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (work.hold.has(kind)) await work.hold.get(kind);
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input, key) : (a ?? { ok: true });
    },
  });
  // A change made: one commit, one pull request, numbered per app.
  const changedFor = (input) => ({
    changed: true, head: SHA(String(input.appId % 10)), summary: `Bumped deps in app ${input.appId}`,
    branch: input.branch, userId: platformUser.id, prNumber: 100 + input.appId,
    prUrl: `https://github.com/acme/x/pull/${100 + input.appId}`, prTitle: 'Bump',
  });
  const defaults = () => {
    work.calls.length = 0;
    work.hold.clear();
    work.answer.clear();
    work.answer.set(WORK.change, changedFor);
    work.answer.set(PWORK.open, async (input) => {
      const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return { head: input.expectedHead || SHA('c'), prNumber: r.pr_number, prUrl: r.pr_url, prTitle: r.pr_title };
    });
  };
  defaults();
  const services = Object.fromEntries(Object.values(PWORK).map((k) => [k, fake(k)]));
  services[WORK.change] = fake(WORK.change);
  const pm = proposal(DEPS);
  const cm = campaign();
  const rt = createRuntime({ pool, machines: [pm, cm], pollMs: 50, publish: async () => {}, services });
  runtimes.push(rt);

  let rk = 0;
  const system = { kind: 'system' };
  const route = { kind: 'route', name: 'test' };
  // An admin's move: appended, applied, and its outcome as a route reads it.
  const send = async (c, type, payload = {}, source = route) => {
    const id = await rt.append(cm, campaignKey(c.id), { type, payload: { ...payload } }, { requestKey: `t-${++rk}`, source });
    await rt.drain();
    const { rows: [e] } = await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id]);
    return { status: e.result, reason: e.reason, reply: e.reply };
  };
  const start = (c) => rt.append(cm, campaignKey(c.id), { type: 'Start', payload: { campaignId: c.id } },
    { requestKey: `start-${++rk}`, source: system });
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  // Run events and work, work items held included, until `done` holds.
  const running = new Set();
  const until = async (done, what) => {
    for (let k = 0; k < 200; k++) {
      await rt.drain();
      if (await done()) return;
      const run = rt.runServices().finally(() => running.delete(run));
      running.add(run);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`never: ${what}`);
  };
  const quiet = async () => { await Promise.all(running); await settle(); };
  const fire = async (c) => {
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, campaignKey(c.id)]));
    await rt.fireTimers();
    await settle();
  };
  // Every campaign below is the only one with live apps of its own: each
  // test retires the apps the one before it made.
  const fresh = () => pool.query(`UPDATE apps SET status = 'error' WHERE self_hosted IS NOT TRUE`);

  await t.test('C-start: the governance apply\'s Start fixes the targets (live apps, not the platform, not suspended, the filter) and changes one app at a time', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    await app({ status: 'creating' });       // bug 4: not live yet
    await app({ repo: false });
    await app({ suspended: true });
    const c = await campaignRow();
    let release;
    work.hold.set(WORK.change, new Promise((r) => { release = r; }));
    await start(c);
    await rt.drain();
    const i = await cInst(c);
    assert.equal(i.state, 'running');
    assert.deepEqual(i.data.apps.map((a) => a.appId), [a1.id, a2.id]);
    assert.deepEqual((await rows(c)).map((r) => [r.app_id, r.state]), [[a1.id, 'running'], [a2.id, 'pending']], 'the first is being changed at once');
    await until(() => calls(WORK.change).length > 0, 'the first change started');
    await new Promise((r) => setTimeout(r, 50));
    await rt.drain();
    assert.equal(calls(WORK.change).length, 1, 'one app at a time');
    assert.equal(calls(WORK.change)[0].input.appId, a1.id);
    assert.equal(calls(WORK.change)[0].input.branch, `maint/c${c.id}/${a1.slug}`, 'one branch name per app, no timestamp (bug 1)');
    assert.equal((await stateOf(c, a1)).state, 'running');
    // The older release's lease is fenced off for good.
    const { rows: [mc] } = await pool.query('SELECT runner_id, lease_until FROM maintenance_campaigns WHERE id = $1', [c.id]);
    assert.equal(mc.runner_id, FENCE);
    assert.equal(String(mc.lease_until), 'Infinity');
    work.hold.delete(WORK.change);
    release();
    await quiet();
    assert.equal((await cInst(c)).state, 'done');
  });

  await t.test('C1 each change goes up for a vote through the promote: the reviewed head, the vote line, the campaign told; done once every proposal answered', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    const c = await campaignRow();
    await start(c);
    await settle();
    const i = await cInst(c);
    assert.equal(i.state, 'done');
    assert.deepEqual(i.data.apps.map((a) => a.state), ['proposed', 'proposed']);
    for (const a of [a1, a2]) {
      const r = await stateOf(c, a);
      assert.equal(r.state, 'pr_open');
      const { rows: [s] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [r.session_id]);
      assert.equal(s.source, 'maintenance');
      assert.equal(s.user_id, platformUser.id);
      assert.equal(s.status, 'promoted');
      assert.equal(s.reviewed_head_sha, SHA(String(a.id % 10)), 'the pushed commit is what the group votes on (bug 5, C3)');
      assert.ok(s.active_users_at_promote >= 1, 'the electorate stamped as for any promote (bug 5)');
      assert.equal(s.pr_number, 100 + a.id);
      const p = await inst(PROPOSAL, sessionKey(s.id));
      assert.equal(p.state, 'in_review');
      assert.equal(p.data.slot, 'none', 'a campaign\'s proposal holds no worker slot');
      assert.equal(p.data.platform, true);
      const vote = (await pool.query(`SELECT content, msg_type FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [s.id])).rows;
      assert.deepEqual(vote.map((l) => l.msg_type), ['vote'], 'the promote\'s own vote line, once (bug 6)');
      assert.match(vote[0].content, /^Platform maintenance promoted /);
      const checks = await pool.query(`SELECT payload FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RevisionSubmitted'`,
        [sessionKey(s.id)]);
      assert.equal(checks.rows[0].payload.head, SHA(String(a.id % 10)));
    }
    assert.equal(calls(PWORK.open).length, 2);
    assert.equal(calls(PWORK.open)[0].input.expectedHead, SHA(String(a1.id % 10)));
    // The exemplar: the first success's summary rides to the next app (bug 13).
    assert.equal(calls(WORK.change)[0].input.exemplar, null);
    assert.equal(calls(WORK.change)[1].input.exemplar, `Bumped deps in app ${a1.id}`);
    assert.equal(i.data.exemplar, `Bumped deps in app ${a1.id}`);
    assert.deepEqual(await lines(c), ['Maintenance campaign "Bump" finished fanning out: 2 PRs opened, 0 skipped, 0 failed. '
      + 'Each PR now runs its own checks and merge vote.'], 'the completion line written with done (bug 12)');
    assert.equal((await pool.query('SELECT status, completed_at FROM maintenance_campaigns WHERE id = $1', [c.id])).rows[0].status, 'done');
  });

  await t.test('C2 not done while a proposal is still going up for a vote; skipped and failed apps move on', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    const a3 = await app();
    work.answer.set(WORK.change, (input) => {
      if (input.appId === a2.id) return { skipped: true, reason: 'no JWT code here' };
      if (input.appId === a3.id) throw Object.assign(new Error('Tool-call budget exhausted'), { permanent: true });
      return changedFor(input);
    });
    let release;
    work.hold.set(PWORK.open, new Promise((r) => { release = r; }));
    const c = await campaignRow();
    await start(c);
    await until(async () => (await cInst(c))?.data.apps.every((a) => a.state !== 'waiting' && a.state !== 'changing'), 'every app changed');
    let i = await cInst(c);
    assert.deepEqual(i.data.apps.map((a) => a.state), ['proposing', 'skipped', 'failed']);
    assert.equal(i.state, 'running', 'waits for the proposal\'s answer');
    assert.equal((await stateOf(c, a2)).error, 'no JWT code here');
    assert.equal((await stateOf(c, a3)).error, 'Tool-call budget exhausted');
    assert.ok(i.deadline_at, 'its check clock runs while a proposal is being put up for a vote');
    work.hold.delete(PWORK.open);
    release();
    await quiet();
    i = await cInst(c);
    assert.equal(i.state, 'done');
    assert.equal(i.deadline_at, null);
    assert.match((await lines(c))[0], /1 PRs opened, 1 skipped, 1 failed/);
  });

  await t.test('C3 a refused promote fails the app with the reason and closes its proposal; Retry makes the change again, on a branch of its own', async () => {
    defaults(); await fresh();
    const a1 = await app();
    let refuse = true;
    work.answer.set(PWORK.open, async (input) => {
      if (refuse) throw Object.assign(new Error('GitHub could not verify the pull request revision.'), { code: 'github_unavailable', permanent: true });
      const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [input.sessionId]);
      return { head: input.expectedHead, prNumber: r.pr_number, prUrl: r.pr_url, prTitle: r.pr_title };
    });
    const c = await campaignRow();
    await start(c);
    await settle();
    let r = await stateOf(c, a1);
    assert.equal(r.state, 'failed');
    assert.match(r.error, /^Could not put it up for a vote: GitHub could not verify/);
    assert.equal((await cInst(c)).state, 'done');
    const first = r.session_id;
    // Nobody can act on the platform account's underway change: it is closed, its PR with it.
    assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [first])).rows[0].status, 'archived');
    assert.equal(calls(PWORK.close).length, 1);
    const line = (await pool.query(`SELECT content FROM chat_messages WHERE thread_type = 'session' AND thread_ref = $1`, [first])).rows.at(-1);
    assert.match(line.content, /could not be put up for a vote and was closed/);
    refuse = false;
    assert.equal((await send(c, 'RetryApp', { appId: a1.id, userId: owner.id, username: 'owner' })).status, 'accepted');
    await settle();
    r = await stateOf(c, a1);
    assert.equal(r.state, 'pr_open');
    assert.notEqual(r.session_id, first, 'a new proposal');
    const changes = calls(WORK.change);
    assert.deepEqual(changes.map((x) => x.key), [`app:${a1.id}:1`, `app:${a1.id}:2`], 'the change made again');
    assert.equal(changes[1].input.branch, `maint/c${c.id}/${a1.slug}-2`, 'not the branch the closed PR is on');
    const { rows: [w] } = await pool.query(`SELECT checkpoint FROM wf_work WHERE machine = $1 AND key = $2 AND work_key = $3`,
      [MACHINE, campaignKey(c.id), `app:${a1.id}:2`]);
    assert.equal(w.checkpoint, null, 'from scratch: the closed pull request is not carried on');
    assert.equal((await cInst(c)).state, 'done');
  });

  await t.test('C4 a proposal that never answers (its promote rejected outright) is read off its row by the check', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const c = await campaignRow();
    // The row the change's result inserts is made headless, so the proposal
    // machine's guard refuses the campaign's promote (a refusal sends no
    // answer).
    await pool.query(`CREATE OR REPLACE FUNCTION wf_test_headless() RETURNS trigger AS $$
      BEGIN NEW.is_headless := TRUE; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER wf_test_headless BEFORE INSERT ON chat_sessions FOR EACH ROW
      WHEN (NEW.source = 'maintenance') EXECUTE FUNCTION wf_test_headless()`);
    try {
      await start(c);
      await settle();
    } finally {
      await pool.query('DROP TRIGGER wf_test_headless ON chat_sessions');
    }
    let i = await cInst(c);
    assert.equal(i.data.apps[0].state, 'proposing', 'no answer came (a rejected promote sends none)');
    const reject = (await pool.query(
      `SELECT reason FROM wf_events WHERE machine = 'proposal' AND type = 'Promote' AND key = $1`,
      [sessionKey((await stateOf(c, a1)).session_id)])).rows[0];
    assert.equal(reject.reason, 'headless');
    assert.ok(i.deadline_at && Date.parse(i.deadline_at) > Date.now() + CHECK_MS - 60000);
    await fire(c);
    i = await cInst(c);
    assert.equal(i.data.apps[0].state, 'failed');
    assert.match(i.data.apps[0].error, /^Could not put it up for a vote: headless/);
    assert.equal(i.state, 'done');
    assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [(await stateOf(c, a1)).session_id])).rows[0].status,
      'archived', 'the proposal nobody could put up for a vote is closed');
  });

  await t.test('C5 a retry keeps the targets: an app created since is not added (bug 3)', async () => {
    defaults(); await fresh();
    const a1 = await app();
    work.answer.set(WORK.change, () => { throw Object.assign(new Error('GitHub 502'), { permanent: true }); });
    const c = await campaignRow();
    await start(c);
    await settle();
    assert.equal((await stateOf(c, a1)).state, 'failed');
    await app();  // created three weeks later
    work.answer.set(WORK.change, changedFor);
    assert.equal((await send(c, 'RetryApp', { appId: a1.id, userId: owner.id })).status, 'accepted');
    await settle();
    assert.deepEqual((await rows(c)).map((r) => [r.app_id, r.state]), [[a1.id, 'pr_open']]);
    assert.deepEqual(calls(WORK.change).map((x) => x.key), [`app:${a1.id}:1`, `app:${a1.id}:2`]);
    assert.equal((await send(c, 'RetryApp', { appId: a1.id })).reason, 'not_retryable');
  });

  await t.test('C6 Stop: nothing more is reached; the change under way finishes, and what it opened stays up for its vote (bug 8)', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    const a3 = await app();
    const c = await campaignRow();
    let hold;
    work.answer.set(WORK.change, async (input) => {
      if (input.appId === a2.id) await new Promise((r) => { hold = r; });
      return changedFor(input);
    });
    await start(c);
    await until(async () => !!hold && (await cInst(c)).data.apps[0].state === 'proposed', 'the first proposed, the second being changed');
    let i = await cInst(c);
    assert.deepEqual(i.data.apps.map((a) => a.state), ['proposed', 'changing', 'waiting']);
    const out = await send(c, 'Stop', { userId: owner.id, username: 'owner' });
    assert.equal(out.status, 'accepted');
    assert.match((await lines(c)).at(-1), /was stopped by owner: 1 PRs opened, 1 change still finishing, 1 apps not reached/);
    // The change under way had already opened its PR: it is kept, as the
    // opened ones are (Q3), not left on GitHub with no proposal.
    hold();
    await quiet();
    i = await cInst(c);
    assert.equal(i.state, 'stopped');
    assert.deepEqual(i.data.apps.map((a) => a.state), ['proposed', 'proposed', 'not_reached']);
    assert.deepEqual((await rows(c)).map((r) => r.state), ['pr_open', 'pr_open', 'stopped']);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM chat_sessions WHERE source = 'maintenance' AND app_id = $1`,
      [a3.id])).rows[0].n, 0, 'no proposal for the app it never reached');
    assert.equal((await pool.query('SELECT status FROM maintenance_campaigns WHERE id = $1', [c.id])).rows[0].status, 'cancelled');
    assert.equal((await send(c, 'RetryApp', { appId: a3.id })).reason, 'stopped');
  });

  await t.test('C7 Merge all green forces, at once, exactly the proposals in review whose checks pass (bug 7)', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    const a3 = await app();
    const c = await campaignRow();
    await start(c);
    await settle();
    const [s1, s2, s3] = await Promise.all([a1, a2, a3].map(async (a) => (await stateOf(c, a)).session_id));
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [s1]);
    await pool.query(`UPDATE chat_sessions SET check_state = 'skipped' WHERE id = $1`, [s2]);
    await pool.query(`UPDATE chat_sessions SET check_state = 'failing' WHERE id = $1`, [s3]);
    const out = await send(c, 'MergeGreen', { userId: owner.id, username: 'owner' });
    assert.equal(out.status, 'accepted');
    assert.deepEqual(out.reply.asked, [s1, s2]);
    await settle();
    for (const s of [s1, s2]) {
      const p = await inst(PROPOSAL, sessionKey(s));
      assert.equal(p.data.force?.by, 'owner', 'forced, under the proposal\'s own lock');
    }
    assert.equal((await inst(PROPOSAL, sessionKey(s3))).data.force ?? null, null);
    assert.deepEqual((await cInst(c)).data.drained.asked, [s1, s2]);
  });

  await t.test('C8 the guard: the campaign\'s rows are refused to writers outside it; a deleted proposal still empties its link', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const c = await campaignRow();
    await start(c);
    await settle();
    await assert.rejects(pool.query(`UPDATE maintenance_campaign_apps SET state = 'merged' WHERE campaign_id = $1`, [c.id]),
      /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query(`UPDATE maintenance_campaigns SET status = 'running' WHERE id = $1`, [c.id]),
      /WF_OWNERSHIP_VIOLATION/);
    // The older release's takeLease, as it was written, takes nothing: on a
    // campaign still running (its change held).
    await app();
    const running = await campaignRow();
    let release;
    work.hold.set(WORK.change, new Promise((r) => { release = r; }));
    await start(running);
    await until(() => calls(WORK.change).some((x) => x.input.campaignId === running.id), 'its change started');
    assert.equal((await cInst(running)).state, 'running');
    const { rowCount } = await pool.query(
      `UPDATE maintenance_campaigns SET runner_id = 'old', lease_until = NOW() + interval '120 seconds'
        WHERE id = $1 AND status = 'running' AND (lease_until IS NULL OR lease_until < NOW() OR runner_id = 'old')`, [running.id]);
    assert.equal(rowCount, 0);
    work.hold.delete(WORK.change);
    release();
    await quiet();
    const sid = (await stateOf(c, a1)).session_id;
    await asTransition((cl) => cl.query('DELETE FROM chat_sessions WHERE id = $1', [sid]));
    assert.equal((await stateOf(c, a1)).session_id, null);
  });

  await t.test('C9 adoption: a campaign an older release drives is left to it until its lease lapses, then taken as its rows stand', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    const a3 = await app();
    const c = await campaignRow();
    // As the older driver left it: one PR open, one mid-change, one pending.
    const { rows: [old] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, pr_number, branch_name) VALUES ($1, $2, 'promoted', 'maintenance', 7, 'maint/old')
       RETURNING id`, [a1.id, platformUser.id]);
    await pool.query(
      `INSERT INTO maintenance_campaign_apps (campaign_id, app_id, state, session_id, runner_id) VALUES
         ($1, $2, 'pr_open', $5, 'old'), ($1, $3, 'running', NULL, 'old'), ($1, $4, 'pending', NULL, NULL)`,
      [c.id, a1.id, a2.id, a3.id, old.id]);
    await pool.query(`UPDATE maintenance_campaigns SET runner_id = 'old', lease_until = NOW() + interval '2 minutes' WHERE id = $1`, [c.id]);
    const first = await start(c);
    await rt.drain();
    const { rows: [ev] } = await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [first]);
    assert.deepEqual([ev.result, ev.reason], ['rejected', 'driven_elsewhere']);
    assert.equal(await cInst(c), undefined);
    await pool.query(`UPDATE maintenance_campaigns SET lease_until = NOW() - interval '1 second' WHERE id = $1`, [c.id]);
    await start(c);
    await settle();
    const i = await cInst(c);
    assert.deepEqual(i.data.apps.map((a) => [a.appId, a.state]), [[a1.id, 'proposed'], [a2.id, 'proposed'], [a3.id, 'proposed']]);
    assert.deepEqual(calls(WORK.change).map((x) => x.input.appId), [a2.id, a3.id], 'the app left mid-change is changed again; the open PR is kept');
    assert.ok((await rows(c)).every((r) => r.runner_id === FENCE), 'every row fenced off for an older driver');
    assert.equal(i.state, 'done');
  });

  await t.test('C10 Start for a campaign with no live app is done at once, and a second Start is ignored', async () => {
    defaults(); await fresh();
    const c = await campaignRow({ filter: ['no-such-app'] });
    await start(c);
    await settle();
    assert.equal((await cInst(c)).state, 'done');
    const again = await start(c);
    await rt.drain();
    assert.equal((await pool.query('SELECT reason FROM wf_events WHERE id = $1', [again])).rows[0].reason, 'already_started');
  });

  await t.test('C11 an app deleted while it is being changed fails, and the campaign goes on (no fault)', async () => {
    defaults(); await fresh();
    const a1 = await app();
    const a2 = await app();
    work.answer.set(WORK.change, async (input) => {
      if (input.appId === a1.id) await asTransition((cl) => cl.query('DELETE FROM apps WHERE id = $1', [a1.id]));
      return changedFor(input);
    });
    const c = await campaignRow();
    await start(c);
    await settle();
    const i = await cInst(c);
    assert.equal(i.flag, null, 'not faulted');
    assert.deepEqual(i.data.apps.map((a) => a.state), ['failed', 'proposed']);
    assert.match(i.data.apps[0].error, /^The app was deleted while it was being changed \(its pull request #\d+ is left on GitHub\)/);
    assert.equal(i.state, 'done');
  });

  await t.test('C12 an app deleted while its change goes up for a vote is failed by the check, and the campaign is done', async () => {
    defaults(); await fresh();
    const a1 = await app();
    let release;
    work.hold.set(PWORK.open, new Promise((r) => { release = r; }));
    const c = await campaignRow();
    await start(c);
    await until(async () => (await cInst(c)).data.apps[0].state === 'proposing' && calls(PWORK.open).length > 0, 'going up for a vote');
    await asTransition((cl) => cl.query('DELETE FROM apps WHERE id = $1', [a1.id]));
    work.hold.delete(PWORK.open);
    release();
    await quiet();
    await fire(c);
    const i = await cInst(c);
    assert.equal(i.data.apps[0].state, 'failed');
    assert.match(i.data.apps[0].error, /deleted before it went up for a vote/);
    assert.equal(i.state, 'done');
  });

  await t.test('C13 the check waits for a promote not applied yet, never reading it as refused', () => {
    // The check's own move, on the facts it reads: the campaign's last
    // Promote still pending (a backlog, a rollout), its proposal underway
    // with an earlier answer.
    const app1 = { appId: 1, slug: 'x', state: 'proposing', n: 1, sessionId: null, prNumber: 101, error: null, resumable: false };
    const s = { name: 'running', data: { campaignId: 1, issueId: 1, threadAppId: 1, title: 'T', proposerId: 2, apps: [app1],
      exemplar: null, drained: null, stopped: null } };
    const asked = (over) => [{ appId: 1, sessionId: 5, status: 'active', prNumber: 101, state: 'underway', promoting: false,
      answer: { ok: false, code: 'github_unavailable' }, promote: { result: null, reason: null }, gone: false, ...over }];
    const check = (facts) => cm.entryFor('running', 'Check').to(s, { type: 'Check', payload: {} },
      { campaign: null, apps: [], green: [], appAlive: null, ...facts }, { now: new Date(), key: 'campaign:1', machine: MACHINE, appId: null, version: 1 });
    assert.equal(check({ asked: asked() }).next.data.apps[0].state, 'proposing', 'pending: waited for');
    const rejected = check({ asked: asked({ promote: { result: 'rejected', reason: 'busy' } }) });
    assert.equal(rejected.next.data.apps[0].state, 'failed');
    assert.deepEqual(rejected.messages.map((m) => [m.to.key, m.event.type]), [['session:5', 'Close']]);
    const rollout = check({ asked: asked({ promote: { result: 'rejected', reason: 'not_a_producer' } }) });
    assert.equal(rollout.next.data.apps[0].state, 'proposing', 'an older release refused it: sent again');
    assert.deepEqual(rollout.messages.map((m) => m.event.type), ['Promote']);
    assert.equal(rollout.next.data.apps[0].resent, 1);
    assert.ok(rollout.timer && rollout.timer.event.type === 'Check', 'the check comes back');
  });

  await t.test('C14 the dashboard reads what came of each proposal (bug 10)', async () => {
    defaults(); await fresh();
    const apps = [await app(), await app(), await app(), await app()];
    const c = await campaignRow();
    await start(c);
    await settle();
    const ids = await Promise.all(apps.map(async (a) => (await stateOf(c, a)).session_id));
    await asTransition(async (cl) => {
      await cl.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [ids[0]]);
      await cl.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [ids[1]]);
      await cl.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [ids[2]]);
    });
    const status = await require('../src/services/fleet-maintenance').campaignStatus(pool, c.id);
    assert.deepEqual(status.apps.map((a) => [a.state, a.sessionStatus]),
      [['merged', 'merged'], ['closed', 'archived'], ['underway', 'active'], ['pr_open', 'promoted']]);
    assert.deepEqual(status.counts, { merged: 1, closed: 1, underway: 1, pr_open: 1 });
  });

  await t.test('C15 the change work: GitHub or the model off fails at once; a stop before the push opens nothing; a resumed change opens its PR once', async () => {
    const { campaignServices } = require('../src/workflow/campaign/services.ts');
    const fm = require('../src/services/fleet-maintenance');
    const github = require('../src/services/github');
    const llm = require('../src/services/llm');
    const saved = new Map([[fm, { ...fm }], [github, { ...github }], [llm, { ...llm }]]);
    const handler = campaignServices({ config: {}, pool })[WORK.change];
    const did = [];
    const a1 = await app();
    const c = await campaignRow();
    const ctx = (resumeFrom = null) => ({ input: { campaignId: c.id, appId: a1.id, branch: `maint/c${c.id}/${a1.slug}`, exemplar: null },
      resumeFrom, signal: new AbortController().signal, checkpoint: async (v) => { did.push(['checkpoint', v]); } });
    try {
      github.isEnabled = () => false;
      await assert.rejects(handler.run(ctx()), (err) => err.permanent === true && /GitHub is not configured/.test(err.message));
      github.isEnabled = () => true;
      llm.isEnabled = () => false;
      await assert.rejects(handler.run(ctx()), (err) => err.permanent === true && /model is not configured/.test(err.message));
      llm.isEnabled = () => true;
      fm.runAppChange = async () => { did.push(['ai']); return { files: new Map([['a', 'b']]), summary: 'S' }; };
      fm.pushChange = async () => { did.push(['push']); return 'e'.repeat(40); };
      fm.openChangePr = async () => { did.push(['pr']); return { number: 9, url: 'u', title: 'T' }; };
      // Stopped while the AI worked: nothing reaches the repository.
      await asTransition((cl) => cl.query(`UPDATE maintenance_campaigns SET status = 'cancelled' WHERE id = $1`, [c.id]));
      assert.deepEqual(await handler.run(ctx()), { stopped: true });
      assert.deepEqual(did.map((x) => x[0]), ['ai']);
      // Resumed after its push: no AI, no push, its PR once.
      await asTransition((cl) => cl.query(`UPDATE maintenance_campaigns SET status = 'running' WHERE id = $1`, [c.id]));
      did.length = 0;
      const out = await handler.run(ctx({ head: 'e'.repeat(40), summary: 'S' }));
      assert.deepEqual(did.map((x) => x[0]), ['checkpoint', 'pr', 'checkpoint']);
      assert.equal(out.prNumber, 9);
      assert.equal(handler.maxAttempts * 0 + [1, 2, 3, 4, 5, 6, 7].reduce((t, n) => t + handler.backoffMs(n), 0) >= 55 * 60 * 1000, true,
        'GitHub\'s and the model\'s temporary errors are retried for about an hour');
    } finally {
      for (const [mod, orig] of saved) Object.assign(mod, orig);
    }
  });
});
