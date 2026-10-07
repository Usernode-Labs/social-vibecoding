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

  // #3737's taste fixture: a run page shows its arms side by side, app by
  // app, from the console's report (never the connector's aggregates).
  assert.equal(await demo.seedStagingTaste(pool), true);
  const taste = await report.runReport(pool, demo.TASTE_RUN_ID);
  assert.deepEqual(taste.tasteTrials.map((x) => [x.stage, x.appName, x.status, x.booted]).sort(),
    [['capture', 'Staging demo bakery', 'ok', true], ['first_version', 'Staging demo bakery', 'ok', true]]);
  for (const x of taste.tasteTrials) {
    assert.ok(x.shots.length > 0 && x.shots.length <= 8, 'the screenshots the judge was shown');
    assert.ok(x.shots.every((sh) => /^[0-9a-f]{32}$/.test(sh.artifactId) && sh.caption));
    assert.equal(x.criteria.of, 12);
  }
  assert.equal(taste.tasteTrials.find((x) => x.stage === 'first_version').criteria.held, 9);
  assert.equal(taste.tasteTrials.find((x) => x.stage === 'capture').criteria.held, 3);
  assert.deepEqual(report.tasteTrials([]), []);
  assert.deepEqual((await report.runReport(pool, demo.RUN_ID)).tasteTrials, [], 'a run with no taste stage lists none');
  const aggregates = await report.runAggregates(pool, demo.TASTE_RUN_ID);
  assert.equal(aggregates.tasteTrials, undefined, 'the connector\'s view names no trial');
  assert.doesNotMatch(JSON.stringify(aggregates), /artifactId|Staging demo bakery/);

  // The declared check: the area opens on its Overview, which reads both
  // fixtures (the default suite's answer, and the taste suite's scores).
  const dapp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  // The App bench studio's fixture: two starter briefs, each with three
  // builds side by side (no pack, the demo pack, a reference), graded, with
  // screenshots, and no branch a preview could point at.
  const studio = require('../src/services/bench/studio');
  assert.equal(await demo.seedStagingStudio(pool), true);
  assert.equal(await demo.seedStagingStudio(pool), false, 'idempotent');
  const g = await studio.gallery(pool, {});
  assert.deepEqual(g.briefs.map((b) => b.ref).sort(), ['bread', 'tier-list']);
  for (const b of g.briefs) {
    assert.deepEqual(b.builds.map((x) => x.armLabel).sort(), ['reference ref-v1 + Staging demo theme v1', 'today', 'today + Staging demo theme v1']);
    assert.ok(b.builds.every((x) => x.shots.length > 0 && x.code === null && x.criteria.of === 12));
  }
  const studioRuns = await studio.listStudioRuns(pool);
  assert.deepEqual(studioRuns.map((x) => [x.id, x.counts.ok]), [[demo.STUDIO_RUN_ID, 6]]);
  assert.ok(demo.STUDIO_RUN_ID < demo.TASTE_RUN_ID && demo.TASTE_RUN_ID < demo.RUN_ID, 'the console still opens on the core demo');
  const studioCheck = dapp.tests.find((c) => c.path === '/#admin/homeroom-bot/benchmark/studio');
  assert.match(studioCheck.expectSelector, /\[data-studio-brief="bread"\]/);
  assert.equal(studioCheck.expectText, 'Bread Bot');

  // The Studio place has a check of its own, which reads no fixture.
  const checks = dapp.tests.filter((c) => c.path.startsWith('/#admin/homeroom-bot/benchmark') && !c.path.endsWith('/studio'));
  assert.equal(checks.length, 1, 'one declared check, as before the area had places of its own');
  const [check] = checks;
  assert.equal(check.path, '/#admin/homeroom-bot/benchmark', 'the Overview');
  assert.match(check.expectSelector, /#admin-homeroom-bench-best-table \[data-bench-stage-row="triage"\]$/);
  assert.match(check.expectSelector, /\/runs\/936551/, `the latest fixture run, ${demo.RUN_ID}`);
  assert.equal(demo.RUN_ID, 936551);
  assert.match(check.expectSelector, /data-bench-taste-score="capture"/);
  assert.ok(check.expectSelector.length <= 256);
  assert.equal(check.expectText, 'Staging demo core v1');
});
