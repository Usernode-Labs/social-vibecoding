'use strict';

// #3654: staging fixtures for the Homeroom bot console's Benchmark area.
//
// The benchmark's tables are all `staging:private`, so a staging copy of the
// database arrives with none of them, and the Benchmark area would show an
// empty suite list and no results in every preview. This seeds ONE obviously
// fake suite, run and set of trials, named "Staging demo", so a reviewer
// sees every part of the screen: a frozen suite with tasks at three stages,
// a finished run on four models (one of them not applicable to triage), the
// results table with pass^3, costs and a paired difference against the
// baseline, a Pareto frontier, judge grades with one person's override, and
// a few items still waiting for the judge.
//
// Staging only (USERNODE_ENV), idempotent (fixed ids in a block of their
// own, 936540 to 936599 for suites, tasks, snapshots and runs, and
// 9365000 up for trials and grades), and it writes nothing a production
// database could ever see. It needs one running app to hang its tasks on.

const crypto = require('crypto');
const log = require('../logger');

const SUITE_ID = 936541;
const RUN_ID = 936551;
const SNAPSHOT_BASE = 936560;
const TASK_BASE = 936570;
const TRIAL_BASE = 9365000;
const GRADE_BASE = 9366000;

const MODELS = Object.freeze([
  { id: 'z-ai/glm-5.3-flash', quality: 0.62, triage: 0.012, build: 0.31, dm: 0.03, ms: 95_000 },
  { id: 'qwen/qwen3.8-flash', quality: 0.7, triage: 0.019, build: 0.44, dm: 0.04, ms: 110_000 },
  { id: 'anthropic/claude-sonnet-5.5', quality: 0.9, triage: 0.24, build: 3.1, dm: 0.5, ms: 140_000 },
  { id: 'moonshotai/kimi-k2.7-code', quality: 0.66, triage: null, build: 0.82, dm: null, ms: 160_000 },
]);

const TRIAGE = Object.freeze([
  { title: 'Staging demo: the save button does nothing on mobile', verdict: 'ready', type: 'bug' },
  { title: 'Staging demo: add a dark theme', verdict: 'question', type: 'feature' },
  { title: 'Staging demo: charge members a monthly fee', verdict: 'person', type: 'feature' },
  { title: 'Staging demo: asdf', verdict: 'empty', type: 'feature' },
  { title: 'Staging demo: sort recipes by rating', verdict: 'ready', type: 'feature' },
  { title: 'Staging demo: the feed is broken after login', verdict: 'question', type: 'bug' },
]);

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OTHER = Object.freeze({ ready: 'question', question: 'ready', person: 'ready', empty: 'question' });

async function seedStagingBench(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return false;
  try {
    const { rows: done } = await pool.query('SELECT 1 FROM bench_suites WHERE id = $1', [SUITE_ID]);
    if (done.length) return false;
    const { rows: apps } = await pool.query(
      "SELECT id, slug, repo_url FROM apps WHERE status = 'running' ORDER BY id LIMIT 2",
    );
    if (!apps.length) {
      log.warn('db', 'Benchmark staging fixtures skipped: no running app');
      return false;
    }
    const snapshots = require('../homeroom-bot-snapshots');
    const graders = require('./graders');
    const rand = prng(3654);
    const token = () => crypto.randomBytes(12).toString('base64url');

    await pool.query(
      `INSERT INTO bench_suites (id, name, version, kind, notes, created_at, frozen_at)
       VALUES ($1, 'Staging demo core', 1, 'frozen', 'Staging demo: fixture tasks, not real requests.', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days')
       ON CONFLICT (id) DO NOTHING`,
      [SUITE_ID],
    );

    // Tasks: six triage, two builds, one DM conversation.
    const tasks = [];
    const addTask = async (i, stage, title, reference, tags, app) => {
      const seed = `Please work on GitHub issue #${900 + i}: "${title}".\n\nStaging demo request body.`;
      const blobs = {
        seed: await snapshots.storeBlob(pool, seed),
        thread: await snapshots.storeBlob(pool, JSON.stringify({
          issueNumber: 900 + i, issue: { number: 900 + i, title, body: 'Staging demo request body.', author: 'staging-demo' },
          comments: [], threadMessages: [], botLogin: 'usernode-bot',
        })),
      };
      await pool.query(
        `INSERT INTO homeroom_bot_run_snapshots (id, run_id, stage, app_id, issue_number, base_sha, texts, extra, source)
         VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, 'import')
         ON CONFLICT (id) DO NOTHING`,
        [SNAPSHOT_BASE + i, stage === 'dm' ? 'triage' : stage, app.id, 900 + i, 'd'.repeat(40), JSON.stringify(blobs)],
      );
      await pool.query(
        `INSERT INTO bench_tasks (id, suite_id, stage, snapshot_id, app_id, issue_number, tags, reference, reference_source, label_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [TASK_BASE + i, SUITE_ID, stage, SNAPSHOT_BASE + i, app.id, 900 + i, JSON.stringify(tags),
          JSON.stringify(reference), reference.verdict || reference.reference_pr ? (reference.reference_pr ? 'merged_pr' : 'opus') : null, token()],
      );
      tasks.push({ id: TASK_BASE + i, stage, reference, app });
    };
    for (let i = 0; i < TRIAGE.length; i += 1) {
      const t = TRIAGE[i];
      const app = apps[i % apps.length];
      // eslint-disable-next-line no-await-in-loop
      await addTask(i, 'triage', t.title, { verdict: t.verdict }, {
        verdict: t.verdict, app_slug: app.slug, repo_size: i % 3 === 0 ? 'large' : 'small', request_type: t.type, difficulty: i % 2 ? 'medium' : 'easy',
      }, app);
    }
    await addTask(6, 'build', 'Staging demo: show a spinner while saving', { reference_pr: 3630, hidden_checks: [{ name: 'Staging demo spinner', path: '/' }] },
      { verdict: 'ready', app_slug: apps[0].slug, repo_size: 'large', request_type: 'feature', known_outcome: 'merged' }, apps[0]);
    await addTask(7, 'build', 'Staging demo: fix the empty state copy', { reference_pr: 3631 },
      { verdict: 'ready', app_slug: apps[apps.length - 1].slug, repo_size: 'small', request_type: 'bug', known_outcome: 'merged' }, apps[apps.length - 1]);
    await addTask(8, 'dm', 'Staging demo: change the header colour', { verdict: 'ready', dm_script: { true_answer: 'Dark blue', max_turns: 3 } },
      { verdict: 'question', app_slug: apps[0].slug, repo_size: 'small', request_type: 'feature' }, apps[0]);

    await pool.query(
      `INSERT INTO bench_runs (id, suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, spent_usd,
                               note, created_at, started_at, finished_at)
       VALUES ($1, $2, $3::text[], 'z-ai/glm-5.3-flash', ARRAY['triage','build','dm'], 3, 50, 1, 'done', 0,
               'Staging demo run: fixture trials, not real results.', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       ON CONFLICT (id) DO NOTHING`,
      [RUN_ID, SUITE_ID, MODELS.map((m) => m.id)],
    );

    let trialId = TRIAL_BASE;
    let gradeId = GRADE_BASE;
    let spent = 0;
    let waitingForJudge = 0;
    for (const task of tasks) {
      const attempts = task.stage === 'build' ? 1 : 3;
      for (const model of MODELS) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          trialId += 1;
          const id = trialId;
          const r = rand();
          let status = 'ok';
          let error = null;
          if (model[task.stage] == null) { status = 'not_applicable'; error = 'Kimi K2.7 Code is entered for build and spec only'; }
          else if (r > 0.97) { status = 'infra_fail'; error = 'worker: the worker would not start'; }
          else if (r > 0.94) { status = 'timeout'; error = 'the turn ran past its time limit'; }
          const good = rand() < model.quality;
          let parsed = null;
          let commits = null;
          let changed = null;
          if (status === 'ok') {
            if (task.stage === 'triage') {
              const verdict = good ? task.reference.verdict : OTHER[task.reference.verdict];
              parsed = verdict === 'question'
                ? { verdict, question: 'Staging demo: which screen do you mean?', questionAnswers: ['The home screen', 'The settings screen'] }
                : { verdict, buildNote: verdict === 'ready' ? 'Staging demo plan.' : null, reason: 'Staging demo reason.' };
            } else if (task.stage === 'build') {
              commits = good || rand() < 0.5 ? 1 + Math.floor(rand() * 3) : 0;
              parsed = { built: commits > 0, spec: '# Staging demo spec' };
              changed = { files: [{ filename: 'public/app.js', status: 'modified' }], complete: true };
            } else {
              parsed = {
                verdict: good ? 'ready' : 'question', buildNote: good ? 'Staging demo: make the header dark blue.' : null,
                conversation: [{ turn: 1, verdict: 'question', question: 'Staging demo: which colour?', answers: ['Dark blue', 'Green'], reply: { kind: 'tap', text: 'Dark blue' } }],
                turns: good ? 2 : 3, maxTurns: 3, endedAsking: !good,
              };
            }
          }
          const cost = status === 'not_applicable' ? null : Math.round((model[task.stage] || 0) * (0.7 + rand() * 0.6) * 10000) / 10000;
          spent += cost || 0;
          const trial = { status, parsed, build_commits: commits, checks: task.reference.hidden_checks ? { ran: false, total: 1, reason: 'Staging demo: hidden checks are not run yet' } : null };
          const det = status === 'ok' ? graders.deterministicGrade({
            stage: task.stage, trial, reference: task.reference,
            scope: changed ? { ok: true, violations: [] } : null,
          }) : null;
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            `INSERT INTO bench_trials (id, run_id, task_id, model, attempt, status, item_token, est_cost_usd, parsed, cost_usd,
                                       input_tokens, output_tokens, duration_ms, build_branch, build_commits, changed_files, checks,
                                       deterministic, error, created_at, started_at, finished_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19,
                     NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
             ON CONFLICT (id) DO NOTHING`,
            [id, RUN_ID, task.id, model.id, attempt, status, token(), cost, parsed ? JSON.stringify(parsed) : null, cost,
              cost == null ? null : Math.round(cost * 4_000_000), cost == null ? null : Math.round(cost * 60_000),
              status === 'not_applicable' ? null : Math.round(model.ms * (0.5 + rand())),
              task.stage === 'build' ? `bench/r${RUN_ID}-t${id}` : null, commits,
              changed ? JSON.stringify(changed) : null, trial.checks ? JSON.stringify(trial.checks) : null,
              det ? JSON.stringify(det) : null, error],
          );
          if (det && det.needsJudge) {
            // Most judged; a few left waiting so the queue has something in it.
            if (waitingForJudge < 4 && rand() < 0.15) { waitingForJudge += 1; continue; }
            gradeId += 1;
            const verdict = good ? 'pass' : 'fail';
            // eslint-disable-next-line no-await-in-loop
            await pool.query(
              `INSERT INTO bench_grades (id, trial_id, grader, grader_label, verdict, critique, criteria, created_at)
               VALUES ($1, $2, 'opus', 'opus via connector (staging demo)', $3, $4, '{}'::jsonb, NOW() - INTERVAL '1 day')
               ON CONFLICT (id) DO NOTHING`,
              [gradeId, id, verdict, `Staging demo critique: ${verdict === 'pass' ? 'does what was asked, nothing more.' : 'misses what the request asked for.'}`],
            );
            if (gradeId % 5 === 0) {
              gradeId += 1;
              // A person checked this one; they disagree with the judge every other time.
              // eslint-disable-next-line no-await-in-loop
              await pool.query(
                `INSERT INTO bench_grades (id, trial_id, grader, grader_label, verdict, critique, criteria, created_at)
                 VALUES ($1, $2, 'human', 'human (staging demo)', $3, 'Staging demo: a spot check by a person.', '{}'::jsonb, NOW() - INTERVAL '20 hours')
                 ON CONFLICT (id) DO NOTHING`,
                [gradeId, id, gradeId % 10 === 1 ? (verdict === 'pass' ? 'fail' : 'pass') : verdict],
              );
            }
          }
        }
      }
    }
    await pool.query('UPDATE bench_runs SET spent_usd = $2 WHERE id = $1', [RUN_ID, Math.round(spent * 10000) / 10000]);
    log.info('db', 'Benchmark staging fixtures seeded', { trials: trialId - TRIAL_BASE });
    return true;
  } catch (err) {
    log.warn('db', 'Benchmark staging fixtures failed', { message: err.message });
    return false;
  }
}

module.exports = { seedStagingBench, SUITE_ID, RUN_ID };
