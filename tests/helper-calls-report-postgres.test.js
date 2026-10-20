'use strict';

// The helper calls per helper (llm-telemetry.js helperCallsReport, Admin →
// Homeroom bot → Calls), against PostgreSQL: one logical call per
// correlation id, a Haiku attempt 2 counted as a fallback, a late first
// attempt as late, and a switch of the helper model as a row of its own.
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const llmTelemetry = require('../src/services/llm-telemetry');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('helper calls: per helper and first model, with fallbacks, lateness, times and cost', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `helper_calls_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 2 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(`CREATE TABLE events (
    id SERIAL PRIMARY KEY, user_id INTEGER, app_id INTEGER, session_id INTEGER,
    event_type TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const add = (meta, ago = '1 hour') => pool.query(
    `INSERT INTO events (event_type, metadata, created_at) VALUES ($1, $2::jsonb, NOW() - $3::interval)`,
    [meta.type || 'llm_invocation', JSON.stringify(meta), ago],
  );
  const GLM = 'z-ai/glm-5.3-flash';
  const DS = 'deepseek/deepseek-v4.1-flash-1017';
  const HAIKU = 'claude-haiku-5-5';
  // Quick replies on GLM: one answered, one late then Haiku.
  await add({ component: 'quick_replies', correlation_id: 'q1', attempt_number: 1, requested_model: GLM, outcome: 'success', duration_ms: 800, cost_usd: 0.0001 });
  await add({ component: 'quick_replies', correlation_id: 'q2', attempt_number: 1, requested_model: GLM, outcome: 'error', error_class: 'timeout', duration_ms: 2500 });
  await add({ component: 'quick_replies', correlation_id: 'q2', attempt_number: 2, requested_model: HAIKU, outcome: 'success', duration_ms: 900, cost_usd: 0.0004 });
  // Then on 1017 after the switch: two answered.
  await add({ component: 'quick_replies', correlation_id: 'q3', attempt_number: 1, requested_model: DS, outcome: 'success', duration_ms: 500, cost_usd: 0.0001 });
  await add({ component: 'quick_replies', correlation_id: 'q4', attempt_number: 1, requested_model: DS, outcome: 'success', duration_ms: 700, cost_usd: 0.0001 });
  // A plan with no key: Haiku is attempt 1, and a call that nothing answered.
  await add({ component: 'first_version_plan', correlation_id: 'p1', attempt_number: 1, requested_model: HAIKU, outcome: 'success', duration_ms: 4000, cost_usd: 0.002 });
  await add({ component: 'first_version_plan', correlation_id: 'p2', attempt_number: 1, requested_model: HAIKU, outcome: 'error', duration_ms: 3000 });
  // Not counted: too old, another component, another event type.
  await add({ component: 'quick_replies', correlation_id: 'old', attempt_number: 1, requested_model: GLM, outcome: 'success', duration_ms: 100 }, '20 days');
  await add({ component: 'homeroom_bot_build', correlation_id: 'b1', attempt_number: 1, requested_model: DS, outcome: 'success', duration_ms: 100 });
  await add({ type: 'other', component: 'quick_replies', correlation_id: 'x1', attempt_number: 1, outcome: 'success' });

  const out = await llmTelemetry.helperCallsReport(pool, { days: 7 });
  assert.equal(out.days, 7);
  assert.deepEqual(out.helpers.map((h) => h.component), ['quick_replies', 'first_version_plan']);
  const qr = out.helpers[0];
  assert.equal(qr.calls, 4, 'one call per correlation id, attempts folded in');
  const glm = qr.models.find((m) => m.model === GLM);
  const ds = qr.models.find((m) => m.model === DS);
  assert.equal(glm.calls, 2);
  assert.equal(glm.firstOkRate, 0.5);
  assert.equal(glm.lateRate, 0.5);
  assert.equal(glm.fallbackRate, 0.5, 'Haiku answered one of the two');
  assert.equal(glm.unanswered, 0);
  assert.deepEqual(glm.totalMs, { p50: 2100, p90: 3140 }, 'a fallen-back call waits for both attempts');
  assert.equal(glm.firstMs.p50, 1650);
  assert.ok(Math.abs(glm.costUsd - 0.0005) < 1e-12);
  assert.equal(ds.calls, 2);
  assert.equal(ds.fallbackRate, 0);
  assert.equal(ds.firstOkRate, 1);
  const plan = out.helpers[1];
  assert.equal(plan.models[0].model, HAIKU, 'with no bot key, Haiku is the first attempt');
  assert.equal(plan.models[0].unanswered, 1);
  assert.equal(plan.models[0].fallbackRate, 0);
  assert.equal(out.totals.calls, 6);
  assert.deepEqual((await llmTelemetry.helperCallsReport(pool, { days: 999 })).days, llmTelemetry.MAX_REPORT_DAYS);

  // Staging's made-up calls (migrate.js seedStagingHelperCalls), seeded once
  // however often a preview boots, and only on staging.
  await pool.query("CREATE UNIQUE INDEX idx_events_llm_invocation_key ON events ((metadata->>'invocation_key')) WHERE event_type = 'llm_invocation'");
  await pool.query('DELETE FROM events');
  const { seedStagingHelperCalls } = require('../src/db/migrate');
  const before = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'production';
    await seedStagingHelperCalls(pool);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM events')).rows[0].n, 0, 'never outside staging');
    process.env.USERNODE_ENV = 'staging';
    await seedStagingHelperCalls(pool);
    await seedStagingHelperCalls(pool);
  } finally {
    if (before === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = before;
  }
  const seeded = await llmTelemetry.helperCallsReport(pool, { days: 7 });
  const quick = seeded.helpers.find((h) => h.component === 'quick_replies');
  assert.equal(quick.calls, 5, 'its rows once, the Haiku fallback folded into its call');
  assert.equal(quick.models.find((m) => m.model === GLM).fallbackRate, 0.5);
  assert.ok(seeded.helpers.some((h) => h.component === 'first_version_plan'));
});
