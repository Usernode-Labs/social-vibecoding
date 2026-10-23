'use strict';

// Events an older build refused as unknown (platform.ts reaskRefused, the
// reask-refused clock), against the full schema and the platform's runtime:
// during a rollout an older workflow process refuses an event type its
// machine gained in the newer build, and what it owed would be lost. Once no
// older build serves, each one this build's machine knows is asked again,
// as it was, once; a type no machine knows, and a refusal for any other
// reason, are left as they are.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-reask-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const NEW = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

test('an event an older build refused as unknown is asked again once no older build serves', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_reask_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const sha = process.env.GIT_SHA;
  process.env.GIT_SHA = NEW;
  const platform = require('../src/workflow/platform.ts');
  t.after(async () => {
    if (sha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = sha;
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  // What an older build left: a refusal, written as the kernel writes it.
  const refused = async (type, reason, payload, tag = '') => (await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
    INSERT INTO wf_events (machine, key, type, payload, source, actor, request_key, status, result, reason, machine_version, processed_at)
    VALUES ('clock', 'clock:reask-me', '${type}', '${JSON.stringify(payload)}'::jsonb, '{"kind":"system","name":"release"}'::jsonb,
            'release', 'arm:r0:${type}:${reason}${tag}', 'processed', 'rejected', '${reason}', 1, now());
    COMMIT`), (await pool.query(`SELECT id FROM wf_events WHERE request_key = 'arm:r0:${type}:${reason}${tag}'`)).rows[0].id);
  const arm = { job: 'reask-me', everyMs: 3600000, firstDueAt: null };
  const known = await refused('Arm', 'unknown_event', arm);
  await refused('Bogus', 'unknown_event', {});
  // This build's rollout began half an hour ago; a refusal from two hours
  // ago was another rollout's.
  const stale = await refused('Arm', 'unknown_event', { ...arm, job: 'reask-old' }, ':old');
  await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
    UPDATE wf_events SET processed_at = now() - interval '2 hours' WHERE id = ${stale};
    INSERT INTO wf_instances (machine, key, state, machine_version, created_at)
    VALUES ('release', 'release:${NEW}', 'adopted', 1, now() - interval '30 minutes')
    ON CONFLICT (machine, key) DO UPDATE SET created_at = EXCLUDED.created_at;
    COMMIT`);
  await refused('Arm', 'system_only', arm);

  // An older build still serves: nothing yet, or it would refuse it again.
  await pool.query(`INSERT INTO platform_processes (id, release, role, state) VALUES ('old-conductor', $1, 'conductor', 'serving')`, [OLD]);
  assert.deepEqual(await platform.reaskRefused(pool), { waiting: 'older_build', asked: 0 });
  // An admin's fleet job is not asked for meanwhile: the older conductor
  // would take the ask without knowing who asked, and its run do nothing.
  assert.equal(await platform.askClockRun('container-rollover', { id: 1, username: 'ada' }), 'rollout');

  await pool.query(`DELETE FROM platform_processes WHERE id = 'old-conductor'`);
  assert.deepEqual(await platform.reaskRefused(pool), { asked: 1 });
  const { rows: again } = await pool.query(
    `SELECT type, payload, source, actor, caused_by FROM wf_events WHERE request_key = $1`, [`reask:${known}`]);
  assert.deepEqual(again, [{ type: 'Arm', payload: arm, source: { kind: 'system', name: 'release' }, actor: 'release', caused_by: known }],
    'asked as it was, caused by the refusal');
  assert.deepEqual(await platform.reaskRefused(pool), { asked: 0 }, 'once');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM wf_events WHERE request_key = $1`, [`reask:${stale}`])).rows[0].n, 0,
    'not one from before this rollout');

  // The runtime's pipeline takes it this time: the clock is armed.
  const deadline = Date.now() + 10000;
  for (;;) {
    const { rows: [i] } = await pool.query(`SELECT state FROM wf_instances WHERE machine = 'clock' AND key = 'clock:reask-me'`);
    if (i) { assert.equal(i.state, 'waiting'); break; }
    assert.ok(Date.now() < deadline, 'the asked-again event was taken');
    await new Promise((r) => setTimeout(r, 50));
  }
});
