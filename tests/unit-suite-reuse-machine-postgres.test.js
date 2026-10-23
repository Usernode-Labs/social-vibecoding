'use strict';

// services/unit-suite-reuse.js through the preview machine
// (src/workflow/preview/), against the full PostgreSQL schema: what happens
// to a person's "Run checks again" (chat_sessions.unit_suite_fresh_sha) when
// the run that answers it copied an earlier unit-suite pass, or brought no
// unit-suite row, and what a settled run does for the passes it records and
// copies. Work kinds are faked, as in tests/workflow-preview-postgres.test.js;
// the transitions, their facts and their writes are the real ones.
//
// Before the machine, this was services/visuals.js requestOwedFreshRun and
// the preview lifecycle (deleted with the old paths, #5212): the owed run had
// to leave the finishing run's operation, or it was cancelled with it. Here
// it is a checks run of its own, a work item with its own key and lease.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { preview, sessionKey, MACHINE, WORK } = require('../src/workflow/preview/machine.ts');
const reuse = require('../src/services/unit-suite-reuse');
const unitSuiteRow = require('../src/services/unit-suite-row');
const recovery = require('../src/services/staging-recovery');
const appManifest = require('../src/services/app-manifest');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const UNIT_KEY = appManifest.checkKey(unitSuiteRow.UNIT_CHECK_NAME, unitSuiteRow.UNIT_CHECK_PATH);
const DIGEST = `registry.example/usernode-worker@sha256:${'c'.repeat(64)}`;

test('unit-suite reuse through the preview machine, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_reuse_' + crypto.randomBytes(6).toString('hex');
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
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

  let seq = 0;
  async function proposal({ status = 'active', source = null } = {}) {
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`ur_${++seq}`]);
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`ur-app-${++seq}`, u.id]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number)
       VALUES ($1, $2, $3, $4, 'feature', $5) RETURNING *`, [a.id, u.id, status, source, ++seq]);
    return { ...s, app: a };
  }
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const runsOf = async (s) => (await pool.query(
    `SELECT work_key, input, status FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at, work_key`,
    [MACHINE, sessionKey(s.id), WORK.run])).rows;

  // Rows as the settlement shapes them (visuals.settleCaptureRun).
  const browser = { index: 0, name: 'Loads /', path: '/', status: 'pass' };
  const unitPass = { index: -3, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false };
  const copied = { ...unitPass, reused: { runId: 'run-a', sessionId: 1, passedAt: new Date().toISOString() } };
  const result = (extra = {}) => ({
    outcome: 'verdict', state: 'passing', results: [browser], console: { state: 'clean', errors: [] },
    history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 }],
    capture: { state: 'console_only', detail: { media: false } }, visuals: false, ...extra,
  });
  // What the next checks run answers, by its trigger: `byTrigger[trigger]`,
  // else `next`.
  const answers = { next: result(), byTrigger: {} };
  const asked = [];
  // A person presses "Run checks again" while the run is going: what the
  // route does (markFreshOwed), then the machine joins the request to it.
  const during = { press: null };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input }) {
      if (kind === WORK.prepare) {
        return { ok: true, url: `https://pv--s${input.sessionId}.apps.test`, runtimeKind: 'kubernetes',
          runtimeName: `sv-preview-1-s${input.sessionId}`, containerId: null, imageRef: `img@sha256:${input.n}`, buildRef: `b-${input.n}` };
      }
      if (kind === WORK.run) {
        asked.push({ key: input.runId, trigger: input.trigger });
        if (during.press) { const p = during.press; during.press = null; await p(input); }
        const a = answers.byTrigger[input.trigger] || answers.next;
        return typeof a === 'function' ? a(input) : a;
      }
      if (kind === WORK.retire) return { closed: true };
      return { ok: true };
    },
  });
  const machine = preview({ maxRetries: 6, retireAfterMs: 0 });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async () => {},
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);
  let rk = 0;
  const send = (s, type, payload = {}, source = { kind: 'system' }) => rt.append(machine, sessionKey(s.id), { type, payload },
    { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const submit = (s, head, extra = {}) => send(s, 'RevisionSubmitted', { sessionId: s.id, head, source: 'test', trigger: 'commit-push', ...extra });
  const press = (s) => async () => {
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: (await row(s.id)).checks_commit_sha });
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
  };
  // A pass the run that passed recorded (unit-suite.recordPassForReuse).
  const recordPass = (s, head, runId) => reuse.recordPass(pool, {
    appId: s.app_id, repo: `acme/${s.app.slug}`, commitSha: head, image: DIGEST, jobHash: 'h'.repeat(64),
  }, { sessionId: s.id, runId });
  const observed = async (s) => (await pool.query(
    'SELECT observed_at FROM unit_suite_passes WHERE session_id = $1', [s.id])).rows.map((r) => !!r.observed_at);

  await t.test('an automatic run that copied a pass stores it, and earns the proposal the gate without a second observation', async () => {
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    const s = await proposal();
    await submit(s, SHA('a'));
    await settle();
    const r = await row(s.id);
    assert.equal(r.check_state, 'passing');
    assert.deepEqual(r.checks_earned_keys, [UNIT_KEY].concat(['k1']).sort(), 'the copied pass earns the unit-suite gate');
    const { rows } = await pool.query('SELECT check_key FROM app_check_history WHERE app_id = $1', [s.app_id]);
    assert.deepEqual(rows.map((h) => h.check_key), ['k1'], 'and observes nothing: the pass it copies was counted when it ran');
    assert.equal(r.unit_suite_fresh_sha, null);
  });

  await t.test('a request that joined a run which copied a pass: the verdict is refused, and their own run starts as a run of its own', async () => {
    const s = await proposal({ status: 'paused', source: 'cli_handoff' });
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    // Their run really runs the suite, passes, and its pass may be copied.
    answers.byTrigger['manual-recheck'] = result({
      results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 },
        { checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }],
    });
    during.press = press(s);
    asked.length = 0;
    await submit(s, SHA('b'));
    await rt.drain();
    await rt.runServices();   // prepare (and the early suite)
    await rt.drain();
    await rt.runServices();   // the automatic run: the press comes while it goes
    await rt.drain();
    let r = await row(s.id);
    assert.equal(r.unit_suite_fresh_sha, SHA('b'), 'the request stands');
    assert.deepEqual([r.check_state, r.check_trigger], ['pending', 'manual-recheck'],
      'the copied pass was not stored: pending, and merge-blocked, for their run');
    assert.equal(unitSuiteRow.freshSuiteOwed(r), true);
    const runs = await runsOf(s);
    assert.equal(runs.length, 2, 'a second checks run, its own work item');
    assert.notEqual(runs[1].work_key, runs[0].work_key);
    assert.deepEqual([runs[0].status, runs[1].input.trigger], ['settled', 'manual-recheck']);
    assert.equal((await instance(s)).state, 'checking');
    await recordPass(s, SHA('b'), 'run-own');
    await settle();
    assert.deepEqual(asked.map((a) => a.trigger), ['commit-push', 'manual-recheck']);
    r = await row(s.id);
    assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null], 'their run answered them');
    assert.deepEqual(await observed(s), [true], 'its pass may be copied: its history row landed with the verdict');
    delete answers.byTrigger['manual-recheck'];
  });

  await t.test('a pass whose run stored no history row, or an error, stays unobserved', async () => {
    const s = await proposal();
    answers.next = result({ results: [browser, unitPass], unitObserved: UNIT_KEY });   // the unit row's history is missing
    await recordPass(s, SHA('c'), 'run-c');
    await submit(s, SHA('c'));
    await settle();
    assert.equal((await row(s.id)).check_state, 'passing');
    assert.deepEqual(await observed(s), [false]);
    const e = await proposal();
    answers.next = result({ state: 'error', results: [browser, unitPass], unitObserved: UNIT_KEY, errorDetail: 'unreachable',
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
    await recordPass(e, SHA('c'), 'run-e');
    await submit(e, SHA('c'));
    await settle();
    assert.equal((await row(e.id)).check_state, 'error');
    assert.deepEqual(await observed(e), [false], 'an error records no history, so no copy is made of it');
  });

  await t.test('a passing unit row behind 900 browser checks is written with them, and its pass observed', async () => {
    const s = await proposal();
    const many = Array.from({ length: 900 }, (_, i) => ({ checkKey: `m${i}`, name: `check ${i}`, path: '/', passes: 1, fails: 0 }));
    answers.next = result({ results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [...many, { checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
    await recordPass(s, SHA('9'), 'run-many');
    await submit(s, SHA('9'));
    await settle();
    assert.equal((await row(s.id)).check_state, 'passing');
    const { rows: [h] } = await pool.query('SELECT count(*)::int AS n FROM app_check_history WHERE app_id = $1 AND check_key = $2', [s.app_id, UNIT_KEY]);
    assert.equal(h.n, 1);
    assert.deepEqual(await observed(s), [true]);
  });

  await t.test('their own run with no unit row is refused and left for the stale sweep, not run again here', async () => {
    const s = await proposal({ status: 'active' });
    answers.next = result({ results: [browser], unitSuiteAbsent: true });
    await submit(s, SHA('d'));
    await settle();
    // The settlement could not read the request (visuals.settleCaptureRun
    // then neither confirms absence nor records the missing-unit error).
    answers.next = result({ results: [browser] });
    asked.length = 0;
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA('d') });
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    assert.deepEqual(asked.map((a) => a.trigger), ['manual-recheck'], 'one run: no loop');
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['pending', SHA('d')]);
    assert.equal((await instance(s)).data.verdict, null);
    assert.equal(recovery.isStuckCheckRecoveryScope(r), true, 'the stale sweep\'s scope takes an owed head');
    // A suite confirmed absent answers it.
    answers.next = result({ results: [browser], unitSuiteAbsent: true });
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    assert.deepEqual([(await row(s.id)).check_state, (await row(s.id)).unit_suite_fresh_sha], ['passing', null]);
  });

  await t.test('a missing-unit error on an owed active proposal is retried by the machine\'s own error lane', async () => {
    const s = await proposal({ status: 'active' });
    answers.next = result({ results: [browser], unitSuiteAbsent: true });
    await submit(s, SHA('e'));
    await settle();
    answers.next = result({ state: 'error', results: [browser], errorDetail: unitSuiteRow.MISSING_UNIT_DETAIL, platformFault: true });
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA('e') });
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_error_detail, r.unit_suite_fresh_sha],
      ['error', unitSuiteRow.MISSING_UNIT_DETAIL, SHA('e')]);
    assert.ok((await instance(s)).deadline_at, 'an owed head is in the retry scope, native or not');
    // An active native proposal with nothing owed is not (P5's rule).
    const plain = await proposal({ status: 'active' });
    answers.next = result({ state: 'error', results: [browser], errorDetail: 'boom' });
    await submit(plain, SHA('e'));
    await settle();
    assert.equal((await instance(plain)).deadline_at, null);
  });

  await t.test('a session adopted from its row runs an owed head instead of settling on its old verdict; a green owed head is not carried', async () => {
    const s = await proposal({ status: 'active' });
    answers.next = result({ results: [browser], unitSuiteAbsent: true });
    await submit(s, SHA('f'));
    await settle();
    // A carry from the owed head checks the merged head instead.
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA('f') });
    const merged = await submit(s, SHA('0'), { carryFrom: SHA('f') });
    await rt.drain();
    assert.equal((await pool.query('SELECT state_after FROM wf_events WHERE id = $1', [merged])).rows[0].state_after, 'preparing');
    await settle();
    // Handed back (detached): its next event adopts it from its row.
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET state = 'detached' WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA('0') });
    asked.length = 0;
    const again = await submit(s, SHA('0'));
    await rt.drain();
    assert.equal((await pool.query('SELECT state_after FROM wf_events WHERE id = $1', [again])).rows[0].state_after, 'checking');
    await settle();
    assert.deepEqual(asked.map((a) => a.trigger), ['manual-recheck']);
    assert.equal((await row(s.id)).unit_suite_fresh_sha, null);
  });
  // The kernel leaves an instance a newer machine version last wrote to the
  // newer code (pipeline.ts, services.ts): during a rollout, a runtime of the
  // version before this one (3) must not settle a run this version started,
  // or it would store a copied pass for an owed head with none of the above.
  await t.test('a runtime of the previous machine version leaves this version\'s instances alone; this version takes over the previous one\'s', async () => {
    assert.ok(machine.version > 3, 'past main\'s version 3');
    const older = { ...machine, version: 3 };
    const old = createRuntime({ pool, machines: [older], pollMs: 50, publish: async () => {}, services: {} });
    runtimes.push(old);
    const s = await proposal({ status: 'promoted' });
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    answers.byTrigger['manual-recheck'] = result({ results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
    during.press = press(s);
    asked.length = 0;
    await submit(s, SHA('7'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    await rt.runServices();   // the copied run; the press joins it; its result is now an event
    assert.equal((await instance(s)).machine_version, machine.version);
    await old.drain();
    let r = await row(s.id);
    assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['pending', SHA('7')], 'the older runtime stored nothing');
    const { rows: [left] } = await pool.query(
      `SELECT count(*)::int AS n FROM wf_events WHERE machine = $1 AND key = $2 AND status = 'pending'`, [MACHINE, sessionKey(s.id)]);
    assert.ok(left.n > 0, 'and left the run\'s result for this version');
    await settle();
    r = await row(s.id);
    assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null]);
    assert.deepEqual(asked.map((a) => a.trigger), ['commit-push', 'manual-recheck'], 'this version refused the copy and ran theirs');
    delete answers.byTrigger['manual-recheck'];

    // An instance the previous version last wrote (in flight at the rollout)
    // is taken over and finished by this one.
    const p = await proposal({ status: 'active' });
    answers.next = result({ results: [browser], unitSuiteAbsent: true });
    await submit(p, SHA('6'));
    await rt.drain();
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query('UPDATE wf_instances SET machine_version = 3 WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(p.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
    await settle();
    const i = await instance(p);
    assert.deepEqual([i.state, i.machine_version], ['settled', machine.version]);
    assert.equal((await row(p.id)).check_state, 'passing');
  });

  // routes/sessions.js deploy-staging: a preview deployed by hand is a
  // person's request for the head's checks. When the branch cannot be read,
  // the head is the one the machine resolves (a promoted proposal's reviewed
  // head), and the request is recorded on it before the machine is asked:
  // joined to a run that copied a pass, that verdict is refused and their own
  // run follows.
  await t.test('deploying a preview by hand during a run that copied a pass gets a fresh suite, whether or not the branch could be read', async (st) => {
    const github = require('../src/services/github');
    st.mock.method(require('../src/db/pool'), 'getPool', () => pool);
    st.mock.method(github, 'isEnabled', () => true);
    st.mock.method(github, 'getBranchSha', async () => null);
    const previewFlow = require('../src/services/preview-workflow');
    st.mock.method(previewFlow, 'request', async (opts) => {
      const ev = await send(opts.session, 'PreviewRequested', { sessionId: opts.session.id, head: opts.head, reason: opts.reason }, { kind: 'route' });
      await rt.drain();
      const out = (await pool.query('SELECT result, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
      return { status: out.result === 'accepted' ? 'accepted' : 'rejected', reason: out.reason };
    });
    const router = require('../src/routes/sessions').sessionRoutes({ databaseUrl: String(url) });
    const layer = router.stack.find((x) => x.route?.path === '/api/sessions/:id/deploy-staging');
    const handler = layer.route.stack.at(-1).handle;
    let lookupWorks = false;
    let tip = null;
    st.mock.method(github, 'getInstallationOctokit', async () => ({ request: async () => {
      if (!lookupWorks) throw new Error('branch lookup 404');
      return { data: { object: { sha: tip } } };
    } }));
    for (const works of [false, true]) {
      const s = await proposal({ status: 'promoted' });
      const head = works ? SHA('5') : SHA('4');
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, head]);
      answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
      answers.byTrigger['manual-recheck'] = result({ results: [browser, unitPass], unitObserved: UNIT_KEY,
        history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
      let answered = null;
      during.press = async () => {
        lookupWorks = works;
        tip = head;
        const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
        await handler({ params: { id: String(s.id) }, user: { id: s.user_id } }, res);
        answered = res;
      };
      await submit(s, head);
      await settle();
      const r = await row(s.id);
      const runs = (await runsOf(s)).map((w) => w.input.trigger);
      assert.deepEqual([answered.statusCode, answered.body.status], [200, 'deploying']);
      assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, `lookup ${works ? 'read' : 'failed'}: not the copy`);
      assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null]);
      assert.deepEqual(runs, ['commit-push', 'manual-recheck']);
    }
    delete answers.byTrigger['manual-recheck'];
  });
  // routes/sessions.js recheck → staging-recovery.recheckSessionChecks →
  // preview-workflow → the machine, with a run that copied a pass of the
  // head starting while the request is on its way (another proposal earned
  // the pass). Two interleavings:
  //   * 'read': the proposal reviews B while its checks still name A; the
  //     route reads that row, then B's run starts. The request is recorded on
  //     the head the recheck is for, read from the row (B), not the stale pin.
  //   * 'mark': the request is recorded on B, then the head moves to C and
  //     C's run starts before the machine hears the request. Only the
  //     machine, joining it under its lock, can name C.
  // Either way the copy is refused and their own run follows.
  await t.test('a recheck whose head moves while it is on its way still gets a fresh suite from the run it joins', async (st) => {
    const platformPath = require.resolve('../src/workflow/platform.ts');
    const realPlatform = require.cache[platformPath];
    const platform = {};
    require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true, exports: platform, paths: [] };
    st.after(() => { if (realPlatform) require.cache[platformPath] = realPlatform; else delete require.cache[platformPath]; });
    platform.previewHeld = async (id) => (await pool.query('SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows.length > 0;
    platform.previewInstance = async (id) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows[0];
    // Stands in for the real submitRevision, which preview-workflow.recheck
    // calls for a proposal whose voted-on head is newer than the machine's (#5282).
    platform.submitRevision = async (r) => {
      const ev = await send({ id: r.sessionId, app_id: r.appId }, 'RevisionSubmitted',
        { sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null }, { kind: 'system', name: r.source });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    let handedOff = null;
    let beforeMachine = null;
    platform.requestRecheck = async (o) => {
      try {
        if (beforeMachine) { const go = beforeMachine; beforeMachine = null; await go(); }
        const ev = await send({ id: o.sessionId, app_id: o.appId }, 'RecheckRequested', { reason: o.reason, trigger: o.trigger }, { kind: 'route' });
        await rt.drain();
        return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
      } finally { if (handedOff) { handedOff(); handedOff = null; } }
    };
    let afterRead = null;
    const routePool = { query: async (sql, params) => {
      const res = await pool.query(sql, params);
      if (afterRead && /^\s*SELECT cs\.\*, a\.slug as app_slug/.test(String(sql))) { const go = afterRead; afterRead = null; await go(); }
      return res;
    } };
    st.mock.method(require('../src/db/pool'), 'getPool', () => routePool);
    const router = require('../src/routes/sessions').sessionRoutes({ databaseUrl: String(url) });
    const handler = router.stack.find((x) => x.route?.path === '/api/sessions/:id/recheck').route.stack.at(-1).handle;
    const realPass = { results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] };
    const startRunOf = async (s, head) => {
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, head]);
      await submit(s, head);
      await rt.drain(); await rt.runServices(); await rt.drain();
    };

    for (const [when, A, B, C] of [['read', SHA('8'), SHA('9'), SHA('9')], ['mark', SHA('c'), SHA('d'), SHA('e')]]) {
      const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
      answers.next = result(realPass);
      await submit(s, A);
      await settle();
      answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
      answers.byTrigger['manual-recheck'] = result(realPass);
      asked.length = 0;
      if (when === 'read') {
        // B is reviewed, and its run queued, when the route reads the row.
        await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
        await submit(s, B);
        afterRead = async () => { await rt.drain(); await rt.runServices(); await rt.drain(); };
      } else {
        await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
        beforeMachine = () => startRunOf(s, C);
      }
      const done = new Promise((resolve) => { handedOff = resolve; });
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
      await handler({ params: { id: String(s.id) }, user: { id: s.user_id } }, res);
      await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('recheck not handed off')), 5000))]);
      assert.equal((await row(s.id)).unit_suite_fresh_sha, C, `${when}: the request names the head it joined`);
      await settle();
      const r = await row(s.id);
      assert.deepEqual([res.statusCode, res.body.status], [200, 'running']);
      assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, `${when}: not answered by the copy`);
      assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', C, null], when);
      assert.deepEqual(asked.map((a) => a.trigger), ['commit-push', 'manual-recheck'], when);
      delete answers.byTrigger['manual-recheck'];
    }
  });
  // The same route, the head moving the other way: the proposal reviews B
  // while a run of A is still going when the person presses. That run is
  // obsolete for their request: B is built and checked as theirs, and A's
  // run neither takes the request nor answers it (review round 11).
  await t.test('a recheck that comes during a run of an older head than the reviewed one runs the reviewed head, and the old run never takes the request', async (st) => {
    const platformPath = require.resolve('../src/workflow/platform.ts');
    const realPlatform = require.cache[platformPath];
    const platform = {};
    require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true, exports: platform, paths: [] };
    st.after(() => { if (realPlatform) require.cache[platformPath] = realPlatform; else delete require.cache[platformPath]; });
    platform.previewHeld = async (id) => (await pool.query('SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows.length > 0;
    platform.previewInstance = async (id) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows[0];
    // Stands in for the real submitRevision, which preview-workflow.recheck
    // calls for a proposal whose voted-on head is newer than the machine's (#5282).
    platform.submitRevision = async (r) => {
      const ev = await send({ id: r.sessionId, app_id: r.appId }, 'RevisionSubmitted',
        { sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null }, { kind: 'system', name: r.source });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    const markers = [];
    platform.requestRecheck = async (o) => {
      markers.push((await row(o.sessionId)).unit_suite_fresh_sha);
      const ev = await send({ id: o.sessionId, app_id: o.appId }, 'RecheckRequested', { reason: o.reason, trigger: o.trigger }, { kind: 'route' });
      await rt.drain();
      markers.push((await row(o.sessionId)).unit_suite_fresh_sha);
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    st.mock.method(require('../src/db/pool'), 'getPool', () => pool);
    const router = require('../src/routes/sessions').sessionRoutes({ databaseUrl: String(url) });
    const handler = router.stack.find((x) => x.route?.path === '/api/sessions/:id/recheck').route.stack.at(-1).handle;
    const realPass = { results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] };
    const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
    const A = SHA('5'); const B = SHA('6');
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    answers.byTrigger['manual-recheck'] = result(realPass);
    asked.length = 0;
    await submit(s, A);
    await rt.drain(); await rt.runServices(); await rt.drain();   // A's run is going
    assert.equal((await instance(s)).state, 'checking');
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
    await handler({ params: { id: String(s.id) }, user: { id: s.user_id } }, res);
    for (let i = 0; i < 100 && markers.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(markers, [B, B], 'recorded on B, and the machine did not move it to A');
    await settle();
    const r = await row(s.id);
    const runs = (await runsOf(s)).map((w) => [w.input.head, w.input.trigger]);
    assert.ok(runs.some(([h, tr]) => h === B && tr === 'manual-recheck'), 'B is checked as theirs');
    assert.ok(!asked.some((a) => a.trigger === 'commit-push'), 'A\'s run was superseded before it answered');
    assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', B, null]);
    delete answers.byTrigger['manual-recheck'];
  });

  // A person presses while the proposal is busy (a turn holds it) and its
  // checks still name A while it reviews B: the route records B and the
  // machine starts the owed run once the session is idle (its ChecksDue,
  // armed by the folded request). Meanwhile a mechanical sync carries A's
  // green verdict to B, or nothing happens before the machine does. Neither
  // leaves B green without its suite.
  await t.test('a request folded into a busy session is recorded on the reviewed head; a carry to it is refused, and the machine runs it', async (st) => {
    const platformPath = require.resolve('../src/workflow/platform.ts');
    const realPlatform = require.cache[platformPath];
    const platform = {};
    require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true, exports: platform, paths: [] };
    st.after(() => { if (realPlatform) require.cache[platformPath] = realPlatform; else delete require.cache[platformPath]; });
    platform.previewHeld = async (id) => (await pool.query('SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows.length > 0;
    platform.previewInstance = async (id) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows[0];
    // Stands in for the real submitRevision, which preview-workflow.recheck
    // calls for a proposal whose voted-on head is newer than the machine's (#5282).
    platform.submitRevision = async (r) => {
      const ev = await send({ id: r.sessionId, app_id: r.appId }, 'RevisionSubmitted',
        { sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null }, { kind: 'system', name: r.source });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    platform.requestRecheck = async (o) => {
      const ev = await send({ id: o.sessionId, app_id: o.appId }, 'RecheckRequested', { reason: o.reason, trigger: o.trigger }, { kind: 'route' });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    platform.recheckFolded = async (o) => {
      const ev = await send({ id: o.sessionId, app_id: o.appId }, 'RecheckFolded', { head: o.head }, { kind: 'route', name: 'manual-recheck' });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    st.mock.method(require('../src/db/pool'), 'getPool', () => pool);
    const busySet = require('../src/services/active-workers').activeWorkers;
    const router = require('../src/routes/sessions').sessionRoutes({ databaseUrl: String(url) });
    const handler = router.stack.find((x) => x.route?.path === '/api/sessions/:id/recheck').route.stack.at(-1).handle;
    const realPass = { results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] };

    for (const thenWhat of ['carry', 'drain']) {
      const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
      const A = thenWhat === 'carry' ? SHA('e') : SHA('0'); const B = thenWhat === 'carry' ? SHA('f') : SHA('1');
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
      answers.next = result(realPass);
      await submit(s, A);
      await settle();
      assert.equal((await row(s.id)).check_state, 'passing');
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
      answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
      answers.byTrigger['manual-recheck'] = result(realPass);
      asked.length = 0;
      busySet.add(Number(s.id));
      const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } };
      try {
        await handler({ params: { id: String(s.id) }, user: { id: s.user_id } }, res);
        assert.deepEqual([res.statusCode, res.body.status], [200, 'running'], 'folded');
        let r = await row(s.id);
        assert.deepEqual([r.unit_suite_fresh_sha, r.checks_commit_sha, r.check_state], [B, A, 'passing'],
          `${thenWhat}: recorded on the reviewed head; A's verdict is untouched`);
        if (thenWhat === 'carry') {
          const ev = await submit(s, B, { carryFrom: A, trigger: 'sync-main' });
          await rt.drain();
          assert.equal((await pool.query('SELECT state_after FROM wf_events WHERE id = $1', [ev])).rows[0].state_after, 'preparing',
            'not carried to the owed head: it is checked');
          await settle();
        }
      } finally { busySet.delete(Number(s.id)); }
      if (thenWhat === 'drain') {
        // The folded request armed the machine's ChecksDue; due now, with
        // nobody working on the session, it runs the owed head.
        const { rows: [armed] } = await pool.query('SELECT deadline_event FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]);
        assert.equal(armed.deadline_event.type, 'ChecksDue', 'armed by the folded request');
        const c = await pool.connect();
        try {
          await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
          await c.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]);
          await c.query('COMMIT');
        } finally { c.release(); }
        await rt.fireTimers();
        await settle();
      }
      const r = await row(s.id);
      assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, `${thenWhat}: not answered by a copy`);
      assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', B, null], thenWhat);
      assert.ok((await runsOf(s)).some((w) => w.input.head === B && w.input.trigger === 'manual-recheck'), `${thenWhat}: B's suite ran as theirs`);
      delete answers.byTrigger['manual-recheck'];
    }
  });
  // The press folded into a busy session whose checks name the head they
  // ask about: the verdict stored for it no longer stands, so the machine
  // stamps it pending (and merge-blocked) until their run answers. On main
  // the route wrote the stamp itself, which the machine's guard refused on
  // every proposal it holds: the old pass kept reading passing.
  await t.test('a request folded into a busy session stamps the held head pending, through the machine', async () => {
    const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
    const A = SHA('9');
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
    answers.next = result({ results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
    await submit(s, A);
    await settle();
    assert.deepEqual([(await row(s.id)).check_state, (await instance(s)).state], ['passing', 'settled']);
    await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: A });
    const fold = (o) => send({ id: o.sessionId, app_id: o.appId }, 'RecheckFolded', { head: o.head }, { kind: 'route', name: 'manual-recheck' })
      .then(() => rt.drain());
    // What the route's busy branch asks (platform.recheckFolded).
    await fold({ sessionId: s.id, appId: s.app_id, head: A });
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.check_trigger, r.unit_suite_fresh_sha], ['pending', A, 'manual-recheck', A],
      'the old pass no longer stands for the head they asked about');
    const { rows: [ev] } = await pool.query(
      `SELECT result FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RecheckFolded' ORDER BY id DESC LIMIT 1`, [sessionKey(s.id)]);
    assert.equal(ev.result, 'accepted');
    // A second press finds it pending already: nothing to stamp, and its
    // owed run is armed again (ChecksDue).
    await fold({ sessionId: s.id, appId: s.app_id, head: A });
    const { rows: [again] } = await pool.query(
      `SELECT result, emitted FROM wf_events WHERE machine = 'preview' AND key = $1 AND type = 'RecheckFolded' ORDER BY id DESC LIMIT 1`, [sessionKey(s.id)]);
    assert.equal(again.result, 'accepted');
    assert.equal((await row(s.id)).check_state, 'pending');
    assert.equal((await instance(s)).deadline_event.type, 'ChecksDue');

    // A row the machine does not hold (its verdict stored before it ran, or
    // its preview retired by a reap) is stamped too, adopted from the row, as
    // the route's own stamp did before (review, 2026-10-17).
    const loose = await proposal({ status: 'promoted', source: 'cli_handoff' });
    const H = SHA('8');
    await pool.query(`UPDATE chat_sessions SET reviewed_head_sha = $2, checks_commit_sha = $2, check_state = 'passing' WHERE id = $1`, [loose.id, H]);
    assert.equal(await instance(loose), undefined, 'no instance yet');
    await send({ id: loose.id, app_id: loose.app_id }, 'RecheckFolded', { head: H, sessionId: loose.id }, { kind: 'route', name: 'manual-recheck' });
    await rt.drain();
    const r2 = await row(loose.id);
    assert.deepEqual([r2.check_state, r2.check_trigger], ['pending', 'manual-recheck'], 'stamped from the row');
    assert.ok(await instance(loose), 'adopted');
  });

  // A same-commit resubmission (submit_work with new testing routes or
  // `recheck: true`: 'testing-update'; shots alone: 'shots-update') replaces
  // the run going, and is a person's request (trigger 'manual-recheck'). When
  // that run is of an older head than the proposal's pin, the pinned head is
  // built and checked as theirs instead of the older head again; when it is
  // of the pinned head, the run is replaced as before. An admin's retry is
  // pinned the same way. (Review round 12.)
  await t.test('a replacing recheck, and an admin retry, check the pinned head rather than an older one held', async () => {
    const realPass = { results: [browser, unitPass], unitObserved: UNIT_KEY,
      history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] };
    const outcomeOf = async (id) => (await pool.query('SELECT result, reason, state_after FROM wf_events WHERE id = $1', [id])).rows[0];
    let n = 0;
    for (const reason of ['testing-update', 'shots-update']) {
      const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
      const A = SHA(String(++n)).replace(/^./, 'a'); const B = SHA(String(n)).replace(/^./, 'b');
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
      answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
      answers.byTrigger['manual-recheck'] = result(realPass);
      asked.length = 0;
      await submit(s, A);
      await rt.drain(); await rt.runServices(); await rt.drain();   // A's run is going
      const firstRun = (await instance(s)).data.run.key;
      // Pinned to A: replaced as before, a new run of A.
      const same = await send(s, 'RecheckRequested', { reason }, { kind: 'route' });
      await rt.drain();
      let i = await instance(s);
      assert.deepEqual([(await outcomeOf(same)).state_after, i.data.run.head], ['checking', A], `${reason}: replaces a run of the pinned head`);
      assert.notEqual(i.data.run.key, firstRun);
      // B is reviewed now; the run going is of A.
      await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
      const ev = await send(s, 'RecheckRequested', { reason }, { kind: 'route' });
      await rt.drain();
      i = await instance(s);
      assert.deepEqual([(await outcomeOf(ev)).state_after, i.data.preparing?.head], ['preparing', B], `${reason}: B is built`);
      assert.equal((await row(s.id)).unit_suite_fresh_sha, B, `${reason}: the request stays on B`);
      await settle();
      const r = await row(s.id);
      assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, reason);
      assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', B, null], reason);
      assert.ok((await runsOf(s)).some((w) => w.input.head === B && w.input.trigger === 'manual-recheck'), `${reason}: B's suite ran as theirs`);
      delete answers.byTrigger['manual-recheck'];
    }
    // An admin's retry of a settled A while the proposal reviews B.
    const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
    const A = SHA('7').replace(/^./, 'a'); const B = SHA('7').replace(/^./, 'b');
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, A]);
    answers.next = result(realPass);
    await submit(s, A);
    await settle();
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, B]);
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    answers.byTrigger['manual-recheck'] = result(realPass);
    await send(s, 'AdminRetry', {}, { kind: 'admin' });
    await rt.drain();
    assert.equal((await instance(s)).data.preparing?.head, B, 'the admin retry builds B');
    await settle();
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', B, null]);
    assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false);
    delete answers.byTrigger['manual-recheck'];
  });

  // The machine reads the proposal's pin itself, under the row's lock, when
  // a person's recheck arrives. preview-workflow.recheck (#5282) hands the
  // reviewed head over as a revision first, so in the route cases above the
  // machine is already on the newest head when the recheck lands, and they
  // would pass even if the machine ignored the pin. A pin can still move
  // after that hand-over (an upload lands between the revision and the
  // recheck) with no revision of its own: these cases move it with nothing
  // announced, so only the machine's own reading of the pin can get the
  // newer head built and checked (review of #5310, round 1).
  const realPassOf = () => result({ results: [browser, unitPass], unitObserved: UNIT_KEY,
    history: [{ checkKey: UNIT_KEY, name: unitSuiteRow.UNIT_CHECK_NAME, path: 'package.json', passed: true }] });
  const pinTo = (s, head) => pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, head]);

  await t.test('a manual recheck builds a pin that moved with no revision announced, settled, preparing or checking', async () => {
    let n = 0;
    for (const state of ['settled', 'preparing', 'checking']) {
      n += 1;
      const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
      const A = SHA(String(n)).replace(/^./, 'a'); const B = SHA(String(n)).replace(/^./, 'b');
      await pinTo(s, A);
      // A settled run of A passed on its own suite; a run of A still to come
      // would answer with a copied pass, which never answers a request.
      answers.next = state === 'settled' ? realPassOf() : result({ results: [browser, copied], unitEarned: UNIT_KEY });
      answers.byTrigger['manual-recheck'] = realPassOf();
      await submit(s, A);
      await rt.drain();
      if (state === 'checking') { await rt.runServices(); await rt.drain(); }
      if (state === 'settled') { await settle(); answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY }); }
      assert.equal((await instance(s)).state, state);
      const runsOfA = (await runsOf(s)).filter((w) => w.input.head === A).length;
      asked.length = 0;

      await pinTo(s, B);
      await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: B });
      await send(s, 'RecheckRequested', { reason: 'manual-recheck', trigger: 'manual-recheck' }, { kind: 'route' });
      await rt.drain();
      assert.equal((await instance(s)).data.preparing?.head, B, `${state}: the newer pin is built, not the head held`);
      assert.equal((await row(s.id)).unit_suite_fresh_sha, B, `${state}: the request stays on the newer pin`);

      await settle();
      const r = await row(s.id);
      assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', B, null], state);
      assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, `${state}: not answered by a copy`);
      assert.ok((await runsOf(s)).some((w) => w.input.head === B && w.input.trigger === 'manual-recheck'), `${state}: B is checked as theirs`);
      assert.equal((await runsOf(s)).filter((w) => w.input.head === A).length, runsOfA, `${state}: no new run of A`);
      assert.ok(!asked.some((a) => a.trigger === 'commit-push'), `${state}: A's run never answered`);
      delete answers.byTrigger['manual-recheck'];
    }
  });

  await t.test('through the recheck route\'s hand-over: an upload that lands between the revision and the recheck is the head checked', async (st) => {
    const platformPath = require.resolve('../src/workflow/platform.ts');
    const realPlatform = require.cache[platformPath];
    const platform = {};
    require.cache[platformPath] = { id: platformPath, filename: platformPath, loaded: true, exports: platform, paths: [] };
    st.after(() => { if (realPlatform) require.cache[platformPath] = realPlatform; else delete require.cache[platformPath]; });
    platform.previewHeld = async (id) => (await pool.query('SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows.length > 0;
    platform.previewInstance = async (id) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows[0];
    const s = await proposal({ status: 'promoted', source: 'cli_handoff' });
    const A = SHA('a'); const B = SHA('b'); const C = SHA('c');
    const handed = [];
    platform.submitRevision = async (r) => {
      const ev = await send({ id: r.sessionId, app_id: r.appId }, 'RevisionSubmitted',
        { sessionId: r.sessionId, head: r.head, source: r.source, trigger: r.trigger ?? null, carryFrom: r.carryFrom ?? null }, { kind: 'system', name: r.source });
      await rt.drain();
      handed.push([r.head, (await instance(s)).data.preparing?.head]);
      // The upload of C moves the voted-on head; nothing announces it to
      // the machine before the recheck arrives.
      await pinTo(s, C);
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    platform.requestRecheck = async (o) => {
      const ev = await send({ id: o.sessionId, app_id: o.appId }, 'RecheckRequested', { reason: o.reason, trigger: o.trigger }, { kind: 'route' });
      await rt.drain();
      return (await pool.query('SELECT result AS status, reason FROM wf_events WHERE id = $1', [ev])).rows[0];
    };
    await pinTo(s, A);
    answers.next = realPassOf();
    await submit(s, A);
    await settle();
    await pinTo(s, B);
    answers.next = result({ results: [browser, copied], unitEarned: UNIT_KEY });
    answers.byTrigger['manual-recheck'] = realPassOf();
    asked.length = 0;

    await recovery.recheckSessionChecks({ pool, session: await row(s.id), reason: 'manual-recheck' });
    assert.deepEqual(handed, [[B, B]], 'the hand-over took B, the head reviewed when the recheck read the row');
    assert.equal((await instance(s)).data.preparing?.head, C, 'the machine read C under the lock and builds it instead of B');
    await settle();
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.unit_suite_fresh_sha], ['passing', C, null]);
    assert.equal(!!r.test_results.find((x) => x.index === -3)?.reused, false, 'not answered by a copy');
    const runs = (await runsOf(s)).map((w) => [w.input.head, w.input.trigger]);
    assert.ok(runs.some(([h, tr]) => h === C && tr === 'manual-recheck'), 'C is checked as theirs');
    assert.ok(!runs.some(([h]) => h === B), 'B, superseded while it was built, is never checked');
    delete answers.byTrigger['manual-recheck'];
  });
});
