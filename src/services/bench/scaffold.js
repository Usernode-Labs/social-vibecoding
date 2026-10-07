'use strict';

// A first-version trial's starting point: the commit a new project's
// repository begins with, made ONCE per run, task and context pack
// (bench_scaffolds) and shared by every arm of the run and every reference
// build handed in for it (services/bench/studio.js), so each starts from the
// same tree, sketch card included.
//
// What is in it, as app creation makes it (services/app-creator.js):
//
//   * today's starter, rendered for the app's name by the template code a
//     new project is created with (services/template.js getTemplateFiles),
//     with no database URL and no pointer to a repository, as the taste
//     eval's always was (services/bench/taste.js scaffoldFiles);
//   * the first session's card of the idea (services/app-sketch.js
//     makeCard, the same model call and fallback creation makes):
//     design/sketch.json and its emoji as the app's icon. The card is made
//     here once, so every arm reads the same one; the request each trial
//     files quotes it, as a project's first request does;
//   * the context pack's files on top (services/bench/packs.js), a pack file
//     replacing a starter file of the same path.
//
// It is a commit with no history on `bench/r<run>-s<id>`, made through the
// trial's guarded GitHub client (runner.guardedGithub createBenchScaffold).
// One trial claims the row and makes it; the others wait for it. A claim
// left `making` past CLAIM_STALE_SECONDS (its process died) or `failed` is
// taken over by the next trial that needs it.

const log = require('../logger');
const packs = require('./packs');

const CLAIM_STALE_SECONDS = 600;
const WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 3000;

/** The branch a scaffold's commit is kept on. Pure. */
function scaffoldBranch(runId, scaffoldId) {
  return `bench/r${Number(runId)}-s${Number(scaffoldId)}`;
}

/** A card as the request quotes it: its tagline and points, committed. Pure; null for none. */
function requestCard(sketch) {
  if (!sketch || !sketch.design) return null;
  const card = require('../app-sketch').cardOf(sketch.design);
  return card ? { ...card, committed: true } : null;
}

/**
 * The files of a first commit: the starter for the app's name, its card, and
 * the pack's files on top. Pure but for the template code's own reads.
 */
function filesFor({ input, pack = null, sketch = null }) {
  const { getTemplateFiles } = require('../template');
  const { slugOf } = require('./taste');
  const files = getTemplateFiles(input.appName, slugOf(input.appName), '', null, {
    template: input.template || null,
    description: input.description || null,
    sketch: sketch && sketch.design ? { design: sketch.design, model: sketch.model || null, ready_at: sketch.readyAt || null } : null,
  });
  return packs.withPackFiles(files, pack);
}

/** The card for a brief, as creation makes it; null when it could not be made at all. */
async function makeSketch(pool, { input, user, deps = {} }) {
  try {
    const made = await require('../app-sketch').makeCard(pool, {
      name: input.appName, brief: input.brief, user, maker: null, deps: deps.sketchDeps || {},
    });
    return made && made.card ? { design: made.card, model: made.model, readyAt: new Date().toISOString() } : null;
  } catch (err) {
    log.warn('bench', 'No sketch card for a first version', { err: err.message });
    return null;
  }
}

async function readRow(pool, { runId, taskId, packId }) {
  const { rows } = await pool.query(
    `SELECT id, status, sha, branch, sketch, error, claimed_at
       FROM bench_scaffolds
      WHERE run_id = $1 AND task_id = $2 AND COALESCE(context_pack_id, 0) = COALESCE($3::int, 0)`,
    [Number(runId), Number(taskId), packId == null ? null : Number(packId)],
  );
  return rows[0] || null;
}

async function make(pool, id, { runId, input, pack, repo, github, user, deps }) {
  try {
    const sketch = deps.makeSketch ? await deps.makeSketch({ input }) : await makeSketch(pool, { input, user, deps });
    const files = filesFor({ input, pack, sketch });
    const branch = scaffoldBranch(runId, id);
    const sha = await github.createBenchScaffold(repo.owner, repo.repo, branch, files, `Initialize ${input.appName} from Homeroom template`);
    await pool.query(
      `UPDATE bench_scaffolds SET status = 'ready', sha = $2, branch = $3, sketch = $4::jsonb, error = NULL, ready_at = NOW()
        WHERE id = $1`,
      [id, sha, branch, sketch ? JSON.stringify(sketch) : null],
    );
    return { ok: true, id, sha, branch, sketch };
  } catch (err) {
    const error = String(err && err.message || 'failed').slice(0, 500);
    await pool.query("UPDATE bench_scaffolds SET status = 'failed', error = $2 WHERE id = $1", [id, error]).catch(() => {});
    return { ok: false, error };
  }
}

/**
 * The first commit for (run, task, pack): made by this caller when it is the
 * first to need it, else waited for. Resolves { ok, id, sha, branch, sketch }
 * or { ok: false, error }. Never throws.
 */
async function ensure(pool, {
  runId, taskId, pack = null, input, repo, github, user = null, deps = {}, waitMs = WAIT_MS, pollMs = POLL_MS,
}) {
  const packId = pack && pack.id ? Number(pack.id) : null;
  const args = { runId, input, pack, repo, github, user, deps };
  try {
    const { rows: [claimed] } = await pool.query(
      `INSERT INTO bench_scaffolds (run_id, task_id, context_pack_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [Number(runId), Number(taskId), packId],
    );
    if (claimed) return make(pool, claimed.id, args);
    const deadline = Date.now() + waitMs;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const row = await readRow(pool, { runId, taskId, packId });
      if (!row) return { ok: false, error: 'the first commit\'s record is gone' };
      if (row.status === 'ready') return { ok: true, id: row.id, sha: row.sha, branch: row.branch, sketch: row.sketch || null };
      // eslint-disable-next-line no-await-in-loop
      const { rows: [taken] } = await pool.query(
        `UPDATE bench_scaffolds SET status = 'making', claimed_at = NOW(), error = NULL
          WHERE id = $1 AND (status = 'failed' OR (status = 'making' AND claimed_at < NOW() - make_interval(secs => $2)))
          RETURNING id`,
        [row.id, CLAIM_STALE_SECONDS],
      );
      if (taken) return make(pool, taken.id, args);
      if (Date.now() + pollMs > deadline) return { ok: false, error: 'the first commit was not ready in time' };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); if (typeof t.unref === 'function') t.unref(); });
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || 'failed').slice(0, 500) };
  }
}

/** A ready scaffold for (run, task, pack), or null: what a reference order hands out. */
async function readyFor(pool, { runId, taskId, packId = null }) {
  const row = await readRow(pool, { runId, taskId, packId });
  return row && row.status === 'ready' ? row : null;
}

module.exports = {
  CLAIM_STALE_SECONDS,
  scaffoldBranch,
  requestCard,
  filesFor,
  makeSketch,
  ensure,
  readyFor,
};
