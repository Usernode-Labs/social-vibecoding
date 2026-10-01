'use strict';

const fs = require('node:fs');
const { Pool } = require('pg');

async function createDatabase(databaseUrl) {
  const root = new Pool({ connectionString: databaseUrl });
  const schema = `c0_${process.pid}_${Date.now()}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: scoped.toString() });

  await pool.query(`CREATE TABLE apps (id INTEGER PRIMARY KEY, slug TEXT);
    INSERT INTO apps VALUES (1, 'c0');
    CREATE TABLE pending_secret_declarations (session_id INTEGER, status TEXT);
    CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, user_id INTEGER DEFAULT 1,
      app_id INTEGER DEFAULT 1, status TEXT DEFAULT 'promoted', source TEXT DEFAULT 'cli_handoff',
      is_headless BOOLEAN DEFAULT FALSE, active_turn JSONB, approval_epoch INTEGER DEFAULT 0,
      stale_notified_at TIMESTAMPTZ, integration_block_reasons JSONB DEFAULT '[]',
      pr_number INTEGER, pr_title TEXT, checks_commit_sha TEXT, reviewed_head_sha TEXT,
      staging_url TEXT, staging_container_id TEXT, staging_runtime_kind TEXT,
      staging_runtime_name TEXT, staging_image_ref TEXT, staging_build_ref TEXT,
      staging_commit_sha TEXT, last_activity_at TIMESTAMPTZ, check_state TEXT,
      test_results JSONB, checks_checked_at TIMESTAMPTZ, check_phase TEXT,
      checks_progress JSONB, check_error_detail TEXT, consecutive_check_failures INTEGER DEFAULT 0,
      first_check_failure_at TIMESTAMPTZ, last_check_failure_at TIMESTAMPTZ,
      check_next_retry_at TIMESTAMPTZ, check_error_notified_at TIMESTAMPTZ);
    CREATE SEQUENCE c0_position;
    CREATE TABLE c0_work (id UUID PRIMARY KEY, input JSONB NOT NULL, backend TEXT NOT NULL,
      version INTEGER NOT NULL, stage TEXT DEFAULT 'reserve', done BOOLEAN DEFAULT FALSE,
      dispatched BOOLEAN DEFAULT FALSE, next_at TIMESTAMPTZ DEFAULT NOW(), token UUID,
      lease_until TIMESTAMPTZ, attempts INTEGER DEFAULT 0,
      position BIGINT DEFAULT nextval('c0_position'), last_error TEXT);
    CREATE TABLE c0_objects (name TEXT PRIMARY KEY, flow_id UUID NOT NULL, kind TEXT NOT NULL,
      uid UUID NOT NULL, body JSONB NOT NULL);
    CREATE TABLE c0_events (id BIGSERIAL PRIMARY KEY, work_id UUID, kind TEXT, detail JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE c0_faults (work_id UUID PRIMARY KEY, policy JSONB NOT NULL)`);

  const source = fs.readFileSync(require.resolve('../../src/db/schema.sql'), 'utf8');
  for (const table of ['preview_flows', 'preview_bindings', 'preview_flow_heads', 'preview_flow_resources',
    'preview_action_receipts', 'preview_flow_decisions', 'proposal_review_receipts', 'proposal_review_decisions']) {
    const definition = source.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\n\);`));
    await pool.query(definition[0]);
  }

  return {
    pool,
    url: scoped.toString(),
    async close() {
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    },
  };
}

async function event(pool, workId, kind, detail = {}) {
  await pool.query('INSERT INTO c0_events (work_id, kind, detail) VALUES ($1, $2, $3)',
    [workId, kind, JSON.stringify(detail)]);
}

module.exports = { createDatabase, event };
