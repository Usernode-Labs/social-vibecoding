'use strict';

// #3654: what a Homeroom bot run read, kept so it can be read again.
//
// Before this nothing could be replayed. A run recorded its verdict and what
// it cost, but not the request thread as it stood when the model read it,
// not the commit the repository was at, and not the prompt: the issue moved
// on, the code moved on, and the only copy of the input was gone. The
// benchmark (services/bench/) needs exactly that input to put a second model
// in front of the same question.
//
// So every stage that runs a model records a snapshot beside its run:
//
//   texts   the seed (the request, its comments and its Homeroom thread as
//           the prompt carries them), the thread itself as JSON (so a
//           simulated reply can be appended and the seed rebuilt), the whole
//           prompt, and a stage's own inputs (the build note, the spec, the
//           failing checks, the replies a follow-up answered)
//   extra   small structured inputs: an issue number, a flag, the model the
//           stage ran on
//   base    the commit the stage ran against
//   hash    of the prompt, so a replay can say whether the prompt it built
//           today is the prompt the run read then
//
// Storage is compact on purpose. A prompt carries the same design guidance on
// every run, and the same thread is read by a triage and then by its build,
// so text is stored once per distinct content (sha256), gzip-compressed, in
// homeroom_bot_snapshot_blobs; a snapshot row holds only the hashes. Each
// text is capped at MAX_TEXT_CHARS (the largest triage seed seen was far
// below it); a capped text is marked, and the snapshot says it is truncated.
//
// Never a reason a run fails: recordSnapshot is best-effort and swallows its
// own errors, like every other piece of bookkeeping the bot does after a turn.

const crypto = require('crypto');
const zlib = require('zlib');
const log = require('./logger');

const STAGES = Object.freeze(['triage', 'spec', 'build', 'followup', 'checks_fix', 'dm']);
// One text's ceiling. A seed is the request, its comments and its thread,
// each clipped where it is read; the prompt adds the triage instructions and
// the design guidance. 400k characters is roughly 100k tokens.
const MAX_TEXT_CHARS = 400_000;
const TRUNCATED_MARK = '\n[snapshot truncated]';
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TEXTS = 12;

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** A text as it will be stored: capped, and whether the cap cut it. */
function capText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_TEXT_CHARS - TRUNCATED_MARK.length)}${TRUNCATED_MARK}`, truncated: true };
}

/** Store one text once; resolves its hash. */
async function storeBlob(pool, text) {
  const hash = hashText(text);
  await pool.query(
    `INSERT INTO homeroom_bot_snapshot_blobs (hash, content, chars)
     VALUES ($1, $2, $3)
     ON CONFLICT (hash) DO NOTHING`,
    [hash, zlib.gzipSync(Buffer.from(text, 'utf8')), text.length],
  );
  return hash;
}

/**
 * Record what one stage of a run read. `texts` maps a short name to a string
 * (or a value stored as its JSON); empty values are left out. Resolves the
 * snapshot id, or null when it could not be recorded (logged, never thrown).
 * A run's stage is recorded once: a second call for the same run and stage
 * replaces the first, which is what a retried build wants.
 */
async function recordSnapshot(pool, {
  runId = null, stage, appId, issueNumber, baseSha = null, texts = {}, extra = {}, source = 'run',
} = {}) {
  try {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
    if (!Number.isInteger(Number(appId)) || !Number.isInteger(Number(issueNumber))) {
      throw new Error('appId and issueNumber are required');
    }
    const stored = {};
    let truncated = false;
    let promptHash = null;
    for (const [name, value] of Object.entries(texts || {}).slice(0, MAX_TEXTS)) {
      if (!NAME_RE.test(name) || value == null || value === '') continue;
      const capped = capText(value);
      if (!capped.text) continue;
      truncated = truncated || capped.truncated;
      // eslint-disable-next-line no-await-in-loop
      stored[name] = await storeBlob(pool, capped.text);
      if (name === 'prompt') promptHash = stored[name];
    }
    const sha = typeof baseSha === 'string' && /^[0-9a-f]{7,64}$/i.test(baseSha) ? baseSha.toLowerCase() : null;
    const values = [runId || null, stage, Number(appId), Number(issueNumber), sha, promptHash,
      JSON.stringify(stored), JSON.stringify(extra || {}), truncated, source === 'import' ? 'import' : 'run'];
    if (runId) {
      const { rows } = await pool.query(
        `INSERT INTO homeroom_bot_run_snapshots
           (run_id, stage, app_id, issue_number, base_sha, prompt_hash, texts, extra, truncated, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         ON CONFLICT (run_id, stage) WHERE run_id IS NOT NULL DO UPDATE
           SET base_sha = EXCLUDED.base_sha, prompt_hash = EXCLUDED.prompt_hash, texts = EXCLUDED.texts,
               extra = EXCLUDED.extra, truncated = EXCLUDED.truncated, created_at = NOW()
         RETURNING id`,
        values,
      );
      return rows[0]?.id || null;
    }
    const { rows } = await pool.query(
      `INSERT INTO homeroom_bot_run_snapshots
         (run_id, stage, app_id, issue_number, base_sha, prompt_hash, texts, extra, truncated, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
       RETURNING id`,
      values,
    );
    return rows[0]?.id || null;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not record a run snapshot', { runId, stage, err: err.message });
    return null;
  }
}

/** The texts behind a snapshot row, decompressed. */
async function loadTexts(pool, texts) {
  const entries = Object.entries(texts || {}).filter(([, hash]) => typeof hash === 'string');
  if (!entries.length) return {};
  const { rows } = await pool.query(
    'SELECT hash, content FROM homeroom_bot_snapshot_blobs WHERE hash = ANY($1::text[])',
    [entries.map(([, hash]) => hash)],
  );
  const byHash = new Map(rows.map((r) => [r.hash, zlib.gunzipSync(r.content).toString('utf8')]));
  const out = {};
  for (const [name, hash] of entries) if (byHash.has(hash)) out[name] = byHash.get(hash);
  return out;
}

function shapeSnapshot(row, texts) {
  let thread = null;
  if (texts.thread) {
    try { thread = JSON.parse(texts.thread); } catch { thread = null; }
  }
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    appId: row.app_id,
    issueNumber: row.issue_number,
    baseSha: row.base_sha,
    promptHash: row.prompt_hash,
    truncated: !!row.truncated,
    source: row.source,
    createdAt: row.created_at,
    extra: row.extra || {},
    texts,
    thread,
  };
}

/** One snapshot with its texts, by id. Null when there is none. */
async function readSnapshot(pool, id) {
  const { rows } = await pool.query('SELECT * FROM homeroom_bot_run_snapshots WHERE id = $1', [Number(id)]);
  if (!rows.length) return null;
  return shapeSnapshot(rows[0], await loadTexts(pool, rows[0].texts));
}

/** The snapshot a run recorded for a stage, with its texts. */
async function snapshotForRun(pool, runId, stage) {
  const { rows } = await pool.query(
    'SELECT * FROM homeroom_bot_run_snapshots WHERE run_id = $1 AND stage = $2',
    [Number(runId), stage],
  );
  if (!rows.length) return null;
  return shapeSnapshot(rows[0], await loadTexts(pool, rows[0].texts));
}

/** Which stages a run can be replayed at: { runId: [stage, ...] }. */
async function stagesForRuns(pool, runIds) {
  const ids = (runIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return {};
  const { rows } = await pool.query(
    'SELECT run_id, stage FROM homeroom_bot_run_snapshots WHERE run_id = ANY($1::int[]) ORDER BY stage',
    [ids],
  );
  const out = {};
  for (const r of rows) (out[r.run_id] = out[r.run_id] || []).push(r.stage);
  return out;
}

/**
 * The thread a triage read, frozen as data: the issue as GitHub returned it,
 * its comments, the Homeroom thread and the bot's own login, which together
 * rebuild the seed with sessions.buildHeadlessSeed. Only the fields the seed
 * reads are kept.
 */
function frozenThread({ issueNumber, issue, comments = [], threadMessages = [], botLogin = null }) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    issueNumber: Number(issueNumber),
    issue: pick(issue || {}, ['number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'labels', 'url']),
    comments: (comments || []).map((c) => pick(c, ['author', 'body', 'createdAt', 'id'])),
    threadMessages: (threadMessages || []).map((m) => pick(m, ['author', 'body', 'createdAt', 'id', 'kind', 'role'])),
    botLogin: botLogin || null,
  };
}

module.exports = {
  STAGES,
  MAX_TEXT_CHARS,
  TRUNCATED_MARK,
  hashText,
  capText,
  storeBlob,
  recordSnapshot,
  readSnapshot,
  snapshotForRun,
  stagesForRuns,
  frozenThread,
};
