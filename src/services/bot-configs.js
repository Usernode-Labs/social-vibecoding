'use strict';

// Homeroom bot CONFIGURATIONS: how the bot builds a project's first version,
// as versioned recipes, and how each one measures up.
//
// ── Recipes and versions ────────────────────────────────────────────────
//
// A recipe is small on purpose:
//
//   models    { triage, spec, build }: an OpenRouter model id per stage
//             (homeroom-bot.js MODEL_ID_RE);
//   reviewer  null, or { model, maxRounds (0 to 5), budgetMinutes }: after
//             the first build, a model looks at the build's screenshots and
//             asks for fixes, one GLM fix turn per round, until it says the
//             screens can ship, the rounds or the minutes run out
//             (services/bot-review.js);
//   pack      null for the platform's own first-version guidance (the spec's
//             FIRST_VERSION_SPEC_DESIGN_BRIEF and the build's design lines,
//             as every first version has them), or an App bench context
//             pack's id (services/bench/packs.js), whose guidance is added to
//             the triage's, the spec's and the build's prompts the way the
//             studio adds it. Its FILES apply only in the studio, whose first
//             commit carries them: a live project's repository already exists.
//
// Every row of bot_config_versions is one immutable VERSION. Editing a
// configuration saves the next version of its key; averages are per version
// and never mixed across versions. A version's role is `current` (the one
// that builds every live first version; exactly one at a time), `side`
// (built silently beside each live first version, for comparison) or
// `retired`. Only FIRST VERSIONS use the current configuration; every other
// build the bot makes keeps the per-stage settings (homeroom-bot.js
// stageModel).
//
// ── Results, pairs and stats ────────────────────────────────────────────
//
// For each live first version, every version that took part gets one
// RESULT (bot_config_results): the current version's from the live build,
// a side version that differs from the current one only by having no
// reviewer from the live build's round-0 snapshot (derivableFrom: the same
// spec and the same build, before any review, so it costs nothing extra and
// the comparison is exactly paired), and any other side version from a
// bench trial on the App bench lane (spawnSideBuilds). Each result's cost
// and active time include the live run's triage, which every configuration
// shares (a side build replays its outcome rather than triaging again).
//
// The current result and each side result of the same live first version
// make a blind PAIR (bot_config_pairs) for an admin to pick through the
// connector: left or right is drawn at random, and nothing in what is shown
// says which configuration made which. A pair where either side did not
// build or boot is never offered; it is counted as that.
//
// A version's win rate against the current version counts a tie as half,
// with a 95% Wilson interval and its n.

const crypto = require('crypto');
const log = require('./logger');

const GLM = 'z-ai/glm-5.3-flash';
const OPUS = 'anthropic/claude-opus-5.5';
const ROLES = Object.freeze(['current', 'side', 'retired']);
const STAGES = Object.freeze(['triage', 'spec', 'build']);
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ROUNDS = 5;
const MIN_BUDGET_MINUTES = 1;
const MAX_BUDGET_MINUTES = 60;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 1000;
// The side builds' own weekly spend, real dollars on the App bench lane's
// key, in cents: a platform setting, $25 unless an admin sets another.
const SIDE_WEEKLY_KEY = 'bot_config_side_weekly_cents';
const DEFAULT_SIDE_WEEKLY_CENTS = 2500;
const MAX_SIDE_WEEKLY_CENTS = 1_000_000;
// The App bench suite side builds are tasks of, one per live first version.
const SIDE_SUITE_NAME = 'Bot configurations';
const SIDE_RUN_KIND = 'bot_config';
// Room left in a side run's cap above its trials' estimates: a run's cap is
// what is left of the week, never more than this many times the estimate.
const SIDE_RUN_CAP_FACTOR = 3;
const MIN_SIDE_RUN_CAP_USD = 0.5;

// The three configurations every deploy starts from. The models were
// confirmed in OpenRouter's catalog on 2026-10-07.
const SEED = Object.freeze([
  Object.freeze({
    seedKey: 'opus-spec-review-v1', key: 'opus-spec-review', label: 'Opus spec, GLM build, Opus review', role: 'current',
    recipe: { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 }, pack: null },
    notes: 'The first versions\' configuration: an Opus 5.5 spec, a GLM 5.3 Flash build, then up to three Opus review rounds that GLM fixes.',
  }),
  Object.freeze({
    seedKey: 'all-glm-v1', key: 'all-glm', label: 'All GLM', role: 'side',
    recipe: { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null },
    notes: 'The pipeline before configurations: GLM 5.3 Flash for every stage, no review. Built for real beside each live first version.',
  }),
  Object.freeze({
    seedKey: 'opus-spec-no-review-v1', key: 'opus-spec-no-review', label: 'Opus spec + GLM, no reviewer', role: 'side',
    recipe: { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: null, pack: null },
    notes: 'The current configuration before any review round: taken from the live build\'s round-0 snapshot, never built on its own.',
  }),
]);

function httpError(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function modelIdRe() {
  return require('./homeroom-bot').MODEL_ID_RE;
}

function num(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

// ── Recipes ──────────────────────────────────────────────────────────────

/**
 * A recipe, checked and put in its one shape. Pure. Resolves
 * { ok: true, recipe } or { ok: false, status: 400, error }. Unknown keys are
 * refused rather than dropped: a recipe is what a result names, so it must
 * say exactly what ran.
 */
function validateRecipe(raw) {
  const re = modelIdRe();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return httpError(400, 'recipe must be an object');
  const extra = Object.keys(raw).filter((k) => !['models', 'reviewer', 'pack'].includes(k));
  if (extra.length) return httpError(400, `recipe has unknown keys: ${extra.join(', ')}`);
  const m = raw.models;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return httpError(400, 'recipe.models must name a model for triage, spec and build');
  const extraStages = Object.keys(m).filter((k) => !STAGES.includes(k));
  if (extraStages.length) return httpError(400, `recipe.models has unknown stages: ${extraStages.join(', ')}`);
  const models = {};
  for (const stage of STAGES) {
    const id = typeof m[stage] === 'string' ? m[stage].trim() : '';
    if (!re.test(id)) return httpError(400, `recipe.models.${stage} must be an OpenRouter model id (vendor/model)`);
    models[stage] = id;
  }
  let reviewer = null;
  if (raw.reviewer != null) {
    const r = raw.reviewer;
    if (typeof r !== 'object' || Array.isArray(r)) return httpError(400, 'recipe.reviewer must be null or { model, maxRounds, budgetMinutes }');
    const bad = Object.keys(r).filter((k) => !['model', 'maxRounds', 'budgetMinutes'].includes(k));
    if (bad.length) return httpError(400, `recipe.reviewer has unknown keys: ${bad.join(', ')}`);
    const model = typeof r.model === 'string' ? r.model.trim() : '';
    if (!re.test(model)) return httpError(400, 'recipe.reviewer.model must be an OpenRouter model id (vendor/model)');
    const maxRounds = Number(r.maxRounds);
    if (!Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > MAX_ROUNDS) {
      return httpError(400, `recipe.reviewer.maxRounds must be a whole number from 0 to ${MAX_ROUNDS}`);
    }
    const budgetMinutes = Number(r.budgetMinutes);
    if (!Number.isInteger(budgetMinutes) || budgetMinutes < MIN_BUDGET_MINUTES || budgetMinutes > MAX_BUDGET_MINUTES) {
      return httpError(400, `recipe.reviewer.budgetMinutes must be a whole number from ${MIN_BUDGET_MINUTES} to ${MAX_BUDGET_MINUTES}`);
    }
    reviewer = { model, maxRounds, budgetMinutes };
  }
  let pack = null;
  if (raw.pack != null) {
    const id = Number(raw.pack);
    if (!Number.isInteger(id) || id <= 0) return httpError(400, 'recipe.pack must be null or an App bench context pack id');
    pack = id;
  }
  return { ok: true, recipe: { models, reviewer, pack } };
}

/** A stored recipe read back in its one shape, or null when it no longer validates. Pure. */
function recipeOf(value) {
  const v = validateRecipe(value);
  return v.ok ? v.recipe : null;
}

/** The recipe as one line: "triage GLM 5.3 Flash · spec Opus 5.5 · …". Pure. */
function recipeLine(recipe) {
  const r = recipeOf(recipe);
  if (!r) return 'not a valid recipe';
  const short = (id) => String(id).split('/').pop();
  const parts = [`triage ${short(r.models.triage)}`, `spec ${short(r.models.spec)}`, `build ${short(r.models.build)}`];
  parts.push(r.reviewer
    ? `review ${short(r.reviewer.model)} ×${r.reviewer.maxRounds} in ${r.reviewer.budgetMinutes} min`
    : 'no review');
  if (r.pack) parts.push(`pack ${r.pack}`);
  return parts.join(' · ');
}

/**
 * Whether a side recipe's result can be taken from the current recipe's own
 * live build at its round-0 snapshot instead of being built: it is the
 * current recipe with no reviewer (the same triage, spec, build and pack).
 * The snapshot is the build before any review, so it is exactly what the
 * side recipe would have produced, from the same request and the same spec.
 * Pure.
 */
function derivableFrom(current, side) {
  const c = recipeOf(current);
  const s = recipeOf(side);
  if (!c || !s || s.reviewer !== null) return false;
  return STAGES.every((st) => c.models[st] === s.models[st]) && (c.pack || null) === (s.pack || null);
}

/** Whether a recipe reviews at all: a reviewer with at least one round. Pure. */
function reviews(recipe) {
  const r = recipeOf(recipe);
  return !!(r && r.reviewer && r.reviewer.maxRounds > 0);
}

// ── Versions ─────────────────────────────────────────────────────────────

const VERSION_COLS = `v.id, v.key, v.label, v.version, v.recipe, v.role, v.notes, v.created_at, v.role_changed_at,
            u.username AS created_by_name`;

function versionOut(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    key: row.key,
    label: row.label,
    version: Number(row.version),
    role: row.role,
    recipe: recipeOf(row.recipe) || row.recipe,
    recipeLine: recipeLine(row.recipe),
    notes: row.notes || null,
    createdBy: row.created_by_name || null,
    createdAt: iso(row.created_at),
    roleChangedAt: iso(row.role_changed_at),
  };
}

async function listVersions(pool) {
  const { rows } = await pool.query(
    `SELECT v.id, v.key, v.label, v.version, v.recipe, v.role, v.notes, v.created_at, v.role_changed_at,
            u.username AS created_by_name
       FROM bot_config_versions v LEFT JOIN users u ON u.id = v.created_by
      ORDER BY CASE v.role WHEN 'current' THEN 0 WHEN 'side' THEN 1 ELSE 2 END, v.key, v.version DESC`,
  );
  return rows.map(versionOut);
}

async function versionById(pool, id) {
  const { rows: [row] } = await pool.query(
    `SELECT v.id, v.key, v.label, v.version, v.recipe, v.role, v.notes, v.created_at, v.role_changed_at,
            u.username AS created_by_name
       FROM bot_config_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.id = $1`,
    [Number(id)],
  );
  return versionOut(row);
}

/**
 * The version that builds live first versions now, with its recipe, or null
 * when there is none (or it no longer validates): the bot then builds a first
 * version as it did before configurations. Never throws.
 */
async function currentVersion(pool) {
  try {
    const { rows: [row] } = await pool.query(
      `SELECT v.id, v.key, v.label, v.version, v.recipe, v.role, v.notes, v.created_at, v.role_changed_at,
              NULL::text AS created_by_name
         FROM bot_config_versions v
        WHERE v.role = 'current'
        LIMIT 1`,
    );
    const out = versionOut(row);
    return out && recipeOf(row.recipe) ? out : null;
  } catch (err) {
    log.warn('bot-configs', 'Could not read the current configuration', { err: err.message });
    return null;
  }
}

/** The side versions, each with its recipe. Never throws. */
async function sideVersions(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.key, v.label, v.version, v.recipe, v.role, v.notes, v.created_at, v.role_changed_at,
              NULL::text AS created_by_name
         FROM bot_config_versions v
        WHERE v.role = 'side'
        ORDER BY v.id`,
    );
    return rows.map(versionOut).filter((v) => recipeOf(v.recipe));
  } catch (err) {
    log.warn('bot-configs', 'Could not read the side configurations', { err: err.message });
    return [];
  }
}

function slugOf(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * Save a new version: of an existing key (its next version), or of a new
 * one. The roles move with it, in one transaction:
 *   - saved `current`: the version current until now becomes `side` (or
 *     `retired`, when it is this key's own earlier version), and this key's
 *     other active versions are retired;
 *   - saved `side`: this key's other side versions are retired (its current
 *     version, if it has one, stays current);
 *   - saved `retired`: nothing else moves.
 * Resolves { ok, version, demoted } or a refusal.
 */
async function saveVersion(pool, {
  key = null, label = null, recipe, role = 'side', notes = null, actorId = null,
} = {}) {
  if (!ROLES.includes(role)) return httpError(400, `role must be one of ${ROLES.join(', ')}`);
  const v = validateRecipe(recipe);
  if (!v.ok) return v;
  const cleanLabel = label == null ? null : String(label).replace(/\s+/g, ' ').trim();
  if (cleanLabel != null && (!cleanLabel || cleanLabel.length > MAX_LABEL_CHARS)) {
    return httpError(400, `label is 1 to ${MAX_LABEL_CHARS} characters`);
  }
  const k = key ? String(key).trim().toLowerCase() : slugOf(cleanLabel);
  if (!KEY_RE.test(k)) return httpError(400, 'key is 1 to 40 lower-case letters, digits or dashes (or give a label to make one from)');
  const cleanNotes = notes == null ? null : String(notes).trim().slice(0, MAX_NOTES_CHARS) || null;
  if (v.recipe.pack) {
    const { rows: [pack] } = await pool.query('SELECT id FROM bench_context_packs WHERE id = $1', [v.recipe.pack]);
    if (!pack) return httpError(404, `No App bench context pack ${v.recipe.pack}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bot_config_versions'))");
    const { rows: [prev] } = await client.query(
      'SELECT MAX(version)::int AS version, (ARRAY_AGG(label ORDER BY version DESC))[1] AS label FROM bot_config_versions WHERE key = $1',
      [k],
    );
    const finalLabel = cleanLabel || prev?.label || null;
    if (!finalLabel) {
      await client.query('ROLLBACK');
      return httpError(400, 'A new configuration needs a label');
    }
    const demoted = [];
    if (role === 'current') {
      const { rows } = await client.query(
        `UPDATE bot_config_versions
            SET role = CASE WHEN key = $1 THEN 'retired' ELSE 'side' END, role_changed_at = NOW()
          WHERE role = 'current'
          RETURNING id, role`,
        [k],
      );
      demoted.push(...rows.map((r) => ({ id: Number(r.id), role: r.role })));
      await client.query(
        "UPDATE bot_config_versions SET role = 'retired', role_changed_at = NOW() WHERE key = $1 AND role = 'side'",
        [k],
      );
    } else if (role === 'side') {
      await client.query(
        "UPDATE bot_config_versions SET role = 'retired', role_changed_at = NOW() WHERE key = $1 AND role = 'side'",
        [k],
      );
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO bot_config_versions (key, label, version, recipe, role, notes, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id`,
      [k, finalLabel, (Number(prev?.version) || 0) + 1, JSON.stringify(v.recipe), role, cleanNotes, actorId],
    );
    await client.query('COMMIT');
    const version = await versionById(pool, row.id);
    log.info('bot-configs', 'Configuration version saved', { id: version.id, key: k, version: version.version, role, demoted });
    return { ok: true, version, demoted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Change one version's role. Promoting a version to `current` demotes the
 * version current until now to `side`. The current version itself cannot be
 * made side or retired directly: there is always exactly one current, so
 * another version is promoted instead. Resolves { ok, version, demoted }.
 */
async function setRole(pool, { id, role } = {}) {
  if (!ROLES.includes(role)) return httpError(400, `role must be one of ${ROLES.join(', ')}`);
  const target = await versionById(pool, id);
  if (!target) return httpError(404, 'No such configuration version');
  if (!recipeOf(target.recipe)) return httpError(409, 'That version\'s recipe no longer validates: save a new version instead');
  if (target.role === role) return { ok: true, version: target, demoted: [] };
  if (target.role === 'current') {
    return httpError(409, 'That version is the current one. Promote another version to current first; this one then becomes a side version.', { code: 'current_required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bot_config_versions'))");
    const demoted = [];
    if (role === 'current') {
      const { rows } = await client.query(
        `UPDATE bot_config_versions SET role = 'side', role_changed_at = NOW()
          WHERE role = 'current' AND id <> $1
          RETURNING id`,
        [Number(id)],
      );
      demoted.push(...rows.map((r) => ({ id: Number(r.id), role: 'side' })));
    }
    await client.query(
      'UPDATE bot_config_versions SET role = $2, role_changed_at = NOW() WHERE id = $1',
      [Number(id), role],
    );
    await client.query('COMMIT');
    const version = await versionById(pool, id);
    log.info('bot-configs', 'Configuration role changed', { id: Number(id), role, demoted });
    return { ok: true, version, demoted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The three configurations every deploy starts from (SEED), each written
 * once (its seed_key), whatever an admin has done since: a seeded version an
 * admin retired stays retired, and the seeded current is written as a side
 * version when some other version is already current. Never throws.
 */
async function seedConfigs(pool) {
  let made = 0;
  try {
    for (const s of SEED) {
      const v = validateRecipe(s.recipe);
      if (!v.ok) throw new Error(`seed ${s.seedKey}: ${v.error}`);
      // eslint-disable-next-line no-await-in-loop
      const { rowCount } = await pool.query(
        `INSERT INTO bot_config_versions (key, label, version, recipe, role, notes, seed_key)
         SELECT $1, $2, 1, $3::jsonb,
                CASE WHEN $4 = 'current' AND EXISTS (SELECT 1 FROM bot_config_versions WHERE role = 'current')
                     THEN 'side' ELSE $4 END,
                $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM bot_config_versions WHERE seed_key = $6 OR (key = $1 AND version = 1))
         ON CONFLICT DO NOTHING`,
        [s.key, s.label, JSON.stringify(v.recipe), s.role, s.notes, s.seedKey],
      );
      made += rowCount || 0;
    }
    if (made) log.info('bot-configs', 'Seeded the bot\'s configurations', { made });
  } catch (err) {
    log.warn('bot-configs', 'Could not seed the bot\'s configurations', { err: err.message });
  }
  return made;
}

// ── Results ──────────────────────────────────────────────────────────────

/**
 * One configuration version's result for one live first version: written
 * once it is known, never overwritten once done. `status` 'pending' marks one
 * still being built (a side trial), 'skipped' one never built (the weekly
 * budget, say), 'done' one with its outcome. Resolves the row's id.
 */
async function recordResult(pool, {
  botRunId, configVersionId, source, trialId = null, status = 'done', built = null, booted = null,
  costUsd = null, activeMs = null, sha = null, capture = null, error = null,
}) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO bot_config_results
       (bot_run_id, config_version_id, source, trial_id, status, built, booted, cost_usd, active_ms, sha, capture, error,
        finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, CASE WHEN $5 = 'pending' THEN NULL ELSE NOW() END)
     ON CONFLICT (bot_run_id, config_version_id) DO UPDATE
       SET source = EXCLUDED.source, trial_id = COALESCE(EXCLUDED.trial_id, bot_config_results.trial_id),
           status = EXCLUDED.status, built = EXCLUDED.built, booted = EXCLUDED.booted,
           cost_usd = EXCLUDED.cost_usd, active_ms = EXCLUDED.active_ms, sha = EXCLUDED.sha,
           capture = EXCLUDED.capture, error = EXCLUDED.error, finished_at = EXCLUDED.finished_at
       WHERE bot_config_results.status <> 'done'
     RETURNING id`,
    [Number(botRunId), Number(configVersionId), source, trialId == null ? null : Number(trialId), status,
      built == null ? null : !!built, booted == null ? null : !!booted, num(costUsd), num(activeMs) == null ? null : Math.round(num(activeMs)),
      sha || null, capture ? JSON.stringify(capture) : null, error ? String(error).slice(0, 600) : null],
  );
  return row ? Number(row.id) : null;
}

/** What the live run's own triage cost and took: shared by every configuration's result. */
async function triageShare(pool, botRunId) {
  const { rows: [r] } = await pool.query(
    'SELECT cost_usd::float8 AS cost, duration_ms FROM homeroom_bot_runs WHERE id = $1',
    [Number(botRunId)],
  );
  return { costUsd: num(r?.cost) || 0, ms: num(r?.duration_ms) || 0 };
}

const add = (a, b) => (a == null && b == null ? null : (Number(a) || 0) + (Number(b) || 0));

/**
 * A live first version's outcome, recorded for the configurations it speaks
 * for: the current version's result from its final state, and every side
 * version's that is derivable from it (derivableFrom) from its round-0
 * snapshot. Then its pairs. `built` is buildAndPropose's answer (its
 * `review` carries the round-0 snapshot and the final capture); `activeMs`
 * is the build's own time, spec to final capture, with no queue in it.
 * Never throws.
 */
async function finishLive(pool, { botRunId, version, built = {}, activeMs = null }) {
  if (!botRunId || !version?.id) return null;
  try {
    const triage = await triageShare(pool, botRunId);
    const review = built.review || null;
    const finalCapture = review?.finalCapture || null;
    const landed = !!(built.sha || built.commits) && !built.blocked && built.error !== 'the build produced no change to propose';
    const builtOk = !!built.ok || landed;
    await recordResult(pool, {
      botRunId, configVersionId: version.id, source: 'live',
      built: builtOk,
      booted: finalCapture ? finalCapture.booted === true : null,
      costUsd: add(built.costUsd, triage.costUsd),
      activeMs: add(activeMs, triage.ms),
      sha: built.sha || null,
      capture: finalCapture,
      error: builtOk ? null : (built.blocked ? `blocked: ${built.blocked}` : built.error || null),
    });
    const round0 = review?.round0 || null;
    const sides = await pool.query(
      `SELECT r.id, r.config_version_id FROM bot_config_results r
        WHERE r.bot_run_id = $1 AND r.source = 'round0' AND r.status = 'pending'`,
      [Number(botRunId)],
    );
    for (const s of sides.rows) {
      // eslint-disable-next-line no-await-in-loop
      await recordResult(pool, {
        botRunId, configVersionId: s.config_version_id, source: 'round0',
        built: round0 ? true : builtOk,
        booted: round0?.capture ? round0.capture.booted === true : (round0 ? null : (finalCapture ? finalCapture.booted === true : null)),
        costUsd: add(round0 ? round0.costUsd : built.costUsd, triage.costUsd),
        activeMs: add(round0 ? round0.activeMs : activeMs, triage.ms),
        sha: round0 ? round0.sha : (built.sha || null),
        capture: round0 ? round0.capture : finalCapture,
        error: round0 || builtOk ? null : (built.blocked ? `blocked: ${built.blocked}` : built.error || null),
      });
    }
    await settlePairs(pool, botRunId);
    return true;
  } catch (err) {
    log.warn('bot-configs', 'Could not record a live first version\'s results', { botRunId, err: err.message });
    return null;
  }
}

/**
 * A side build's trial is over (services/bench/lane.js recordTrial): its
 * result, with the live run's triage added, and the pairs it completes.
 * Never throws.
 */
async function finishSideTrial(pool, trialId) {
  try {
    const { rows: [t] } = await pool.query(
      `SELECT tr.id, tr.bot_run_id, tr.bot_config_version_id, tr.status, tr.parsed, tr.capture, tr.cost_usd::float8 AS cost,
              tr.interrupted_cost_usd::float8 AS interrupted, tr.duration_ms, tr.build_sha, tr.build_commits, tr.error
         FROM bench_trials tr WHERE tr.id = $1`,
      [Number(trialId)],
    );
    if (!t || !t.bot_run_id || !t.bot_config_version_id) return null;
    const triage = await triageShare(pool, t.bot_run_id);
    const built = t.status === 'ok' && t.parsed?.built === true;
    const ranAtAll = !['cancelled', 'skipped_cap', 'not_applicable'].includes(t.status);
    await recordResult(pool, {
      botRunId: t.bot_run_id, configVersionId: t.bot_config_version_id, source: 'trial', trialId: t.id,
      status: ranAtAll ? 'done' : 'skipped',
      built,
      booted: t.capture ? t.capture.booted === true : null,
      costUsd: add(add(t.cost, t.interrupted), triage.costUsd),
      activeMs: add(t.duration_ms, triage.ms),
      sha: t.build_sha || null,
      capture: t.capture || null,
      error: built ? null : (t.error || (t.parsed?.blocked ? `blocked: ${t.parsed.blocked}` : null)),
    });
    await settlePairs(pool, t.bot_run_id);
    return true;
  } catch (err) {
    log.warn('bot-configs', 'Could not record a side build\'s result', { trialId, err: err.message });
    return null;
  }
}

/** Why a pair is not offered, or null when it is: either side not built, or not booted. Pure. */
function exclusionOf(current, side) {
  const which = (r) => (r === current ? 'the current configuration' : 'the side configuration');
  for (const r of [current, side]) {
    if (r.built !== true) return `didn't build (${which(r)})`;
  }
  for (const r of [current, side]) {
    if (!r.capture) return `no screenshots (${which(r)})`;
    if (r.booted !== true) return `didn't boot (${which(r)})`;
  }
  return null;
}

/**
 * Make the pairs one live first version now has: its current result against
 * each side result that is done. Idempotent. Resolves how many it made.
 */
async function settlePairs(pool, botRunId, { random = crypto.randomInt } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.source, r.status, r.built, r.booted, r.capture IS NOT NULL AS has_capture, r.config_version_id
       FROM bot_config_results r
      WHERE r.bot_run_id = $1`,
    [Number(botRunId)],
  );
  const current = rows.find((r) => r.source === 'live' && r.status === 'done');
  if (!current) return 0;
  let made = 0;
  for (const side of rows) {
    if (side.source === 'live' || side.status !== 'done') continue;
    const why = exclusionOf(
      { built: current.built, booted: current.booted, capture: current.has_capture ? {} : null },
      { built: side.built, booted: side.booted, capture: side.has_capture ? {} : null },
    );
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await pool.query(
      `INSERT INTO bot_config_pairs (token, bot_run_id, current_result_id, side_result_id, left_is_current, status, excluded_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (current_result_id, side_result_id) DO NOTHING`,
      [crypto.randomBytes(12).toString('base64url'), Number(botRunId), current.id, side.id,
        random(2) === 0, why ? 'excluded' : 'waiting', why],
    );
    made += rowCount || 0;
  }
  return made;
}

// ── Pairs, blind ─────────────────────────────────────────────────────────

const MAX_BRIEF_CHARS = 6000;
const MAX_PLAN_CHARS = 4000;
const PAIR_IMAGE_BYTES = 8 * 1024 * 1024;

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Stored screenshots by id, from either store (a round's or a bench trial's). */
async function readArtifactsById(pool, ids) {
  const list = [...new Set((ids || []).filter((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)))];
  if (!list.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, content_type, data FROM bot_capture_artifacts WHERE id = ANY($1::text[])
     UNION ALL
     SELECT id, content_type, data FROM bench_trial_artifacts WHERE id = ANY($1::text[])`,
    [list],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** One side of a pair as a picker sees it: whether it booted, its eight screenshots' captions and, with `images`, the images. */
async function sideView(pool, capture, { images = false } = {}) {
  const { pickShots } = require('./bench/capture');
  const picked = pickShots(capture || {});
  const out = {
    booted: capture?.booted === true,
    screenshots: picked.chosen.map((sh) => sh.caption),
    identicalScreens: picked.identical,
  };
  if (images) {
    const stored = await readArtifactsById(pool, picked.chosen.map((sh) => sh.artifactId));
    let total = 0;
    out.images = [];
    for (const sh of picked.chosen) {
      const a = stored.get(sh.artifactId);
      const data = a && (Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data || ''));
      if (!data || !data.length || total + data.length > PAIR_IMAGE_BYTES / 2) continue;
      total += data.length;
      out.images.push({ caption: sh.caption, mimeType: a.content_type || 'image/png', data: data.toString('base64') });
    }
  }
  return out;
}

/**
 * The next pair waiting for a pick, oldest first, blind: the request as the
 * bot read it and the plan every side built from, then Left and Right, each
 * with whether it booted and its eight most telling screenshots (images with
 * `images`). Nothing says which configuration is which, or what either
 * cost. The spec is left out on purpose: each configuration writes its own,
 * so showing one would say which side followed it. Resolves
 * { ok, pair: null } when none waits.
 */
async function nextPair(pool, { images = false } = {}) {
  const { rows: [p] } = await pool.query(
    `SELECT p.id, p.token, p.bot_run_id, p.left_is_current, cr.capture AS current_capture, sr.capture AS side_capture,
            r.build_note, a.name AS app_name,
            (SELECT COUNT(*)::int FROM bot_config_pairs w WHERE w.status = 'waiting') AS waiting
       FROM bot_config_pairs p
       JOIN bot_config_results cr ON cr.id = p.current_result_id
       JOIN bot_config_results sr ON sr.id = p.side_result_id
       JOIN homeroom_bot_runs r ON r.id = p.bot_run_id
       JOIN apps a ON a.id = r.app_id
      WHERE p.status = 'waiting'
      ORDER BY p.id
      LIMIT 1`,
  );
  if (!p) return { ok: true, pair: null, waiting: 0 };
  const snapshots = require('./homeroom-bot-snapshots');
  const snap = await snapshots.snapshotForRun(pool, p.bot_run_id, 'build').catch(() => null);
  const brief = snap?.texts?.seed || null;
  const plan = snap?.texts?.build_note || p.build_note || null;
  const left = p.left_is_current ? p.current_capture : p.side_capture;
  const right = p.left_is_current ? p.side_capture : p.current_capture;
  return {
    ok: true,
    waiting: Number(p.waiting) || 0,
    pair: {
      pairId: p.token,
      appName: p.app_name || null,
      brief: brief ? clip(brief, MAX_BRIEF_CHARS) : null,
      plan: plan ? clip(plan, MAX_PLAN_CHARS) : null,
      left: await sideView(pool, left, { images }),
      right: await sideView(pool, right, { images }),
    },
  };
}

/**
 * An admin's pick for one waiting pair: 'left', 'right' or 'tie', and an
 * optional note. Once: a pair already picked is refused. Resolves
 * { ok, waiting } with how many pairs still wait.
 */
async function submitPick(pool, { pairId, pick, note = null, userId = null } = {}) {
  if (!['left', 'right', 'tie'].includes(pick)) return httpError(400, 'pick is left, right or tie');
  const token = String(pairId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return httpError(400, 'Invalid pairId');
  const { rows: [p] } = await pool.query('SELECT id, status, left_is_current FROM bot_config_pairs WHERE token = $1', [token]);
  if (!p) return httpError(404, 'No such pair');
  if (p.status !== 'waiting') return httpError(409, p.status === 'picked' ? 'That pair was already picked' : 'That pair is not offered for a pick');
  const winner = pick === 'tie' ? 'tie' : ((pick === 'left') === p.left_is_current ? 'current' : 'side');
  const { rowCount } = await pool.query(
    `UPDATE bot_config_pairs SET status = 'picked', pick = $2, note = $3, picked_by = $4, picked_at = NOW()
      WHERE id = $1 AND status = 'waiting'`,
    [p.id, winner, note ? String(note).trim().slice(0, 1000) || null : null, userId],
  );
  if (!rowCount) return httpError(409, 'That pair was already picked');
  const { rows: [w] } = await pool.query("SELECT COUNT(*)::int AS n FROM bot_config_pairs WHERE status = 'waiting'");
  return { ok: true, waiting: Number(w?.n) || 0 };
}

// ── Stats ────────────────────────────────────────────────────────────────

/**
 * The 95% Wilson score interval of `successes` out of `n` (successes may be
 * fractional: a tie counts half). Pure. { rate, low, high, n }; nulls for n 0.
 */
function wilson(successes, n, z = 1.959963984540054) {
  const total = Number(n);
  if (!(total > 0)) return { rate: null, low: null, high: null, n: 0 };
  const p = Math.min(Math.max(Number(successes) / total, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n: total };
}

/**
 * A version's win rate against another, from picked pairs between the two:
 * each pair is { winner: version id | 'tie' }. Ties count half. Pure.
 */
function winRateOf(picks, versionId) {
  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (const p of picks || []) {
    if (p.winner === 'tie') ties += 1;
    else if (Number(p.winner) === Number(versionId)) wins += 1;
    else losses += 1;
  }
  const n = wins + ties + losses;
  return { wins, ties, losses, ...wilson(wins + ties / 2, n) };
}

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Every version with its numbers: builds, average real cost, median active
 * time, boot rate, and win rate against the version current now (picked
 * pairs between the two), the pairs that were not offered and why, and the
 * pairs still waiting for a pick. Per version, never across versions.
 */
async function listWithStats(pool) {
  const versions = await listVersions(pool);
  const current = versions.find((v) => v.role === 'current') || null;
  const { rows: results } = await pool.query(
    `SELECT config_version_id, built, booted, cost_usd::float8 AS cost, active_ms::float8 AS ms
       FROM bot_config_results WHERE status = 'done'`,
  );
  const { rows: pairs } = await pool.query(
    `SELECT p.status, p.pick, p.excluded_reason, cr.config_version_id AS current_version, sr.config_version_id AS side_version
       FROM bot_config_pairs p
       JOIN bot_config_results cr ON cr.id = p.current_result_id
       JOIN bot_config_results sr ON sr.id = p.side_result_id`,
  );
  const { rows: [skipped] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM bot_config_results WHERE status = 'skipped'",
  );
  const out = versions.map((v) => {
    const mine = results.filter((r) => Number(r.config_version_id) === v.id);
    const costs = mine.map((r) => num(r.cost)).filter((c) => c != null);
    const builtN = mine.filter((r) => r.built === true).length;
    const bootKnown = mine.filter((r) => r.booted != null || r.built === false);
    const involving = pairs.filter((p) => Number(p.current_version) === v.id || Number(p.side_version) === v.id);
    let vsCurrent = null;
    if (current && current.id !== v.id) {
      const between = involving.filter((p) => [Number(p.current_version), Number(p.side_version)].includes(current.id));
      const picks = between.filter((p) => p.status === 'picked').map((p) => ({
        winner: p.pick === 'tie' ? 'tie' : (p.pick === 'current' ? Number(p.current_version) : Number(p.side_version)),
      }));
      vsCurrent = {
        against: current.id,
        ...winRateOf(picks, v.id),
        excluded: between.filter((p) => p.status === 'excluded').length,
        didntBoot: between.filter((p) => p.status === 'excluded' && /^didn't boot|^no screenshots/.test(String(p.excluded_reason || ''))).length,
        didntBuild: between.filter((p) => p.status === 'excluded' && /^didn't build/.test(String(p.excluded_reason || ''))).length,
        waiting: between.filter((p) => p.status === 'waiting').length,
      };
    }
    return {
      ...v,
      stats: {
        builds: mine.length,
        built: builtN,
        avgCostUsd: costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null,
        medianActiveMs: median(mine.map((r) => num(r.ms))),
        bootRate: bootKnown.length ? mine.filter((r) => r.booted === true).length / bootKnown.length : null,
        pairsWaiting: involving.filter((p) => p.status === 'waiting').length,
        vsCurrent,
      },
    };
  });
  return {
    ok: true,
    versions: out,
    currentId: current ? current.id : null,
    pairsWaiting: pairs.filter((p) => p.status === 'waiting').length,
    sideBuilds: { ...(await sideBudget(pool)), skipped: Number(skipped?.n) || 0 },
  };
}

// ── Side builds on the App bench lane ────────────────────────────────────

async function sideWeeklyCents(pool) {
  try {
    const { rows: [r] } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [SIDE_WEEKLY_KEY]);
    const n = parseInt(r?.value, 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_SIDE_WEEKLY_CENTS) : DEFAULT_SIDE_WEEKLY_CENTS;
  } catch {
    return DEFAULT_SIDE_WEEKLY_CENTS;
  }
}

/**
 * The side builds' week: the limit, what their runs spent in the last seven
 * days (interrupted attempts included), and what their trials still waiting
 * or running are expected to cost. Real dollars.
 */
async function sideBudget(pool) {
  const limitCents = await sideWeeklyCents(pool);
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(SUM(br.spent_usd), 0)::float8 AS spent,
            COALESCE((SELECT SUM(tr.est_cost_usd) FROM bench_trials tr JOIN bench_runs rr ON rr.id = tr.run_id
                       WHERE rr.kind = 'bot_config' AND tr.status IN ('pending', 'running')), 0)::float8 AS pending
       FROM bench_runs br
      WHERE br.kind = 'bot_config' AND br.created_at > NOW() - INTERVAL '7 days'`,
  );
  const spentUsd = num(r?.spent) || 0;
  const pendingUsd = num(r?.pending) || 0;
  return { limitUsd: limitCents / 100, spentUsd, pendingUsd, leftUsd: Math.max(0, limitCents / 100 - spentUsd - pendingUsd) };
}

async function ensureSideSuite(pool) {
  const { rows: [s] } = await pool.query(
    'SELECT id, frozen_at FROM bench_suites WHERE name = $1 ORDER BY version DESC LIMIT 1',
    [SIDE_SUITE_NAME],
  );
  if (s && !s.frozen_at) return s.id;
  const suites = require('./bench/suites');
  const made = await suites.createSuite(pool, {
    name: SIDE_SUITE_NAME, kind: 'rotating',
    notes: 'Side builds of live first versions, one task per first version (services/bot-configs.js). Never frozen; never graded by the judge: they are picked pairwise.',
  });
  if (!made.ok) throw new Error(made.error);
  return made.suite.id;
}

/**
 * When a live first version starts building under the current version:
 * every side version gets its place. One derivable from the current one
 * (derivableFrom) waits for the live build's round-0 snapshot; any other is
 * a trial on the App bench lane, replaying the live run's request, triage
 * and plan on the live project's own repository at the commit the live
 * build starts from, linked to the live run and the version. Its spend is
 * the bench user's, within the side builds' weekly budget: once that is
 * spent, a side version is recorded skipped, with why, and nothing is
 * spawned. Idempotent (a live build restarted from its kept spec spawns
 * nothing twice). Never throws; resolves what it did.
 */
async function spawnSideBuilds(pool, config, {
  botRunId, app, snapshotId, current, deps = {},
} = {}) {
  const out = { derived: 0, trials: 0, skipped: 0, runId: null };
  if (!botRunId || !app?.id || !current?.recipe) return out;
  try {
    const sides = await sideVersions(pool);
    if (!sides.length) return out;
    const { rows: had } = await pool.query(
      'SELECT config_version_id FROM bot_config_results WHERE bot_run_id = $1',
      [Number(botRunId)],
    );
    const already = new Set(had.map((r) => Number(r.config_version_id)));
    const toBuild = [];
    for (const side of sides) {
      if (already.has(side.id)) continue;
      if (derivableFrom(current.recipe, side.recipe)) {
        // eslint-disable-next-line no-await-in-loop
        await recordResult(pool, { botRunId, configVersionId: side.id, source: 'round0', status: 'pending' });
        out.derived += 1;
      } else {
        toBuild.push(side);
      }
    }
    if (!toBuild.length) return out;
    const catalog = require('./bench/catalog');
    const models = await catalog.listModels(pool, toBuild.map((s) => s.recipe.models.build)).catch(() => []);
    const ests = toBuild.map((s) => {
      const est = catalog.estimateTrialCost(catalog.modelInfo(models, s.recipe.models.build), 'first_version', []);
      return Math.round((Number(est) || 1) * 10000) / 10000;
    });
    const budget = await sideBudget(pool);
    const fits = [];
    let left = budget.leftUsd;
    for (let i = 0; i < toBuild.length; i += 1) {
      if (!snapshotId) {
        // eslint-disable-next-line no-await-in-loop
        await recordResult(pool, {
          botRunId, configVersionId: toBuild[i].id, source: 'trial', status: 'skipped',
          error: 'the live build recorded no snapshot to replay',
        });
        out.skipped += 1;
      } else if (ests[i] > left) {
        // eslint-disable-next-line no-await-in-loop
        await recordResult(pool, {
          botRunId, configVersionId: toBuild[i].id, source: 'trial', status: 'skipped',
          error: `the side builds' weekly budget ($${budget.limitUsd.toFixed(2)}) is spent`,
        });
        out.skipped += 1;
      } else {
        left -= ests[i];
        fits.push({ side: toBuild[i], est: ests[i] });
      }
    }
    if (!fits.length) {
      if (out.skipped) log.info('bot-configs', 'Side builds skipped', { botRunId, skipped: out.skipped, leftUsd: budget.leftUsd });
      return out;
    }
    const suiteId = await ensureSideSuite(pool);
    const { rows: [task0] } = await pool.query(
      "SELECT id FROM bench_tasks WHERE suite_id = $1 AND source_run_id = $2 AND stage = 'first_version'",
      [suiteId, Number(botRunId)],
    );
    let taskId = task0?.id || null;
    if (!taskId) {
      const suites = require('./bench/suites');
      const task = await suites.insertTask(pool, {
        suiteId, stage: 'first_version', sourceRunId: Number(botRunId), snapshotId: Number(snapshotId),
        appId: app.id, issueNumber: null,
        tags: { bot_config: true, app_slug: app.slug || null, side_of_run: Number(botRunId) },
        reference: {}, referenceSource: 'authored',
      });
      taskId = task.id;
    }
    const estTotal = fits.reduce((s, f) => s + f.est, 0);
    const capUsd = Math.max(MIN_SIDE_RUN_CAP_USD, Math.min(budget.leftUsd, estTotal * SIDE_RUN_CAP_FACTOR));
    const client = await pool.connect();
    let run;
    try {
      await client.query('BEGIN');
      ({ rows: [run] } = await client.query(
        `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, note, kind)
         VALUES ($1, $2::text[], $3, ARRAY['first_version'], 1, $4, $5, $6, 'bot_config')
         RETURNING id`,
        [suiteId, [...new Set(fits.map((f) => f.side.recipe.models.build))], fits[0].side.recipe.models.build,
          Math.round(capUsd * 100) / 100, Math.max(1, Math.min(fits.length, 3)),
          `Side builds of Homeroom bot run ${Number(botRunId)}`],
      ));
      for (const f of fits) {
        // eslint-disable-next-line no-await-in-loop
        const { rows: [trial] } = await client.query(
          `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, est_cost_usd, item_token, bot_run_id, bot_config_version_id)
           VALUES ($1, $2, $3, 1, 'pending', $4, $5, $6, $7)
           RETURNING id`,
          [run.id, taskId, `config:${f.side.id}`, f.est, crypto.randomBytes(12).toString('base64url'), Number(botRunId), f.side.id],
        );
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO bot_config_results (bot_run_id, config_version_id, source, trial_id, status)
           VALUES ($1, $2, 'trial', $3, 'pending')
           ON CONFLICT (bot_run_id, config_version_id) DO NOTHING`,
          [Number(botRunId), f.side.id, trial.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    out.trials = fits.length;
    out.runId = Number(run.id);
    (deps.lane || require('./bench/lane')).wake();
    log.info('bot-configs', 'Side builds queued on the App bench lane', {
      botRunId, benchRunId: out.runId, trials: out.trials, derived: out.derived, skipped: out.skipped, capUsd,
    });
    return out;
  } catch (err) {
    log.warn('bot-configs', 'Could not queue the side builds (the live build goes on)', { botRunId, err: err.message });
    return out;
  }
}

/**
 * A recipe's pack guidance per stage ({ triage, spec, build }), or null when
 * it names no pack (the platform's own first-version guidance alone) or the
 * pack is gone. Never throws.
 */
async function recipeGuidance(pool, recipe) {
  const r = recipeOf(recipe);
  if (!r || !r.pack) return null;
  try {
    const packs = require('./bench/packs');
    const pack = await packs.packRow(pool, r.pack);
    if (!pack) return null;
    return Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null]));
  } catch (err) {
    log.warn('bot-configs', 'Could not read a configuration\'s pack (building without it)', { pack: r.pack, err: err.message });
    return null;
  }
}

// ── Staging ──────────────────────────────────────────────────────────────

// The staging demo's first versions: obviously fake runs on one running app,
// each with every configuration's result and their pairs, so a preview of
// the console's Bot configurations section has numbers to show. Fixed issue
// numbers mark them (and keep the seed to once).
const STAGING_ISSUES = Object.freeze([936701, 936702, 936703, 936704, 936705]);

/**
 * Staging only (USERNODE_ENV), idempotent, and nothing a production database
 * could see: five fake first versions of one running app ("Staging demo"),
 * each with the current configuration's result and its two side ones, and
 * their pairs: some picked, one waiting, one left out because its side did
 * not boot. Results and pairs are staging:private, so a preview has none
 * without this. Never throws.
 */
async function seedStagingBotConfigs(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return false;
  try {
    const { rows: [have] } = await pool.query(
      "SELECT 1 FROM homeroom_bot_runs WHERE issue_number = $1 AND build_note LIKE 'Staging demo:%' LIMIT 1",
      [STAGING_ISSUES[0]],
    );
    if (have) return false;
    const { rows: [app] } = await pool.query("SELECT id FROM apps WHERE status = 'running' ORDER BY id LIMIT 1");
    const versions = await listVersions(pool);
    const current = versions.find((v) => v.role === 'current');
    const sides = versions.filter((v) => v.role === 'side');
    if (!app || !current || !sides.length) return false;
    // Per first version: [current cost, minutes], then each side's [cost,
    // minutes, booted], and the pick against each side ('current', 'side',
    // 'tie', or null for one still waiting).
    const plan = [
      { cur: [2.12, 38], sides: [[0.41, 21, true], [1.04, 24, true]], picks: ['current', 'current'] },
      { cur: [1.97, 35], sides: [[0.38, 19, true], [0.98, 22, true]], picks: ['side', 'tie'] },
      { cur: [2.31, 41], sides: [[0.44, 23, false], [1.11, 26, true]], picks: [null, 'current'] },
      { cur: [1.88, 33], sides: [[0.36, 18, true], [0.95, 21, true]], picks: ['current', 'current'] },
      { cur: [2.05, 37], sides: [[0.42, 22, true], [1.02, 24, true]], picks: [null, null] },
    ];
    for (const [i, row] of plan.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: [run] } = await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, model, cost_usd, duration_ms,
                                        bot_config_version_id, review_rounds, review_stop, created_at)
         VALUES ($1, $2, 'shadow', 'ready', 'Staging demo: a first version for the configurations table', $3, 0.03, 80000,
                 $4, $5, $6, NOW() - make_interval(days => $7))
         RETURNING id`,
        [app.id, STAGING_ISSUES[i], GLM, current.id, 2, i % 2 ? 'ship' : 'round_limit', 5 - i],
      );
      const capture = { booted: true, shots: [] };
      // eslint-disable-next-line no-await-in-loop
      const curId = await recordResult(pool, {
        botRunId: run.id, configVersionId: current.id, source: 'live', built: true, booted: true,
        costUsd: row.cur[0], activeMs: row.cur[1] * 60000, capture,
      });
      for (const [j, side] of sides.entries()) {
        const [cost, mins, booted] = row.sides[j] || row.sides[0];
        // eslint-disable-next-line no-await-in-loop
        const sideId = await recordResult(pool, {
          botRunId: run.id, configVersionId: side.id, source: derivableFrom(current.recipe, side.recipe) ? 'round0' : 'trial',
          built: true, booted, costUsd: cost, activeMs: mins * 60000, capture: { booted, shots: [] },
        });
        const pick = row.picks[j] ?? null;
        const excluded = booted ? null : 'didn\'t boot (the side configuration)';
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO bot_config_pairs (token, bot_run_id, current_result_id, side_result_id, left_is_current, status,
                                         excluded_reason, pick, picked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() END)
           ON CONFLICT (current_result_id, side_result_id) DO NOTHING`,
          [crypto.randomBytes(12).toString('base64url'), run.id, curId, sideId, (i + j) % 2 === 0,
            excluded ? 'excluded' : (pick ? 'picked' : 'waiting'), excluded, excluded ? null : pick],
        );
      }
    }
    log.info('db', 'Seeded the staging bot configurations demo', { runs: plan.length });
    return true;
  } catch (err) {
    log.warn('db', 'Staging bot configurations demo skipped', { err: err.message });
    return false;
  }
}

/** The configuration a side trial builds, from its model (`config:<id>`), or null. Pure. */
function configIdOfModel(model) {
  const m = /^config:(\d+)$/.exec(String(model || ''));
  return m ? Number(m[1]) : null;
}

module.exports = {
  GLM,
  OPUS,
  ROLES,
  STAGES,
  SEED,
  MAX_ROUNDS,
  SIDE_WEEKLY_KEY,
  DEFAULT_SIDE_WEEKLY_CENTS,
  SIDE_SUITE_NAME,
  SIDE_RUN_KIND,
  validateRecipe,
  recipeOf,
  recipeLine,
  derivableFrom,
  reviews,
  listVersions,
  versionById,
  currentVersion,
  sideVersions,
  saveVersion,
  setRole,
  seedConfigs,
  recordResult,
  finishLive,
  finishSideTrial,
  exclusionOf,
  settlePairs,
  readArtifactsById,
  nextPair,
  submitPick,
  wilson,
  winRateOf,
  median,
  listWithStats,
  sideWeeklyCents,
  sideBudget,
  spawnSideBuilds,
  recipeGuidance,
  configIdOfModel,
  seedStagingBotConfigs,
  STAGING_ISSUES,
};
