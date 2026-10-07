'use strict';

// #3737: the benchmark's TASTE EVAL for first versions: how the screens a
// first version ships look, judged from screenshots, before and after a
// change to how the bot builds them. Part of #3737's research (its section
// 5); the services/bench/ design applies throughout, and this module adds
// two task kinds to it:
//
//   first_version  a brief, an app name and the starter to begin from
//                  (today's Empty starter). The trial renders that starter
//                  for the name with the platform's own template code
//                  (services/template.js), as a commit with no history on
//                  the trial's `bench/` branch, files the brief as the
//                  request the bot reads for a new project (homeroom-bot-dm
//                  firstVersionIssue), and runs the bot's real first-version
//                  path on it with its current prompts and harness: triage
//                  with the first-version note, then spec and build
//                  (homeroom-bot-live buildAndPropose, firstVersion). Then
//                  the screenshot step (services/bench/capture.js).
//   capture        the "before" arm: an existing app's repository at a
//                  commit an admin names (its historical first version,
//                  say), with no build, only the screenshot step. It is
//                  graded against the same brief, so an admin naming an app
//                  that already has a first-version task in the suite need
//                  not type the brief again.
//
// Both run in the sealed worker every trial gets (services/bench/runner.js)
// and are graded on one rubric (grading.js RUBRICS.taste), by a judge who
// cannot tell the two apart: a grade item says `taste`, never which kind.
//
// A task's inputs live in its snapshot (texts.brief; extra.appName,
// template, sha), like every other task's, and are DATA: the checked-in
// definition (suites/taste-v1.json) seeds them, and an admin edits them
// while the suite is not frozen (editTask records a new snapshot). A brief
// that starts with "placeholder:" is never run: its trials are not
// applicable until it is replaced (notRunnableReason).
//
// The suite is made from its definition a little after boot on production
// and staging, as Core's is (startOnBoot): rows in the database and no
// GitHub, model or worker. Nothing is ever run without an admin launching
// a run.

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const snapshots = require('../homeroom-bot-snapshots');
const suites = require('./suites');

const { TASTE_STAGES } = suites;
const DEFINITION_FILE = path.join(__dirname, 'suites', 'taste-v1.json');
// The request a first version is filed as is its project's first; the
// number is only what the request's text and the trial's snapshot carry.
const ISSUE_NUMBER = 1;
// Who the request says filed it: a fake requester, never a real person.
const REQUESTER = 'staging-demo-requester';
const PLACEHOLDER_RE = /^\s*placeholder\s*:/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 200;
const BOOT_DELAY_MS = 120 * 1000;

function httpError(status, error) {
  return { ok: false, status, error };
}

function isTasteStage(stage) {
  return TASTE_STAGES.includes(stage);
}

/** Whether a brief is the seeded stand-in an admin still has to replace. Pure. */
function isPlaceholder(brief) {
  return PLACEHOLDER_RE.test(String(brief || ''));
}

/** The slug a starter is rendered for, from the app's name. Pure. */
function slugOf(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'first-version';
}

/**
 * A task's inputs, checked and cleaned. Pure. A first version needs a brief
 * the create dialog would accept, a name and a known starter; a capture
 * needs a full commit id (its brief and name come from the suite when left
 * out, see addTask).
 */
function validateInput(kind, raw = {}) {
  const dm = require('../homeroom-bot-dm');
  const appTemplates = require('../app-templates');
  if (!isTasteStage(kind)) return httpError(400, `kind must be ${TASTE_STAGES.join(' or ')}`);
  const appName = String(raw.appName || '').replace(/\s+/g, ' ').trim();
  if (!appName || appName.length > NAME_MAX) return httpError(400, `The app's name is 1 to ${NAME_MAX} characters`);
  const brief = dm.normalizeBrief(raw.brief);
  if (!brief) return httpError(400, 'The brief is too short: describe the app as its creator would');
  const input = { appName, brief };
  if (kind === 'first_version') {
    const template = raw.template == null || raw.template === '' ? appTemplates.DEFAULT_TEMPLATE : String(raw.template);
    if (!appTemplates.isTemplate(template)) return httpError(400, `Unknown starter template: ${template}`);
    input.template = template;
    const description = String(raw.description || '').replace(/\s+/g, ' ').trim();
    if (description) input.description = description.slice(0, DESCRIPTION_MAX);
  } else {
    const sha = String(raw.sha || '').trim().toLowerCase();
    if (!SHA_RE.test(sha)) return httpError(400, 'A capture task needs the full 40-character commit to check out');
    input.sha = sha;
  }
  return { ok: true, input };
}

/** A taste task's inputs, read back from its snapshot. Pure. */
function inputOf(snapshot) {
  const extra = snapshot?.extra || {};
  const brief = snapshot?.texts?.brief || '';
  return {
    kind: extra.taste || null,
    appName: extra.appName || '',
    brief,
    template: extra.template || null,
    description: extra.description || null,
    sha: extra.sha || snapshot?.baseSha || null,
    placeholder: isPlaceholder(brief),
  };
}

/** Why a taste task cannot be run yet, or null. Pure over the task row's tags. */
function notRunnableReason(task) {
  if (!isTasteStage(task?.stage)) return null;
  if (task.tags?.brief_placeholder) return 'the brief is a placeholder: replace it with the original before running this task';
  return null;
}

/**
 * The request the bot reads for this first version, as it would be filed.
 * `card` is the first session's card (services/bench/scaffold.js
 * requestCard), quoted as a project's first request quotes it. Pure.
 */
function firstVersionRequest(input, card = null) {
  const { firstVersionIssue } = require('../homeroom-bot-dm');
  return firstVersionIssue({ name: input.appName, username: REQUESTER, brief: input.brief, botBuilds: true, card });
}

/** The seed the triage and the build read, as the bot builds one from a filed request. */
function seedFor(input, botLogin = null, card = null) {
  const sessions = require('../../routes/sessions');
  return sessions.buildHeadlessSeed(ISSUE_NUMBER, firstVersionRequest(input, card), [], botLogin, []);
}

/**
 * Today's starter, rendered for this app by the template code a new
 * project is created with. No database URL (the template never writes one)
 * and no repository: a pointer to the app's real repository would send the
 * agent to its later history.
 */
function scaffoldFiles(input) {
  const { getTemplateFiles } = require('../template');
  return getTemplateFiles(input.appName, slugOf(input.appName), '', null, {
    template: input.template || null,
    description: input.description || null,
  });
}

/** Record a task's inputs as its snapshot. Resolves the snapshot's id. */
async function recordInput(pool, { appId, kind, input }) {
  return snapshots.recordSnapshot(pool, {
    runId: null, stage: suites.SNAPSHOT_STAGE[kind], appId, issueNumber: ISSUE_NUMBER,
    baseSha: input.sha || null, source: 'import',
    texts: { brief: input.brief },
    extra: {
      taste: kind, appName: input.appName,
      ...(input.template ? { template: input.template } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.sha ? { sha: input.sha } : {}),
    },
  });
}

function tagsFor(kind, app, input, ref) {
  return {
    taste: kind, app_slug: app.slug, repo_size: 'small', request_type: 'feature', difficulty: null, known_outcome: null,
    prompt_chars: input.brief.length, brief_placeholder: isPlaceholder(input.brief),
    ...(ref ? { taste_ref: String(ref).slice(0, 80) } : {}),
  };
}

/** The suite's first-version task on an app, when it has one: what a capture task borrows its brief from. */
async function pairedInput(pool, suiteId, appId) {
  const { rows: [t] } = await pool.query(
    `SELECT snapshot_id FROM bench_tasks
      WHERE suite_id = $1 AND app_id = $2 AND stage = 'first_version'
      ORDER BY id LIMIT 1`,
    [Number(suiteId), Number(appId)],
  );
  if (!t) return null;
  return inputOf(await snapshots.readSnapshot(pool, t.snapshot_id));
}

/**
 * Add one taste task to an unfrozen suite. A capture task with no brief or
 * name takes them from the suite's first-version task on the same app.
 * Resolves { ok, task } or a refusal.
 */
async function addTask(pool, {
  suiteId, kind, appSlug, appName = null, brief = null, template = null, description = null, sha = null, ref = null,
} = {}) {
  if (!isTasteStage(kind)) return httpError(400, `kind must be ${TASTE_STAGES.join(' or ')}`);
  const suite = await suites.suiteRow(pool, suiteId);
  if (!suite) return httpError(404, 'Suite not found');
  if (suite.frozen_at) return httpError(409, 'The suite is frozen: make a new version to add tasks');
  const { rows: [app] } = await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE slug = $1', [String(appSlug || '')]);
  if (!app) return httpError(404, 'App not found');
  if (!require('../homeroom-bot').parseRepo(app.repo_url)) return httpError(409, `${app.slug} has no GitHub repository`);
  let raw = { appName, brief, template, description, sha };
  if (kind === 'capture' && (!String(brief || '').trim() || !String(appName || '').trim())) {
    const paired = await pairedInput(pool, suite.id, app.id);
    raw = {
      ...raw,
      appName: String(appName || '').trim() || paired?.appName || app.name,
      brief: String(brief || '').trim() || paired?.brief || '',
    };
  }
  const v = validateInput(kind, raw);
  if (!v.ok) return v;
  const snapshotId = await recordInput(pool, { appId: app.id, kind, input: v.input });
  if (!snapshotId) return httpError(500, 'Could not record the task\'s inputs');
  const task = await suites.insertTask(pool, {
    suiteId: suite.id, stage: kind, snapshotId, appId: app.id, issueNumber: null,
    tags: tagsFor(kind, app, v.input, ref),
    // There is no answer key: the brief and the rubric are what a judge
    // grades against. Authored, so the task never waits for a label.
    reference: {}, referenceSource: 'authored',
  });
  return { ok: true, task };
}

/**
 * Change a taste task's inputs (brief, name, starter, commit) while its
 * suite is not frozen: a new snapshot with the old inputs and the patch.
 * Trials already run keep the snapshot they ran on.
 */
async function editTask(pool, { taskId, patch = {} } = {}) {
  const task = await suites.taskRow(pool, { taskId });
  if (!task) return httpError(404, 'Task not found');
  if (!isTasteStage(task.stage)) return httpError(400, 'Only a first-version or capture task has a brief to edit');
  if (task.frozen_at) return httpError(409, 'The suite is frozen: edit the task on a new version');
  const current = inputOf(await snapshots.readSnapshot(pool, task.snapshot_id));
  const pick = (key) => (patch[key] !== undefined && patch[key] !== null ? patch[key] : current[key]);
  const v = validateInput(task.stage, {
    appName: pick('appName'), brief: pick('brief'), template: pick('template'), description: pick('description'), sha: pick('sha'),
  });
  if (!v.ok) return v;
  const snapshotId = await recordInput(pool, { appId: task.app_id, kind: task.stage, input: v.input });
  if (!snapshotId) return httpError(500, 'Could not record the task\'s inputs');
  const { rows: [row] } = await pool.query(
    `UPDATE bench_tasks t
        SET snapshot_id = $2,
            tags = t.tags || jsonb_build_object('brief_placeholder', $3::boolean, 'prompt_chars', $4::int)
       FROM bench_suites s
      WHERE t.id = $1 AND s.id = t.suite_id AND s.frozen_at IS NULL
      RETURNING t.id, t.stage, t.tags`,
    [task.id, snapshotId, isPlaceholder(v.input.brief), v.input.brief.length],
  );
  if (!row) return httpError(409, 'The suite was frozen while the task was being edited');
  return { ok: true, task: row, input: v.input };
}

/** Each taste task of a listing with its inputs, for the console to show and edit. */
async function withInputs(pool, tasks) {
  const out = [];
  for (const t of tasks || []) {
    if (!isTasteStage(t.stage)) { out.push(t); continue; }
    // eslint-disable-next-line no-await-in-loop
    const input = inputOf(await snapshots.readSnapshot(pool, t.snapshot_id));
    out.push({
      ...t,
      taste: {
        appName: input.appName, brief: input.brief, template: input.template, sha: input.sha, placeholder: input.placeholder,
      },
    });
  }
  return out;
}

// ── The checked-in definition ────────────────────────────────────────────

function loadDefinition(file = DEFINITION_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Whether a taste definition is well formed. Pure. Every task has a unique
 * ref, a kind, an app and inputs validateInput accepts (a capture's brief
 * and name may come from the suite at materialize time instead).
 */
function validateDefinition(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['not an object'] };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(def.key || ''))) errors.push('key must be a short lower-case slug');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(String(def.name || ''))) errors.push('name is not a valid suite name');
  if (!Number.isInteger(def.version) || def.version <= 0) errors.push('version must be a positive integer');
  if (!suites.SUITE_KINDS.includes(def.kind)) errors.push('kind must be frozen or rotating');
  if (!Array.isArray(def.tasks) || !def.tasks.length) errors.push('tasks must be a non-empty list');
  const refs = new Set();
  for (const [i, t] of (def.tasks || []).entries()) {
    const at = `task ${i} (${t?.ref || 'no ref'})`;
    if (!t || typeof t !== 'object') { errors.push(`${at}: not an object`); continue; }
    if (typeof t.ref !== 'string' || !t.ref) errors.push(`${at}: no ref`);
    else if (refs.has(t.ref)) errors.push(`${at}: duplicate ref`);
    else refs.add(t.ref);
    if (typeof t.app_slug !== 'string' || !t.app_slug) errors.push(`${at}: no app_slug`);
    if (t.kind === 'capture' && !t.brief) {
      if (!SHA_RE.test(String(t.sha || ''))) errors.push(`${at}: a capture task needs its sha`);
      continue;
    }
    const v = validateInput(t.kind, { appName: t.app_name, brief: t.brief, template: t.template, description: t.description, sha: t.sha });
    if (!v.ok) errors.push(`${at}: ${v.error}`);
  }
  return { ok: !errors.length, errors };
}

async function claim(pool, definition) {
  const { rows } = await pool.query(
    `INSERT INTO bench_materializations (definition, version, status, attempts, started_at, heartbeat_at)
     VALUES ($1, $2, 'running', 1, NOW(), NOW())
     ON CONFLICT (definition, version) DO UPDATE
       SET status = 'running', attempts = bench_materializations.attempts + 1, started_at = NOW(),
           heartbeat_at = NOW(), finished_at = NULL
     WHERE bench_materializations.status = 'failed'
     RETURNING *`,
    [definition.key, definition.version],
  );
  return rows[0] || null;
}

/**
 * Make the suite from its definition: once (keyed in bench_materializations
 * like Core), every task whose app exists, and each skipped one with its
 * reason. Idempotent and never fatal. Resolves { ok, noop?, suiteId, summary }.
 */
async function materialize(pool, config = {}, { definition = loadDefinition(), actorId = null } = {}) {
  const v = validateDefinition(definition);
  if (!v.ok) {
    log.error('bench', 'The taste suite definition is invalid', { errors: v.errors.slice(0, 10) });
    return { ok: false, status: 500, error: `The definition is invalid: ${v.errors[0]}` };
  }
  const row = await claim(pool, definition);
  if (!row) {
    const { rows: [current] } = await pool.query(
      'SELECT status, suite_id, summary FROM bench_materializations WHERE definition = $1 AND version = $2',
      [definition.key, definition.version],
    );
    return { ok: true, noop: true, status: current?.status || null, suiteId: current?.suite_id || null, summary: current?.summary || null };
  }
  try {
    let suiteId = row.suite_id || null;
    if (!suiteId || !(await suites.suiteRow(pool, suiteId))) {
      const made = await suites.createSuite(pool, {
        name: definition.name, kind: definition.kind,
        notes: `${definition.notes || ''} Definition ${definition.key} v${definition.version}.`.trim(), actorId,
      });
      if (!made.ok) throw new Error(made.error);
      suiteId = made.suite.id;
      await pool.query(
        'UPDATE bench_materializations SET suite_id = $3 WHERE definition = $1 AND version = $2',
        [definition.key, definition.version, suiteId],
      );
    }
    const skipped = [];
    let ready = 0;
    for (const spec of definition.tasks) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: have } = await pool.query(
        "SELECT 1 FROM bench_tasks WHERE suite_id = $1 AND tags->>'taste_ref' = $2 LIMIT 1", [suiteId, spec.ref],
      );
      if (have.length) { ready += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const out = await addTask(pool, {
        suiteId, kind: spec.kind, appSlug: spec.app_slug, appName: spec.app_name, brief: spec.brief,
        template: spec.template, description: spec.description, sha: spec.sha, ref: spec.ref,
      });
      if (out.ok) ready += 1;
      else skipped.push({ ref: spec.ref, stage: spec.kind, app: spec.app_slug, reason: String(out.error || 'unknown').slice(0, 300) });
    }
    const summary = { definition: definition.key, version: definition.version, suiteId, ready, skipped, finishedAt: new Date().toISOString() };
    await pool.query(
      `UPDATE bench_materializations SET status = 'done', summary = $3::jsonb, finished_at = NOW()
        WHERE definition = $1 AND version = $2`,
      [definition.key, definition.version, JSON.stringify(summary)],
    );
    log.info('bench', 'Taste suite materialized', { definition: `${definition.key}@${definition.version}`, suiteId, ready, skipped: skipped.length });
    return { ok: true, suiteId, summary };
  } catch (err) {
    log.warn('bench', 'Taste suite materialization failed', { err: err.message });
    await pool.query(
      `UPDATE bench_materializations SET status = 'failed', summary = summary || $3::jsonb, finished_at = NOW()
        WHERE definition = $1 AND version = $2`,
      [definition.key, definition.version, JSON.stringify({ error: String(err.message).slice(0, 500) })],
    ).catch(() => {});
    return { ok: false, status: 500, error: err.message };
  }
}

/** On the leader: make the taste suite a little after boot, on production and staging, as Core is. */
function startOnBoot(config, { env = process.env, delayMs = BOOT_DELAY_MS } = {}) {
  if (!require('./core').bootEnabled(env)) return false;
  const timer = setTimeout(() => {
    try {
      const { getPool } = require('../../db/pool');
      materialize(getPool(config), config).catch((err) => log.warn('bench', 'Taste suite boot pass failed', { err: err.message }));
    } catch (err) {
      log.warn('bench', 'Taste suite boot pass failed to start', { err: err.message });
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

module.exports = {
  TASTE_STAGES,
  DEFINITION_FILE,
  ISSUE_NUMBER,
  REQUESTER,
  isTasteStage,
  isPlaceholder,
  slugOf,
  validateInput,
  inputOf,
  notRunnableReason,
  firstVersionRequest,
  seedFor,
  scaffoldFiles,
  addTask,
  editTask,
  withInputs,
  loadDefinition,
  validateDefinition,
  materialize,
  startOnBoot,
};
