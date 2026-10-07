'use strict';

// The preview machine (src/workflow/preview/) against the full PostgreSQL
// schema: admission, supersession, publication, settlement, the error lane,
// deferral, retirement and detaching (machine-preview.md §11). Work kinds
// are faked here, each recording what it was asked; services.ts has its own
// tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { preview, sessionKey, MACHINE, NOTIFIERS, WORK, attemptDb } = require('../src/workflow/preview/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);

test('preview machine against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_preview_' + crypto.randomBytes(6).toString('hex');
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

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user() {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [`pv_${++seq}`]);
    return u;
  }
  async function app() {
    const owner = await user();
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text) RETURNING *`,
      [`pv-app-${++seq}`, owner.id]);
    return a;
  }
  async function proposal(a, { status = 'promoted', source = null, pin = null, extra = {} } = {}) {
    const by = await user();
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, reviewed_head_sha, imported_pr_head_sha)
       VALUES ($1, $2, $3, $4, 'feature', $5, $6, $7) RETURNING *`,
      [a.id, by.id, status, source, ++seq, source === 'imported' ? null : pin, source === 'imported' ? pin : null]);
    if (Object.keys(extra).length) {
      const cols = Object.keys(extra);
      await pool.query(`UPDATE chat_sessions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [s.id, ...cols.map((c) => extra[c])]);
    }
    return { ...s, app: a };
  }
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const workOf = async (s, kind) => (await pool.query(
    `SELECT kind, work_key, input, status, result, due_at FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, sessionKey(s.id), kind || null])).rows;

  const notified = [];
  const notifiers = Object.fromEntries(NOTIFIERS.map((n) => [n, (x) => { notified.push(x); }]));
  // Fake work: records each call; `answer` decides per kind (a function of
  // the input, or a value), `hold` keeps a kind running until released.
  const work = { calls: [], answer: new Map(), holds: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key, signal }) {
      work.calls.push({ kind, key, input });
      const hold = work.holds.get(kind);
      if (hold) {
        await Promise.race([hold.promise, new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
      }
      const a = work.answer.get(kind);
      return typeof a === 'function' ? a(input) : (a ?? { ok: true });
    },
  });
  const hold = (kind) => {
    let release;
    const promise = new Promise((r) => { release = r; });
    work.holds.set(kind, { promise });
    return () => { work.holds.delete(kind); release(); };
  };
  const prepareOk = (input) => ({
    ok: true, url: `https://pv--s${input.sessionId}.apps.test`, runtimeKind: 'kubernetes',
    runtimeName: `sv-preview-1-s${input.sessionId}`, containerId: null, imageRef: `img@sha256:${input.n}`, buildRef: `b-${input.n}`,
  });
  const verdict = (state, extra = {}) => () => ({
    outcome: 'verdict', state, results: [{ index: 0, name: 'Loads /', status: state === 'passing' ? 'pass' : 'fail' }],
    console: { state: 'clean', errors: [] }, history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 }],
    capture: { state: 'console_only', detail: { media: false } }, visuals: false, ...extra,
  });
  work.answer.set(WORK.prepare, prepareOk);
  work.answer.set(WORK.run, verdict('passing'));
  work.answer.set(WORK.retire, { closed: true });

  const machine = preview({ maxRetries: 6, retireAfterMs: 0, notifiers });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50,
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
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after, emitted FROM wf_events WHERE id = $1', [id])).rows[0];
  // Bring an instance's deadline forward, as the pipeline would write it.
  const due = async (s) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };
  const reply = async (id) => (await pool.query('SELECT reply FROM wf_events WHERE id = $1', [id])).rows[0].reply;
  const submit = (s, head, extra = {}) => send(s, 'RevisionSubmitted', { sessionId: s.id, head, source: 'test', trigger: 'commit-push', ...extra });

  await t.test('P1 a revision is built, published, checked and settled, with its history counted once', async () => {
    const s = await proposal(await app(), { pin: SHA('a') });
    const id = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'preparing');
    let r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_phase, r.checks_commit_sha, r.check_trigger], ['pending', 'building', SHA('a'), 'commit-push']);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'settled');
    r = await row(s.id);
    assert.equal(r.staging_url, `https://pv--s${s.id}.apps.test`);
    assert.equal(r.staging_commit_sha, SHA('a'));
    assert.equal(r.check_state, 'passing');
    assert.equal(r.console_check_state, 'clean');
    assert.equal(r.capture_state, 'console_only');
    const prepare = (await workOf(s, WORK.prepare))[0];
    assert.equal(prepare.input.db, attemptDb(s.app.slug, s.id, i.data.seed, 1));
    const { rows: history } = await pool.query('SELECT pass_count FROM app_check_history WHERE app_id = $1', [s.app_id]);
    assert.deepEqual(history.map((h) => h.pass_count), [1]);
    assert.ok(notified.some((n) => n.type === 'mergeKick' && n.sessionId === s.id), 'a passing verdict kicks the merge queue');
    const publish = (await workOf(s, WORK.publish))[0];
    assert.equal(publish.input.state, 'passing', 'the platform-variables check refreshes on a verdict (review finding 4)');
    const kinds = (await workOf(s)).map((w) => w.kind).sort();
    assert.deepEqual(kinds, [WORK.botNote, WORK.run, WORK.publish, WORK.prepare, WORK.scheduleShots, WORK.startShots].sort());
  });

  await t.test('P2 the same head joins; a stale producer is refused; a newer head cancels the attempt and retires it', async () => {
    const s = await proposal(await app(), { status: 'active' });
    const release = hold(WORK.prepare);
    await submit(s, SHA('a'));
    await rt.drain();
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    const again = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(again)).reason, 'same_head');
    const newer = await submit(s, SHA('b'));
    await rt.drain();
    assert.equal((await outcome(newer)).state_after, 'preparing');
    await running;   // the held handler saw its signal abort
    release();
    const prepares = await workOf(s, WORK.prepare);
    assert.deepEqual(prepares.map((w) => [w.work_key, w.status, w.result]),
      [['prepare:1', 'settled', { cancelled: true }], ['prepare:2', 'queued', null]]);
    assert.deepEqual((await workOf(s, WORK.retireAttempt)).map((w) => [w.work_key, w.input.n]), [['retire-attempt:1', 1]]);
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).staging_commit_sha, SHA('b'));
    assert.deepEqual((await instance(s)).data.retiring, []);

    const promoted = await proposal(await app(), { pin: SHA('c') });
    const stale = await submit(promoted, SHA('d'));
    await rt.drain();
    assert.equal((await outcome(stale)).reason, 'head_superseded');
    assert.equal(await instance(promoted), undefined, 'a refused first event leaves no instance');
  });

  await t.test('P3 a newer head during checks cancels the run by its id, and its late result is refused', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    const release = hold(WORK.run);
    const running = rt.runServices();
    await new Promise((r) => setTimeout(r, 50));
    await submit(s, SHA('b'));
    await rt.drain();
    release();
    await running;
    const cancels = await workOf(s, WORK.cancel);
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].input.runId, (await workOf(s, WORK.run))[0].work_key);
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'settled');
    assert.equal(i.data.head, SHA('b'));
    const { rows: refused } = await pool.query(
      `SELECT reason FROM wf_events WHERE key = $1 AND type = 'WorkSucceeded' AND result = 'rejected'`, [sessionKey(s.id)]);
    assert.ok(refused.every((e) => e.reason === 'work_cancelled'));
  });

  await t.test('P4 a failed candidate leaves the serving preview linked; the error lane retries it', async () => {
    const s = await proposal(await app(), { pin: SHA('a') });
    await submit(s, SHA('a'));
    await settle();
    const served = await row(s.id);
    await pool.query('UPDATE chat_sessions SET reviewed_head_sha = $2 WHERE id = $1', [s.id, SHA('b')]);
    work.answer.set(WORK.prepare, (input) => (input.head === SHA('b')
      ? { ok: false, detail: 'Container exited with code 1', infrastructure: false }
      : prepareOk(input)));
    await submit(s, SHA('b'));
    await settle();
    const i = await instance(s);
    assert.equal(i.state, 'failed');
    assert.equal(i.data.serving.head, SHA('a'), 'the older attempt still serves');
    const r = await row(s.id);
    assert.equal(r.staging_url, served.staging_url, 'and stays linked (bug 4)');
    assert.equal(r.staging_commit_sha, SHA('a'));
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.consecutive_check_failures], ['error', SHA('b'), 1]);
    assert.ok(r.check_error_notified_at, 'the author was told once');
    const { rows: lines } = await pool.query(`SELECT content FROM chat_session_messages WHERE session_id = $1`, [s.id]);
    assert.equal(lines.length, 1);
    assert.match(lines[0].content, /Container exited with code 1/);
    assert.ok(i.deadline_at, 'a promoted row is in the error lane');
    assert.deepEqual((await workOf(s, WORK.retireAttempt)).map((w) => w.input.n), [2], 'the failed attempt is retired');
    // RetryDue: a new attempt of the same head; a second failure stays quiet.
    await due(s);
    await rt.fireTimers();
    await settle();
    assert.equal((await instance(s)).data.streak, 2);
    assert.equal((await row(s.id)).consecutive_check_failures, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM chat_session_messages WHERE session_id = $1`, [s.id])).rows[0].n, 1);
    work.answer.set(WORK.prepare, prepareOk);
    await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).staging_commit_sha, SHA('b'));
    assert.equal((await row(s.id)).consecutive_check_failures, 0);
  });

  await t.test('P5 a run that cannot say is an error, never a verdict, and adds no history', async () => {
    const s = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The capture Job output could not be read' });
    await submit(s, SHA('e'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_error_detail], ['error', 'The capture Job output could not be read']);
    assert.equal((await instance(s)).deadline_at, null, 'an active native row is outside the error lane');
    const { rows } = await pool.query('SELECT 1 FROM app_check_history WHERE app_id = $1', [s.app_id]);
    assert.equal(rows.length, 0);
    assert.ok(!notified.some((n) => n.type === 'mergeKick' && n.sessionId === s.id));
  });

  await t.test('P6 a deferred head waits for ConflictResolved, once per episode', async () => {
    const s = await proposal(await app(), { pin: SHA('f') });
    work.answer.set(WORK.run, { outcome: 'deferred', capture: { state: 'console_only', detail: { deferred: true } } });
    await submit(s, SHA('f'));
    await settle();
    work.answer.set(WORK.run, verdict('failing'));
    assert.equal((await instance(s)).state, 'deferred');
    assert.deepEqual([(await row(s.id)).check_state, (await row(s.id)).check_phase], ['pending', 'deferred']);
    const wrong = await send(s, 'ConflictResolved', { head: SHA('9') });
    await rt.drain();
    assert.equal((await outcome(wrong)).reason, 'not_deferred_head');
    await send(s, 'ConflictResolved', { head: SHA('f') });
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await row(s.id)).check_state, 'failing');
  });

  await t.test('P7 retirement: an exit is terminal and clears the row; an idle one keeps the newest revision', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('1'));
    await settle();
    const idle = await send(s, 'RetireRequested', { reason: 'idle', terminal: false });
    await rt.drain();
    assert.equal((await outcome(idle)).state_after, 'retiring');
    assert.equal((await row(s.id)).staging_url, null);
    const during = await submit(s, SHA('2'));
    await rt.drain();
    assert.equal((await outcome(during)).state_after, 'retiring');
    await settle();
    let i = await instance(s);
    assert.equal(i.state, 'settled', 'the revision that arrived during the retirement was built after it');
    assert.equal(i.data.serving.head, SHA('2'));
    const retire = (await workOf(s, WORK.retire))[0];
    assert.deepEqual(retire.input.attempts.map((a) => a.n), [1]);

    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [s.id]);
    await send(s, 'RetireRequested', { reason: 'archived', terminal: true });
    await settle();
    i = await instance(s);
    assert.equal(i.state, 'retired');
    assert.ok(i.data.closedAt);
    const archived = await submit(s, SHA('3'));
    await rt.drain();
    assert.equal((await outcome(archived)).reason, 'not_open');
    // Unarchived: it starts again from its row, numbering on.
    await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = $1`, [s.id]);
    const again = await submit(s, SHA('3'));
    await rt.drain();
    assert.equal((await outcome(again)).state_after, 'preparing');
    assert.equal((await instance(s)).data.preparing.n, 3);
    await settle();
  });

  await t.test('P8 detach cancels everything; the next event adopts the row again', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('4'));
    await rt.drain();
    await send(s, 'Detach');
    await rt.drain();
    assert.equal((await instance(s)).state, 'detached');
    assert.deepEqual((await workOf(s, WORK.prepare)).map((w) => w.result), [{ cancelled: true }]);
    // [main] built a preview meanwhile; the next event adopts it as attempt 0.
    await pool.query(
      `UPDATE chat_sessions SET staging_url = 'https://legacy', staging_runtime_name = 'sv-preview-legacy',
              staging_runtime_kind = 'kubernetes', staging_commit_sha = $2, checks_commit_sha = $2, check_state = 'passing'
        WHERE id = $1`, [s.id, SHA('5')]);
    const same = await submit(s, SHA('5'));
    await rt.drain();
    assert.equal((await outcome(same)).state_after, 'settled', 'the adopted verdict for the served head stands');
    const i = await instance(s);
    assert.equal(i.data.serving.n, 0);
    assert.equal(i.data.last, 1, 'numbering continues');
    await submit(s, SHA('6'));
    await settle();
    const retired = await workOf(s, WORK.retireAttempt);
    assert.deepEqual(retired.map((w) => [w.input.n, w.input.db]),
      [[0, `app_${s.app.slug.replace(/-/g, '_')}_staging_s${s.id}_555555`]], 'the adopted preview is retired by its [main] name');
  });

  await t.test('P10 a head with nothing beyond main settles skipped without a build, and kicks the queue', async () => {
    const s = await proposal(await app(), { status: 'promoted', pin: SHA('8') });
    const id = await send(s, 'ChecksSkipped', { sessionId: s.id, head: SHA('9'), reason: 'branch has no commits beyond main' });
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'settled');
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.checks_commit_sha, r.check_error_detail], ['skipped', SHA('9'), 'branch has no commits beyond main']);
    assert.equal((await workOf(s, WORK.prepare)).length, 0);
    assert.ok(notified.some((n) => n.type === 'mergeKick' && n.sessionId === s.id && n.state === 'skipped'));
  });

  await t.test('P11 a mechanical merge carries a green verdict to the merged head; anything else is checked', async () => {
    work.answer.set(WORK.run, verdict('passing'));
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await settle();
    const carried = await submit(s, SHA('b'), { carryFrom: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(carried)).state_after, 'settled');
    assert.deepEqual([(await row(s.id)).checks_commit_sha, (await row(s.id)).check_state], [SHA('b'), 'passing']);
    assert.equal((await instance(s)).data.serving.head, SHA('a'), 'the tested head still serves');
    const stale = await submit(s, SHA('c'), { carryFrom: SHA('a') });
    await rt.drain();
    assert.equal((await outcome(stale)).state_after, 'preparing', 'a carry from a head that is not the settled one is checked');
    await settle();
  });

  await t.test('P12 detached and re-enabled with nothing rebuilt: the instance\'s own attempt is kept, by its own name', async () => {
    work.answer.set(WORK.run, verdict('passing'));
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('d'));
    await settle();
    const before = (await instance(s)).data.serving;
    await send(s, 'Detach');
    await rt.drain();
    await submit(s, SHA('e'));
    await settle();
    const retired = (await workOf(s, WORK.retireAttempt)).map((w) => [w.input.n, w.input.db]);
    assert.deepEqual(retired, [[before.n, before.db]], 'the attempt it built is retired, under the name it was built with');
  });

  await t.test('P13 code nothing checks yet clears the verdict through the machine and cancels the old run', async () => {
    work.answer.set(WORK.run, verdict('passing'));
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await rt.drain();
    await rt.runServices();   // prepare
    await rt.drain();
    assert.equal((await instance(s)).state, 'checking');
    const id = await send(s, 'ChecksCleared', { reason: 'upload' });
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'settled');
    const i = await instance(s);
    assert.equal(i.data.verdict, null);
    assert.deepEqual((await workOf(s, WORK.run)).map((w) => w.result), [{ cancelled: true }]);
    const r = await row(s.id);
    assert.deepEqual([r.check_state, r.check_phase, r.capture_state], [null, null, null]);
    assert.equal(r.staging_url, `https://pv--s${s.id}.apps.test`, 'the preview still serves');
    // Submitting the same head again checks it: a cleared verdict is not a join.
    const again = await submit(s, SHA('a'));
    await rt.drain();
    assert.equal((await outcome(again)).state_after, 'preparing');
    await settle();
  });

  await t.test('P9 manual requests: ensure joins what serves, deploy builds again, a recheck waits for the run', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('7'));
    await settle();
    const ensure = await send(s, 'PreviewRequested', { sessionId: s.id, head: SHA('7'), reason: 'ensure' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(ensure)).reason, 'already_serving');
    await send(s, 'PreviewRequested', { sessionId: s.id, head: SHA('7'), reason: 'deploy' }, { kind: 'route' });
    await rt.drain();
    const busy = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(busy)).reason, 'run_outstanding');
    await settle();
    const i = await instance(s);
    assert.equal(i.data.serving.n, 2, 'deploy built a new attempt of the same head');
    const recheck = await send(s, 'RecheckRequested', { reason: 'manual' }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(recheck)).result, 'accepted');
    assert.deepEqual(await reply(recheck), { state: 'checking', head: SHA('7'), url: `https://pv--s${s.id}.apps.test`, verdict: null });
  });
});
