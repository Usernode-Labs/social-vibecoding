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

// ── #3737: the taste eval, on staging ────────────────────────────────────
//
// One open suite with a first-version task and a capture task on the same
// brief, and a finished run of both, each with its nineteen screenshots
// (drawn here: a ground in the look's colour and a few bars per state; the
// result state's with "Plan the week" as the control it tapped) and
// the judge's grade, so the results table shows both arms, the spot check
// shows screenshots, and the suite's tasks show their brief and the form to
// add another. Its run is older than the core demo's, so the console still
// opens on that one.

const TASTE_SUITE_ID = 936542;
const TASTE_RUN_ID = 936550;
const TASTE_SNAPSHOT_BASE = 936580;
const TASTE_TASK_BASE = 936582;
const TASTE_TRIAL_BASE = 9365900;
const TASTE_GRADE_BASE = 9366900;
const TASTE_BRIEF = 'Staging demo: a planner for a weekly bake. Pick the breads for the week and see when to start each dough so every loaf is ready on its day.';

/** A PNG of one flat colour with horizontal bars: enough to stand in for a screenshot. Pure. */
function demoPng(width, height, ground, bars = []) {
  const zlib = require('zlib');
  const row = Buffer.alloc(1 + width * 3);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const bar = bars.find((b) => y >= b.y && y < b.y + b.h);
    const [r, g, b] = bar ? bar.rgb : ground;
    const line = Buffer.from(row);
    for (let x = 0; x < width; x += 1) {
      const inBar = bar && x >= 16 && x < width - 16;
      line[1 + x * 3] = inBar ? r : ground[0];
      line[2 + x * 3] = inBar ? g : ground[1];
      line[3 + x * 3] = inBar ? b : ground[2];
    }
    rows.push(line);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function demoShot(viewport, look, state) {
  const width = viewport === 'phone' ? 390 : 1280;
  const height = viewport === 'phone' ? 844 : 800;
  const ground = look === 'light' ? [250, 250, 249] : [24, 24, 27];
  const ink = look === 'light' ? [214, 211, 209] : [63, 63, 70];
  const accent = [217, 119, 6];
  const bars = state === 'empty' ? [{ y: 120, h: 40, rgb: ink }]
    : state === 'error' ? [{ y: 120, h: 56, rgb: [220, 38, 38] }]
      : state === 'loading' ? [0, 1, 2].map((i) => ({ y: 120 + i * 96, h: 72, rgb: ink }))
        // The result: the form folded up and the answer below it.
        : state === 'result' ? [{ y: 64, h: 48, rgb: accent }, { y: 160, h: 88, rgb: ink }, { y: 280, h: 320, rgb: accent }]
          : [{ y: 64, h: 48, rgb: accent }, ...[0, 1, 2, 3].map((i) => ({ y: 160 + i * 112, h: 88, rgb: ink }))];
  return demoPng(width, height, ground, bars);
}

// The control the demo's result screens tapped, as the step records it.
const DEMO_ACTION = Object.freeze({ label: 'Plan the week', rule: 'kit-primary' });

/** The demo's screenshots, one per planned shot, the result screens with the control they tapped. */
function demoShots(capture, lookOf = (p) => p.look) {
  return capture.plannedShots().map((p) => {
    const data = demoShot(p.viewport, lookOf(p), p.state);
    return {
      ...p, data, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), status: 200, consoleErrors: 0,
      ...(p.state === 'result' ? { action: DEMO_ACTION } : {}),
    };
  });
}

/** The step's account of the demo's result screens. */
function demoPrimaryAction(capture) {
  return capture.plannedShots().filter((p) => p.state === 'result').map((p) => ({
    id: p.id,
    used: { ...DEMO_ACTION, why: 'the design kit\'s primary button (.btn-primary), the only one in the main content' },
    settled: 'network idle', changes: 3, revealed: p.viewport === 'phone', dialogs: 0, blocked: 0, ms: 1400,
  }));
}

async function seedStagingTaste(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return false;
  try {
    const { rows: done } = await pool.query('SELECT 1 FROM bench_suites WHERE id = $1', [TASTE_SUITE_ID]);
    if (done.length) return false;
    const { rows: [app] } = await pool.query("SELECT id, slug FROM apps WHERE status = 'running' ORDER BY id LIMIT 1");
    if (!app) return false;
    const snapshots = require('../homeroom-bot-snapshots');
    const graders = require('./graders');
    const capture = require('./capture');
    const token = () => crypto.randomBytes(12).toString('base64url');
    await pool.query(
      `INSERT INTO bench_suites (id, name, version, kind, notes, created_at)
       VALUES ($1, 'Staging demo taste', 1, 'frozen', 'Staging demo: a taste eval fixture, not real first versions.', NOW() - INTERVAL '3 days')
       ON CONFLICT (id) DO NOTHING`,
      [TASTE_SUITE_ID],
    );
    const brief = await snapshots.storeBlob(pool, TASTE_BRIEF);
    const kinds = [
      { stage: 'first_version', extra: { taste: 'first_version', appName: 'Staging demo bakery', template: 'empty' } },
      { stage: 'capture', extra: { taste: 'capture', appName: 'Staging demo bakery', sha: 'd'.repeat(40) } },
    ];
    for (const [i, k] of kinds.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO homeroom_bot_run_snapshots (id, run_id, stage, app_id, issue_number, base_sha, texts, extra, source)
         VALUES ($1, NULL, 'build', $2, 1, $3, $4::jsonb, $5::jsonb, 'import')
         ON CONFLICT (id) DO NOTHING`,
        [TASTE_SNAPSHOT_BASE + i, app.id, k.extra.sha || null, JSON.stringify({ brief }), JSON.stringify(k.extra)],
      );
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO bench_tasks (id, suite_id, stage, snapshot_id, app_id, issue_number, tags, reference, reference_source, label_token)
         VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, '{}'::jsonb, 'authored', $7)
         ON CONFLICT (id) DO NOTHING`,
        [TASTE_TASK_BASE + i, TASTE_SUITE_ID, k.stage, TASTE_SNAPSHOT_BASE + i, app.id,
          JSON.stringify({ taste: k.stage, app_slug: app.slug, repo_size: 'small', request_type: 'feature', brief_placeholder: false, prompt_chars: TASTE_BRIEF.length }),
          token()],
      );
    }
    await pool.query(
      `INSERT INTO bench_runs (id, suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, spent_usd,
                               note, created_at, started_at, finished_at)
       VALUES ($1, $2, ARRAY['z-ai/glm-5.3-flash'], 'z-ai/glm-5.3-flash', ARRAY['first_version','capture'], 1, 10, 1, 'done', 1.12,
               'Staging demo taste run: fixture screenshots, not real results.', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
       ON CONFLICT (id) DO NOTHING`,
      [TASTE_RUN_ID, TASTE_SUITE_ID],
    );
    const criteria = [
      { hierarchy: true, type_scale: true, spacing: true, accent: true, both_looks: true, states: false, copy: true, no_tells: true, works_at_390: true, kit_use: false, domain_fit: true, would_ship: false },
      { hierarchy: false, type_scale: false, spacing: true, accent: false, both_looks: false, states: false, copy: true, no_tells: false, works_at_390: true, kit_use: false, domain_fit: false, would_ship: false },
    ];
    for (const [i, k] of kinds.entries()) {
      const id = TASTE_TRIAL_BASE + i + 1;
      const shots = demoShots(capture);
      const summary = capture.summarize({
        booted: true, steps: {}, ms: 61_000, primaryAction: demoPrimaryAction(capture),
        checks: {
          consoleErrors: { count: i, screens: 8, samples: i ? ['Staging demo: Failed to load resource'] : [] },
          overflow360: { light: 0, dark: i * 24, worst: i * 24 },
          smallTapTargets: { small: 1 + i * 3, checked: 9, samples: [] },
          lowContrast: { light: { low: i * 4, checked: 40, worst: i ? 2.8 : 4.9, samples: [] }, dark: { low: 2 + i * 6, checked: 40, worst: 3.6, samples: [] } },
          nestedCards: { worst: i * 2 },
        },
        tells: {
          files: 3, emojiIcons: { count: i * 7, samples: [] }, uppercaseEyebrows: { count: i * 3, samples: [] },
          arbitraryTextSizes: { count: i * 4, values: i ? ['15px', '17px'] : [] }, hexColours: { count: i * 9, values: [] },
        },
      }, shots, [], {});
      const parsed = k.stage === 'first_version'
        ? { built: true, triage: { verdict: 'ready', buildNote: 'Staging demo plan.' }, spec: '# Staging demo bakery' }
        : { captured: true };
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO bench_trials (id, run_id, task_id, model, attempt, status, item_token, est_cost_usd, parsed, cost_usd,
                                   duration_ms, build_commits, capture, created_at, started_at, finished_at)
         VALUES ($1, $2, $3, 'z-ai/glm-5.3-flash', 1, 'ok', $4, $5, $6::jsonb, $5, $7, $8, '{}'::jsonb,
                 NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
         ON CONFLICT (id) DO NOTHING`,
        [id, TASTE_RUN_ID, TASTE_TASK_BASE + i, token(), k.stage === 'first_version' ? 1.12 : 0, JSON.stringify(parsed),
          k.stage === 'first_version' ? 1_480_000 : 380_000, k.stage === 'first_version' ? 3 : null],
      );
      // eslint-disable-next-line no-await-in-loop
      const ids = await capture.storeShots(pool, id, shots);
      const stored = { ...summary, shots: summary.shots.map((sh) => ({ ...sh, artifactId: ids[sh.id] || null })) };
      const det = graders.deterministicGrade({ stage: k.stage, trial: { status: 'ok', parsed, capture: stored } });
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE bench_trials SET capture = $2::jsonb, deterministic = $3::jsonb WHERE id = $1',
        [id, JSON.stringify(stored), JSON.stringify(det)]);
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO bench_grades (id, trial_id, grader, grader_label, verdict, critique, criteria, created_at)
         VALUES ($1, $2, 'opus', 'opus via connector (staging demo)', 'fail', $3, $4::jsonb, NOW() - INTERVAL '2 days')
         ON CONFLICT (id) DO NOTHING`,
        [TASTE_GRADE_BASE + i + 1, id, 'Staging demo critique: a clear populated screen, but the empty and error states say nothing.', JSON.stringify(criteria[i])],
      );
    }
    log.info('db', 'Benchmark taste staging fixtures seeded');
    return true;
  } catch (err) {
    log.warn('db', 'Benchmark taste staging fixtures failed', { message: err.message });
    return false;
  }
}

// ── The App bench studio (services/bench/studio.js) ──────────────────
//
// One studio run over two starter briefs: each built by the live bot's model
// with no pack and with a demo pack, beside a reference, every build with its
// screenshots and a grade, so the Studio place's gallery has something to
// show. Builds carry no branch, so a preview never points at one. Older than
// both runs above, so the console still opens on the core demo.

const STUDIO_SUITE_ID = 936543;
const STUDIO_RUN_ID = 936549;
const STUDIO_PACK_ID = 936541;
const STUDIO_SNAPSHOT_BASE = 936590;
const STUDIO_TASK_BASE = 936590;
const STUDIO_TRIAL_BASE = 9365950;
const STUDIO_GRADE_BASE = 9366950;

async function seedStagingStudio(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return false;
  try {
    const { rows: done } = await pool.query('SELECT 1 FROM bench_suites WHERE id = $1', [STUDIO_SUITE_ID]);
    if (done.length) return false;
    const { rows: [app] } = await pool.query("SELECT id, slug FROM apps WHERE status = 'running' ORDER BY id LIMIT 1");
    if (!app) return false;
    const studio = require('./studio');
    const snapshots = require('../homeroom-bot-snapshots');
    const graders = require('./graders');
    const capture = require('./capture');
    const packs = require('./packs');
    const token = () => crypto.randomBytes(12).toString('base64url');
    const briefs = studio.starterBriefs().filter((b) => ['bread', 'tier-list'].includes(b.ref));
    await pool.query(
      `INSERT INTO bench_suites (id, name, version, kind, notes, created_at)
       VALUES ($1, $2, 1, 'rotating', 'Staging demo: the App bench studio''s briefs, with fixture builds.', NOW() - INTERVAL '4 days')
       ON CONFLICT (id) DO NOTHING`,
      [STUDIO_SUITE_ID, studio.SUITE_NAME],
    );
    const pack = { guidance: 'Staging demo: warm neutrals, one accent, generous spacing.', stageGuidance: {}, files: [] };
    await pool.query(
      `INSERT INTO bench_context_packs (id, name, version, guidance, stage_guidance, files, notes, sha256, created_at, used_at)
       VALUES ($1, 'Staging demo theme', 1, $2, '{}'::jsonb, '[]'::jsonb, 'Staging demo pack.', $3, NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days')
       ON CONFLICT (id) DO NOTHING`,
      [STUDIO_PACK_ID, pack.guidance, packs.hashOf(pack)],
    );
    for (const [i, b] of briefs.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const blob = await snapshots.storeBlob(pool, b.brief);
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO homeroom_bot_run_snapshots (id, run_id, stage, app_id, issue_number, base_sha, texts, extra, source)
         VALUES ($1, NULL, 'build', $2, 1, NULL, $3::jsonb, $4::jsonb, 'import')
         ON CONFLICT (id) DO NOTHING`,
        [STUDIO_SNAPSHOT_BASE + i, app.id, JSON.stringify({ brief: blob }), JSON.stringify({ taste: 'first_version', appName: b.appName, template: 'empty' })],
      );
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO bench_tasks (id, suite_id, stage, snapshot_id, app_id, issue_number, tags, reference, reference_source, label_token)
         VALUES ($1, $2, 'first_version', $3, $4, NULL, $5::jsonb, '{}'::jsonb, 'authored', $6)
         ON CONFLICT (id) DO NOTHING`,
        [STUDIO_TASK_BASE + i, STUDIO_SUITE_ID, STUDIO_SNAPSHOT_BASE + i, app.id,
          JSON.stringify({ taste: 'first_version', taste_ref: b.ref, app_slug: app.slug, studio_key: studio.studioKey(b.appName, b.brief), prompt_chars: b.brief.length }),
          token()],
      );
    }
    await pool.query(
      `INSERT INTO bench_runs (id, suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status, spent_usd, note,
                               kind, context_pack_ids, references_per_brief, created_at, started_at, finished_at)
       VALUES ($1, $2, ARRAY['today'], 'today', ARRAY['first_version'], 1, 10, 4, 'done', 4.48,
               'Staging demo studio run: fixture screenshots, not real builds.', 'studio', ARRAY[0, $3]::int[], 1,
               NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days')
       ON CONFLICT (id) DO NOTHING`,
      [STUDIO_RUN_ID, STUDIO_SUITE_ID, STUDIO_PACK_ID],
    );
    const arms = [
      { model: 'today', pack: null, label: null, pass: false, critique: 'Staging demo critique: the numbers are right, but every screen is the same grey list.' },
      { model: 'today', pack: STUDIO_PACK_ID, label: null, pass: true, critique: 'Staging demo critique: warm and clear, with an accent that leads to the one action.' },
      { model: 'reference:ref-v1', pack: STUDIO_PACK_ID, label: 'ref-v1', pass: true, critique: 'Staging demo critique: the reference, as the target for this brief.' },
    ];
    const criteriaFor = (pass) => ({
      hierarchy: true, type_scale: pass, spacing: true, accent: pass, both_looks: true, states: pass, copy: true,
      no_tells: pass, works_at_390: true, kit_use: pass, domain_fit: true, would_ship: pass,
    });
    let n = 0;
    for (const [i] of briefs.entries()) {
      for (const arm of arms) {
        n += 1;
        const id = STUDIO_TRIAL_BASE + n;
        const shots = demoShots(capture, (p) => (arm.pass ? p.look : 'dark'));
        const summary = capture.summarize({ booted: true, steps: {}, ms: 58_000, primaryAction: demoPrimaryAction(capture), checks: {}, tells: {} }, shots, [], {});
        const parsed = { built: true, triage: { verdict: 'ready', buildNote: 'Staging demo plan.' }, skills: { invoked: arm.pack ? ['staging-demo-theme'] : [], read: [] } };
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO bench_trials (id, run_id, task_id, model, attempt, status, item_token, est_cost_usd, parsed, cost_usd,
                                     duration_ms, build_commits, capture, context_pack_id, reference_label,
                                     created_at, started_at, finished_at)
           VALUES ($1, $2, $3, $4, 1, 'ok', $5, $6, $7::jsonb, $6, $8, 3, '{}'::jsonb, $9, $10,
                   NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days' + INTERVAL '21 minutes')
           ON CONFLICT (id) DO NOTHING`,
          [id, STUDIO_RUN_ID, STUDIO_TASK_BASE + i, arm.model, token(), arm.label ? 0 : 1.12, JSON.stringify(parsed),
            arm.label ? 300_000 : 1_260_000, arm.pack, arm.label],
        );
        // eslint-disable-next-line no-await-in-loop
        const ids = await capture.storeShots(pool, id, shots);
        const stored = { ...summary, shots: summary.shots.map((sh) => ({ ...sh, artifactId: ids[sh.id] || null })) };
        const det = graders.deterministicGrade({ stage: 'first_version', trial: { status: 'ok', parsed, capture: stored } });
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE bench_trials SET capture = $2::jsonb, deterministic = $3::jsonb WHERE id = $1',
          [id, JSON.stringify(stored), JSON.stringify(det)]);
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO bench_grades (id, trial_id, grader, grader_label, verdict, critique, criteria, created_at)
           VALUES ($1, $2, 'opus', 'opus via connector (staging demo)', $3, $4, $5::jsonb, NOW() - INTERVAL '3 days')
           ON CONFLICT (id) DO NOTHING`,
          [STUDIO_GRADE_BASE + n, id, arm.pass ? 'pass' : 'fail', arm.critique, JSON.stringify(criteriaFor(arm.pass))],
        );
      }
    }
    log.info('db', 'App bench studio staging fixtures seeded');
    return true;
  } catch (err) {
    log.warn('db', 'App bench studio staging fixtures failed', { message: err.message });
    return false;
  }
}

module.exports = {
  seedStagingBench, seedStagingTaste, seedStagingStudio, demoPng, SUITE_ID, RUN_ID, TASTE_SUITE_ID, TASTE_RUN_ID,
  STUDIO_SUITE_ID, STUDIO_RUN_ID,
};
