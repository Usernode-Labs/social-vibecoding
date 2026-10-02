'use strict';

// #3654: the Benchmark area's staging fixtures against the FULL PostgreSQL
// schema: seeded only on staging, once, and complete enough that the results
// screen has something in every part (rows for each stage and model, a
// paired difference, a Pareto frontier, slices, judge agreement, items
// waiting for the judge) and the CSV has every trial. Also the declared
// check that looks at it.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const demo = require('../src/services/bench/demo');
const report = require('../src/services/bench/report');
const grading = require('../src/services/bench/grading');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the benchmark\'s staging fixtures against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_demo_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const realEnv = process.env.USERNODE_ENV;
  t.after(async () => {
    if (realEnv === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = realEnv;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query("INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo'), ('Notes', 'notes', 'running', 'https://github.com/o/notes')");

  delete process.env.USERNODE_ENV;
  assert.equal(await demo.seedStagingBench(pool), false, 'nothing outside staging');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM bench_suites')).rows[0].n, 0);

  process.env.USERNODE_ENV = 'staging';
  assert.equal(await demo.seedStagingBench(pool), true);
  assert.equal(await demo.seedStagingBench(pool), false, 'idempotent');
  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM bench_suites) AS suites, (SELECT COUNT(*)::int FROM bench_tasks) AS tasks,
            (SELECT COUNT(*)::int FROM bench_trials) AS trials, (SELECT COUNT(*)::int FROM bench_grades) AS grades`,
  );
  assert.deepEqual({ suites: counts.suites, tasks: counts.tasks }, { suites: 1, tasks: 9 });
  assert.equal(counts.trials, 6 * 4 * 3 + 2 * 4 + 1 * 4 * 3);
  assert.ok(counts.grades > 10);

  const r = await report.runReport(pool, demo.RUN_ID);
  assert.equal(r.run.suiteName, 'Staging demo core');
  assert.deepEqual([...new Set(r.rows.map((x) => x.stage))].sort(), ['build', 'dm', 'triage']);
  const kimiTriage = r.rows.find((x) => x.stage === 'triage' && x.model === 'moonshotai/kimi-k2.7-code');
  assert.equal(kimiTriage.notApplicable, 18, 'Kimi is not applicable to triage, not failed');
  assert.equal(kimiTriage.accuracy, null);
  const glm = r.rows.find((x) => x.stage === 'triage' && x.model === 'z-ai/glm-5.3-flash');
  assert.ok(glm.baseline && glm.graded > 0 && glm.passK.k === 3);
  assert.ok(r.paired.some((p) => p.stage === 'triage' && p.n > 0 && p.low != null));
  assert.ok(r.pareto.some((p) => p.stage === 'triage' && p.frontier));
  assert.ok(r.slice.groups.length > 0);
  const agreement = await grading.agreement(pool, { runId: demo.RUN_ID });
  assert.ok(agreement.n > 0, 'some trials a person also graded');
  const queue = await grading.queue(pool, { kind: 'grade' });
  assert.ok(queue.total > 0, 'a few items wait for the judge');
  const rows = await report.csvRows(pool, demo.RUN_ID);
  assert.equal(rows.length, counts.trials);
  assert.equal(rows[0].length, report.CSV_COLUMNS.length);

  const dapp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const check = dapp.tests.find((c) => c.path === '/#admin/homeroom-bot/benchmark');
  assert.ok(check, 'a declared check looks at the Benchmark area');
  assert.match(check.expectSelector, /#admin-homeroom-bench-results-table/);
  assert.equal(check.expectText, 'Staging demo core v1');
});
