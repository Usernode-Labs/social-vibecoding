'use strict';

// The proposal machine's rules that replaced the leader's sweeps
// (src/workflow/proposal/, version 4), against the full PostgreSQL schema:
// a session's insert enrols it (schema.sql wf_enrol_proposal), and a closed
// proposal's CC volume is purged once its retention window passes, by a
// purge queued with the close that a Reopen cancels. The fixture is
// workflow-proposal-postgres.test.js's.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { proposal, sessionKey, MACHINE, WORK } = require('../src/workflow/proposal/machine.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHA = (c) => c.repeat(40).slice(0, 40);
const DAY = 24 * 60 * 60 * 1000;
const DEPS = { idleMs: 5 * 60 * 1000, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 7 * DAY, staleGraceMs: 3 * DAY };
const RETAIN_MS = 7 * DAY;

test('proposal machine rules against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_proposal_rules_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  const runtimes = [];
  const held = [];
  const hold = (kind) => {
    let release;
    work.gate.set(kind, new Promise((r) => { release = r; }));
    held.push(release);
    return release;
  };
  const openAll = () => { for (const r of held.splice(0)) r(); };
  t.after(async () => {
    openAll();
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1'), ('enabled:merge-followups', '1')
                    ON CONFLICT DO NOTHING`);

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  async function user({ synthetic = false } = {}) {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [`pr_${++seq}`, synthetic]);
    return u;
  }
  async function app(owner, { approvalsRequired = null } = {}) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, repo_url, approvals_required)
       VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text, $3) RETURNING *`,
      [`pr-app-${++seq}`, owner.id, approvalsRequired]);
    return a;
  }
  async function session({ status = 'active', source = null, head = SHA('a'), owner = null, appRow = null, pr = true,
    headless = false, promotedAgo = null, approvalsRequired = null, lastActivityAgo = 0 } = {}) {
    const o = owner || await user();
    const a = appRow || await app(o, { approvalsRequired });
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, source, branch_name, pr_number, pr_title, reviewed_head_sha,
                                  imported_pr_head_sha, is_headless, promoted_at, last_activity_at)
       VALUES ($1, $2, $3, $4, 'feature', $5, 'Make it better', $6, $7, $8,
               CASE WHEN $9::bigint IS NULL THEN NULL ELSE NOW() - make_interval(secs => $9::bigint / 1000.0) END,
               NOW() - make_interval(secs => $10::bigint / 1000.0))
       RETURNING *`,
      [a.id, o.id, status, source, pr ? ++seq : null, source === 'imported' ? null : head,
        source === 'imported' ? head : null, headless, promotedAgo, lastActivityAgo]);
    return { ...s, app: a, owner: o };
  }
  const row = async (s) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  const instance = async (s) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)])).rows[0];
  const workOf = async (s, kind) => (await pool.query(
    `SELECT kind, work_key, input, status, result FROM wf_work WHERE machine = $1 AND key = $2 AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at, work_key`, [MACHINE, sessionKey(s.id), kind || null])).rows;
  // What this machine asked of the others, in order.
  const sentTo = async (s, machine) => (await pool.query(
    `SELECT type, payload, source FROM wf_events WHERE machine = $1 AND key = $2 AND source->'from'->>'machine' = $3 ORDER BY id`,
    [machine, sessionKey(s.id), MACHINE])).rows;
  const asTransition = async (fn) => {
    const c = await pool.connect();
    try { await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(c); await c.query('COMMIT'); } finally { c.release(); }
  };
  const due = (s) => asTransition((c) => c.query(
    'UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(s.id)]));
  const vote = (s, u, v, epoch = null) => pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, head_sha, approval_epoch)
     SELECT $1, $2, $3, cs.reviewed_head_sha, COALESCE($4, cs.approval_epoch) FROM chat_sessions cs WHERE cs.id = $1
     ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, approval_epoch = EXCLUDED.approval_epoch, created_at = NOW()`,
    [s.id, u.id, v, epoch]);

  // Fake work: each call recorded; `answer` per kind (a value, or a
  // function of the input, which may throw).
  const work = { calls: [], answer: new Map(), gate: new Map() };
  const fake = (kind) => ({
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      if (work.gate.has(kind)) await work.gate.get(kind);
      const a = work.answer.get(kind);
      return typeof a === 'function' ? await a(input) : (a ?? { ok: true });
    },
  });
  const defaults = () => {
    work.calls.length = 0;
    work.gate.clear();
    work.answer.set(WORK.open, () => ({ head: SHA('a'), prNumber: 77, prUrl: 'https://github.com/acme/x/pull/77', prTitle: 'Make it better' }));
    work.answer.set(WORK.close, { closed: true });
    work.answer.set(WORK.reopen, { reopened: true });
  };
  defaults();
  t.afterEach(openAll);
  const pushed = [];
  const machine = proposal({ ...DEPS, retentionMs: RETAIN_MS });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async (q, list) => { pushed.push(...list); },
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  runtimes.push(rt);

  let rk = 0;
  const route = { kind: 'route' };
  const system = { kind: 'system' };
  const fromMerge = { kind: 'message', from: { machine: 'merge-followups', key: 'x', eventId: 1 } };
  const send = (s, type, payload = {}, source = system) => rt.append(machine, sessionKey(s.id),
    { type, payload: { sessionId: s.id, ...payload } }, { requestKey: `t-${++rk}`, source, appId: s.app_id });
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const outcome = async (id) => (await pool.query('SELECT result, reason, state_after, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  const purges = async (s) => (await pool.query(
    `SELECT work_key, status, result, due_at FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 ORDER BY created_at`,
    [MACHINE, sessionKey(s.id), WORK.purge])).rows;

  await t.test('R1 a session is the proposal machine\'s from its insert, whoever inserts it', async () => {
    defaults();
    const s = await session({ status: 'active' });
    const { rows: enrolled } = await pool.query(
      `SELECT type, request_key, source, payload FROM wf_events WHERE machine = $1 AND key = $2`, [MACHINE, sessionKey(s.id)]);
    assert.deepEqual(enrolled.map((e) => [e.type, e.request_key, e.source.kind, e.payload.sessionId]),
      [['Adopted', `adopt:${s.id}`, 'system', s.id]], 'the insert itself appended the adoption');
    await rt.drain();
    const i = await instance(s);
    assert.equal(i.state, 'underway');
    assert.ok(i.deadline_at, 'its idle check is armed');
    // The release's backfill asks again with the same key: a replay.
    const again = await send(s, 'Adopted', {}, system);
    await rt.drain();
    assert.ok(['rejected', 'replayed'].includes((await outcome(again)).result));
    const promoted = await session({ status: 'promoted', promotedAgo: 0 });
    await rt.drain();
    assert.equal((await instance(promoted)).state, 'in_review', 'born in review, its review check armed');
    const paused = await session({ status: 'paused' });
    const { rows: none } = await pool.query('SELECT 1 FROM wf_events WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(paused.id)]);
    assert.equal(none.length, 0, 'a paused row holds no slot: its first move adopts it');
  });

  await t.test('R2 a close queues the CC purge for when its retention passes; a reopen cancels it', async () => {
    defaults();
    const s = await session({ status: 'active' });
    await rt.drain();
    await send(s, 'Close', { from: 'active', reason: 'manual', userId: s.owner.id, username: s.owner.username }, route);
    await settle();
    const [p] = await purges(s);
    assert.equal(p.status, 'queued', 'not run yet');
    const archivedAt = new Date((await row(s)).archived_at).getTime();
    assert.ok(Math.abs(new Date(p.due_at).getTime() - (archivedAt + RETAIN_MS)) < 60000, 'due when the window ends');
    assert.ok((await instance(s)).data.doomed.some((x) => x.kind === WORK.purge), 'doomed: a reopen spares it');
    const reopen = await send(s, 'Reopen', { from: 'archived', userId: s.owner.id }, route);
    await settle();
    assert.equal((await outcome(reopen)).result, 'accepted', 'a purge waiting for its window does not hold a reopen');
    const [cancelled] = await purges(s);
    assert.deepEqual([cancelled.status, cancelled.result], ['settled', { cancelled: true }]);
    assert.equal(work.calls.filter((c) => c.kind === WORK.purge).length, 0, 'it never ran');
  });

  await t.test('R3 a purge past its window runs and marks the row; a row closed before the rule is adopted with one', async () => {
    defaults();
    work.answer.set(WORK.purge, { purged: true });
    // Closed eight days ago and never held: its adoption queues the purge, due now.
    const old = await session({ status: 'active' });
    await rt.drain();
    await send(old, 'Close', { from: 'active', reason: 'manual', userId: old.owner.id }, route);
    await settle();
    await asTransition((c) => c.query('DELETE FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(old.id)]));
    await pool.query('DELETE FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(old.id)]);
    await pool.query(`UPDATE chat_sessions SET archived_at = NOW() - interval '8 days' WHERE id = $1`, [old.id]);
    await send(old, 'Adopted', {}, system);
    await settle();
    assert.equal((await instance(old)).state, 'closed');
    assert.ok((await purges(old)).some((p) => p.status === 'settled' && p.result?.value?.purged), 'past its window: purged at once');
    assert.equal((await row(old)).cc_purged, true);
    // Purged already: nothing more is queued for it.
    await send(old, 'Rearm', {}, system);
    await settle();
    assert.equal((await purges(old)).filter((p) => p.status === 'queued').length, 0);
    assert.deepEqual((await instance(old)).data.doomed, [], 'its report took it off the doomed list, and queued none again');
  });
  await t.test('R4 a close that follows GitHub\'s leaves the pull request alone; a close with no time keeps the volume', async () => {
    defaults();
    const s = await session({ status: 'promoted', promotedAgo: 0 });
    await rt.drain();
    await send(s, 'Close', { from: 'promoted', reason: 'pr-closed' });
    await settle();
    assert.equal((await row(s)).status, 'archived');
    assert.equal((await workOf(s, WORK.close)).length, 0, 'GitHub closed it: not closed again (an author\'s reopen stands)');
    assert.equal((await purges(s)).length, 1, 'the retention purge still queued');

    const legacy = await session({ status: 'active' });
    await rt.drain();
    await send(legacy, 'Close', { from: 'active', reason: 'manual', userId: legacy.owner.id }, route);
    await settle();
    await asTransition((c) => c.query('DELETE FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(legacy.id)]));
    await pool.query('DELETE FROM wf_work WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(legacy.id)]);
    await pool.query('UPDATE chat_sessions SET archived_at = NULL WHERE id = $1', [legacy.id]);
    await send(legacy, 'Adopted', {}, system);
    await settle();
    assert.equal((await instance(legacy)).state, 'closed');
    assert.equal((await purges(legacy)).length, 0, 'closed with no time recorded: kept, as the old GC kept it');
  });
});

test('a release re-arms a closed proposal\'s given-up purge, and adopts nothing: every close creates its instance', () => {
  // The adoption of archived proposals no instance held (up to 2000 a
  // release) is gone: every close is the proposal machine's Close, which
  // creates the instance, and production had none left (2026-10-21).
  const src = require('node:fs').readFileSync(require.resolve('../src/workflow/platform.ts'), 'utf8');
  const fn = src.slice(src.indexOf('async function retainClosedProposals('), src.indexOf('\n}\n', src.indexOf('async function retainClosedProposals(')));
  assert.match(fn, /type: 'Rearm'/);
  assert.doesNotMatch(fn, /proposalAdopted|LIMIT 2000|NOT EXISTS \(SELECT 1 FROM wf_instances/);
});
