'use strict';

// app-creation (src/workflow/app-creation/) against the full PostgreSQL
// schema: a project's insert starts its making (the apps_wf_enrol_creation
// trigger); its setup is one work item; its first deploy is app delivery's;
// its first request is filed once beside it; every status a person sees is
// written by the machine; its time limit fails it; a person's Retry sets it
// up again; and a row an older build makes is waited for. The setup, the
// deploy and the filing are fake services; the real ones are
// app-creator.js setUp, staging.deployProduction and homeroom-bot-dm.js
// fileFirstRequest.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-app-creation-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const creation = require('../src/workflow/app-creation/machine.ts');
const delivery = require('../src/workflow/app-delivery/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40);
const { MACHINE, WORK, creationKey } = creation;

test('app-creation machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_creation_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 10 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  for (const m of [MACHINE, delivery.MACHINE]) {
    await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${m}', '1') ON CONFLICT DO NOTHING`);
  }

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('maker', 'x') RETURNING id`);
  // A project as a route inserts it: the workflow makes it.
  async function project({ by = 'workflow', status = 'creating', heartbeat = null } = {}) {
    const slug = `made-${++seq}`;
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, creating_owner, creating_heartbeat_at)
       VALUES ($1, $1, $2, $3, $4, $5) RETURNING *`,
      [slug, owner.id, status, by, heartbeat]);
    return a;
  }
  const owe = (a) => pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds) VALUES ($1, $2, 'a tier list of cafes', TRUE)`,
    [a.id, owner.id]);

  // The setup, the deploy and the filing: each call answers what `next` says.
  const setups = { calls: [], next: [] };
  const deploys = { calls: [], next: [] };
  const filings = { calls: [] };
  const machine = creation.appCreation();
  const deliveries = delivery.appDelivery({ githubOn: () => true, runtimeMode: 'kubernetes' });
  const pushed = [];
  const services = {
    [WORK.setup]: {
      maxAttempts: 1, resumable: true, maxLostAttempts: 3,
      async run({ input, key }) {
        setups.calls.push({ key, input });
        const answer = setups.next.shift() || { sha: SHA('1'), repoUrl: 'https://github.com/bot/x', offer: { starter: { sha: SHA('1'), template: 'blank' } }, timing: { stages: { database: 10 } } };
        if (answer.throw) throw new Error(answer.throw);
        if (answer.hang) await new Promise((r) => setTimeout(r, answer.hang));
        if (answer.repoUrl) await pool.query('UPDATE apps SET repo_url = $2 WHERE id = $1', [input.appId, answer.repoUrl]);
        return answer;
      },
    },
    [WORK.firstRequest]: {
      maxAttempts: 1,
      async run({ input, key }) { filings.calls.push({ key, input }); return { issueNumber: 1 }; },
    },
    [delivery.WORK.deploy]: {
      maxAttempts: 1,
      async run({ input, key }) {
        deploys.calls.push({ key, input });
        const answer = deploys.next.shift() || { sha: SHA('1'), url: 'https://made.example' };
        if (answer.throw) throw Object.assign(new Error(answer.throw), { permanent: true });
        return answer;
      },
    },
  };
  const publish = async (q, list) => { pushed.push(...list); };
  const rt = createRuntime({ pool, machines: [machine, deliveries], pollMs: 50, publish, services });
  runtimes.push(rt);
  // A process that makes projects but whose app delivery is an older
  // build's: what it asks of app delivery waits for the test to answer.
  const solo = createRuntime({ pool, machines: [machine], pollMs: 50, publish, services: { [WORK.setup]: services[WORK.setup] } });
  runtimes.push(solo);
  // An older build's app delivery refused the asks (it knew no app-creation).
  const refuseAsks = async (a) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      const { rowCount } = await c.query(
        `UPDATE wf_events SET status = 'processed', result = 'rejected', reason = 'unknown_asker'
          WHERE machine = $1 AND key = $2 AND type = 'DeployRequested' AND status = 'pending'`, [delivery.MACHINE, delivery.appKey(a.id)]);
      await c.query('COMMIT');
      return rowCount;
    } finally { c.release(); }
  };

  const settle = async () => { for (let i = 0; i < 30; i++) { await rt.drain(); if (!(await rt.runServices())) { await rt.drain(); return; } } };
  const inst = async (a) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, creationKey(a.id)])).rows[0];
  const row = async (a) => (await pool.query('SELECT * FROM apps WHERE id = $1', [a.id])).rows[0];
  const reset = () => { setups.calls.length = 0; setups.next.length = 0; deploys.calls.length = 0; deploys.next.length = 0; filings.calls.length = 0; pushed.length = 0; };
  let rk = 0;
  const retry = (a, counted = true) => rt.append(machine, creationKey(a.id), { type: 'Retry', payload: { appId: a.id, counted } },
    { requestKey: `retry-${++rk}`, appId: a.id, source: { kind: 'system', name: 'retry' } });
  const outcomeOf = async (id) => (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id])).rows[0];
  const statuses = (a) => pushed.filter((p) => p.data.type === 'app_status' && p.data.appId === a.id && !p.data.phase).map((p) => p.data.status);
  // The instance's deadline due now.
  const dueNow = async (a) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now(),
                             data = data || jsonb_build_object('deadline', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                      WHERE machine = $1 AND key = $2`, [MACHINE, creationKey(a.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

  const due = async (a) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, creationKey(a.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

  await t.test('C1: a project\'s insert starts its making; set up, its first deploy is app delivery\'s, then it runs', async () => {
    reset();
    const a = await project();
    await rt.drain();
    assert.equal((await inst(a)).state, 'setting_up');
    await settle();
    assert.deepEqual(setups.calls.map((c) => c.key), ['setup:1']);
    assert.equal(deploys.calls.length, 1, 'one deploy, app delivery\'s');
    assert.deepEqual(deploys.calls[0].input.reuse, { starter: { sha: SHA('1'), template: 'blank' } }, 'the starter commit is offered');
    const r = await row(a);
    assert.equal(r.status, 'running');
    assert.equal(r.main_sha, SHA('1'), 'app delivery wrote what deployed');
    assert.ok(r.first_running_at, 'its first run is marked');
    assert.equal((await inst(a)).state, 'running');
    assert.deepEqual(statuses(a), ['running']);
    assert.equal(pushed.find((p) => p.data.type === 'app_status' && p.data.status === 'running').data.url, 'https://made.example');
    const { rows: timed } = await pool.query(`SELECT metadata FROM events WHERE app_id = $1 AND event_type = 'app_creation_timed'`, [a.id]);
    assert.equal(timed.length, 1);
    assert.equal(timed[0].metadata.outcome, 'running');
    assert.equal(timed[0].metadata.stages.database, 10);
    assert.equal(filings.calls.length, 0, 'no first request owed');
    const phases = pushed.filter((p) => p.data.type === 'app_status' && p.data.appId === a.id && p.data.phase).map((p) => p.data.phase);
    assert.deepEqual(phases, ['database', 'build'], 'the made screen hears its making start, and its first deploy start');
  });

  await t.test('C2: a row an older build inserts during a rollout is waited for: that build makes it, or it is made here once left', async () => {
    reset();
    // Inserted without an owner: that build writes its owner just after.
    const a = await project({ by: null });
    await settle();
    assert.equal((await inst(a)).state, 'waiting');
    assert.equal(setups.calls.length, 0, 'that build makes it');
    // That build finished it: the instance lands where the row is.
    await pool.query(`UPDATE apps SET status = 'running' WHERE id = $1`, [a.id]);
    await due(a);
    await rt.fireTimers();
    await settle();
    assert.equal((await inst(a)).state, 'running');
    assert.equal(setups.calls.length, 0);
    // One its build finished as failed reads failed (a Retry is the way on).
    const f = await project({ by: null });
    await rt.drain();
    await pool.query(`UPDATE apps SET status = 'error' WHERE id = $1`, [f.id]);
    await due(f);
    await rt.fireTimers();
    await settle();
    assert.equal((await inst(f)).state, 'failed');
    // One left ownerless past that build's ten minutes: made here.
    const b = await project({ by: null });
    await rt.drain();
    await pool.query(`UPDATE apps SET created_at = now() - interval '11 minutes' WHERE id = $1`, [b.id]);
    await due(b);
    await rt.fireTimers();
    await settle();
    assert.equal((await inst(b)).state, 'running');
    assert.deepEqual(setups.calls.map((c) => c.key), ['setup:1']);
    assert.equal((await row(b)).creating_owner, 'workflow');
  });

  await t.test('C3: a failed setup reads failed with its record; Retry sets it up again, counted', async () => {
    reset();
    setups.next.push({ failed: { stage: 'repo', reason: 'GitHub said no', at: new Date().toISOString() } });
    const a = await project();
    await settle();
    let r = await row(a);
    assert.equal(r.status, 'error');
    assert.equal(r.last_failure.reason, 'GitHub said no');
    assert.equal((await inst(a)).state, 'failed');
    assert.deepEqual(statuses(a), ['error']);
    assert.equal(deploys.calls.length, 0);
    await retry(a);
    await settle();
    r = await row(a);
    assert.equal(r.status, 'running');
    assert.equal(r.retry_count, 1);
    assert.deepEqual(setups.calls.map((c) => c.key), ['setup:1', 'setup:2']);
    const again = await retry(a);
    await rt.drain();
    assert.equal((await outcomeOf(again)).reason, 'running', 'only a failed project is tried again');
  });

  await t.test('C4: a setup whose processes kept going away reads interrupted, and its Retry is free', async () => {
    reset();
    const a = await project();
    await rt.drain();
    // Every attempt so far lost with its process (the kernel's count): the
    // next claim gives it up.
    await pool.query(`UPDATE wf_work SET lost_attempts = 4, attempt_count = 4 WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, creationKey(a.id), WORK.setup]);
    await settle();
    assert.equal(setups.calls.length, 0, 'never run again');
    const r = await row(a);
    assert.equal((await inst(a)).state, 'failed');
    assert.equal(r.status, 'error');
    assert.equal(r.last_failure.interrupted, true);
    assert.equal(r.last_failure.reason, creation.INTERRUPTED);
    await retry(a, false);
    await settle();
    assert.equal((await row(a)).status, 'running');
    assert.equal((await row(a)).retry_count, 0, 'not counted');
  });

  await t.test('C5: missing keys: it waits for them, with the first commit recorded', async () => {
    reset();
    deploys.next.push({ failed: 'missing_secrets', message: 'keys', missingSecrets: ['OPENAI_KEY'] });
    const a = await project();
    await settle();
    const r = await row(a);
    assert.equal(r.status, 'awaiting_secrets');
    assert.equal(r.main_sha, SHA('1'));
    assert.equal((await inst(a)).state, 'awaiting_secrets');
    const p = pushed.find((x) => x.data.type === 'app_status' && x.data.status === 'awaiting_secrets');
    assert.deepEqual(p.data.missingSecrets, ['OPENAI_KEY']);
  });

  await t.test('C6: past its time limit a setup is given up, its late result stale; a late first deploy makes it run', async () => {
    reset();
    const a = await project();
    await rt.drain();
    await dueNow(a);
    await rt.fireTimers();
    await rt.drain();
    let r = await row(a);
    assert.equal(r.status, 'error');
    assert.equal(r.last_failure.reason, creation.TIMED_OUT);
    const { rows: [w] } = await pool.query(`SELECT status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3`, [MACHINE, creationKey(a.id), WORK.setup]);
    assert.equal(w.status, 'settled', 'cancelled: it never runs');
    await settle();
    assert.equal(setups.calls.length, 0);
    assert.equal((await row(a)).status, 'error');
    // One whose first deploy is under way when its time is up.
    reset();
    const b = await project();
    await rt.drain();
    await rt.runServices();   // the setup
    await rt.drain();
    assert.equal((await inst(b)).state, 'deploying');
    await dueNow(b);
    await rt.fireTimers();
    await rt.drain();
    assert.equal((await row(b)).status, 'error');
    assert.equal((await row(b)).last_failure.reason, creation.TIMED_OUT, 'app delivery holds its deploy: timed out, not interrupted');
    // A Retry now would set it up again under that deploy.
    const early = await retry(b);
    await rt.drain();
    assert.equal((await outcomeOf(early)).reason, 'still_deploying');
    assert.equal((await inst(b)).data.attempt, 1);
    await settle();          // the deploy answers after all
    r = await row(b);
    assert.equal(r.status, 'running');
    assert.equal((await inst(b)).state, 'running');
  });

  await t.test('C7: a first request owed is filed once, beside the first deploy', async () => {
    reset();
    const a = await project();
    await owe(a);
    await settle();
    assert.deepEqual(filings.calls.map((c) => c.key), ['first-request']);
    assert.equal((await row(a)).status, 'running');
  });

  await t.test('C8: a row an older build is still making is waited for, then made from where it is', async () => {
    reset();
    const a = await project({ by: 'old-process-token', heartbeat: new Date() });
    await rt.append(machine, creationKey(a.id), { type: 'Adopted', payload: { appId: a.id } },
      { requestKey: `adopt:${a.id}`, appId: a.id, source: { kind: 'system', name: 'release' } });
    await rt.drain();
    let i = await inst(a);
    assert.equal(i.state, 'waiting', 'its owner is alive');
    assert.equal(i.deadline_event.type, 'Recheck');
    assert.equal(setups.calls.length, 0);
    // Its owner went quiet.
    await pool.query(`UPDATE apps SET creating_heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [a.id]);
    await due(a);
    await rt.fireTimers();
    await settle();
    i = await inst(a);
    assert.equal(i.state, 'running');
    assert.equal((await row(a)).creating_owner, 'workflow', 'the workflow\'s now: an older sweep never takes it');
    assert.equal(Number((await row(a)).creating_heartbeat_at), Infinity, 'its heartbeat never lapses (an older sweep takes a lapsed one)');
  });

  await t.test('C11: a first deploy an older build\'s app delivery refused is asked again; never taken up by its time limit, it was interrupted', async () => {
    reset();
    const a = await project();
    await solo.drain();
    await solo.runServices();   // the setup
    await solo.drain();
    assert.equal((await inst(a)).state, 'deploying');
    assert.equal(await refuseAsks(a), 1);
    // Its look, before its time limit: app delivery does not hold it.
    await due(a);
    await solo.fireTimers();
    await solo.drain();
    assert.equal((await inst(a)).state, 'deploying');
    const { rows: asks } = await pool.query(`SELECT status FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'DeployRequested' ORDER BY id`,
      [delivery.MACHINE, delivery.appKey(a.id)]);
    assert.deepEqual(asks.map((x) => x.status), ['processed', 'pending'], 'asked again');
    // A process of this build's app delivery takes it up: it runs.
    await settle();
    assert.equal(deploys.calls.length, 1);
    assert.equal((await row(a)).status, 'running');
    assert.equal((await inst(a)).state, 'running');
    // Held, it is not asked again.
    reset();
    const h = await project();
    await settle();
    assert.equal((await inst(h)).state, 'running');

    // One whose ask nothing took up when its time ran out: the platform's
    // doing, so its Retry is free.
    reset();
    const b = await project();
    await solo.drain();
    await solo.runServices();
    await solo.drain();
    await refuseAsks(b);
    await dueNow(b);
    await solo.fireTimers();
    await solo.drain();
    const r = await row(b);
    assert.equal(r.status, 'error');
    assert.equal(r.last_failure.reason, creation.INTERRUPTED);
    assert.equal(r.last_failure.interrupted, true);
  });

  await t.test('C12: a first request an older build left open is filed here, once, in the state its row is in', async () => {
    reset();
    // Made by an older build: running, with a repository, no instance.
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, repo_url) VALUES ('owed-1', 'owed-1', $1, 'running', 'https://github.com/bot/owed-1') RETURNING *`,
      [owner.id]);
    await owe(a);
    const ask = (key) => rt.append(machine, creationKey(a.id), { type: 'FirstRequestOwed', payload: { appId: a.id } },
      { requestKey: key, appId: a.id, source: { kind: 'system', name: 'release' } });
    const first = await ask('owed-1');
    await settle();
    assert.equal((await outcomeOf(first)).result, 'accepted');
    assert.equal((await inst(a)).state, 'running');
    assert.deepEqual(filings.calls.map((c) => c.key), ['first-request']);
    await ask('owed-2');
    await settle();
    assert.equal(filings.calls.length, 1, 'once: its key');
    // One this machine made, running, whose filing an older build's sweep
    // left open.
    const m = await project();
    await settle();
    await owe(m);
    await rt.append(machine, creationKey(m.id), { type: 'FirstRequestOwed', payload: { appId: m.id } },
      { requestKey: 'owed-m', appId: m.id, source: { kind: 'system', name: 'release' } });
    await settle();
    assert.deepEqual(filings.calls.map((c) => c.input.appId), [a.id, m.id]);
    // Owed nothing: no repository to file it in, or nothing described.
    const { rows: [n] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status) VALUES ('owed-2', 'owed-2', $1, 'running') RETURNING *`, [owner.id]);
    await owe(n);
    const none = await rt.append(machine, creationKey(n.id), { type: 'FirstRequestOwed', payload: { appId: n.id } },
      { requestKey: 'owed-3', appId: n.id, source: { kind: 'system', name: 'release' } });
    await rt.drain();
    assert.equal((await outcomeOf(none)).reason, 'not_owed');
    assert.equal(await inst(n), undefined);
  });

  await t.test('C10: the step a project is on is read from its making, in any process', async () => {
    reset();
    const phase = require('../src/services/app-creation-phase');
    const a = await project();
    await rt.drain();
    assert.deepEqual(await phase.read(pool, a.id), { phase: 'database' });
    // Its setup kept its database step.
    await pool.query(`UPDATE wf_work SET checkpoint = '{"database": true}' WHERE machine = $1 AND key = $2 AND kind = $3`,
      [MACHINE, creationKey(a.id), WORK.setup]);
    assert.deepEqual(await phase.read(pool, a.id), { phase: 'repository' });
    await rt.runServices();
    await rt.drain();
    assert.equal((await inst(a)).state, 'deploying');
    assert.deepEqual(await phase.read(pool, a.id), { phase: 'build' });
    await settle();
    assert.equal(await phase.read(pool, a.id), null, 'made: nothing to report');
    assert.equal(await phase.read(pool, 999999), null);
  });

  await t.test('C9: only app delivery answers, and only the system starts', async () => {
    reset();
    const a = await project();
    await settle();
    const forged = await rt.append(machine, creationKey(a.id), { type: 'Delivered', payload: { sha: SHA('9') } },
      { requestKey: `forged-${a.id}`, appId: a.id, source: { kind: 'system', name: 'x' } });
    await rt.drain();
    assert.equal((await outcomeOf(forged)).reason, 'delivery_only');
  });
});
