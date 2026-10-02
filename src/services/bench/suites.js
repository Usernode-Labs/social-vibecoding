'use strict';

// #3654: the Homeroom bot benchmark's SUITES and TASKS.
//
// A task is one stage of one real case, frozen: the snapshot of what the bot
// read (services/homeroom-bot-snapshots.js), tags to slice results by, and a
// reference to grade a candidate against. The method this follows is error
// analysis first: a small, high-quality suite drawn from real runs rather
// than a large synthetic one, stratified so one common verdict or one busy
// app cannot stand for the whole, and versioned so two results are only
// compared on the same tasks.
//
//   frozen    the versioned core. Freezing a suite makes its tasks
//             immutable: every write below refuses a frozen suite's task,
//             and an edit is made on the next version (newVersion), which
//             copies the tasks into an unfrozen suite of the same name.
//   rotating  a set refreshed from recent runs, so the core does not slowly
//             stop resembling what people ask for.
//
// Where tasks come from:
//
//   a run     "Add to a benchmark suite" on a run row. Only a run that
//             recorded a snapshot for the stage can be replayed; runs from
//             before #3654 have none.
//   a sample  proposeSample draws N candidates per stage from recorded runs,
//             balanced across verdicts, apps and repository sizes, and
//             preferring issues whose outcome is known (a merged proposal).
//   a merged pull request  importTaskFromPr, for build tasks: the request
//             as it stood when the pull request was opened, the commit the
//             pull request was based on, and the checks it added to
//             dapp.json as the task's hidden checks.
//
// The reference starts from what is known for certain (a labeller's verdict
// on the run, a merged pull request, the answer a person gave in a DM) and
// is completed by a labelling session (services/bench/grading.js).
//
// Every function takes the pool and validates its own input; the routes in
// routes/homeroom-bench.js only gate and translate.

const crypto = require('crypto');
const log = require('../logger');
const snapshots = require('../homeroom-bot-snapshots');

const TASK_STAGES = Object.freeze(['triage', 'spec', 'build', 'followup', 'checks_fix', 'dm']);
const SUITE_KINDS = Object.freeze(['frozen', 'rotating']);
// The snapshot a stage replays. A spec task re-runs the spec turn of a
// build, so it reads the build's snapshot; a DM task re-runs the triage.
const SNAPSHOT_STAGE = Object.freeze({
  triage: 'triage', spec: 'build', build: 'build', followup: 'followup', checks_fix: 'checks_fix', dm: 'triage',
});
// The first version's shape (#3654): ~40 triage, ~20 builds (half on small
// apps, half on the platform's own repository), ~5 follow-ups or check
// fixes, ~5 DM conversations; and a rotating set of ~20.
const TARGETS = Object.freeze({
  frozen: Object.freeze({ triage: 40, build: 20, followup: 5, dm: 5 }),
  rotating: Object.freeze({ total: 20 }),
});
const MAX_SAMPLE = 100;
const MAX_HIDDEN_CHECKS = 25;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

function token() {
  return crypto.randomBytes(12).toString('base64url');
}

function httpError(status, error) {
  return { ok: false, status, error };
}

/** "bug" or "feature", from a request's own words. A labeller may correct it. */
function requestType(title, body = '') {
  const text = `${title || ''}\n${String(body || '').slice(0, 2000)}`;
  return /\b(bug|broken|fix(es|ed)?|crash(es|ed)?|errors?|fails?|failing|doesn'?t work|not working|wrong|regression)\b/i.test(text)
    ? 'bug' : 'feature';
}

/** The platform's own repository is the one large repository; every app is small. */
function repoSize(app, config = {}) {
  const bot = require('../homeroom-bot');
  return bot.isPlatformRepo(app, config) ? 'large' : 'small';
}

// ── Suites ───────────────────────────────────────────────────────────────

async function createSuite(pool, { name, kind = 'frozen', notes = null, actorId = null } = {}) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!NAME_RE.test(clean)) return httpError(400, 'A suite name is 1 to 80 letters, digits, spaces, dots, dashes or underscores');
  if (!SUITE_KINDS.includes(kind)) return httpError(400, 'kind must be frozen or rotating');
  const { rows } = await pool.query(
    `INSERT INTO bench_suites (name, version, kind, notes, created_by)
     VALUES ($1, COALESCE((SELECT MAX(version) FROM bench_suites WHERE name = $1), 0) + 1, $2, $3, $4)
     RETURNING id, name, version, kind, notes, created_at, frozen_at`,
    [clean, kind, notes ? String(notes).slice(0, 2000) : null, actorId],
  );
  return { ok: true, suite: rows[0] };
}

// Each row also says what deleteSuite would decide (`runs`, `is_default`,
// `deletable`), so the console offers Delete only where it would succeed.
async function listSuites(pool) {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.version, s.kind, s.notes, s.parent_id, s.created_at, s.frozen_at,
            u.username AS created_by,
            COALESCE(c.counts, '{}'::jsonb) AS counts,
            COALESCE(c.labelled, 0) AS labelled,
            COALESCE(c.total, 0) AS total,
            r.runs, d.is_default,
            (s.frozen_at IS NULL AND r.runs = 0 AND NOT d.is_default) AS deletable
       FROM bench_suites s
       CROSS JOIN LATERAL (SELECT COUNT(*)::int AS runs FROM bench_runs WHERE suite_id = s.id) r
       CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM bench_materializations WHERE suite_id = s.id) AS is_default) d
       LEFT JOIN users u ON u.id = s.created_by
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(stage, n) AS counts, SUM(n)::int AS total, SUM(l)::int AS labelled
           FROM (SELECT stage, COUNT(*)::int AS n,
                        COUNT(*) FILTER (WHERE reference_source IS NOT NULL)::int AS l
                   FROM bench_tasks WHERE suite_id = s.id GROUP BY stage) per_stage
       ) c ON TRUE
      ORDER BY s.name, s.version DESC`,
  );
  return rows;
}

async function suiteRow(pool, id) {
  const { rows } = await pool.query('SELECT * FROM bench_suites WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

/**
 * Freeze a suite: its tasks are immutable from now on. A suite materialized
 * from a checked-in definition (Core v1, services/bench/core.js) is frozen
 * only once every task has its reference: a frozen task can no longer be
 * labelled, so freezing it unlabelled would leave it ungradable for good.
 * Hand-made suites keep the old rule (any task at all).
 */
async function freezeSuite(pool, id) {
  const suite = await suiteRow(pool, id);
  if (!suite) return httpError(404, 'Suite not found');
  if (suite.frozen_at) return httpError(409, 'The suite is already frozen');
  const { rows: [{ n, unlabelled, defined }] } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE reference_source IS NULL)::int AS unlabelled,
            EXISTS (SELECT 1 FROM bench_materializations WHERE suite_id = $1) AS defined
       FROM bench_tasks WHERE suite_id = $1`,
    [suite.id],
  );
  if (!n) return httpError(409, 'A suite with no tasks cannot be frozen');
  if (defined && unlabelled) {
    return httpError(409, `${unlabelled} of ${n} tasks have no reference yet: label them before freezing (a frozen task cannot be labelled)`);
  }
  const { rows } = await pool.query(
    'UPDATE bench_suites SET frozen_at = NOW() WHERE id = $1 AND frozen_at IS NULL RETURNING id, frozen_at',
    [suite.id],
  );
  return { ok: true, suite: rows[0] };
}

/**
 * The next version of a suite: a new, unfrozen suite of the same name with
 * a copy of every task (new label tokens, the same snapshots, tags and
 * references). Edits happen there; the frozen version stays what earlier
 * results were measured on.
 */
async function newVersion(pool, id, { actorId = null } = {}) {
  const suite = await suiteRow(pool, id);
  if (!suite) return httpError(404, 'Suite not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [next] } = await client.query(
      `INSERT INTO bench_suites (name, version, kind, notes, parent_id, created_by)
       VALUES ($1, (SELECT MAX(version) FROM bench_suites WHERE name = $1) + 1, $2, $3, $4, $5)
       RETURNING id, name, version, kind, created_at, frozen_at`,
      [suite.name, suite.kind, suite.notes, suite.id, actorId],
    );
    const { rows: tasks } = await client.query(
      'SELECT id FROM bench_tasks WHERE suite_id = $1 ORDER BY id', [suite.id],
    );
    for (const t of tasks) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO bench_tasks (suite_id, stage, source_run_id, snapshot_id, app_id, issue_number,
                                  tags, reference, reference_source, labeled_by, labeled_at, label_token)
         SELECT $1, stage, source_run_id, snapshot_id, app_id, issue_number,
                tags, reference, reference_source, labeled_by, labeled_at, $3
           FROM bench_tasks WHERE id = $2`,
        [next.id, t.id, token()],
      );
    }
    await client.query('COMMIT');
    return { ok: true, suite: next, copied: tasks.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a suite and its tasks, for a suite made by mistake. Refused for a
 * frozen suite (the answer key past runs were graded against), for one with
 * runs (bench_runs would cascade away with it), and for the default suite a
 * checked-in definition was materialized into (Core). The checks run under
 * a lock on the suite row, which a run being launched against it must share
 * to insert, so no run can slip in between the check and the delete.
 */
async function deleteSuite(pool, { suiteId, actorId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [suite] } = await client.query(
      'SELECT id, name, version, frozen_at FROM bench_suites WHERE id = $1 FOR UPDATE', [Number(suiteId)],
    );
    let refusal = null;
    if (!suite) refusal = httpError(404, 'Suite not found');
    else if (suite.frozen_at) refusal = httpError(409, 'The suite is frozen: a frozen suite is the answer key past runs were graded against');
    else {
      const { rows: [f] } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM bench_runs WHERE suite_id = $1) AS has_runs,
                EXISTS (SELECT 1 FROM bench_materializations WHERE suite_id = $1) AS is_default`,
        [suite.id],
      );
      if (f.has_runs) refusal = httpError(409, 'The suite cannot be deleted: it has runs');
      else if (f.is_default) refusal = httpError(409, 'The suite cannot be deleted: it is the default suite; make a new version instead');
    }
    if (refusal) {
      await client.query('ROLLBACK');
      return refusal;
    }
    const { rowCount: tasks } = await client.query('DELETE FROM bench_tasks WHERE suite_id = $1', [suite.id]);
    await client.query('DELETE FROM bench_suites WHERE id = $1', [suite.id]);
    await client.query('COMMIT');
    log.info('bench', 'Suite deleted', { actorId, suiteId: suite.id, name: suite.name, version: suite.version, tasks });
    return { ok: true, deleted: { suiteId: suite.id, tasks } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────

async function listTasks(pool, suiteId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.suite_id, t.stage, t.source_run_id, t.snapshot_id, t.issue_number, t.tags,
            t.reference, t.reference_source, t.labeled_at, t.created_at,
            a.slug AS app_slug, a.name AS app_name, u.username AS labeled_by,
            sn.base_sha, sn.source AS snapshot_source
       FROM bench_tasks t
       LEFT JOIN apps a ON a.id = t.app_id
       LEFT JOIN users u ON u.id = t.labeled_by
       LEFT JOIN homeroom_bot_run_snapshots sn ON sn.id = t.snapshot_id
      WHERE t.suite_id = $1
      ORDER BY t.stage, t.id`,
    [Number(suiteId)],
  );
  return rows;
}

/** A task with its suite's frozen mark, by id or by its opaque label token. */
async function taskRow(pool, { taskId = null, labelToken = null }) {
  const { rows } = await pool.query(
    `SELECT t.*, s.frozen_at, s.name AS suite_name, s.version AS suite_version
       FROM bench_tasks t JOIN bench_suites s ON s.id = t.suite_id
      WHERE ($1::int IS NOT NULL AND t.id = $1::int) OR ($2::text IS NOT NULL AND t.label_token = $2::text)
      LIMIT 1`,
    [taskId == null ? null : Number(taskId), labelToken || null],
  );
  return rows[0] || null;
}

/** Why a run's stage can or cannot become a task, and what it starts from. */
async function runFacts(pool, runId) {
  const { rows } = await pool.query(
    `SELECT r.id, r.app_id, r.issue_number, r.verdict, r.label_verdict, r.build_ok, r.proposal_session_id,
            r.question_answers, a.slug AS app_slug, a.repo_url,
            ps.status AS proposal_status, ps.pr_number AS proposal_pr,
            dm.answer_text
       FROM homeroom_bot_runs r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions ps ON ps.id = r.proposal_session_id
       LEFT JOIN LATERAL (
         SELECT m.content AS answer_text
           FROM homeroom_bot_dm_messages d
           JOIN conversation_messages m ON m.id = d.answer_message_id
          WHERE d.run_id = r.id AND d.answered_at IS NOT NULL
          ORDER BY d.answered_at LIMIT 1
       ) dm ON TRUE
      WHERE r.id = $1`,
    [Number(runId)],
  );
  return rows[0] || null;
}

function knownOutcome(facts) {
  if (facts.proposal_status === 'merged') return 'merged';
  if (facts.proposal_session_id) return 'proposed';
  if (facts.build_ok === true) return 'built';
  return null;
}

/**
 * Tags and the starting reference for one stage of one run. Pure: what the
 * run says (its labelled verdict, its merged proposal, a DM answer), never
 * the bot's own verdict as a reference, which would grade the bot against
 * itself. The bot's verdict is a stratification tag only.
 */
function startingTask(stage, facts, snapshot, config = {}) {
  const issue = snapshot?.thread?.issue || {};
  const outcome = knownOutcome(facts);
  const tags = {
    verdict: facts.label_verdict || (facts.verdict === 'failed' ? 'unknown' : facts.verdict),
    app_slug: facts.app_slug,
    repo_size: repoSize({ repo_url: facts.repo_url }, config),
    request_type: requestType(issue.title, issue.body),
    difficulty: null,
    known_outcome: outcome,
    prompt_chars: snapshot?.texts?.prompt ? snapshot.texts.prompt.length : null,
  };
  let reference = {};
  let source = null;
  if (stage === 'triage' && facts.label_verdict) {
    reference = { verdict: facts.label_verdict };
    source = 'human';
  }
  if ((stage === 'build' || stage === 'spec') && outcome === 'merged' && facts.proposal_pr) {
    reference = { reference_pr: Number(facts.proposal_pr), proposal_session_id: Number(facts.proposal_session_id) };
    source = 'merged_pr';
  }
  if (stage === 'dm') {
    reference = {
      dm_script: {
        // What the person actually answered, in their own words: the
        // simulated user (services/bench/dm-sim.js) answers the same way.
        true_answer: facts.answer_text || null,
        accepted: [],
        max_turns: 3,
      },
    };
  }
  return { tags, reference, source };
}

/** "Add to a benchmark suite" on a run row. */
async function addTaskFromRun(pool, { suiteId, runId, stage, config = {} } = {}) {
  if (!TASK_STAGES.includes(stage)) return httpError(400, `stage must be one of ${TASK_STAGES.join(', ')}`);
  const suite = await suiteRow(pool, suiteId);
  if (!suite) return httpError(404, 'Suite not found');
  if (suite.frozen_at) return httpError(409, 'The suite is frozen: make a new version to add tasks');
  const facts = await runFacts(pool, runId);
  if (!facts) return httpError(404, 'Run not found');
  const snapshot = await snapshots.snapshotForRun(pool, facts.id, SNAPSHOT_STAGE[stage]);
  if (!snapshot) {
    return httpError(409, `This run recorded no ${SNAPSHOT_STAGE[stage]} snapshot, so it cannot be replayed (runs from before snapshots existed have none)`);
  }
  if (stage === 'dm' && (facts.verdict !== 'question' || !facts.answer_text)) {
    return httpError(409, 'A DM task needs a question run its requester answered in a DM');
  }
  const { tags, reference, source } = startingTask(stage, facts, snapshot, config);
  try {
    const { rows } = await pool.query(
      `INSERT INTO bench_tasks (suite_id, stage, source_run_id, snapshot_id, app_id, issue_number,
                                tags, reference, reference_source, label_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       RETURNING id, stage, tags, reference, reference_source`,
      [suite.id, stage, facts.id, snapshot.id, facts.app_id, facts.issue_number,
        JSON.stringify(tags), JSON.stringify(reference), source, token()],
    );
    return { ok: true, task: rows[0] };
  } catch (err) {
    if (err.code === '23505') return httpError(409, 'That run is already in this suite at that stage');
    throw err;
  }
}

/**
 * Insert one task row as it is: the materializer's path (services/bench/
 * core.js), which has already resolved the snapshot, tags and reference.
 * `referenceSource` 'authored' is a reference written into the suite's
 * definition by its author.
 */
async function insertTask(pool, {
  suiteId, stage, sourceRunId = null, snapshotId, appId, issueNumber, tags = {}, reference = {}, referenceSource = null,
}) {
  if (!TASK_STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  if (referenceSource != null && !['human', 'opus', 'merged_pr', 'authored'].includes(referenceSource)) {
    throw new Error(`unknown reference source ${referenceSource}`);
  }
  const { rows } = await pool.query(
    `INSERT INTO bench_tasks (suite_id, stage, source_run_id, snapshot_id, app_id, issue_number,
                              tags, reference, reference_source, label_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING id, stage, tags, reference, reference_source`,
    [suiteId, stage, sourceRunId, snapshotId, appId, issueNumber, JSON.stringify(tags), JSON.stringify(reference),
      referenceSource, token()],
  );
  return rows[0];
}

async function removeTask(pool, { taskId }) {
  const task = await taskRow(pool, { taskId });
  if (!task) return httpError(404, 'Task not found');
  if (task.frozen_at) return httpError(409, 'The suite is frozen: its tasks cannot change');
  await pool.query('DELETE FROM bench_tasks WHERE id = $1', [task.id]);
  return { ok: true };
}

const REFERENCE_KEYS = Object.freeze([
  'verdict', 'answers', 'notes', 'question_needed', 'action', 'expected_files', 'allowed_test_edits',
  'hidden_checks', 'reference_pr', 'reference_sha', 'base_sha', 'dm_script', 'spec_points',
]);
const TAG_KEYS = Object.freeze(['verdict', 'request_type', 'difficulty']);

/** Whether a DM script's answer is the requester's own (not one written for them). */
function isRealAnswer(script) {
  return !!script?.true_answer && script.source !== 'scripted';
}

/**
 * Record (part of) a task's reference: a labelling session's verdict and
 * answers, or an admin's. Merged into what is there, refused on a frozen
 * suite. Unknown keys are dropped.
 */
async function setReference(pool, { taskId = null, labelToken = null, patch = {}, tags = {}, source, actorId = null }) {
  if (!['human', 'opus', 'merged_pr'].includes(source)) return httpError(400, 'Unknown reference source');
  const task = await taskRow(pool, { taskId, labelToken });
  if (!task) return httpError(404, 'Task not found');
  if (task.frozen_at) return httpError(409, 'The suite is frozen: label the task on a new version');
  const ref = {};
  for (const key of REFERENCE_KEYS) if (patch[key] !== undefined) ref[key] = patch[key];
  // A DM task's answer (services/bench/core.js resolveDm): one its requester
  // never gave is written before the task counts as labelled, and one they
  // did give is never replaced.
  if (task.stage === 'dm') {
    const had = task.reference?.dm_script;
    const next = ref.dm_script !== undefined ? ref.dm_script : had;
    if (had && !had.true_answer && !next?.true_answer) {
      return httpError(400, 'The requester never answered this DM task\'s question: write their answer (dmAnswer) before labelling it');
    }
    if (isRealAnswer(had) && ref.dm_script !== undefined && ref.dm_script?.true_answer !== had.true_answer) {
      return httpError(409, 'This DM task has the requester\'s real answer, which is never replaced');
    }
  }
  const tagPatch = {};
  for (const key of TAG_KEYS) if (tags[key] !== undefined) tagPatch[key] = tags[key];
  const { rows } = await pool.query(
    `UPDATE bench_tasks
        SET reference = reference || $2::jsonb, tags = tags || $3::jsonb,
            reference_source = $4, labeled_by = $5, labeled_at = NOW()
      WHERE id = $1
      RETURNING id, stage, reference, reference_source, tags, labeled_at`,
    [task.id, JSON.stringify(ref), JSON.stringify(tagPatch), source, actorId],
  );
  return { ok: true, task: rows[0] };
}

// ── Importing a merged pull request as a build task ─────────────────────

function parseTests(text) {
  try {
    const manifest = JSON.parse(text || '{}');
    return Array.isArray(manifest.tests) ? manifest.tests.filter((t) => t && typeof t === 'object') : [];
  } catch {
    return [];
  }
}

/** The checks a change added or changed in dapp.json: the task's hidden checks. */
function addedChecks(baseText, headText) {
  const before = new Set(parseTests(baseText).map((t) => JSON.stringify(t)));
  return parseTests(headText).filter((t) => !before.has(JSON.stringify(t))).slice(0, MAX_HIDDEN_CHECKS);
}

/**
 * A build task from a merged pull request (#3654): the request's thread as it
 * stood when the pull request was opened (later comments would give the
 * answer away), the pull request's base commit, and the checks it added to
 * dapp.json as hidden checks. Recorded as an imported snapshot.
 */
async function importTaskFromPr(pool, {
  suiteId, appSlug, issueNumber, prNumber, config = {}, deps = {},
  // Core v1 (services/bench/core.js): the base commit its definition names
  // (the work order's, which GitHub's base.sha need not equal), a request
  // that is the pull request's own description (a change with no issue),
  // and tags/extra recorded beside the task.
  baseSha: baseOverride = null, requestFromPr = false, tags: moreTags = {}, extra: moreExtra = {},
} = {}) {
  const github = deps.github || require('../github');
  const threadContext = deps.threadContext || require('../thread-context');
  const sessions = deps.sessions || require('../../routes/sessions');
  const live = require('../homeroom-bot-live');
  const pr = Number(prNumber);
  const n = requestFromPr ? pr : Number(issueNumber);
  if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(pr) || pr <= 0) {
    return httpError(400, 'issueNumber and prNumber must be positive integers');
  }
  const suite = await suiteRow(pool, suiteId);
  if (!suite) return httpError(404, 'Suite not found');
  if (suite.frozen_at) return httpError(409, 'The suite is frozen: make a new version to add tasks');
  const { rows: [app] } = await pool.query(
    'SELECT id, slug, repo_url FROM apps WHERE slug = $1', [String(appSlug || '')],
  );
  if (!app) return httpError(404, 'App not found');
  const bot = require('../homeroom-bot');
  const repo = bot.parseRepo(app.repo_url);
  if (!repo || !github.isEnabled()) return httpError(503, 'GitHub is not available for that app');

  let pull;
  try {
    pull = await github.getPR(repo.owner, repo.repo, pr);
  } catch (err) {
    return httpError(err.status === 404 ? 404 : 502, `Could not read PR #${pr}: ${err.message}`);
  }
  if (!pull?.merged_at || !pull.merge_commit_sha) return httpError(409, `PR #${pr} is not merged`);
  const prBaseSha = pull.base?.sha || null;
  const baseSha = (typeof baseOverride === 'string' && /^[0-9a-f]{40}$/i.test(baseOverride)) ? baseOverride.toLowerCase() : prBaseSha;
  if (!baseSha) return httpError(502, `PR #${pr} has no base commit`);

  let issue;
  let keptComments = [];
  let keptThread = [];
  let seed;
  const botLogin = await live.botUsernameOf(github);
  if (requestFromPr) {
    // No request of its own: the pull request's description is the task.
    // The seed names no number, so it does not point the model at the
    // merged pull request (the answer).
    issue = { number: n, title: String(pull.title || ''), body: String(pull.body || ''), author: pull.user?.login || null, createdAt: pull.created_at || null };
    seed = `Please work on this request: "${issue.title}".${issue.body ? `\n\n${issue.body}` : ''}`;
  } else {
    const fetched = await github.fetchPublicIssue(repo.owner, repo.repo, n);
    issue = fetched?.issue || null;
    if (!issue) return httpError(404, `Issue #${n} was not found`);
    const cutoff = Date.parse(pull.created_at) || Date.now();
    const before = (at) => !at || Date.parse(at) <= cutoff;
    const [{ comments = [] } = {}, thread] = await Promise.all([
      github.fetchIssueComments(repo.owner, repo.repo, n).catch(() => ({ comments: [] })),
      threadContext.loadIssueThread(pool, app.id, n),
    ]);
    keptComments = comments.filter((c) => before(c.createdAt));
    keptThread = (thread?.messages || []).filter((m) => before(m.createdAt));
    seed = sessions.buildHeadlessSeed(n, issue, keptComments, botLogin, keptThread);
  }

  let hidden = [];
  let files = [];
  try {
    const [baseManifest, headManifest] = await Promise.all([
      github.getFileContent(repo.owner, repo.repo, 'dapp.json', baseSha),
      github.getFileContent(repo.owner, repo.repo, 'dapp.json', pull.merge_commit_sha),
    ]);
    hidden = addedChecks(baseManifest, headManifest);
  } catch (err) {
    log.warn('bench', 'Could not read the pull request\'s checks', { appSlug, prNumber: pr, err: err.message });
  }
  try {
    files = (await github.listChangedFiles(repo.owner, repo.repo, `${baseSha}...${pull.merge_commit_sha}`)).slice(0, 300);
  } catch (err) {
    log.warn('bench', 'Could not list the pull request\'s files', { appSlug, prNumber: pr, err: err.message });
  }

  const platformRepo = bot.isPlatformRepo(app, config);
  const snapshotId = await snapshots.recordSnapshot(pool, {
    runId: null, stage: 'build', appId: app.id, issueNumber: n, baseSha, source: 'import',
    texts: {
      seed,
      build_note: '',
      thread: snapshots.frozenThread({ issueNumber: n, issue, comments: keptComments, threadMessages: keptThread, botLogin }),
    },
    extra: {
      ...moreExtra, platformRepo, importedFrom: { prNumber: pr, mergeSha: pull.merge_commit_sha, prBaseSha },
      ...(requestFromPr ? { requestFromPr: true } : {}),
    },
  });
  if (!snapshotId) return httpError(500, 'Could not record the task\'s snapshot');
  const tags = {
    verdict: 'ready', app_slug: app.slug, repo_size: platformRepo ? 'large' : 'small',
    request_type: requestType(issue.title, issue.body), difficulty: null, known_outcome: 'merged',
    prompt_chars: seed.length, ...moreTags,
  };
  const reference = {
    reference_pr: pr, reference_sha: pull.merge_commit_sha, base_sha: baseSha,
    hidden_checks: hidden, expected_files: files, title: String(pull.title || '').slice(0, 300),
  };
  const { rows } = await pool.query(
    `INSERT INTO bench_tasks (suite_id, stage, source_run_id, snapshot_id, app_id, issue_number,
                              tags, reference, reference_source, label_token)
     VALUES ($1, 'build', NULL, $2, $3, $4, $5::jsonb, $6::jsonb, 'merged_pr', $7)
     RETURNING id, stage, tags, reference, reference_source`,
    [suite.id, snapshotId, app.id, n, JSON.stringify(tags), JSON.stringify(reference), token()],
  );
  return { ok: true, task: rows[0], hiddenChecks: hidden.length, snapshotId };
}

// ── The stratified sampler ──────────────────────────────────────────────

// A tiny seeded PRNG (mulberry32), so a sample is reproducible from its seed.
function prng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTCOME_RANK = Object.freeze({ merged: 0, proposed: 1, built: 2 });

/**
 * Pick `n` candidates spread across strata. Pure and deterministic for a
 * seed. Strata are the combinations of `keys` (default: the verdict and the
 * repository size); the picker takes from each stratum in turn, so a rare
 * verdict is not drowned by a common one, and within a stratum it takes the
 * candidate with a known outcome first and then the one whose app has been
 * picked least, so one busy app does not fill the sample.
 *
 * candidates: [{ id, tags: { verdict, repo_size, app_slug, known_outcome } }]
 */
function stratifiedSample(candidates, n, { keys = ['verdict', 'repo_size'], seed = 1 } = {}) {
  const want = Math.max(0, Math.min(Number(n) || 0, MAX_SAMPLE));
  const rand = prng(seed);
  const jitter = new Map((candidates || []).map((c) => [c, rand()]));
  const strata = new Map();
  for (const c of candidates || []) {
    const key = keys.map((k) => String(c.tags?.[k] ?? '?')).join('|');
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(c);
  }
  const rank = (c) => OUTCOME_RANK[c.tags?.known_outcome] ?? 3;
  for (const list of strata.values()) list.sort((a, b) => (rank(a) - rank(b)) || (jitter.get(a) - jitter.get(b)));
  const order = [...strata.keys()].sort();
  const perApp = new Map();
  const picked = [];
  while (picked.length < want) {
    let took = false;
    for (const key of order) {
      if (picked.length >= want) break;
      const list = strata.get(key);
      if (!list.length) continue;
      // The best-ranked outcome first; among those, the least-picked app.
      const bestRank = rank(list[0]);
      let at = 0;
      let fewest = Infinity;
      for (let i = 0; i < list.length && rank(list[i]) === bestRank; i += 1) {
        const count = perApp.get(list[i].tags?.app_slug) || 0;
        if (count < fewest) { fewest = count; at = i; }
      }
      const [c] = list.splice(at, 1);
      perApp.set(c.tags?.app_slug, (perApp.get(c.tags?.app_slug) || 0) + 1);
      picked.push(c);
      took = true;
    }
    if (!took) break;
  }
  return picked;
}

/**
 * The runs a stage could draw tasks from: the newest run per issue that
 * recorded the stage's snapshot, not already in the suite. Each carries the
 * tags the sampler balances on.
 */
async function candidateRuns(pool, { stage, suiteId = null, limit = 2000, config = {} }) {
  const snapStage = SNAPSHOT_STAGE[stage];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.app_id, r.issue_number)
            r.id, r.app_id, r.issue_number, r.verdict, r.label_verdict, r.build_ok, r.proposal_session_id,
            r.created_at, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            ps.status AS proposal_status, sn.id AS snapshot_id,
            EXISTS (SELECT 1 FROM homeroom_bot_dm_messages d
                     WHERE d.run_id = r.id AND d.answered_at IS NOT NULL AND d.answer_message_id IS NOT NULL) AS dm_answered
       FROM homeroom_bot_run_snapshots sn
       JOIN homeroom_bot_runs r ON r.id = sn.run_id
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN chat_sessions ps ON ps.id = r.proposal_session_id
      WHERE sn.stage = $1
        AND ($2::int IS NULL OR NOT EXISTS (
              SELECT 1 FROM bench_tasks t
               WHERE t.suite_id = $2::int AND t.stage = $3
                 AND t.app_id = r.app_id AND t.issue_number = r.issue_number))
      ORDER BY r.app_id, r.issue_number, r.id DESC
      LIMIT $4`,
    [snapStage, suiteId == null ? null : Number(suiteId), stage, Math.min(Number(limit) || 2000, 5000)],
  );
  return rows
    .filter((r) => (stage === 'dm' ? r.verdict === 'question' && r.dm_answered : true))
    .filter((r) => (stage === 'build' || stage === 'spec' ? r.verdict === 'ready' : true))
    .map((r) => ({
      id: r.id,
      appSlug: r.app_slug,
      appName: r.app_name,
      issueNumber: r.issue_number,
      createdAt: r.created_at,
      tags: {
        verdict: r.label_verdict || (r.verdict === 'failed' ? 'unknown' : r.verdict),
        app_slug: r.app_slug,
        repo_size: repoSize({ repo_url: r.repo_url }, config),
        known_outcome: knownOutcome(r),
      },
    }));
}

/** N proposed tasks for one stage of a suite, for an admin to accept. */
async function proposeSample(pool, { suiteId = null, stage, n = 10, seed = 1, config = {} } = {}) {
  if (!TASK_STAGES.includes(stage)) return httpError(400, `stage must be one of ${TASK_STAGES.join(', ')}`);
  const candidates = await candidateRuns(pool, { stage, suiteId, config });
  // A build sample is balanced on the repository first: half small apps,
  // half the platform's own repository, as the first version asks.
  const keys = stage === 'build' || stage === 'spec' ? ['repo_size', 'verdict'] : ['verdict', 'repo_size'];
  return {
    ok: true,
    stage,
    available: candidates.length,
    picked: stratifiedSample(candidates, n, { keys, seed }),
  };
}

module.exports = {
  TASK_STAGES,
  SUITE_KINDS,
  SNAPSHOT_STAGE,
  TARGETS,
  REFERENCE_KEYS,
  requestType,
  repoSize,
  createSuite,
  listSuites,
  suiteRow,
  freezeSuite,
  newVersion,
  deleteSuite,
  listTasks,
  taskRow,
  startingTask,
  addTaskFromRun,
  insertTask,
  removeTask,
  setReference,
  isRealAnswer,
  addedChecks,
  importTaskFromPr,
  prng,
  stratifiedSample,
  candidateRuns,
  proposeSample,
};
