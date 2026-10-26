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
