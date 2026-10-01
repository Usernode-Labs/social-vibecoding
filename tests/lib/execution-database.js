'use strict';

const fs = require('node:fs');
const { Pool } = require('pg');

async function createExecutionDatabase(databaseUrl) {
  const root = new Pool({ connectionString: databaseUrl });
  const schema = `execution_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: scoped.toString() });
  await pool.query(`CREATE TABLE apps (id INTEGER PRIMARY KEY, slug TEXT, repo_url TEXT);
    INSERT INTO apps VALUES (1, 'demo', 'https://github.com/example/demo');
    CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, app_id INTEGER DEFAULT 1,
      source TEXT DEFAULT 'cli_handoff', status TEXT DEFAULT 'active', branch_name TEXT DEFAULT 'proposal',
      pr_number INTEGER DEFAULT 7, checks_commit_sha TEXT, reviewed_head_sha TEXT, approval_epoch INTEGER DEFAULT 0,
      staging_url TEXT DEFAULT 'https://serving.test', staging_container_id TEXT DEFAULT 'serving',
      staging_runtime_kind TEXT DEFAULT 'docker', staging_runtime_name TEXT DEFAULT 'serving',
      staging_image_ref TEXT DEFAULT 'serving:image', staging_build_ref TEXT, staging_commit_sha TEXT,
      last_activity_at TIMESTAMPTZ, check_state TEXT, test_results JSONB, checks_checked_at TIMESTAMPTZ,
      check_phase TEXT, checks_progress JSONB, check_error_detail TEXT, consecutive_check_failures INTEGER DEFAULT 0,
      first_check_failure_at TIMESTAMPTZ, last_check_failure_at TIMESTAMPTZ, check_next_retry_at TIMESTAMPTZ,
      check_error_notified_at TIMESTAMPTZ)`);
  const source = fs.readFileSync(require.resolve('../../src/db/schema.sql'), 'utf8');
  for (const table of ['preview_flows', 'preview_bindings', 'preview_flow_heads', 'preview_flow_resources',
    'preview_action_receipts', 'preview_flow_decisions', 'execution_work_requests', 'execution_work_attempts',
    'execution_work_events']) {
    await pool.query(source.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\n\);`))[0]);
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

module.exports = { createExecutionDatabase };
