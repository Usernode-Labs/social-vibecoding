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
});
