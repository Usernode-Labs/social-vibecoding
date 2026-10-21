'use strict';

// What roadmap item 3.2 drops, against a database that still has it: the
// schema, applied over a deployment that kept the old names and leases,
// leaves none of them, and keeps what the release before it still reads
// while it drains (process_holds, shots_eval_trials.proxy_cents,
// apps.creating_owner / creating_heartbeat_at, starter_images.owner /
// heartbeat_at, local_agent_turns.waiter_seen_at).
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/rollout-remnants-schema-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');

test('the schema drops the rollout-only remnants of a deployment that has them, and keeps what the previous release reads', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `remnants_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 2 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(SCHEMA);
  // A deployment as the release before this one left it.
  await pool.query(`
    CREATE TABLE leader_sweeps (name TEXT PRIMARY KEY, last_run_at TIMESTAMPTZ NOT NULL);
    CREATE VIEW visual_evidence_runs AS SELECT * FROM shot_runs;
    CREATE VIEW visual_evidence_artifacts AS SELECT * FROM shot_artifacts;
    CREATE VIEW visual_evidence_diagnostic_artifacts AS SELECT * FROM shot_diagnostic_artifacts;
    ALTER TABLE chat_sessions ADD COLUMN visual_evidence_state VARCHAR(24), ADD COLUMN visual_evidence_run_id VARCHAR(32),
      ADD COLUMN visual_evidence_detail JSONB, ADD COLUMN visual_evidence_updated_at TIMESTAMPTZ;
    CREATE FUNCTION chat_sessions_shots_legacy_sync() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER chat_sessions_shots_legacy_sync BEFORE INSERT OR UPDATE ON chat_sessions
      FOR EACH ROW EXECUTE FUNCTION chat_sessions_shots_legacy_sync();
    ALTER TABLE apps ADD COLUMN creating_redrives INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE maintenance_campaigns ADD COLUMN runner_id TEXT, ADD COLUMN lease_until TIMESTAMPTZ;
    ALTER TABLE maintenance_campaign_apps ADD COLUMN runner_id TEXT;
    DROP TRIGGER maintenance_campaigns_wf_owned ON maintenance_campaigns;
    CREATE TRIGGER maintenance_campaigns_wf_owned BEFORE UPDATE ON maintenance_campaigns FOR EACH ROW
      EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=campaign/campaign:', 'status', 'completed_at', 'runner_id', 'lease_until');
    DROP TRIGGER maintenance_campaign_apps_wf_owned ON maintenance_campaign_apps;
    CREATE TRIGGER maintenance_campaign_apps_wf_owned BEFORE UPDATE ON maintenance_campaign_apps FOR EACH ROW
      WHEN (wf_holds('campaign', 'campaign:' || OLD.campaign_id)) EXECUTE FUNCTION wf_guard_owned_columns('state', 'error', 'runner_id');
    ALTER TABLE apps ALTER COLUMN creating_owner DROP DEFAULT;
  `);
  await pool.query(SCHEMA);

  const { rows: [gone] } = await pool.query(`
    SELECT to_regclass('leader_sweeps') AS sweeps, to_regclass('visual_evidence_runs') AS runs,
           to_regclass('visual_evidence_artifacts') AS artifacts, to_regclass('visual_evidence_diagnostic_artifacts') AS diagnostics,
           (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'chat_sessions_shots_legacy_sync') AS triggers,
           (SELECT count(*)::int FROM pg_proc WHERE proname = 'chat_sessions_shots_legacy_sync') AS functions`);
  assert.deepEqual(gone, { sweeps: null, runs: null, artifacts: null, diagnostics: null, triggers: 0, functions: 0 });
  const columns = async (table) => (await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map((r) => r.column_name);
  const sessions = await columns('chat_sessions');
  assert.deepEqual(sessions.filter((c) => c.startsWith('visual_evidence_')), []);
  assert.ok(sessions.includes('shots_state'), 'the renamed columns stay');
  const apps = await columns('apps');
  assert.equal(apps.includes('creating_redrives'), false);
  assert.ok(apps.includes('creating_owner') && apps.includes('creating_heartbeat_at'), 'the previous release still reads these');
  assert.deepEqual((await columns('maintenance_campaigns')).filter((c) => ['runner_id', 'lease_until'].includes(c)), []);
  assert.equal((await columns('maintenance_campaign_apps')).includes('runner_id'), false);
  // The guard triggers name only the columns that are there.
  const { rows: guards } = await pool.query(
    `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname IN ('maintenance_campaigns_wf_owned', 'maintenance_campaign_apps_wf_owned')`);
  assert.equal(guards.length, 2);
  for (const g of guards) assert.doesNotMatch(g.def, /runner_id|lease_until/);

  // What the release before this one reads as it drains stays.
  assert.notEqual((await pool.query(`SELECT to_regclass('process_holds') AS t`)).rows[0].t, null);
  assert.ok((await columns('shots_eval_trials')).includes('proxy_cents'));
  assert.ok((await columns('starter_images')).includes('owner'));
  assert.ok((await columns('local_agent_turns')).includes('waiter_seen_at'));

  // A row inserted with no owner is the workflow's by default: the previous
  // release's trigger, which a rollback applies again, starts only those.
  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('maker', 'x') RETURNING id`);
  const { rows: [plain] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status) VALUES ('q', 'q', $1, 'running') RETURNING creating_owner`, [u.id]);
  assert.equal(plain.creating_owner, 'workflow');
  // A project's insert starts its making whatever its owner columns say.
  const { rows: [a] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, creating_owner) VALUES ('p', 'p', $1, 'creating', 'old-token') RETURNING id`, [u.id]);
  const { rows: events } = await pool.query(`SELECT type FROM wf_events WHERE machine = 'app-creation' AND key = $1`, [`app:${a.id}`]);
  assert.deepEqual(events.map((e) => e.type), ['Started']);
});
