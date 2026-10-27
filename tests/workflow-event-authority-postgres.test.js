'use strict';

// Current authority at the real platform/kernel/SQL boundary. All data and
// work below are synthetic; no Git host, worker or production service runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { authorizePlatformEvent, createPlatformRuntime, ADMIN_EVENTS } = require('../src/workflow/event-authority.ts');
const { clock, clockKey } = require('../src/workflow/clock/machine.ts');
const { proposal, sessionKey } = require('../src/workflow/proposal/machine.ts');
const { governanceProposal, issueKey } = require('../src/workflow/governance-proposal/machine.ts');
const { benchLane } = require('../src/workflow/bench-lane/machine.ts');
const { botBuild } = require('../src/workflow/bot-build/machine.ts');
const { botBuildServices } = require('../src/workflow/bot-build/services.ts');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('platform workflow commands require current authority', { timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const db = 'wf_authority_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(DSN); url.pathname = '/' + db;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${db}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:proposal', '1'), ('enabled:governance-proposal', '1')`);
  let n = 0;
  const user = async (isAdmin = false, readonly = false) => (await pool.query(
    `INSERT INTO users (username, password, is_admin, admin_readonly) VALUES ($1, 'synthetic', $2, $3) RETURNING id, username`,
    [`authority_${++n}`, isAdmin, readonly])).rows[0];
  const owner = await user();
  const member = await user();
  const projectAdmin = await user();
  const full = await user(true);
  const readonly = await user(true, true);
  const app = async () => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required)
     VALUES ($1::text, $1::text, $2, 'https://github.com/synthetic/authority', 99) RETURNING id`,
    [`authority-${++n}`, owner.id])).rows[0];
  const a = await app();
  const b = await app();
  await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [a.id, projectAdmin.id]);
  const session = async (appId = a.id, explicit = false) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, reviewed_head_sha, promoted_at, requires_explicit_approval)
     VALUES ($1, $2, 'promoted', $3, 'Synthetic proposal', $4, NOW(), $5) RETURNING id, app_id`,
    [appId, owner.id, ++n, 'a'.repeat(40), explicit])).rows[0];
  const issue = async (kind = 'close_issue', appId = a.id) => (await pool.query(
    `INSERT INTO issues (app_id, title, kind, payload, created_by)
     VALUES ($1, 'Synthetic decision', $2, '{"issueNumber":99,"issueTitle":"Synthetic target"}', $3) RETURNING id, app_id`,
    [appId, kind, owner.id])).rows[0];
  const make = (machines, extra = {}) => {
    const r = createPlatformRuntime({ pool, machines, ...extra });
    runtimes.push(r); return r;
  };
  const c = clock();
  const pm = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 3600000, staleNotifyMs: 0, staleGraceMs: 0 });
  const gm = governanceProposal({ dataKey: 'synthetic-authority-key' });
  const rt = make([c, pm, gm]);
  const outcome = async (id) => (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [id])).rows[0];
  const instance = async (machine, key) => (await pool.query('SELECT state, data, version, flag FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  const append = (machine, key, type, payload, actor, extra = {}) => rt.append(machine, key, { type, payload }, {
    requestKey: `authority:${++n}`, source: { kind: 'admin' }, actor: actor == null ? undefined : `user:${actor.id}`, ...extra,
  });
  const decide = async (...args) => { const id = await append(...args); await rt.drain(); return outcome(id); };
  const check = async (machine, type, who, payload = {}, extra = {}) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await authorizePlatformEvent(client, {
        id: 1, type, payload, actor: who == null ? null : `user:${who.id}`, source: { kind: 'admin' },
        requestKey: 'synthetic', appId: null, causedBy: null, ...extra.event,
      }, { machine, key: 'synthetic', appId: null, now: new Date(), version: 0, ...extra.ctx });
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  const denied = (result) => assert.deepEqual(result, { reject: 'not_authorized' });

  await t.test('abandoned side builds recover from durable comparison state without admitting actor labels', async (st) => {
    const runner = require('../src/services/bench/runner');
    const graders = require('../src/services/bench/graders');
    const realEnsureUser = runner.ensureBenchUser;
    const realGrade = graders.gradeTrial;
    runner.ensureBenchUser = async () => member;
    graders.gradeTrial = async () => {};
    st.after(() => { runner.ensureBenchUser = realEnsureUser; graders.gradeTrial = realGrade; });
    // Run only the real stopped-build finisher; no build pipeline, key
    // provisioning, worker, or external grader runs in this fixture.
    const lane = make([benchLane(), botBuild()], { services: {
      'build.lost': botBuildServices({ pool, config: {} })['build.lost'],
    } });
    const configs = require('../src/services/bot-configs');
    const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
    const send = (machine, key, type, payload, extra = {}) => lane.append(machine, key, { type, payload }, {
      requestKey: `side-authority:${++n}`, source: { kind: 'system', name: 'synthetic-side' }, ...extra,
    });
    const tick = async () => { await send('bench-lane', 'lane', 'Tick', {}); await lane.drain(); };
    const side = async ({ scope = 'later', status = 'running', resultStatus = 'pending', source = 'trial', startBuild = true } = {}) => {
      const version = await one(`INSERT INTO bot_config_versions (key, label, recipe, scope)
        VALUES ($1, 'Synthetic side', '{}'::jsonb, $2) RETURNING id`, [`authority-side-${++n}`, scope]);
      const live = await one(`INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, bot_config_version_id)
        VALUES ($1, $2, 'live', 'ready', $3) RETURNING id`, [a.id, ++n, version.id]);
      const suite = await one('INSERT INTO bench_suites (name) VALUES ($1) RETURNING id', [`Synthetic side ${++n}`]);
      const stage = scope === 'later' ? 'build' : 'first_version';
      const snapshot = await one(`INSERT INTO homeroom_bot_run_snapshots (run_id, stage, app_id, issue_number)
        VALUES ($1, 'build', $2, $3) RETURNING id`, [live.id, a.id, n]);
      const task = await one(`INSERT INTO bench_tasks (suite_id, stage, snapshot_id, app_id, label_token)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [suite.id, stage, snapshot.id, a.id, `side-task-${++n}`]);
      const run = await one(`INSERT INTO bench_runs (suite_id, models, stages, status, kind)
        VALUES ($1, ARRAY['synthetic'], ARRAY[$2::text], 'running', $3) RETURNING id`,
      [suite.id, stage, scope === 'later' ? 'bot_config_later' : 'bot_config']);
      const trial = await one(`INSERT INTO bench_trials
        (run_id, task_id, model, status, item_token, bot_run_id, bot_config_version_id, started_at)
        VALUES ($1, $2, 'synthetic', $3, $4, $5, $6, NOW()) RETURNING id`,
      [run.id, task.id, status, `side-item-${++n}`, live.id, version.id]);
      const key = `trial:${trial.id}@c1.g1`;
      await pool.query('UPDATE bench_trials SET build_key = $2 WHERE id = $1', [trial.id, key]);
      const result = await one(`INSERT INTO bot_config_results (bot_run_id, config_version_id, source, trial_id, status)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [live.id, version.id, source, trial.id, resultStatus]);
      if (status === 'running') {
        await send('bot-build', key, 'Requested', { target: 'trial', id: trial.id, nonce: 'c1.g1', input: {}, replyTo: { machine: 'bench-lane', key: 'lane' } });
        if (startBuild) await lane.drain();
      }
      return { botRunId: live.id, trialId: trial.id, runId: run.id, resultId: result.id, key };
    };
    const stops = async (s) => Number((await one(`SELECT COUNT(*) FROM wf_events
      WHERE machine = 'bot-build' AND key = $1 AND type = 'StopRequested'`, [s.key])).count);
    const trialStatus = async (s) => (await one('SELECT status FROM bench_trials WHERE id = $1', [s.trialId])).status;

    await st.test('the old cleanup is refused, then a periodic look stops both scopes from their skipped results', async () => {
      for (const scope of ['first_version', 'later']) {
        const s = await side({ scope });
        let oldEvent;
        // Exact serialization of benchCancelTrial before actor admission.
        // The real cleanup still performs its durable comparison write.
        assert.equal(await configs.abandonSideBuilds(pool, s.botRunId, 'given up', { lane: {
          async cancelTrial(_pool, trialId, o) {
            oldEvent = await send('bench-lane', 'lane', 'TrialCancelled', { trialId, by: o.by, why: o.why },
              { source: { kind: 'admin', name: 'bench' }, actor: o.by });
          },
        } }), 1);
        await lane.drain();
        assert.deepEqual(await outcome(oldEvent), { result: 'rejected', reason: 'not_authorized' });
        assert.equal((await one('SELECT status FROM bot_config_results WHERE id = $1', [s.resultId])).status, 'skipped');
        assert.equal((await instance('bot-build', s.key)).state, 'building');
        assert.equal(await trialStatus(s), 'running');
        assert.equal(await stops(s), 0);
        await tick();
        assert.equal((await instance('bot-build', s.key)).state, 'failed');
        const stop = await one(`SELECT source, result FROM wf_events
          WHERE machine = 'bot-build' AND key = $1 AND type = 'StopRequested'`, [s.key]);
        assert.equal(stop.result, 'accepted');
        assert.equal(stop.source.kind, 'message');
        assert.equal(stop.source.from.machine, 'bench-lane');
        const work = await one(`SELECT status, result FROM wf_work
          WHERE machine = 'bot-build' AND key = $1 AND kind = 'build.run'`, [s.key]);
        assert.equal(work.status, 'settled');
        assert.equal(work.result.cancelled, true);
        assert.equal(Number((await one(`SELECT COUNT(*) FROM wf_work
          WHERE machine = 'bot-build' AND key = $1 AND kind = 'build.lost'`, [s.key])).count), 1);
        for (let i = 0; i < 3; i++) await tick();
        assert.equal(await stops(s), 1, 'an ended build is not stopped again while its finisher waits');
        await lane.runServices();
        await lane.drain();
        assert.equal(await trialStatus(s), 'cancelled', 'the real finisher records the stopped trial');
        await tick();
        assert.equal((await one('SELECT status FROM bench_runs WHERE id = $1', [s.runId])).status, 'done');
        assert.deepEqual(await outcome(oldEvent), { result: 'rejected', reason: 'not_authorized' });
      }
    });
    await st.test('a claimed build whose request is still queued is stopped when it starts', async () => {
      const s = await side({ resultStatus: 'skipped', startBuild: false });
      const laneOnly = make([benchLane()]);
      await laneOnly.append('bench-lane', 'lane', { type: 'Tick', payload: {} },
        { requestKey: `side-authority:${++n}`, source: { kind: 'system' } });
      await laneOnly.drain();
      assert.equal(await instance('bot-build', s.key), undefined);
      assert.equal(await stops(s), 1);
      await lane.drain();
      assert.equal((await instance('bot-build', s.key)).state, 'failed');
      await tick();
      assert.equal(await stops(s), 1);
    });
    await st.test('skipped waiting trials are cancelled before a grant, and settled trials are left alone', async () => {
      const waiting = await side({ status: 'pending', resultStatus: 'skipped' });
      const awaiting = await side({ status: 'awaiting', resultStatus: 'skipped' });
      const settled = await side({ status: 'ok', resultStatus: 'skipped' });
      await tick();
      assert.equal(await trialStatus(waiting), 'cancelled');
      assert.equal(await trialStatus(awaiting), 'cancelled');
      assert.equal(await trialStatus(settled), 'ok');
      assert.equal(await instance('bot-build', waiting.key), undefined);
      assert.equal(await instance('bot-build', awaiting.key), undefined);
      assert.equal(await stops(settled), 0);
    });
    await st.test('active comparisons, other result sources and mismatched links do not authorize cleanup', async () => {
      const active = await side();
      const done = await side({ resultStatus: 'done' });
      const round0 = await side({ resultStatus: 'skipped', source: 'round0' });
      const wrongConfig = await side();
      const wrongRun = await side();
      await pool.query(`UPDATE bot_config_results SET status = 'skipped', config_version_id =
        (SELECT config_version_id FROM bot_config_results WHERE id = $2) WHERE id = $1`, [wrongConfig.resultId, active.resultId]);
      await pool.query('UPDATE bot_config_results SET status = \'skipped\', bot_run_id = $2 WHERE id = $1', [wrongRun.resultId, active.botRunId]);
      await tick();
      for (const s of [active, done, round0, wrongConfig, wrongRun]) {
        assert.equal((await instance('bot-build', s.key)).state, 'building');
        assert.equal(await trialStatus(s), 'running');
        assert.equal(await stops(s), 0);
      }
    });
    await st.test('forged human cancels stay refused and a current full administrator can still cancel', async () => {
      const s = await side();
      const deniedEvents = [];
      for (const actor of [undefined, 'Homeroom', `user:${member.id}`, `user:${readonly.id}`]) {
        deniedEvents.push(await send('bench-lane', 'lane', 'TrialCancelled', { trialId: s.trialId, by: 'Homeroom' }, { source: { kind: 'admin', name: 'bench' }, actor }));
        deniedEvents.push(await send('bench-lane', 'lane', 'RunCancelled', { runId: s.runId, by: 'Homeroom' }, { source: { kind: 'admin', name: 'bench' }, actor }));
      }
      await lane.drain();
      for (const id of deniedEvents) assert.deepEqual(await outcome(id), { result: 'rejected', reason: 'not_authorized' });
      await tick();
      assert.equal((await instance('bot-build', s.key)).state, 'building');
      assert.equal(await trialStatus(s), 'running');
      assert.equal(await stops(s), 0);
      const id = await send('bench-lane', 'lane', 'TrialCancelled', { trialId: s.trialId, by: full.username },
        { source: { kind: 'admin', name: 'bench' }, actor: `user:${full.id}` });
      await lane.drain();
      assert.equal((await outcome(id)).result, 'accepted');
      assert.equal((await instance('bot-build', s.key)).state, 'failed');
      assert.equal(await stops(s), 1);
    });
    await st.test('the current real cleanup producer sends an admitted system command once', async () => {
      const s = await side();
      const platform = require('../src/workflow/platform.ts');
      const dbPool = require('../src/db/pool');
      const realGetPool = dbPool.getPool;
      dbPool.getPool = () => pool;
      try {
        await platform.startWorkflow({ databaseUrl: String(url), wfPoolMax: 3, wfSlots: 0, dataEncryptionKey: 'synthetic-authority-key' }, { loops: false });
        assert.equal(await configs.abandonSideBuilds(pool, s.botRunId, 'given up'), 1);
      } finally {
        await platform.stopWorkflow();
        dbPool.getPool = realGetPool;
      }
      const event = await one(`SELECT id, source, actor FROM wf_events
        WHERE machine = 'bench-lane' AND type = 'TrialCancelled' AND payload->>'trialId' = $1
        ORDER BY id DESC LIMIT 1`, [String(s.trialId)]);
      assert.equal(event.source.kind, 'system');
      assert.equal(event.actor, null);
      await lane.drain();
      assert.equal((await outcome(event.id)).result, 'accepted');
      assert.equal((await instance('bot-build', s.key)).state, 'failed');
      await tick();
      assert.equal(await stops(s), 1, 'the explicit cancel and reconciliation share one stop');
    });
  });

  for (const [machine, types] of ADMIN_EVENTS) for (const type of types) {
    if (type === 'AdminApply') continue; // Target-bound matrix below.
    await t.test(`${machine}.${type}: labels grant no admin authority`, async () => {
      denied(await check(machine, type, member));
      denied(await check(machine, type, readonly));
      denied(await check(machine, type, null));
      assert.equal(await check(machine, type, full), true);
    });
  }
  await t.test('route-origin fleet actions, manual deploys and merge-resume require a current full admin', async () => {
    const actions = [
      ...['RetryApp', 'MergeGreen', 'Stop', 'Resume', 'AutoMerge'].map((type) => ['campaign', type, { userId: member.id }]),
      ['main-check', 'Resume', {}], ['app-delivery', 'DeployRequested', { reason: 'redeploy' }],
      ['app-delivery', 'MainMoved', { byHand: true }],
    ];
    for (const [machine, type, payload] of actions) {
      denied(await check(machine, type, member, payload, { event: { source: { kind: 'route' } } }));
      assert.equal(await check(machine, type, full, { ...payload, ...(payload.userId ? { userId: full.id } : {}) }, { event: { source: { kind: 'route' } } }), true);
    }
    assert.equal(await check('clock', 'Tick', null, {}, { event: { source: { kind: 'timer', setAtVersion: 1 } } }), true);
    assert.equal(await check('governance-proposal', 'Evaluate', null, {}, { event: { source: { kind: 'timer', setAtVersion: 1 } } }), true);
    assert.equal(await check('app-delivery', 'MainMoved', null, {}, { event: { source: { kind: 'system', name: 'drift' } } }), true);
  });
  await t.test('malformed actors and a payload impersonating a different user are denied', async () => {
    for (const actor of ['admin', full.username, 'user:01', 'user:0', 'user:-1', 'user:1.1', 'user:2147483648', 'user:1e2']) {
      denied(await check('clock', 'RunNow', full, {}, { event: { actor } }));
    }
    denied(await check('clock', 'RunNow', member, { userId: full.id }));
  });
  await t.test('force merge binds current project authority to the actual session and protected-change flag', async () => {
    const s = await session();
    const protectedSession = await session(a.id, true);
    const foreign = await session(b.id);
    const force = (s, who, extra = {}) => check('proposal', 'ForceMerge', who, { sessionId: s.id, userId: who.id }, {
      ctx: { key: sessionKey(s.id), appId: s.app_id }, event: { source: { kind: 'route' }, appId: s.app_id, ...extra },
    });
    denied(await force(s, member)); denied(await force(s, owner));
    assert.equal(await force(s, projectAdmin), true);
    denied(await force(protectedSession, projectAdmin));
    assert.equal(await force(protectedSession, full), true);
    denied(await force(foreign, projectAdmin, { appId: a.id }));
    denied(await check('proposal', 'ForceMerge', projectAdmin, { sessionId: foreign.id, userId: projectAdmin.id }, {
      ctx: { key: sessionKey(s.id), appId: a.id }, event: { source: { kind: 'route' }, appId: a.id },
    }));
    await pool.query('DELETE FROM app_admins WHERE app_id = $1 AND user_id = $2', [a.id, projectAdmin.id]);
    denied(await force(s, projectAdmin));
    await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [a.id, projectAdmin.id]);
  });
  await t.test('governance force-apply keeps project admins scoped; secrets and fleet campaigns require platform authority', async () => {
    for (const kind of ['close_issue', 'featured_illustration', 'secret_change', 'maintenance_campaign']) {
      const i = await issue(kind);
      const apply = (who) => check('governance-proposal', 'AdminApply', who, { userId: who.id }, { ctx: { key: issueKey(i.id), appId: a.id } });
      denied(await apply(member));
      const result = await apply(projectAdmin);
      if (['secret_change', 'maintenance_campaign'].includes(kind)) denied(result);
      else assert.equal(result, true);
      assert.equal(await apply(full), true);
    }
  });
  await t.test('shots waiver preserves creator/project-admin authority on its own project', async () => {
    const s = await session();
    for (const [who, allowed] of [[owner, true], [projectAdmin, true], [full, true], [member, false]]) {
      const result = await check('shots', 'WaiveRequested', who, { sessionId: s.id, userId: who.id }, { ctx: { key: sessionKey(s.id), appId: a.id } });
      if (allowed) assert.equal(result, true); else denied(result);
    }
  });
  await t.test('campaign force messages recheck the administrator who armed the campaign', async () => {
    const who = await user(true);
    const message = { source: { kind: 'message', from: { machine: 'campaign', key: 'campaign:1', eventId: 1 } }, actor: null };
    const fromCampaign = (id) => check('proposal', 'ForceMerge', null, { userId: id }, { event: message });
    assert.equal(await fromCampaign(who.id), true);
    denied(await fromCampaign(member.id));
    denied(await fromCampaign(readonly.id));
    denied(await fromCampaign(null));
    await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [who.id]);
    denied(await fromCampaign(who.id));
  });
  await t.test('a deleted actor cannot use retained admin metadata', async () => {
    const who = await user(true);
    await pool.query('DELETE FROM users WHERE id = $1', [who.id]);
    denied(await check('clock', 'RunNow', who));
  });
  await t.test('actual proposal machine rejects queued force after project-admin removal, without writes or messages', async () => {
    const s = await session();
    const id = await append(pm, sessionKey(s.id), 'ForceMerge', { sessionId: s.id, from: 'promoted', userId: projectAdmin.id }, projectAdmin,
      { source: { kind: 'route' }, appId: a.id });
    await pool.query('DELETE FROM app_admins WHERE app_id = $1 AND user_id = $2', [a.id, projectAdmin.id]);
    await rt.drain();
    assert.deepEqual(await outcome(id), { result: 'rejected', reason: 'not_authorized' });
    assert.equal((await instance('proposal', sessionKey(s.id))).data.force ?? null, null);
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM wf_events WHERE caused_by = $1', [id])).rows[0].count), 0);
    await pool.query('INSERT INTO app_admins (app_id, user_id) VALUES ($1, $2)', [a.id, projectAdmin.id]);
    assert.equal((await decide(pm, sessionKey(s.id), 'ForceMerge', { sessionId: s.id, from: 'promoted', userId: projectAdmin.id }, projectAdmin,
      { source: { kind: 'route' }, appId: a.id })).result, 'accepted');
    assert.equal((await instance('proposal', sessionKey(s.id))).data.force.userId, projectAdmin.id);
  });
  await t.test('actual governance machine rejects a forged admin source but accepts the current project admin', async () => {
    const i = await issue();
    await decide(gm, issueKey(i.id), 'Filed', { issueId: i.id }, null, { source: { kind: 'system' }, appId: a.id });
    const before = await instance('governance-proposal', issueKey(i.id));
    assert.deepEqual(await decide(gm, issueKey(i.id), 'AdminApply', { userId: member.id, username: member.username }, member, { appId: a.id }),
      { result: 'rejected', reason: 'not_authorized' });
    assert.deepEqual(await instance('governance-proposal', issueKey(i.id)), before);
    assert.equal((await decide(gm, issueKey(i.id), 'AdminApply', { userId: projectAdmin.id, username: projectAdmin.username }, projectAdmin, { appId: a.id })).result, 'accepted');
  });

  const arm = async (key) => {
    await decide(c, clockKey(key), 'Arm', { job: key, everyMs: 3600000, firstDueAt: new Date(Date.now() + 3600000).toISOString() }, null, { source: { kind: 'system' } });
  };
  await t.test('revocation after append is checked by the consuming process, before any work is queued', async () => {
    const who = await user(true); await arm('revoked');
    const id = await append(c, clockKey('revoked'), 'RunNow', {}, who);
    await pool.query('UPDATE users SET admin_readonly = TRUE WHERE id = $1', [who.id]);
    await rt.drain();
    assert.deepEqual(await outcome(id), { result: 'rejected', reason: 'not_authorized' });
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM wf_work WHERE machine = 'clock' AND key = $1", [clockKey('revoked')])).rows[0].count), 0);
  });
  await t.test('receipt replay rechecks current authority and never creates duplicate work', async () => {
    const who = await user(true); const key = clockKey('receipt'); await arm('receipt');
    const options = { requestKey: 'same-admin-command' };
    assert.equal((await decide(c, key, 'RunNow', {}, who, options)).result, 'accepted');
    const before = await instance('clock', key);
    await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [who.id]);
    assert.deepEqual(await decide(c, key, 'RunNow', {}, who, options), { result: 'rejected', reason: 'not_authorized' });
    assert.deepEqual(await instance('clock', key), before);
    await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [who.id]);
    assert.equal((await decide(c, key, 'RunNow', {}, who, options)).result, 'replayed');
    assert.deepEqual(await instance('clock', key), before);
  });
  await t.test('a revocation holding the user lock is observed after it commits', async () => {
    const who = await user(true); await arm('race');
    const id = await append(c, clockKey('race'), 'RunNow', {}, who);
    const revoker = await pool.connect();
    let processing;
    try {
      await revoker.query('BEGIN');
      await revoker.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [who.id]);
      processing = rt.processNext();
      const deadline = Date.now() + 2000;
      for (;;) {
        const { rows: [r] } = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'SELECT is_admin, admin_readonly FROM users%') AS waiting`);
        if (r.waiting) break;
        assert.ok(Date.now() < deadline, 'the event must wait on the current authority row');
        await sleep(10);
      }
      await revoker.query('COMMIT');
      await processing;
      assert.deepEqual(await outcome(id), { result: 'rejected', reason: 'not_authorized' });
    } finally { await revoker.query('ROLLBACK'); revoker.release(); await processing; }
  });
  await t.test('fault release cannot bypass the same current-admin boundary', async () => {
    const key = clockKey('release'); await arm('release');
    const faulty = createRuntime({ pool, machines: [c], authorizeEvent: async () => { throw new Error('synthetic fault'); } });
    runtimes.push(faulty);
    await faulty.append(c, key, { type: 'RunNow', payload: {} },
      { requestKey: 'fault-before-release', source: { kind: 'admin' }, actor: `user:${full.id}` });
    await faulty.drain();
    const held = await append(c, key, 'RunNow', {}, full);
    await rt.drain();
    assert.deepEqual(await rt.release('clock', key, { mode: 'retry', actor: `user:${readonly.id}` }), { released: false, reason: 'not_authorized' });
    assert.equal((await instance('clock', key)).flag, 'faulted');
    assert.equal((await pool.query('SELECT status FROM wf_events WHERE id = $1', [held])).rows[0].status, 'pending');
    assert.equal((await rt.release('clock', key, { mode: 'skip', actor: `user:${full.id}` })).released, true);
    assert.equal((await instance('clock', key)).flag, null);
    await rt.drain();
  });
  await t.test('platform factory cannot be configured with an admission bypass', async () => {
    await arm('factory');
    const guarded = make([c], { authorizeEvent: async () => true });
    const id = await guarded.append(c, clockKey('factory'), { type: 'RunNow', payload: {} },
      { requestKey: 'factory', source: { kind: 'admin' }, actor: `user:${member.id}` });
    await guarded.drain();
    assert.deepEqual(await outcome(id), { result: 'rejected', reason: 'not_authorized' });
  });
  await t.test('an authorization database failure cannot be swallowed into approval', async () => {
    await arm('broken');
    const broken = createRuntime({ pool, machines: [c], authorizeEvent: async (tx) => {
      try { await tx.query('SELECT sec09_missing_authority_column FROM users'); } catch { /* a broken checker */ }
      return true;
    } });
    runtimes.push(broken);
    const id = await broken.append(c, clockKey('broken'), { type: 'RunNow', payload: {} },
      { requestKey: 'broken', source: { kind: 'admin' }, actor: `user:${full.id}` });
    await broken.drain();
    assert.equal((await outcome(id)).result, 'faulted');
    assert.equal(Number((await pool.query("SELECT COUNT(*) FROM wf_work WHERE machine = 'clock' AND key = $1", [clockKey('broken')])).rows[0].count), 0);
  });
});
