'use strict';

// The preview machine's own housekeeping (src/workflow/preview/machine.ts,
// version 7): the deadline it sets itself whenever an outcome leaves none,
// which replaced the leader's idle staging GC and its stuck-checks sweeps
// (IdleDue, ChecksDue), a fired deadline the state cannot use, a promote
// that re-arms the error lane, and a stale environment the release reports
// (EnvStale). The fixture is workflow-preview-postgres.test.js's.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { preview, sessionKey, MACHINE, WORK } = require('../src/workflow/preview/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const IDLE_MS = 60 * 60 * 1000;

test('preview machine housekeeping against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_preview_rest_' + crypto.randomBytes(6).toString('hex');
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
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);

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
  // The Homeroom bot: a change of its is followed by its change machine,
  // which the verdict's own write tells (rules/bot-notes.ts).
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const toldBot = async (s) => (await pool.query(
    `SELECT type, payload FROM wf_events WHERE machine = 'bot-change' AND key = $1 ORDER BY id`, [`session:${s.id}`])).rows
    .map((e) => [e.type, e.payload.state ?? null]);
  async function proposal(a, { status = 'promoted', source = null, pin = null, extra = {}, bot = false } = {}) {
    const by = bot ? botUser : await user();
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

  // What browsers heard: the pushes each transition published.
  const pushed = [];
  const heard = (s, event) => pushed.filter((p) => p.kind === 'session' && p.routing.sessionId === s.id
    && p.data.event === event);
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
  // These apps have no repo unit suite, and their runs say so as a real run
  // does (visuals.settleCaptureRun's `unitSuiteAbsent`), which is what
  // answers a person's "Run checks again" (rules/check-store.ts unitAnswer).
  const verdict = (state, extra = {}) => () => ({
    outcome: 'verdict', state, unitSuiteAbsent: true,
    results: [{ index: 0, name: 'Loads /', status: state === 'passing' ? 'pass' : 'fail' }],
    console: { state: 'clean', errors: [] }, history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 }],
    capture: { state: 'console_only', detail: { media: false } }, visuals: false, ...extra,
  });
  work.answer.set(WORK.prepare, prepareOk);
  work.answer.set(WORK.run, verdict('passing'));
  work.answer.set(WORK.retire, { closed: true });

  const machine = preview({ maxRetries: 6, retireAfterMs: 0, idleMs: IDLE_MS });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
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

  // The instance's one deadline, as [event, at].
  const deadline = async (s) => {
    const i = await instance(s);
    return i?.deadline_event ? [i.deadline_event.type, new Date(i.deadline_at).getTime()] : null;
  };
  const near = (at, want, slackMs = 15000) => Math.abs(at - want) < slackMs;
  const ago = (s, ms) => pool.query(
    `UPDATE chat_sessions SET last_activity_at = now() - make_interval(secs => $2::double precision / 1000) WHERE id = $1`, [s.id, ms]);
  // The instance's deadline turned into another event, due now (as one an
  // older outcome set would fire: its version is the one that set it).
  const setDeadline = async (s, type) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now(), deadline_event = $3
                      WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id), JSON.stringify({ type, payload: {} })]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };
  const fire = async (s) => { await due(s); await rt.fireTimers(); await settle(); };
  const lastOf = async (s, type) => (await pool.query(
    `SELECT result, reason, source FROM wf_events WHERE machine = $1 AND key = $2 AND type = $3 ORDER BY id DESC LIMIT 1`,
    [MACHINE, sessionKey(s.id), type])).rows[0];

  await t.test('H1 a preview nobody uses is given back once its idle window passes, never sooner', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('a'));
    await settle();
    assert.equal((await instance(s)).state, 'settled');
    const [type, at] = await deadline(s);
    assert.equal(type, 'IdleDue');
    const last = new Date((await row(s.id)).last_activity_at).getTime();
    assert.ok(near(at, last + IDLE_MS), 'due when the session has been unused for the window');
    // Used since it was armed: the deadline comes again from the new use.
    await ago(s, 60 * 1000);
    await fire(s);
    assert.equal((await instance(s)).state, 'settled', 'used a minute ago: kept');
    const [again, at2] = await deadline(s);
    assert.equal(again, 'IdleDue');
    assert.ok(near(at2, Date.now() - 60 * 1000 + IDLE_MS));
    // Unused for longer than the window: retired, the row unlinked.
    await ago(s, IDLE_MS + 60 * 1000);
    await fire(s);
    assert.equal((await instance(s)).state, 'idle');
    assert.equal((await row(s.id)).staging_url, null);
    assert.equal(await deadline(s), null, 'nothing serves: no deadline');
  });

  await t.test('H2 a vote-backed preview, or one somebody works on, is not given back', async () => {
    const voted = await proposal(await app(), { pin: SHA('b') });
    await submit(voted, SHA('b'));
    await settle();
    await ago(voted, IDLE_MS * 2);
    await fire(voted);
    assert.equal((await instance(voted)).state, 'settled', 'under review: kept');
    const [type, at] = await deadline(voted);
    assert.equal(type, 'IdleDue');
    assert.ok(near(at, Date.now() + IDLE_MS), 'looked at again a window later');

    const worked = await proposal(await app(), { status: 'active' });
    await submit(worked, SHA('c'));
    await settle();
    await ago(worked, IDLE_MS * 2);
    await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"t1"}'::jsonb WHERE id = $1`, [worked.id]);
    await fire(worked);
    assert.equal((await instance(worked)).state, 'settled', 'a turn on it: kept');
    const [w, wat] = await deadline(worked);
    assert.equal(w, 'IdleDue');
    assert.ok(near(wat, Date.now() + 60 * 1000), 'and looked at again in a minute');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [worked.id]);
    await fire(worked);
    assert.equal((await instance(worked)).state, 'idle', 'the turn over, it goes');
  });

  await t.test('H3 checks the row owes and nothing runs are run by the machine itself', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('d'));
    await settle();
    const runs = (await workOf(s, WORK.run)).length;
    // A person's "Run checks again" recorded on the row whose append a
    // restart lost: the next outcome that leaves no deadline arms ChecksDue.
    await pool.query('UPDATE chat_sessions SET unit_suite_fresh_sha = $2 WHERE id = $1', [s.id, SHA('d')]);
    const id = await send(s, 'IdleDue', {}, { kind: 'system', name: 'release' });
    await rt.drain();
    assert.equal((await outcome(id)).result, 'accepted');
    const [type, at] = await deadline(s);
    assert.equal(type, 'ChecksDue');
    assert.ok(near(at, Date.now() + 10 * 60 * 1000), 'ten minutes on, before the idle window');
    await fire(s);
    assert.equal((await workOf(s, WORK.run)).length, runs + 1, 'the owed run ran');
    assert.equal((await row(s.id)).check_trigger, 'manual-recheck', 'as the person\'s');
  });

  await t.test('H4 a promote re-arms the error lane for a head that errored out of its scope', async () => {
    const s = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The capture Job output could not be read' });
    await submit(s, SHA('e'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    assert.equal((await row(s.id)).check_state, 'error');
    assert.equal((await deadline(s))?.[0], 'IdleDue', 'an ordinary session\'s error has no retry');
    const sameBefore = await submit(s, SHA('e'));
    await rt.drain();
    assert.equal((await outcome(sameBefore)).reason, 'same_head', 'any other same-head revision is refused, as before');
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $2 WHERE id = $1`, [s.id, SHA('e')]);
    const kick = await submit(s, SHA('e'), { trigger: 'promote-kick' });
    await rt.drain();
    assert.equal((await outcome(kick)).result, 'accepted');
    assert.equal((await deadline(s))?.[0], 'RetryDue', 'up for a vote, the error is retried');
    await fire(s);
    assert.equal((await row(s.id)).check_state, 'passing');
  });

  await t.test('H5 a fired deadline the state cannot use is taken, and the next one set', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('f'));
    await settle();
    await setDeadline(s, 'RetryDue');
    await rt.fireTimers();
    await settle();
    const e = await lastOf(s, 'RetryDue');
    assert.deepEqual([e.result, e.source.kind], ['accepted', 'timer'], 'not refused: a refusal would leave no deadline');
    assert.equal((await instance(s)).state, 'settled');
    assert.equal((await deadline(s))?.[0], 'IdleDue');
    // A RetryDue a release sends is still refused where it does not apply.
    const sent = await send(s, 'RetryDue', {}, { kind: 'system', name: 'release-retry' });
    await rt.drain();
    assert.equal((await outcome(sent)).result, 'rejected');
  });

  await t.test('H6 a preview built with another environment: rebuilt under review, else given back', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await submit(s, SHA('1'));
    await settle();
    const n = (await instance(s)).data.serving.n;
    const wrong = await send(s, 'EnvStale', { attempt: n + 1 });
    await rt.drain();
    assert.equal((await outcome(wrong)).reason, 'not_serving');
    await send(s, 'EnvStale', { attempt: n });
    await settle();
    assert.equal((await instance(s)).state, 'idle');
    assert.equal((await row(s.id)).staging_url, null);

    const voted = await proposal(await app(), { pin: SHA('2') });
    await submit(voted, SHA('2'));
    await settle();
    const before = (await instance(voted)).data.serving.n;
    const id = await send(voted, 'EnvStale', { attempt: before });
    await rt.drain();
    assert.equal((await outcome(id)).state_after, 'preparing', 'its vote keeps it: built again');
    await settle();
    const i = await instance(voted);
    assert.equal(i.state, 'settled');
    assert.ok(i.data.serving.n > before, 'a new attempt serves');
  });
  await t.test('H7 an error on a head a person asked to recheck is the error lane\'s, not a loop of ChecksDue', async () => {
    const s = await proposal(await app(), { status: 'active' });
    await pool.query('UPDATE chat_sessions SET unit_suite_fresh_sha = $2 WHERE id = $1', [s.id, SHA('7')]);
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The browser checks could not start' });
    await submit(s, SHA('7'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    assert.equal((await row(s.id)).check_state, 'error');
    assert.equal((await row(s.id)).unit_suite_fresh_sha, SHA('7'), 'the unit suite never ran: still owed');
    // The error lane retries it up to its cap (6 here); after that only the
    // idle window is due, never ChecksDue's endless re-run.
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The browser checks could not start' });
    for (let n = 0; n < 8 && (await deadline(s))?.[0] === 'RetryDue'; n++) await fire(s);
    work.answer.set(WORK.run, verdict('passing'));
    assert.equal((await instance(s)).data.streak, 6, 'errors up to the cap');
    assert.equal((await deadline(s))?.[0], 'IdleDue', 'a held error never arms ChecksDue');
  });

  await t.test('H8 a folded recheck on a failed build keeps its retry', async () => {
    const s = await proposal(await app(), { pin: SHA('8') });
    work.answer.set(WORK.prepare, { ok: false, detail: 'Container exited with code 1', infrastructure: false });
    await submit(s, SHA('8'));
    await settle();
    work.answer.set(WORK.prepare, prepareOk);
    assert.equal((await instance(s)).state, 'failed');
    assert.equal((await deadline(s))?.[0], 'RetryDue');
    const id = await send(s, 'RecheckFolded', { head: SHA('8'), sessionId: s.id }, { kind: 'route' });
    await rt.drain();
    assert.equal((await outcome(id)).result, 'accepted');
    assert.equal((await row(s.id)).check_state, 'pending');
    assert.equal((await deadline(s))?.[0], 'RetryDue', 'the retry that runs it is kept');
  });

  await t.test('H9 a housekeeping event a newer deadline overtook keeps that deadline', async () => {
    const s = await proposal(await app(), { status: 'active' });
    work.answer.set(WORK.run, { outcome: 'blocked', reason: 'The capture Job output could not be read' });
    await submit(s, SHA('9'));
    await settle();
    work.answer.set(WORK.run, verdict('passing'));
    assert.equal((await deadline(s))?.[0], 'IdleDue');
    await pool.query(`UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $2 WHERE id = $1`, [s.id, SHA('9')]);
    await submit(s, SHA('9'), { trigger: 'promote-kick' });
    await rt.drain();
    assert.equal((await deadline(s))?.[0], 'RetryDue');
    // An IdleDue that fired before the promote, processed after it, and the
    // release's own: neither puts the idle deadline back.
    const fired = await send(s, 'IdleDue', {}, { kind: 'timer', setAtVersion: 1 });
    const sent = await send(s, 'IdleDue', {}, { kind: 'system', name: 'release' });
    await rt.drain();
    assert.deepEqual([(await outcome(fired)).result, (await outcome(sent)).result], ['accepted', 'accepted']);
    assert.equal((await deadline(s))?.[0], 'RetryDue', 'the retry stands');
  });
});
