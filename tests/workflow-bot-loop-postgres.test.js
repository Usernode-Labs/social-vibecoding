'use strict';

// The Homeroom bot's loop machines (src/workflow/bot-request/, bot-lane/)
// against the full PostgreSQL schema, with the work faked: a request owed a
// look is queued (its row the projection), the lane grants slots under its
// caps from what the requests hold, a look's end decides what comes next, a
// person writing during a read starts it over, a Stop and a merge end a look
// and stop its turn, a fix bot-change asked for is answered, a build is
// asked for and its end frees its slot, an older release's queue row is
// adopted. The [main] bugs fixed are named where each is pinned
// (workflow-foundation's trace-bot-loop.md §7).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-bot-loop-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const request = require('../src/workflow/bot-request/machine.ts');
const lane = require('../src/workflow/bot-lane/machine.ts');
const { requestKey, lookCardKey, SLOTS_IN_USE_SQL, NEXT_ELIGIBLE_SQL } = require('../src/workflow/rules/bot-loop.ts');
const { TURN_STOP } = require('../src/workflow/rules/turn-stop.ts');
const { TURN_OWNER_SQL, syncWorkingSql } = require('../src/workflow/session-work.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the Homeroom bot\'s loop machines against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_botloop_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // Its guard on: what every process's boot syncs (platform.syncSettings).
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${request.MACHINE}', '1')`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const user = async (name = `p${++seq}`) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [name])).rows[0];
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`);
  const ada = await user('ada');
  const ben = await user('ben');
  const mkApp = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, status) VALUES ($1, $1, $2, 'running') RETURNING id`, [slug, ada.id])).rows[0];
  const app = await mkApp('clubs');
  const app2 = await mkApp('gardens');
  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  await setting('homeroom_bot_mode', 'live');
  await setting('homeroom_bot_live_at_once', '3');
  await setting('homeroom_bot_per_person', '2');
  const requester = (appId, n, userId) => pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [appId, n, userId]);
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try { await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT'); } finally { cl.release(); }
  };

  // Fake work: each call recorded; `answer` per kind (a value, or a
  // function of the input, or a promise a test settles).
  const work = { calls: [], answer: new Map() };
  const fake = (kind) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, concurrency: 32,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      const a = work.answer.get(kind);
      if (typeof a === 'function') return a(input, key);
      return a ?? { outcome: 'done' };
    },
  });
  const kinds = [...Object.values(request.WORK), ...Object.values(lane.WORK), TURN_STOP];
  const services = Object.fromEntries(kinds.map((k) => [k, fake(k)]));
  const rt = createRuntime({ pool, machines: [request.botRequest({ staging: false }), lane.botLane({ staging: false })], pollMs: 50, publish: async () => {}, services });
  runtimes.push(rt);
  const settle = async () => {
    for (let i = 0; i < 80; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  const reset = () => { work.calls.length = 0; work.answer.clear(); };
  const inst = async (machine, key) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  const row = async (appId, n) => (await pool.query('SELECT * FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [appId, n])).rows[0];
  let rk = 0;
  const send = async (machine, key, type, payload, source = { kind: 'system', name: 'test' }) => {
    const id = await rt.append(machine, key, { type, payload }, { requestKey: `t-${++rk}`, source });
    await settle();
    return (await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  };
  const owe = (appId, n, more = {}) => send(request.MACHINE, requestKey(appId, n), 'Owed',
    { appId, issueNumber: n, reason: 'new', priority: 1, ...more });
  // Events applied, no work run: a look granted stays queued as work (the
  // kernel's driver awaits the work it runs), so a test sees it under way.
  const sendOnly = async (machine, key, type, payload, source = { kind: 'system', name: 'test' }) => {
    const id = await rt.append(machine, key, { type, payload }, { requestKey: `t-${++rk}`, source });
    await rt.drain();
    return (await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  };
  const oweOnly = (appId, n, more = {}) => sendOnly(request.MACHINE, requestKey(appId, n), 'Owed',
    { appId, issueNumber: n, reason: 'new', priority: 1, ...more });
  // The work items queued (not run yet) of a kind.
  const queuedWork = async (kind) => (await pool.query(
    `SELECT key, work_key, input, status FROM wf_work WHERE kind = $1 AND status = 'queued' ORDER BY created_at`, [kind])).rows;
  const states = async (st) => (await pool.query(
    `SELECT key FROM wf_instances WHERE machine = $1 AND state = $2 ORDER BY key`, [request.MACHINE, st])).rows.map((r) => r.key);
  const events = async (machine, key, type) => (await pool.query(
    'SELECT payload, result, reason FROM wf_events WHERE machine = $1 AND key = $2 AND type = $3 ORDER BY id', [machine, key, type])).rows;

  await t.test('owed: a request owed a look is queued, its row the projection; a person\'s ask goes first and lifts a hold', async () => {
    reset();
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await setting('homeroom_bot_mode', 'off');
    await owe(app.id, 1);
    let i = await inst(request.MACHINE, requestKey(app.id, 1));
    assert.equal(i.state, 'queued');
    let q = await row(app.id, 1);
    assert.equal(q.priority, 1);
    assert.equal(q.reason, 'new');
    assert.equal(q.started_at, null);
    // The refresh's own find does not take a person's ask's place.
    await owe(app.id, 1, { reason: 'dm_answer', priority: 0, requestedBy: ada.id });
    await owe(app.id, 1, { reason: 'changed', priority: 2 });
    q = await row(app.id, 1);
    assert.deepEqual([q.priority, q.reason, q.requested_by], [0, 'dm_answer', ada.id]);
    // Outside writes to a row it holds are refused by its guard.
    await assert.rejects(pool.query('UPDATE homeroom_bot_queue SET priority = 5 WHERE app_id = $1 AND issue_number = 1', [app.id]), /WF_OWNERSHIP_VIOLATION/);
    await assert.rejects(pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 1', [app.id]), /WF_OWNERSHIP_VIOLATION/);
    // The refresh no longer wants it: a person's ask stays until it runs.
    await send(request.MACHINE, requestKey(app.id, 1), 'NotOwed', { appId: app.id, issueNumber: 1, quiet: false });
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 1))).state, 'queued');
    // The answer a caller gets (enqueueFront): queued, and its look's card key.
    const r = await owe(app.id, 1, { reason: 'asked', priority: 0 });
    assert.deepEqual(r.reply, { queued: true, looking: false, jobKey: lookCardKey(app.id, 1, 1) });
    i = await inst(request.MACHINE, requestKey(app.id, 1));
    assert.equal(i.data.n, 0, 'no look yet: the bot is off');
  });

  await t.test('lane: grants under its caps, one read per project session, per person; a look\'s end frees its slot and the next is granted', async () => {
    reset();
    await requester(app.id, 1, ada.id);
    await requester(app.id, 2, ada.id);
    await requester(app2.id, 3, ada.id);
    await requester(app2.id, 4, ben.id);
    await requester(app2.id, 5, ben.id);
    await oweOnly(app.id, 2);
    await oweOnly(app2.id, 3);
    await oweOnly(app2.id, 4);
    await oweOnly(app2.id, 5);
    await setting('homeroom_bot_mode', 'live');
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    // liveAtOnce 3; one read per project: app #1 (ada, a person's ask) and
    // app2 #3 (ada). ada is at perPerson 2; app2's session is taken.
    assert.deepEqual(await states('reading'), [requestKey(app.id, 1), requestKey(app2.id, 3)].sort());
    assert.equal((await queuedWork(request.WORK.look)).length, 2, 'two looks under way');
    assert.ok((await row(app.id, 1)).started_at, 'its row says it runs');
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 1))).data.slot.kind, 'read');
    // L2: a second read on app2's session is never granted while #3 runs,
    // and asking the lane again grants nothing twice (L1).
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal((await queuedWork(request.WORK.look)).length, 2);
    // The two looks end: their slots free, and app #2 (ada) and app2 #4
    // (ben) are granted.
    await settle();
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 1))).state, 'idle');
    assert.equal(await row(app.id, 1), undefined, 'consumed: its row is gone with its end');
    const looked = new Set(calls(request.WORK.look).map((c) => `${c.input.appId}:${c.input.issueNumber}`));
    for (const k of [`${app.id}:1`, `${app2.id}:3`, `${app.id}:2`, `${app2.id}:4`, `${app2.id}:5`]) assert.ok(looked.has(k), `${k} looked at in turn`);
    // Never two reads of one project's session at once (each look's grant
    // came after the previous one's end).
    const app2Looks = calls(request.WORK.look).filter((c) => c.input.appId === app2.id).map((c) => c.input.issueNumber);
    assert.deepEqual(app2Looks, [3, 4, 5]);
  });

  // The refresh: a full one every five minutes, and soon after a project is
  // asked for, that project alone (never a second full one).
  await t.test('refresh: a full one covers every project; a project asked for after it is refreshed alone', async () => {
    reset();
    const setRefresh = (field, value) => asTransition((cl) => cl.query(
      `UPDATE wf_instances SET data = jsonb_set(data, $3::text[], to_jsonb($4::text)) WHERE machine = $1 AND key = $2`,
      [lane.MACHINE, lane.KEY, ['refresh', field], value]));
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    await setRefresh('due', new Date(Date.now() - 1000).toISOString());
    await send(lane.MACHINE, lane.KEY, 'Tick', {});
    const full = calls(lane.WORK.refresh).at(-1);
    assert.equal(full.input.apps, null, 'the full one: every project');
    assert.deepEqual((await inst(lane.MACHINE, lane.KEY)).data.refresh.asked, []);
    await send(lane.MACHINE, lane.KEY, 'RefreshAsked', { appId: app2.id });
    await setRefresh('soon', new Date(Date.now() - 1000).toISOString());
    await send(lane.MACHINE, lane.KEY, 'Tick', {});
    assert.deepEqual(calls(lane.WORK.refresh).at(-1).input.apps, [app2.id], 'that project alone');
    assert.equal(calls(lane.WORK.sweep).length, 1, 'the sweeps go with the full one only');
    // A first version just filed (newcomer run nine): its project at once,
    // not after the settle.
    await send(lane.MACHINE, lane.KEY, 'RefreshAsked', { appId: app.id, now: true });
    assert.deepEqual(calls(lane.WORK.refresh).at(-1).input.apps, [app.id], 'refreshed at once');
  });

  // A request an admin must look at (its instance flagged) holds no slot,
  // and the lane wakes when a follow-up's burst on its change settles.
  await t.test('lane SQL: a flagged request holds no slot; a burst on a change\'s thread is waited out, then looked at', async () => {
    reset();
    const app6 = await mkApp('ponds-sql');
    await oweOnly(app6.id, 1);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    const held = async () => (await pool.query(`SELECT key FROM (${SLOTS_IN_USE_SQL}) s WHERE key = $1`, [requestKey(app6.id, 1)])).rows.length;
    assert.equal(await held(), 1);
    await asTransition((cl) => cl.query(`UPDATE wf_instances SET flag = 'faulted' WHERE machine = $1 AND key = $2`, [request.MACHINE, requestKey(app6.id, 1)]));
    assert.equal(await held(), 0, 'flagged: no slot');
    await asTransition((cl) => cl.query(`UPDATE wf_instances SET flag = NULL WHERE machine = $1 AND key = $2`, [request.MACHINE, requestKey(app6.id, 1)]));
    // A queued follow-up whose change's thread a person just wrote on.
    const { rows: [cs] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, linked_issues) VALUES ($1, $2, 'b', 'promoted', ARRAY[2]) RETURNING id`, [app6.id, bot.id]);
    await pool.query(`INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'one more thing', 'message', 'session', $3)`,
      [app6.id, ada.id, cs.id]);
    await oweOnly(app6.id, 2);
    assert.equal((await inst(request.MACHINE, requestKey(app6.id, 2))).state, 'queued', 'not granted while it settles');
    const { rows: [n] } = await pool.query(NEXT_ELIGIBLE_SQL);
    assert.ok(n.at && Date.parse(n.at) > Date.now() && Date.parse(n.at) - Date.now() <= 21000, 'when it settles');
  });

  // A person's message on a request's thread: its instance hears it in the
  // statement that stores it, when it has one; a request the bot never had
  // anything to do with gets no instance per comment (its project is
  // refreshed instead, by the caller).
  await t.test('heard: a message on a request\'s thread reaches its instance only when it has one', async () => {
    reset();
    const platform = require('../src/workflow/platform.ts');
    const app7 = await mkApp('ponds-heard');
    const post = async (n) => (await platform.insertHeard(pool,
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'hi', 'message', 'issue', $3) RETURNING id, created_at`,
      [app7.id, ada.id, n], { appId: app7.id, thread: { type: 'issue', ref: n } }))[0];
    const activity = async (n) => (await events(request.MACHINE, requestKey(app7.id, n), 'Activity')).length;
    assert.equal((await post(1)).requestHeard, false);
    assert.equal(await activity(1), 0, 'no instance made for a comment');
    await oweOnly(app7.id, 2);
    assert.equal((await post(2)).requestHeard, true);
    assert.equal(await activity(2), 1);
  });

  // A platform sync waiting for the session to be idle is not yet working on
  // it for the shots agent (which would wait for it while it waits for the
  // agent): only once it has started.
  await t.test('session work: a sync counts for the shots agent only once it has started', async () => {
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'b', 'promoted') RETURNING id`, [app.id, ada.id]);
    const read = async () => (await pool.query(
      `SELECT ${syncWorkingSql('$1::int')} AS any, ${syncWorkingSql('$1::int', { started: true })} AS started`, [s.id])).rows[0];
    await asTransition((cl) => cl.query(
      `INSERT INTO wf_work (machine, key, kind, work_key, input) VALUES ('proposal', $1, 'branch.sync', 'sync:1', '{}')`, [`session:${s.id}`]));
    assert.deepEqual(await read(), { any: true, started: false }, 'waiting for idle');
    await asTransition((cl) => cl.query(`UPDATE wf_work SET checkpoint = '{"started": true}' WHERE key = $1`, [`session:${s.id}`]));
    assert.deepEqual(await read(), { any: true, started: true });
    await asTransition((cl) => cl.query(`DELETE FROM wf_work WHERE key = $1`, [`session:${s.id}`]));
  });

  // Before the bot has an account (a fresh platform switched live), the lane
  // still refreshes, which makes the account; it grants nothing yet.
  await t.test('lane facts: with the bot on and no bot account yet, it acts (the refresh makes one) and grants nothing', async () => {
    const { readFacts } = require('../src/workflow/bot-lane/facts.ts');
    const tx = { async query(sql) {
      if (/FROM platform_settings/.test(sql)) return { rows: [{ key: 'homeroom_bot_mode', value: 'live' }] };
      if (/FROM users/.test(sql)) return { rows: [] };
      throw new Error(`unexpected: ${sql.slice(0, 40)}`);
    } };
    const f = await readFacts(tx, { staging: false });
    assert.equal(f.acting, true);
    assert.deepEqual([f.reads, f.builds, f.inUse], [[], [], []]);
  });

  await t.test('busy: a look refused for now waits on its own backoff, its tries untouched; L5: a fault pauses every grant instead', async () => {
    reset();
    work.answer.set(request.WORK.look, { outcome: 'busy', error: 'session_busy' });
    await owe(app.id, 6);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    let i = await inst(request.MACHINE, requestKey(app.id, 6));
    assert.equal(i.state, 'queued');
    assert.equal(i.data.backoff.failures, 1);
    const q = await row(app.id, 6);
    assert.equal(q.wait_reason, 'session_busy');
    assert.ok(new Date(q.wait_until) > new Date(), 'backed off');
    const looks = calls(request.WORK.look).length;
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal(calls(request.WORK.look).length, looks, 'not granted inside its backoff');
    // Its backoff ends (its clock): granted again; a fault now.
    await asTransition((cl) => cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{backoff,until}', to_jsonb(now() - interval '1 second'))
                                          WHERE machine = $1 AND key = $2`, [request.MACHINE, requestKey(app.id, 6)]));
    await asTransition((cl) => cl.query('UPDATE homeroom_bot_queue SET wait_until = now() - interval \'1 second\' WHERE app_id = $1 AND issue_number = 6', [app.id]));
    work.answer.set(request.WORK.look, { outcome: 'fault', error: 'worker quota' });
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    i = await inst(request.MACHINE, requestKey(app.id, 6));
    assert.equal(i.state, 'queued', 'owed as it was');
    const l = await inst(lane.MACHINE, lane.KEY);
    assert.ok(l.data.fault && new Date(l.data.fault.until) > new Date(), 'the lane pauses');
    await owe(app2.id, 7);
    const before = calls(request.WORK.look).length;
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal(calls(request.WORK.look).length, before, 'nothing granted while paused');
    // The pause ends; a look that runs ends it for good.
    await asTransition((cl) => cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{fault,until}', to_jsonb(now() - interval '1 second'))
                                          WHERE machine = $1 AND key = $2`, [lane.MACHINE, lane.KEY]));
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await send(lane.MACHINE, lane.KEY, 'Tick', {});
    await settle();
    assert.equal((await inst(lane.MACHINE, lane.KEY)).data.fault, null);
  });

  // One request the platform always fails on (a provider refusing its
  // conversation, a turn that always throws) must not keep pausing every
  // grant: it waits on its own count, and its look is told the count, so
  // its FAULT_TRIES-th fault is recorded as a failed read (laneFault: its
  // debt spent, the lane paused all the same).
  await t.test('faults: a request failing on the platform waits on its own count, its look told it; a recorded failure spends its debt', async () => {
    reset();
    const unpause = () => asTransition((cl) => cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{fault}', 'null')
                                                           WHERE machine = $1 AND key = $2`, [lane.MACHINE, lane.KEY]));
    const unwait = (n) => asTransition(async (cl) => {
      await cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{backoff,until}', to_jsonb(now() - interval '1 second'))
                       WHERE machine = $1 AND key = $2`, [request.MACHINE, requestKey(app2.id, n)]);
      await cl.query('UPDATE homeroom_bot_queue SET wait_until = now() - interval \'1 second\' WHERE app_id = $1 AND issue_number = $2', [app2.id, n]);
    });
    await unpause();
    work.answer.set(request.WORK.look, { outcome: 'fault', error: 'provider down' });
    await owe(app2.id, 11);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    let i = await inst(request.MACHINE, requestKey(app2.id, 11));
    assert.equal(i.state, 'queued', 'owed as it was');
    assert.equal(i.data.faults, 1);
    assert.equal(i.data.backoff.failures, 1, 'it waits on its own count too');
    assert.equal((await row(app2.id, 11)).wait_reason, 'provider down');
    await unpause(); await unwait(11);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    i = await inst(request.MACHINE, requestKey(app2.id, 11));
    assert.equal(i.data.faults, 2);
    assert.ok(Date.parse(i.data.backoff.until) - Date.now() > 3 * 60 * 1000, 'its wait doubles');
    await unpause(); await unwait(11);
    // The look recorded its failure (homeroom-bot.js recordFailure): spent.
    work.answer.set(request.WORK.look, (input) => ({ outcome: 'failed', laneFault: true, seen: input.faults }));
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    const looks = calls(request.WORK.look).filter((c) => c.input.issueNumber === 11);
    assert.deepEqual(looks.map((c) => c.input.faults), [0, 1, 2], 'each look told its count');
    assert.ok(looks.every((c) => /^[ua]\d+$/.test(c.input.person)), 'and who it is for (the budget\'s pause is said to them)');
    i = await inst(request.MACHINE, requestKey(app2.id, 11));
    assert.equal(i.state, 'idle');
    assert.equal(i.data.faults, 0);
    assert.equal(await row(app2.id, 11), undefined, 'nothing owed after');
    assert.ok((await inst(lane.MACHINE, lane.KEY)).data.fault, 'the lane still pauses');
    await unpause();
  });

  // A look whose work throws (a bug, data it cannot read) is no outage: the
  // lane goes on granting, the request waits on its own count, and after
  // THROWN_TRIES in a row it is held a day, which a person's ask lifts.
  await t.test('thrown: a look whose work throws pauses nothing else, waits on its own count, and is held after five', async () => {
    reset();
    const unwait = (n) => asTransition(async (cl) => {
      await cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{backoff,until}', to_jsonb(now() - interval '1 second'))
                       WHERE machine = $1 AND key = $2`, [request.MACHINE, requestKey(app2.id, n)]);
      await cl.query('UPDATE homeroom_bot_queue SET wait_until = now() - interval \'1 second\' WHERE app_id = $1 AND issue_number = $2', [app2.id, n]);
    });
    work.answer.set(request.WORK.look, () => { throw new Error('a bug'); });
    await owe(app2.id, 112);
    for (let i = 1; i <= 5; i++) {
      if (i > 1) await unwait(112);
      await send(lane.MACHINE, lane.KEY, 'Look', {});
      const d = (await inst(request.MACHINE, requestKey(app2.id, 112))).data;
      assert.equal(d.faults, i);
      assert.equal(d.backoff.reason, 'look_failed');
      assert.equal((await inst(lane.MACHINE, lane.KEY)).data.fault, null, 'the lane is not paused');
    }
    const d = (await inst(request.MACHINE, requestKey(app2.id, 112))).data;
    assert.ok(Date.parse(d.owed.heldUntil) - Date.now() > 23 * 3600 * 1000, 'held a day');
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await oweOnly(app2.id, 112, { reason: 'dm_answer', priority: 0 });
    assert.equal((await inst(request.MACHINE, requestKey(app2.id, 112))).data.owed.heldUntil, null, 'a person\'s ask lifts it');
    work.answer.set(request.WORK.look, { outcome: 'done' });
  });

  // GitHub's hourly budget nearly used up (services/github-budget.js): a look
  // or a refresh that finds it so reads nothing; the request stays owed, and
  // the lane grants nothing and refreshes nothing until the reset, then runs
  // a full refresh.
  await t.test('github: a look held by GitHub\'s budget stays owed, and the lane waits for the reset', async () => {
    reset();
    const unpause = () => asTransition((cl) => cl.query(`UPDATE wf_instances SET data = data - 'github' - 'fault' WHERE machine = $1 AND key = $2`, [lane.MACHINE, lane.KEY]));
    await unpause();
    const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    work.answer.set(request.WORK.look, { outcome: 'github', until });
    await owe(app2.id, 13);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    const i = await inst(request.MACHINE, requestKey(app2.id, 13));
    assert.equal(i.state, 'queued', 'owed as it was');
    assert.equal(i.data.faults || 0, 0, 'no fault of its own');
    let l = await inst(lane.MACHINE, lane.KEY);
    assert.equal(l.data.github.until, until);
    const looks = calls(request.WORK.look).length;
    await owe(app2.id, 14);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal(calls(request.WORK.look).length, looks, 'nothing granted until the reset');
    assert.ok(Date.parse(l.deadline_at) <= Date.parse(until), 'its clock wakes it by then');
    // A refresh the budget held moves the next full refresh to the reset.
    await unpause();
    await asTransition((cl) => cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{refresh,due}', to_jsonb($3::text)) WHERE machine = $1 AND key = $2`,
      [lane.MACHINE, lane.KEY, new Date(Date.now() - 1000).toISOString()]));
    work.answer.set(request.WORK.look, { outcome: 'done' });
    work.answer.set(lane.WORK.refresh, { github: until });
    await send(lane.MACHINE, lane.KEY, 'Tick', {});
    l = await inst(lane.MACHINE, lane.KEY);
    assert.equal(l.data.github.until, until);
    assert.equal(l.data.refresh.due, until, 'a full refresh once it resets');
    work.answer.delete(lane.WORK.refresh);
    await unpause();
  });

  await t.test('interrupt: a person writing during a read stops its turn and reads it again, once, carrying what it spent', async () => {
    reset();
    await oweOnly(app.id, 8);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 8))).state, 'reading');
    await sendOnly(request.MACHINE, requestKey(app.id, 8), 'Activity', { appId: app.id, issueNumber: 8, at: new Date().toISOString() });
    const i = await inst(request.MACHINE, requestKey(app.id, 8));
    assert.equal(i.data.look.interrupted, true);
    work.answer.set(request.WORK.look, (input) => (input.n === i.data.look.n ? { outcome: 'interrupted', carried: { costUsd: 0.5 } } : null));
    await rt.runServices(); await rt.drain();
    const again = await inst(request.MACHINE, requestKey(app.id, 8));
    assert.equal(again.state, 'reading');
    assert.equal(again.data.look.owed.reason, 'read_again');
    assert.deepEqual(again.data.carried, { costUsd: 0.5 });
    const next = (await queuedWork(request.WORK.look)).find((w) => w.key === requestKey(app.id, 8));
    assert.deepEqual(next.input.carried, { costUsd: 0.5 }, 'the next read carries what this one spent');
    // A read started over is never interrupted again: what was said is owed
    // after it, from its project's refresh, asked for now.
    const asked = (await events(lane.MACHINE, lane.KEY, 'RefreshAsked')).length;
    await sendOnly(request.MACHINE, requestKey(app.id, 8), 'Activity', { appId: app.id, issueNumber: 8, at: new Date().toISOString() });
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 8))).data.look.interrupted, false);
    assert.equal((await events(lane.MACHINE, lane.KEY, 'RefreshAsked')).length, asked + 1, 'its project refreshed soon');
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await settle();
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 8))).state, 'idle');
  });

  await t.test('stop: a person\'s Stop ends the look, stops its turn by its record and releases it; nothing is owed after', async () => {
    reset();
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'main', 'paused') RETURNING id`, [app.id, bot.id]);
    await oweOnly(app.id, 9);
    // The lane names the triage session in its grant.
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    const i = await inst(request.MACHINE, requestKey(app.id, 9));
    assert.equal(i.data.look.sessionId, s.id);
    const r = await sendOnly(request.MACHINE, requestKey(app.id, 9), 'StopRequested', { sessionId: s.id, by: 'ada' }, { kind: 'route' });
    assert.equal(r.result, 'accepted');
    const after = await inst(request.MACHINE, requestKey(app.id, 9));
    assert.equal(after.state, 'idle');
    assert.equal(await row(app.id, 9), undefined);
    const stop = (await queuedWork(TURN_STOP)).find((w) => w.input.sessionId === s.id);
    assert.deepEqual([stop.input.machine, stop.input.key, stop.input.by, stop.input.release],
      [request.MACHINE, requestKey(app.id, 9), 'ada', true]);
    // Its look was cancelled: it never runs.
    await settle();
    assert.equal(calls(request.WORK.look).filter((c) => c.input.issueNumber === 9).length, 0);
  });

  // Which instance a person's Stop goes to: a workflow turn spinning up
  // (no record yet) is the one that waits on the session; a person's own
  // turn running there is theirs, and a Stop of it never ends the
  // platform's look that merely waits beside it.
  await t.test('stop: a Stop goes to the look spinning up, never to it while a person\'s own turn runs on the session', async () => {
    reset();
    const app3 = await mkApp('ponds-stop');
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'main', 'paused') RETURNING id`, [app3.id, bot.id]);
    await oweOnly(app3.id, 1);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal((await inst(request.MACHINE, requestKey(app3.id, 1))).data.look.sessionId, s.id);
    const ownerOf = async () => (await pool.query(TURN_OWNER_SQL, [s.id])).rows[0] || null;
    assert.deepEqual(await ownerOf(), { machine: request.MACHINE, key: requestKey(app3.id, 1) }, 'spinning up: the look\'s');
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
      [s.id, JSON.stringify({ turnId: 'person-1', journal: '/home/node/.claude/turn-person-1.log', phase: 'executing', mode: 'build' })]);
    assert.equal(await ownerOf(), null, 'a person\'s turn: the old path\'s Stop');
    await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [s.id]);
  });

  // A project's first read is granted before its triage session exists (its
  // look makes it): the look tells its instance the session once it knows
  // it, and from then a Stop finds the look by it.
  await t.test('stop: a project\'s first read, granted with no session, is stopped once its look names the session it made', async () => {
    reset();
    const app4 = await mkApp('ponds-first');
    await oweOnly(app4.id, 1);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    let i = await inst(request.MACHINE, requestKey(app4.id, 1));
    assert.equal(i.state, 'reading');
    assert.equal(i.data.look.sessionId, null, 'no triage session yet');
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'main', 'paused') RETURNING id`, [app4.id, bot.id]);
    const stale = await sendOnly(request.MACHINE, requestKey(app4.id, 1), 'LookOn', { appId: app4.id, issueNumber: 1, n: i.data.look.n + 1, sessionId: s.id });
    assert.equal(stale.result, 'accepted');
    assert.equal((await inst(request.MACHINE, requestKey(app4.id, 1))).data.look.sessionId, null, 'another look\'s session changes nothing');
    await sendOnly(request.MACHINE, requestKey(app4.id, 1), 'LookOn', { appId: app4.id, issueNumber: 1, n: i.data.look.n, sessionId: s.id });
    i = await inst(request.MACHINE, requestKey(app4.id, 1));
    assert.equal(i.data.look.sessionId, s.id);
    assert.deepEqual((await pool.query(TURN_OWNER_SQL, [s.id])).rows[0], { machine: request.MACHINE, key: requestKey(app4.id, 1) });
    await sendOnly(request.MACHINE, requestKey(app4.id, 1), 'StopRequested', { sessionId: s.id, by: 'ada' }, { kind: 'route' });
    assert.equal((await inst(request.MACHINE, requestKey(app4.id, 1))).state, 'idle');
    assert.ok((await queuedWork(TURN_STOP)).some((w) => w.input.sessionId === s.id && w.input.workKey === `look:${i.data.look.n}`));
  });

  await t.test('fix: bot-change\'s ask is refused at once with the bot off, else owed and answered by how the round came out', async () => {
    reset();
    await setting('homeroom_bot_mode', 'off');
    await send(request.MACHINE, requestKey(app.id, 10), 'FixAsked', { appId: app.id, issueNumber: 10, sessionId: 777, head: 'a'.repeat(40) }, { kind: 'system' });
    let fx = await events('bot-change', 'session:777', 'FixRefused');
    assert.equal(fx.length, 1);
    assert.equal(fx[0].payload.why, 'off');
    await setting('homeroom_bot_mode', 'live');
    work.answer.set(request.WORK.look, { outcome: 'done', fix: { outcome: 'looked' } });
    await send(request.MACHINE, requestKey(app.id, 10), 'FixAsked', { appId: app.id, issueNumber: 10, sessionId: 777, head: 'b'.repeat(40) }, { kind: 'system' });
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    const look = calls(request.WORK.look).at(-1);
    assert.equal(look.input.owed.reason, 'checks_failing');
    fx = await events('bot-change', 'session:777', 'FixRoundEnded');
    assert.equal(fx.length, 1);
    assert.deepEqual([fx[0].payload.head, fx[0].payload.outcome], ['b'.repeat(40), 'looked']);
    // A round lost (its look ended with no word of it): answered as lost.
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await send(request.MACHINE, requestKey(app.id, 10), 'FixAsked', { appId: app.id, issueNumber: 10, sessionId: 777, head: 'c'.repeat(40) }, { kind: 'system' });
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    fx = await events('bot-change', 'session:777', 'FixRoundEnded');
    assert.equal(fx.at(-1).payload.outcome, 'lost');
  });

  await t.test('L7: a fix asked for a request held for its payer\'s week is not held by it', async () => {
    reset();
    work.answer.set(request.WORK.look, { outcome: 'held', until: new Date(Date.now() + 86400000).toISOString() });
    await owe(app.id, 11);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    assert.ok((await row(app.id, 11)).held_until, 'held');
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await sendOnly(request.MACHINE, requestKey(app.id, 11), 'FixAsked', { appId: app.id, issueNumber: 11, sessionId: 778, head: 'd'.repeat(40) }, { kind: 'system' });
    assert.equal((await row(app.id, 11)).held_until, null);
    assert.equal((await row(app.id, 11)).reason, 'checks_failing');
    await settle();
  });

  await t.test('build: a ready verdict waits for a build slot, is asked of bot-build, and its end frees the slot', async () => {
    reset();
    work.answer.set(request.WORK.look, { outcome: 'done', build: 501 });
    work.answer.set(request.WORK.build, { outcome: 'requested', key: 'run:501@w1' });
    await owe(app2.id, 12);
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    const i = await inst(request.MACHINE, requestKey(app2.id, 12));
    assert.equal(i.state, 'building');
    assert.deepEqual([i.data.build.runId, i.data.build.phase, i.data.build.key], [501, 'running', 'run:501@w1']);
    assert.equal(i.data.slot.kind, 'build');
    const b = calls(request.WORK.build).at(-1);
    assert.equal(b.input.runId, 501);
    // Its end, from bot-build.
    await send(request.MACHINE, requestKey(app2.id, 12), 'BuildEnded', { id: 501, outcome: 'done' },
      { kind: 'message', from: { machine: 'bot-build', key: 'run:501@w1', eventId: 1 } });
    const done = await inst(request.MACHINE, requestKey(app2.id, 12));
    assert.equal(done.state, 'idle');
    assert.equal(done.data.slot, null);
    // A build held for its payer's week waits for its slot again, held.
    work.answer.set(request.WORK.build, { outcome: 'held', until: new Date(Date.now() + 86400000).toISOString() });
    await send(request.MACHINE, requestKey(app2.id, 12), 'BuildOwed', { appId: app2.id, issueNumber: 12, runId: 502 });
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    const held = await inst(request.MACHINE, requestKey(app2.id, 12));
    assert.equal(held.state, 'building');
    assert.equal(held.data.build.phase, 'waiting');
    assert.ok(held.data.build.heldUntil, 'held');
    const n = calls(request.WORK.build).length;
    await send(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal(calls(request.WORK.build).length, n, 'L9: a held build takes no slot');
  });

  // A live run waiting for its build that no instance holds (an older
  // release's, an append that never landed, one turned away while another
  // build ran) is told to its request by the lane's sweep, once a window.
  await t.test('builds owed: the sweep tells a request its waiting run no instance holds, once a window', async () => {
    reset();
    const bot_ = require('../src/services/homeroom-bot');
    const app5 = await mkApp('ponds-builds');
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at) VALUES ($1, 3, 'live', 'ready', now()) RETURNING id`, [app5.id]);
    const told = [];
    const deps = { now: () => 1_000_000_000, platform: { async botBuildOwed(_db, p) {
      told.push(p);
      await rt.append(request.MACHINE, requestKey(p.appId, p.issueNumber), { type: 'BuildOwed', payload: p }, { requestKey: p.key, source: { kind: 'system', name: 'test' } });
      await rt.drain();
    } } };
    // The lane is not asked here: the request only takes the run.
    assert.equal(await bot_.sweepWaitingBuilds(pool, deps), 1);
    assert.equal(told[0].runId, Number(run.id));
    const i = await inst(request.MACHINE, requestKey(app5.id, 3));
    assert.equal(i.state, 'building');
    assert.equal(i.data.build.runId, Number(run.id));
    assert.equal(await bot_.sweepWaitingBuilds(pool, deps), 0, 'held now: not told again');
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = NULL, live_build_waiting_at = NULL WHERE id = $1', [run.id]);
  });

  await t.test('merged: what was owed before the merge is dropped, a look begun before stops', async () => {
    reset();
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'main', 'paused') RETURNING id`, [app2.id, bot.id]);
    await oweOnly(app2.id, 13);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal((await inst(request.MACHINE, requestKey(app2.id, 13))).state, 'reading');
    await sendOnly(request.MACHINE, requestKey(app2.id, 13), 'RequestMerged', { appId: app2.id, issueNumber: 13, before: new Date().toISOString() });
    assert.equal((await inst(request.MACHINE, requestKey(app2.id, 13))).state, 'idle');
    assert.ok((await queuedWork(TURN_STOP)).some((w) => w.input.sessionId === s.id), 'its turn is stopped');
    await settle();
  });

  await t.test('adopted: an older release\'s unclaimed row is owed; a claimed one waits for that release\'s turn, then is read again', async () => {
    reset();
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await setting('homeroom_bot_mode', 'off');
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 20, 2, 'changed')`, [app.id]);
    await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at) VALUES ($1, 21, 1, 'new', now())`, [app.id]);
    const { rows: [old] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn)
      VALUES ($1, $2, 'main', 'active', '{"turnId":"older","phase":"executing"}'::jsonb) RETURNING id`, [app.id, bot.id]);
    for (const q of (await pool.query('SELECT * FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number IN (20, 21)', [app.id])).rows) {
      await send(request.MACHINE, requestKey(q.app_id, q.issue_number), 'Adopted', {
        appId: q.app_id, issueNumber: q.issue_number, reason: q.reason, priority: q.priority,
        enqueuedAt: q.enqueued_at.toISOString(), startedAt: q.started_at ? q.started_at.toISOString() : null,
      });
    }
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 20))).state, 'queued');
    const older = await inst(request.MACHINE, requestKey(app.id, 21));
    assert.equal(older.state, 'older_turn');
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [request.MACHINE, requestKey(app.id, 21)]));
    await rt.fireTimers(); await settle();
    assert.equal((await inst(request.MACHINE, requestKey(app.id, 21))).state, 'older_turn', 'its turn still runs');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [old.id]);
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [request.MACHINE, requestKey(app.id, 21)]));
    await rt.fireTimers(); await settle();
    const after = await inst(request.MACHINE, requestKey(app.id, 21));
    assert.equal(after.state, 'queued');
    assert.equal(after.data.owed.reason, 'restart', 'read again quietly (L4: the restart reason is written)');
    await setting('homeroom_bot_mode', 'live');
  });

  await t.test('L1: a look is never granted twice, and a newer ask during it is looked at after it, not dropped by its end', async () => {
    reset();
    const app3 = await mkApp('ponds');
    await oweOnly(app3.id, 30);
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    await sendOnly(lane.MACHINE, lane.KEY, 'Look', {});
    assert.equal((await queuedWork(request.WORK.look)).filter((w) => w.key === requestKey(app3.id, 30)).length, 1, 'one look');
    await oweOnly(app3.id, 30, { reason: 'dm_answer', priority: 0, requestedBy: ben.id });
    assert.equal((await inst(request.MACHINE, requestKey(app3.id, 30))).state, 'reading');
    assert.equal((await inst(request.MACHINE, requestKey(app3.id, 30))).data.owed.reason, 'dm_answer', 'kept for after the look');
    work.answer.set(request.WORK.look, { outcome: 'done' });
    await settle();
    assert.equal(calls(request.WORK.look).filter((c) => c.input.issueNumber === 30).length, 2, 'looked at again for the newer ask');
    assert.equal(calls(request.WORK.look).filter((c) => c.input.issueNumber === 30)[1].input.owed.reason, 'dm_answer');
  });
});
