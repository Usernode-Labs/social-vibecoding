'use strict';

// Exercise the actual import transaction's SQL with PostgreSQL. A recording
// client cannot catch parameter-type errors or a plan that is lost between
// the proposal row and the evidence run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const state = require('../src/services/visual-evidence-state');
const contract = require('../src/services/visual-evidence-plan');
const fixtures = require('./fixtures/visual-evidence');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://usernode:localdev@127.0.0.1:5440/usernode';

test('author plan and proposal pointer commit together on real PostgreSQL', async (t) => {
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
  } catch (error) {
    t.skip(`PostgreSQL unavailable: ${error.code || error.message}`);
    return;
  }
  const schema = `visual_evidence_import_${process.pid}_${Date.now()}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY, visual_evidence_state VARCHAR(24),
      visual_evidence_run_id VARCHAR(32), visual_evidence_detail JSONB,
      visual_evidence_updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE visual_evidence_runs (
      id VARCHAR(32) PRIMARY KEY, session_id INTEGER NOT NULL,
      base_sha VARCHAR(40) NOT NULL, head_sha VARCHAR(40) NOT NULL,
      plan_version INTEGER NOT NULL, intent JSONB NOT NULL,
      author_plan JSONB, state VARCHAR(24) NOT NULL,
      trigger VARCHAR(32), failure_code VARCHAR(48), failure_reason TEXT,
      completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query('INSERT INTO chat_sessions (id) VALUES (42)');
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    await state.recordIntentInTransaction(client, 42, fixtures.intent(), { headSha });
    const created = await state.createRunInTransaction(client, {
      sessionId: 42, baseSha, headSha, intent: fixtures.intent(),
      authorPlan: fixtures.plan(), trigger: 'import-author-plan',
    });
    const result = await client.query(
      `SELECT cs.visual_evidence_run_id, cs.visual_evidence_detail,
              r.author_plan, r.base_sha, r.head_sha
         FROM chat_sessions cs JOIN visual_evidence_runs r
           ON r.id = cs.visual_evidence_run_id WHERE cs.id = 42`
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].visual_evidence_run_id, created.run.id);
    assert.equal(result.rows[0].base_sha, baseSha);
    assert.equal(result.rows[0].head_sha, headSha);
    assert.deepEqual(result.rows[0].author_plan, contract.parseReplayPlan(fixtures.plan()));
    assert.equal(Object.hasOwn(result.rows[0].visual_evidence_detail, 'authorPlan'), false);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
