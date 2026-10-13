'use strict';

// #3654: a benchmark run's results, per stage and model, and its trials as
// a CSV. Everything is computed from the trials and their grades
// (services/bench/stats.js), never stored, so a late grade or a person's
// override changes the report the next time it is read.
//
// What is kept apart, because folding it in would mislead:
//   * platform faults (infra_fail) are not the model's: excluded from
//     accuracy, reported as their own rate;
//   * a timeout IS the model's (it ran out the clock the bot gives it):
//     counted as a fail, and reported as its own rate too;
//   * not applicable (the model cannot take the task) and skipped at the cap
//     are counted, never graded;
//   * cost includes every attempt, failed ones too, so "$ per successful
//     build" is what a passing build really cost.
//   * a DM task's answer is the requester's real one or one written for them
//     (services/bench/core.js resolveDm): the `answer_source` slice keeps
//     the two apart as "real" and "scripted".

const graders = require('./graders');
const stats = require('./stats');

// `template`: the starter a first-version task's first commit came from
// (services/bench/taste.js tagsFor), so with and without a game starter
// read side by side.
const SLICE_KEYS = Object.freeze(['verdict', 'repo_size', 'request_type', 'difficulty', 'app_slug', 'known_outcome', 'answer_source', 'template']);
// A first version (#3737) is built `repeats` times, so pass^k reads how
// reliably each brief comes out well, as the research behind it asks.
const REPEATED_STAGES = Object.freeze(['triage', 'dm', 'followup', 'checks_fix', 'first_version']);

/**
 * Whose answer a DM trial's simulated requester gave: 'scripted' when it was
 * written for them, 'real' otherwise (a DM task made from a run has its
 * requester's own answer); null for any other stage. Pure.
 */
function answerSource(t) {
  if (t.stage !== 'dm') return null;
  return t.dm_answer_source === 'scripted' || t.tags?.answer_source === 'scripted' ? 'scripted' : 'real';
}

/**
 * Accuracy per stage, model and value of one slice key. Pure over trials
 * (runTrials' rows). `answer_source` reads real or scripted off the task,
 * not the raw tag, so a DM task made before the tag existed still counts.
 */
function sliceGroups(trials, key) {
  const groups = new Map();
  for (const t of trials) {
    let value;
    if (key === 'app_slug') value = t.appSlug;
    else if (key === 'answer_source') value = t.answerSource ?? 'none';
    else value = t.tags?.[key] ?? 'none';
    const id = `${t.stage}|${t.model}|${value}`;
    if (!groups.has(id)) groups.set(id, { stage: t.stage, model: t.model, value: String(value), pass: 0, fail: 0 });
    const g = groups.get(id);
    if (t.final === 'pass') g.pass += 1;
    if (t.final === 'fail') g.fail += 1;
  }
  const slices = [...groups.values()].map((g) => ({ ...g, n: g.pass + g.fail, accuracy: g.pass + g.fail ? g.pass / (g.pass + g.fail) : null }));
  slices.sort((a, b) => a.stage.localeCompare(b.stage) || a.value.localeCompare(b.value) || a.model.localeCompare(b.model));
  return slices;
}

/**
 * A trial's ARM: its model, or for the App bench studio (services/bench/
 * studio.js) its model with its context pack ("<model> + <pack> v<n>"), or
 * a reference build's label (its model, "reference:<label>"). A run with no
 * packs and no references has exactly one arm per model, as before. Pure.
 */
function armKey(t) {
  const pack = t.context_pack_id ? ` + ${t.pack_name || `pack ${t.context_pack_id}`}${t.pack_version ? ` v${t.pack_version}` : ''}` : '';
  return `${t.model}${pack}`;
}

/** The arms a stage's trials ran in: the run's models first, as launched, then the rest in order. Pure. */
function armsOf(models, trials) {
  const present = [...new Set(trials.map((t) => t.arm || t.model))];
  const first = (models || []).filter((m) => present.includes(m));
  return [...first, ...present.filter((a) => !first.includes(a)).sort()];
}

async function runTrials(pool, runId) {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.task_id, tr.model, tr.attempt, tr.status, tr.cost_usd::float8 AS cost_usd,
            tr.input_tokens, tr.output_tokens, tr.duration_ms, tr.deterministic, tr.error,
            tr.build_branch, tr.build_sha, tr.build_commits, tr.created_at, tr.finished_at,
            tk.stage, tk.tags, tk.issue_number, a.slug AS app_slug,
            tk.reference->'dm_script'->>'source' AS dm_answer_source,
            CASE WHEN tk.stage IN ('first_version', 'capture') THEN tr.capture END AS capture,
            CASE WHEN tk.stage IN ('first_version', 'capture') THEN sn.extra->>'appName' END AS taste_app_name,
            tr.context_pack_id, tr.reference_label, p.name AS pack_name, p.version AS pack_version
       FROM bench_trials tr
       JOIN bench_tasks tk ON tk.id = tr.task_id
       LEFT JOIN apps a ON a.id = tk.app_id
       LEFT JOIN homeroom_bot_run_snapshots sn ON sn.id = tk.snapshot_id
       LEFT JOIN bench_context_packs p ON p.id = tr.context_pack_id
      WHERE tr.run_id = $1
      ORDER BY tr.id`,
    [Number(runId)],
  );
  const { rows: grades } = await pool.query(
    `SELECT g.id, g.trial_id, g.grader, g.verdict, g.criteria, g.created_at
       FROM bench_grades g JOIN bench_trials tr ON tr.id = g.trial_id
      WHERE tr.run_id = $1`,
    [Number(runId)],
  );
  const byTrial = new Map();
  for (const g of grades) {
    if (!byTrial.has(g.trial_id)) byTrial.set(g.trial_id, []);
    byTrial.get(g.trial_id).push(g);
  }
  return rows.map((t) => {
    const gs = byTrial.get(t.id) || [];
    const latest = (kind) => gs.filter((g) => g.grader === kind)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)[0];
    return {
      ...t,
      arm: armKey(t),
      appSlug: t.app_slug || '?',
      tags: t.tags || {},
      answerSource: answerSource(t),
      final: graders.finalVerdict({ status: t.status, deterministic: t.deterministic, grades: gs }),
      opus: latest('opus')?.verdict || null,
      human: latest('human')?.verdict || null,
      // The rubric's criteria as the grade that counts recorded them: a
      // person's over the judge's.
      criteria: (latest('human') && Object.keys(latest('human').criteria || {}).length ? latest('human') : latest('opus'))?.criteria || null,
    };
  });
}

// ── The taste eval's averages (#3737) ─────────────────────────────────────

function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * One taste cell's averages, for comparing arms: each rubric criterion's
 * share of true among the grades that answered it, the share of trials whose
 * app booted, and each automatic check and tell as a mean over the trials
 * that measured it. Pure over runTrials' rows.
 */
function tasteAggregates(trials) {
  const done = trials.filter((t) => t.status === 'ok');
  const criteria = {};
  for (const t of done) {
    for (const [id, value] of Object.entries(t.criteria || {})) {
      if (typeof value !== 'boolean') continue;
      if (!criteria[id]) criteria[id] = { yes: 0, n: 0 };
      criteria[id].n += 1;
      if (value) criteria[id].yes += 1;
    }
  }
  const caps = done.map((t) => t.capture).filter(Boolean);
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const avg = (pick) => {
    const m = mean(caps.map((c) => num(pick(c))));
    return m == null ? null : Math.round(m * 100) / 100;
  };
  return {
    trials: done.length,
    criteria: Object.fromEntries(Object.entries(criteria).map(([id, c]) => [id, { rate: c.yes / c.n, n: c.n }])),
    bootedRate: caps.length ? caps.filter((c) => c.booted).length / caps.length : null,
    checks: {
      consoleErrors: avg((c) => c.checks?.consoleErrors?.count),
      overflowAt360px: avg((c) => c.checks?.overflow360?.worst),
      tapTargetsUnder44px: avg((c) => c.checks?.smallTapTargets?.small),
      lowContrastLight: avg((c) => c.checks?.lowContrast?.light?.low),
      lowContrastDark: avg((c) => c.checks?.lowContrast?.dark?.low),
      cardsNestedInCards: avg((c) => c.checks?.nestedCards?.worst),
    },
    tells: {
      emojiIcons: avg((c) => c.tells?.emojiIcons?.count),
      uppercaseEyebrows: avg((c) => c.tells?.uppercaseEyebrows?.count),
      arbitraryTextSizes: avg((c) => c.tells?.arbitraryTextSizes?.count),
      hexColours: avg((c) => c.tells?.hexColours?.count),
    },
  };
}

/**
 * A taste run's trials one by one, for the console's side-by-side view: the
 * app, the arm (the stage, and the model for a first version), what happened,
 * the screenshots the judge was shown, and how many of the rubric's criteria
 * the grade that counts said held. The console's view only: runAggregates
 * copies its fields by name and never reaches this, so nothing here names a
 * trial to the connector. Pure over runTrials' rows.
 */
function tasteTrials(trials) {
  const { pickShots } = require('./capture');
  return trials.filter((t) => t.stage === 'first_version' || t.stage === 'capture').map((t) => {
    const answered = Object.values(t.criteria || {}).filter((v) => typeof v === 'boolean');
    return {
      trialId: t.id,
      stage: t.stage,
      model: t.arm || t.model,
      attempt: t.attempt,
      status: t.status,
      appSlug: t.appSlug,
      appName: t.taste_app_name || t.appSlug,
      booted: t.capture ? t.capture.booted === true : null,
      shots: t.capture ? pickShots(t.capture).chosen.map((sh) => ({ caption: sh.caption, artifactId: sh.artifactId })) : [],
      criteria: answered.length ? { held: answered.filter(Boolean).length, of: answered.length } : null,
    };
  });
}

/** One cell of the results table: a stage on a model. */
function summarize(trials, { stage, k }) {
  const by = (s) => trials.filter((t) => t.status === s).length;
  const pass = trials.filter((t) => t.final === 'pass').length;
  const fail = trials.filter((t) => t.final === 'fail').length;
  const attempted = by('ok') + by('model_fail') + by('timeout') + by('infra_fail');
  const costed = trials.filter((t) => Number.isFinite(t.cost_usd));
  const cost = costed.reduce((s, t) => s + t.cost_usd, 0);
  const tasks = new Set(trials.filter((t) => ['ok', 'model_fail', 'timeout', 'infra_fail'].includes(t.status)).map((t) => t.task_id));
  const attempts = new Map();
  for (const t of trials) {
    if (!attempts.has(t.task_id)) attempts.set(t.task_id, []);
    attempts.get(t.task_id).push(t.final);
  }
  const durations = trials.filter((t) => ['ok', 'model_fail', 'timeout'].includes(t.status)).map((t) => Number(t.duration_ms));
  return {
    trials: trials.length,
    graded: pass + fail,
    pass,
    fail,
    pending: trials.filter((t) => t.final === 'pending').length,
    unlabelled: trials.filter((t) => t.final === 'unlabelled').length,
    notApplicable: by('not_applicable'),
    skippedCap: by('skipped_cap'),
    accuracy: pass + fail ? pass / (pass + fail) : null,
    passK: stats.passHatK(attempts, k),
    costUsd: cost,
    // Per task counts all k of a task's attempts; per attempt is the unit a
    // success is counted in, so the two read side by side: a success costs
    // at least an attempt, failed attempts included.
    costPerTask: tasks.size ? cost / tasks.size : null,
    costPerAttempt: attempted ? cost / attempted : null,
    costPerSuccess: pass ? cost / pass : null,
    p50Ms: stats.percentile(durations, 50),
    p95Ms: stats.percentile(durations, 95),
    timeoutRate: attempted ? by('timeout') / attempted : null,
    infraRate: attempted ? by('infra_fail') / attempted : null,
    inputTokens: trials.reduce((s, t) => s + (Number(t.input_tokens) || 0), 0),
    outputTokens: trials.reduce((s, t) => s + (Number(t.output_tokens) || 0), 0),
    stage,
  };
}

/** Each task's score for one model: the mean of its graded attempts. */
function taskScores(trials) {
  const out = new Map();
  for (const t of trials) {
    if (t.final !== 'pass' && t.final !== 'fail') continue;
    if (!out.has(t.task_id)) out.set(t.task_id, { app: t.appSlug, n: 0, pass: 0 });
    const s = out.get(t.task_id);
    s.n += 1;
    if (t.final === 'pass') s.pass += 1;
  }
  return new Map([...out].map(([task, s]) => [task, { app: s.app, score: s.pass / s.n }]));
}

/**
 * The whole report for a run: rows per stage and model, each model's
 * paired difference against the baseline per stage, slices by a tag, and
 * the cost-vs-quality points with their Pareto frontier.
 */
async function runReport(pool, runId, { slice = 'verdict', trials: loaded = null } = {}) {
  const { rows: [run] } = await pool.query(
    `SELECT r.id, r.suite_id, r.models, r.baseline_model, r.stages, r.repeats, r.status, r.created_at, r.started_at,
            r.finished_at, r.cap_usd::float8 AS cap_usd, r.spent_usd::float8 AS spent_usd, s.name AS suite_name, s.version AS suite_version,
            s.frozen_at AS suite_frozen_at
       FROM bench_runs r JOIN bench_suites s ON s.id = r.suite_id WHERE r.id = $1`,
    [Number(runId)],
  );
  if (!run) return null;
  const trials = loaded || await runTrials(pool, runId);
  const rows = [];
  const paired = [];
  const points = [];
  for (const stage of run.stages) {
    const ofStage = trials.filter((t) => t.stage === stage);
    // pass^k counts the attempts a stage was actually given: a launch can
    // repeat triage and run the other stages once (lane.attemptsFor).
    const given = Math.max(1, ...ofStage.map((t) => Number(t.attempt) || 1));
    const k = REPEATED_STAGES.includes(stage) ? Math.min(run.repeats, given) : 1;
    if (!ofStage.length) continue;
    const armOf = (t) => t.arm || t.model;
    const arms = armsOf(run.models, ofStage);
    for (const arm of arms) {
      const mine = ofStage.filter((t) => armOf(t) === arm);
      if (!mine.length) continue;
      const reference = !!mine[0].reference_label;
      const row = {
        stage, model: arm, baseline: arm === run.baseline_model, ...summarize(mine, { stage, k }),
        ...(stage === 'first_version' || stage === 'capture' ? { taste: tasteAggregates(mine) } : {}),
        ...(reference ? { reference: true } : {}),
        ...(mine[0].context_pack_id ? { packId: Number(mine[0].context_pack_id) } : {}),
      };
      rows.push(row);
      // A reference build is the target, never a candidate: it is shown
      // beside the arms and kept out of the comparisons.
      if (reference) continue;
      points.push({ key: `${stage}|${arm}`, stage, model: arm, cost: row.costPerAttempt, accuracy: row.accuracy });
      // Each arm against its own model without a pack when it has one (what
      // the pack changed), else against the run's baseline.
      const own = mine[0].context_pack_id && arms.includes(mine[0].model) ? mine[0].model : run.baseline_model;
      if (arm === own) continue;
      const base = taskScores(ofStage.filter((t) => armOf(t) === own));
      if (!base.size && own !== run.baseline_model) continue;
      const scores = taskScores(mine);
      const pairs = [...scores].filter(([task]) => base.has(task))
        .map(([task, s]) => ({ task, app: s.app, a: s.score, b: base.get(task).score }));
      paired.push({ stage, model: arm, baselineModel: own, ...stats.pairedDiff(pairs, { seed: 3654 + Number(runId) }) });
    }
  }
  const frontier = new Set();
  for (const stage of run.stages) {
    for (const key of stats.paretoFrontier(points.filter((p) => p.stage === stage))) frontier.add(key);
  }
  const key = SLICE_KEYS.includes(slice) ? slice : 'verdict';
  const slices = sliceGroups(trials, key);
  return {
    run: {
      id: run.id, suiteId: run.suite_id, suiteName: run.suite_name, suiteVersion: run.suite_version,
      suiteFrozen: !!run.suite_frozen_at, models: run.models, baseline: run.baseline_model, stages: run.stages,
      repeats: run.repeats, capUsd: run.cap_usd, spentUsd: run.spent_usd, status: run.status,
      createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at,
    },
    rows,
    paired,
    slice: { key, keys: SLICE_KEYS, groups: slices },
    pareto: points.map((p) => ({ ...p, frontier: frontier.has(p.key) })),
    tasteTrials: tasteTrials(trials),
  };
}

// ── The connector's view of a run (get_bench_run) ─────────────────────────
//
// The same report, with nothing in it that names one trial. A session that
// grades blind items (services/bench/grading.js) can also read a run, so
// what it reads is counted per stage and model and never per trial: no trial
// or task id, no item token, no issue number, no branch, no app. The slices
// leave out app_slug for the same reason, and a failure reason is the
// trial's error with its numbers, branch names and SHAs taken out, so that
// reasons group and none of them points back at one trial.

const CONNECTOR_SLICE_KEYS = Object.freeze(SLICE_KEYS.filter((k) => k !== 'app_slug'));
const FAILURE_STATUSES = Object.freeze(['model_fail', 'infra_fail', 'timeout', 'not_applicable', 'skipped_cap', 'cancelled']);
const MAX_REASON_CHARS = 200;
const MAX_REASONS_PER_CELL = 10;
const SAFE_TAG_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * A trial's error as a reason that can be grouped and shown: whitespace
 * collapsed, `bench/` branch names, SHAs and every run of digits replaced,
 * cut to 200 characters. Pure.
 */
function reasonText(error) {
  const text = String(error == null ? '' : error)
    .replace(/\s+/g, ' ')
    .replace(/\bbench\/[^\s'"`,;)]+/g, 'bench/…')
    .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) ? '<sha>' : m))
    .replace(/\d+/g, 'N')
    .trim();
  if (!text) return '(no reason recorded)';
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

/** Trial counts by status, and failure reasons grouped by (status, reason). Pure. */
function statusAndReasons(trials) {
  const statuses = {};
  const reasons = new Map();
  for (const t of trials) {
    statuses[t.status] = (statuses[t.status] || 0) + 1;
    if (!FAILURE_STATUSES.includes(t.status)) continue;
    const reason = reasonText(t.error);
    const key = `${t.status}\u0000${reason}`;
    if (!reasons.has(key)) reasons.set(key, { status: t.status, reason, count: 0 });
    reasons.get(key).count += 1;
  }
  const all = [...reasons.values()].sort((a, b) => b.count - a.count || a.status.localeCompare(b.status) || a.reason.localeCompare(b.reason));
  return { statuses, failureReasons: all.slice(0, MAX_REASONS_PER_CELL), moreReasons: Math.max(0, all.length - MAX_REASONS_PER_CELL) };
}

/**
 * A slice's groups with any value that is not a plain tag folded into
 * '(other)': a tag is written by whoever labelled the task. Pure.
 */
function safeGroups(groups) {
  const out = new Map();
  for (const g of groups) {
    const value = SAFE_TAG_RE.test(g.value) ? g.value : '(other)';
    const id = `${g.stage}|${g.model}|${value}`;
    if (!out.has(id)) out.set(id, { stage: g.stage, model: g.model, value, pass: 0, fail: 0 });
    out.get(id).pass += g.pass;
    out.get(id).fail += g.fail;
  }
  return [...out.values()].map((g) => ({ ...g, n: g.pass + g.fail, accuracy: g.pass + g.fail ? g.pass / (g.pass + g.fail) : null }));
}

/**
 * A run's results as aggregates only: per stage and model, trial counts by
 * status, the graded pass/fail and accuracy, cost, and failure reasons; the
 * paired difference against the baseline with its interval; one slice; the
 * judge's agreement with people. Every field is copied by name, so a field
 * added to the report later does not reach the connector by accident.
 * Null when there is no such run.
 */
async function runAggregates(pool, runId, { slice = 'verdict', agreement = null } = {}) {
  const trials = await runTrials(pool, runId);
  const key = CONNECTOR_SLICE_KEYS.includes(slice) ? slice : 'verdict';
  const report = await runReport(pool, runId, { slice: key, trials });
  if (!report) return null;
  const frontier = new Set(report.pareto.filter((p) => p.frontier).map((p) => p.key));
  const cells = report.rows.map((r) => {
    const mine = trials.filter((t) => t.stage === r.stage && (t.arm || t.model) === r.model);
    return {
      stage: r.stage,
      model: r.model,
      baseline: r.baseline,
      trials: r.trials,
      ...statusAndReasons(mine),
      graded: r.graded,
      pass: r.pass,
      fail: r.fail,
      pendingJudge: r.pending,
      unlabelled: r.unlabelled,
      accuracy: r.accuracy,
      passK: { k: r.passK.k, tasks: r.passK.tasks, passAll: r.passK.passAll, value: r.passK.value },
      costUsd: r.costUsd,
      costPerAttempt: r.costPerAttempt,
      costPerSuccess: r.costPerSuccess,
      timeoutRate: r.timeoutRate,
      infraRate: r.infraRate,
      p50Ms: r.p50Ms,
      p95Ms: r.p95Ms,
      paretoFrontier: frontier.has(`${r.stage}|${r.model}`),
      ...(r.taste ? { taste: r.taste } : {}),
    };
  });
  const run = report.run;
  const overall = statusAndReasons(trials);
  return {
    run: {
      id: run.id, suiteId: run.suiteId, suiteName: run.suiteName, suiteVersion: run.suiteVersion, suiteFrozen: run.suiteFrozen,
      status: run.status, models: run.models, baseline: run.baseline, stages: run.stages, repeats: run.repeats,
      capUsd: run.capUsd, spentUsd: run.spentUsd, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    },
    trials: trials.length,
    statuses: overall.statuses,
    pendingJudge: cells.reduce((s, c) => s + c.pendingJudge, 0),
    cells,
    paired: report.paired.map((p) => ({
      stage: p.stage, model: p.model, baselineModel: p.baselineModel, n: p.n, apps: p.apps, diff: p.diff, low: p.low, high: p.high,
    })),
    slice: {
      key: report.slice.key,
      keys: CONNECTOR_SLICE_KEYS,
      groups: safeGroups(report.slice.groups),
    },
    agreement: agreement ? {
      n: agreement.n, agreement: agreement.agreement, tpr: agreement.tpr, tnr: agreement.tnr,
      positives: agreement.positives, negatives: agreement.negatives,
    } : null,
  };
}

const CSV_COLUMNS = Object.freeze([
  'trial_id', 'run_id', 'task_id', 'stage', 'app_slug', 'issue_number', 'model', 'attempt', 'status', 'final_verdict',
  'deterministic_pass', 'opus_verdict', 'human_verdict', 'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms',
  'build_branch', 'build_sha', 'build_commits', 'tag_verdict', 'tag_repo_size', 'tag_request_type', 'tag_difficulty',
  'answer_source', 'error', 'created_at', 'finished_at',
]);

/** A run's trials as CSV rows, in CSV_COLUMNS order. */
async function csvRows(pool, runId) {
  const trials = await runTrials(pool, runId);
  return trials.map((t) => {
    const flat = {
      trial_id: t.id, run_id: Number(runId), task_id: t.task_id, stage: t.stage, app_slug: t.appSlug,
      issue_number: t.issue_number, model: t.model, attempt: t.attempt, status: t.status, final_verdict: t.final,
      deterministic_pass: t.deterministic ? t.deterministic.pass : null, opus_verdict: t.opus, human_verdict: t.human,
      cost_usd: t.cost_usd, input_tokens: t.input_tokens, output_tokens: t.output_tokens, duration_ms: t.duration_ms,
      build_branch: t.build_branch, build_sha: t.build_sha, build_commits: t.build_commits,
      tag_verdict: t.tags.verdict, tag_repo_size: t.tags.repo_size, tag_request_type: t.tags.request_type,
      tag_difficulty: t.tags.difficulty, answer_source: t.answerSource, error: t.error, created_at: t.created_at, finished_at: t.finished_at,
    };
    return CSV_COLUMNS.map((c) => {
      const v = flat[c];
      if (v == null) return '';
      if (v instanceof Date) return v.toISOString();
      return v;
    });
  });
}

module.exports = {
  SLICE_KEYS,
  CONNECTOR_SLICE_KEYS,
  FAILURE_STATUSES,
  CSV_COLUMNS,
  runTrials,
  armKey,
  armsOf,
  summarize,
  answerSource,
  sliceGroups,
  tasteAggregates,
  tasteTrials,
  taskScores,
  runReport,
  reasonText,
  statusAndReasons,
  runAggregates,
  csvRows,
};
