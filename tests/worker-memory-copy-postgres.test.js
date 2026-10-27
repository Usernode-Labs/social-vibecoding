'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const { workerMemoryCopy, MACHINE, WORK, copyKey } = require('../src/workflow/worker-memory-copy/machine.ts');
const { requestWorkerMemoryCopy } = require('../src/workflow/worker-memory-copy/request.ts');
const { workerMemoryCopyServices } = require('../src/workflow/worker-memory-copy/services.ts');
const { assertNotCopying } = require('../src/services/worker-memory-copy');
const { workedOnSql } = require('../src/workflow/session-work.ts');
const { asTransition } = require('./lib/as-transition');

test('worker memory copies against the full PostgreSQL schema', { timeout: 60000 }, async t => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; TEST_DATABASE_URL requires this regression'); return;
  }
  const name = `memory_copy_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(admin.options.connectionString); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  t.mock.method(require('../src/db/pool'), 'getPool', () => pool);
  const worker = require('../src/services/worker');
  const calls = []; let duringCopy = null; let cleanupError = null;
  t.mock.method(worker, 'cloneCcVolume', async (sourceId, sessionId, options) => {
    assert.equal(process.env.PROCESS_ROLE, 'conductor');
    assert.equal(await options.proceed(), true); calls.push(['copy', sourceId, sessionId]);
    assert.equal((await row(sessionId)).cc_session_id, null, 'I/O does not publish the inherited conversation');
    if (duringCopy) await duringCopy(options);
    await options.renew();
  });
  t.mock.method(worker, 'cleanupCcVolumeClone', async (sourceId, sessionId, options) => {
    assert.equal(process.env.PROCESS_ROLE, 'conductor'); calls.push(['cleanup', sourceId, sessionId]);
    if (cleanupError) throw cleanupError; await options.renew();
  });
  const services = workerMemoryCopyServices({ pool });
  const web = createRuntime({ pool, machines: [workerMemoryCopy()], services, slots: 0 });
  const conductor = createRuntime({ pool, machines: [workerMemoryCopy()], services, slots: 1 });
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  t.after(async () => {
    await web.stop(); await conductor.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
    if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role;
  });
  let seq = 0;
  async function fixture() {
    calls.length = 0; duringCopy = null; cleanupError = null;
    const { rows: [u] } = await pool.query(`INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id`, [`memory_${++seq}`]);
    const { rows: [app] } = await pool.query(`INSERT INTO apps (slug, name, created_by, status) VALUES ($1, $1, $2, 'running') RETURNING id`, [`memory-${seq}`, u.id]);
    await pool.query(`INSERT INTO community_members (community_id, user_id, source)
      SELECT community_id, $2, 'joined' FROM apps WHERE id = $1`, [app.id, u.id]);
    const { rows: [s] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, is_headless, headless_status, cc_session_id)
      VALUES ($1, $2, TRUE, 'ready', $3) RETURNING id, agent_config_version`, [app.id, u.id, `memory-${seq}`]);
    const { rows: [d] } = await pool.query(`INSERT INTO chat_sessions (app_id, user_id, status, cloned_from_session_id)
      VALUES ($1, $2, 'active', $3) RETURNING id, agent_config_version`, [app.id, u.id, s.id]);
    return { sourceId: s.id, sessionId: d.id, appId: app.id, userId: u.id, sourceOwnerId: u.id,
      sourceVersion: s.agent_config_version, configVersion: d.agent_config_version, ccSessionId: `memory-${seq}`, requestId: randomUUID() };
  }
  const row = async id => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  const state = async p => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, copyKey(p.sessionId)])).rows[0];
  async function append(p, envelope = {}) {
    return web.append(MACHINE, copyKey(p.sessionId), { type: 'Requested', payload: p }, {
      appId: p.appId, actor: `user:${p.userId}`, source: { kind: 'route', name: WORK }, requestKey: p.requestId, ...envelope,
    });
  }
  async function service(rt = conductor) {
    process.env.PROCESS_ROLE = 'conductor';
    try { await rt.runServices(); } finally { process.env.PROCESS_ROLE = 'web'; }
  }
  async function settle(rt = conductor) {
    await rt.drain(); await service(rt); await rt.drain(); await service(rt); await rt.drain();
  }

  await t.test('web appends only; copying, fresh authority and atomic publication belong to the conductor', async () => {
    const p = await fixture(); const id = await append(p); assert.deepEqual(calls, []);
    await conductor.drain(); const admission = await web.waitForEvent(id, 1000);
    assert.equal(admission.status, 'accepted', JSON.stringify(admission));
    await assert.rejects(assertNotCopying(pool, p.sourceId), err => err.code === 'memory_copy_pending');
    await assert.rejects(assertNotCopying(pool, p.sessionId), err => err.code === 'memory_copy_pending');
    const busy = await pool.query(`SELECT cs.id FROM chat_sessions cs WHERE cs.id = ANY($1::int[]) AND ${workedOnSql()}`, [[p.sourceId, p.sessionId]]);
    assert.equal(busy.rowCount, 2, 'eviction and other processes see both reservations');
    await service(); assert.equal((await row(p.sessionId)).cc_session_id, null);
    await conductor.drain(); assert.equal((await row(p.sessionId)).cc_session_id, p.ccSessionId);
    assert.equal((await state(p)).data.result.copied, true);
    await assertNotCopying(pool, p.sessionId); assert.deepEqual(calls.map(c => c[0]), ['copy']);
  });
  await t.test('duplicate admission cannot copy or publish twice; the request helper waits for the result', async () => {
    const p = await fixture();
    const accepting = { ...web, appendAndWait: async (...args) => {
      const id = await web.append(...args); await conductor.drain(); await settle(); return web.waitForEvent(id, 1000);
    } };
    assert.deepEqual(await requestWorkerMemoryCopy(accepting, p), { copied: true });
    await append({ ...p, requestId: randomUUID() }); await settle();
    assert.equal(calls.filter(c => c[0] === 'copy').length, 1);
  });
  await t.test('a private project member can adopt a bot-owned ready run; revoked collaboration is refused', async () => {
    const p = await fixture();
    await pool.query(`UPDATE apps SET collab_visibility = 'private' WHERE id = $1`, [p.appId]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [p.appId, p.userId]);
    await pool.query('UPDATE chat_sessions SET user_id = NULL WHERE id = $1', [p.sourceId]); p.sourceOwnerId = null;
    await append(p); await settle(); assert.equal((await row(p.sessionId)).cc_session_id, p.ccSessionId);
    const revoked = await fixture();
    await pool.query(`UPDATE apps SET collab_visibility = 'private' WHERE id = $1`, [revoked.appId]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [revoked.appId, revoked.userId]);
    await append(revoked); await conductor.drain();
    duringCopy = () => pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [revoked.appId, revoked.userId]);
    await settle(); assert.equal((await row(revoked.sessionId)).cc_session_id, null);
    assert.equal((await state(revoked)).data.result.copied, false);
  });
  await t.test('current access, identity, source readiness and destination idleness are enforced before I/O', async () => {
    for (const change of ['app', 'owner', 'context', 'source-context', 'source-memory', 'not-headless', 'source-busy', 'destination-busy', 'used', 'blocked', 'membership', 'anonymised', 'actor', 'producer']) {
      const p = await fixture();
      if (change === 'app') p.appId += 100000;
      if (change === 'owner') p.userId += 100000;
      if (change === 'context') p.configVersion += 1;
      if (change === 'source-context') p.sourceVersion += 1;
      if (change === 'source-memory') p.ccSessionId = 'another-conversation';
      if (change === 'not-headless') await pool.query('UPDATE chat_sessions SET is_headless = FALSE WHERE id = $1', [p.sourceId]);
      if (change === 'source-busy' || change === 'destination-busy') await pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"busy"}'::jsonb WHERE id = $1`, [change === 'source-busy' ? p.sourceId : p.sessionId]);
      if (change === 'used') await pool.query('INSERT INTO session_workers (session_id) VALUES ($1)', [p.sessionId]);
      if (change === 'blocked') await pool.query('INSERT INTO user_app_blocks (app_id, user_id) VALUES ($1, $2)', [p.appId, p.userId]);
      if (change === 'membership') await pool.query('DELETE FROM community_members WHERE user_id = $1', [p.userId]);
      if (change === 'anonymised') await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [p.userId]);
      const id = await append(p, change === 'actor' ? { actor: 'user:99999' } : change === 'producer' ? { source: { kind: 'system' } } : {});
      await conductor.drain(); const out = await web.waitForEvent(id, 1000);
      assert.equal(out.status, 'rejected', change); assert.deepEqual(calls, [], change);
      assert.equal((await row(p.sessionId)).cc_session_id, null);
    }
  });
  await t.test('admission becoming stale is refused again before copying and before publication', async () => {
    for (const when of ['before-copy', 'before-publication']) {
      const p = await fixture(); await append(p); await conductor.drain();
      const change = () => pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [p.userId]);
      if (when === 'before-copy') await change();
      else duringCopy = change;
      await settle(); assert.equal((await state(p)).data.result.copied, false);
      assert.equal((await row(p.sessionId)).cc_session_id, null);
      assert.deepEqual(calls.map(c => c[0]), when === 'before-copy' ? ['cleanup'] : ['copy', 'cleanup']);
    }
  });
  await t.test('a turn admitted during copying never receives partial memory or a stale conversation id', async () => {
    const p = await fixture(); await append(p); await conductor.drain();
    duringCopy = () => pool.query(`UPDATE chat_sessions SET active_turn = '{"turnId":"new-turn"}'::jsonb WHERE id = $1`, [p.sessionId]);
    await settle(); assert.equal((await row(p.sessionId)).cc_session_id, null);
    assert.equal((await state(p)).data.result.copied, false);
    assert.deepEqual(calls.map(c => c[0]), ['copy', 'cleanup']);
  });
  await t.test('copy failure and cleanup failure stay reserved across restart until cleanup is confirmed', async () => {
    const p = await fixture(); await append(p); await conductor.drain();
    duringCopy = () => { throw new Error('partially copied'); }; cleanupError = new Error('runtime unavailable');
    await settle(); assert.equal((await state(p)).state, 'waiting_cleanup');
    await assert.rejects(assertNotCopying(pool, p.sessionId), /still being copied/);
    const fresh = createRuntime({ pool, machines: [workerMemoryCopy()], services, slots: 1 });
    try {
      cleanupError = null;
      await asTransition(pool, 'UPDATE wf_instances SET deadline_at = NOW() WHERE machine = $1 AND key = $2', [MACHINE, copyKey(p.sessionId)]);
      await fresh.fireTimers(); await settle(fresh);
      assert.equal((await state(p)).state, 'done'); assert.equal((await row(p.sessionId)).cc_session_id, null);
      await assertNotCopying(pool, p.sessionId); assert.equal(calls.filter(c => c[0] === 'copy').length, 1);
    } finally { await fresh.stop(); }
  });
  await t.test('a restart after copying but before the transition still publishes or cleans up durably', async () => {
    const p = await fixture(); await append(p); await conductor.drain(); await service();
    assert.equal((await row(p.sessionId)).cc_session_id, null);
    const fresh = createRuntime({ pool, machines: [workerMemoryCopy()], services, slots: 1 });
    try { await fresh.drain(); assert.equal((await row(p.sessionId)).cc_session_id, p.ccSessionId); }
    finally { await fresh.stop(); }
  });
  await t.test('a lost claim mid-copy stays reserved and another conductor cleans the abandoned attempt', async () => {
    const p = await fixture(); await append(p); await conductor.drain();
    duringCopy = () => asTransition(pool, `UPDATE wf_work SET claim_id = $3, lease_until = NOW() - interval '1 second'
      WHERE machine = $1 AND key = $2 AND status = 'running'`, [MACHINE, copyKey(p.sessionId), randomUUID()]);
    await service(); assert.equal((await state(p)).state, 'copying');
    await assert.rejects(assertNotCopying(pool, p.sessionId), /still being copied/);
    const fresh = createRuntime({ pool, machines: [workerMemoryCopy()], services, slots: 1 });
    try {
      await settle(fresh); await settle(fresh);
      assert.equal((await state(p)).state, 'done'); assert.equal((await row(p.sessionId)).cc_session_id, null);
      assert.deepEqual(calls.map(c => c[0]), ['copy', 'cleanup']);
    } finally { await fresh.stop(); }
  });
  await t.test('old conductors and expired work fail to fresh memory without privileged web fallback', async () => {
    const p = await fixture();
    const unavailable = { appendAndWait: async () => ({ status: 'pending', eventId: 1 }), refuseIfPending: async () => ({ status: 'rejected' }) };
    assert.deepEqual(await requestWorkerMemoryCopy(unavailable, p), { copied: false }); assert.deepEqual(calls, []);
    await append(p); await conductor.drain();
    await asTransition(pool, `UPDATE wf_work SET input = jsonb_set(input, '{target,expiresAt}', '0'::jsonb) WHERE machine = $1 AND key = $2`, [MACHINE, copyKey(p.sessionId)]);
    await settle(); assert.equal((await state(p)).data.result.copied, false); assert.equal(calls.some(c => c[0] === 'copy'), false);
    await assert.rejects(services[WORK].run({ input: {}, signal: new AbortController().signal }), /requires a workflow process/);
  });
});
