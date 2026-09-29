'use strict';

// ── The hub's since-your-last-visit line ─────────────────────────────
//
// One or two sentences at the top of a project's page on what LANDED while
// a member was away, written by Claude Sonnet 5.5 from each merged
// change's own plain-English summary (llm.generateSinceSummary).
//
// WHY WINDOWS, NOT VISITS. The last visit is the viewer's own (the hub
// keeps it per device, AppView._workshopBaseline), and on a busy project
// no two members share one: a line per visit would be a model call per
// member per merge. So the visit is floored to a WINDOW that many members
// share, and the line describes the window:
//
//   - within the last day: floored to a six-hour block (UTC);
//   - within the last two weeks: floored to its UTC day;
//   - longer ago: the last two weeks, from a UTC midnight.
//
// That is about twenty windows per project at most, whoever is visiting,
// and the line covers slightly more than the visit did. The count on the
// card is the window's, so what it says and what it covers agree.
//
// WHEN THE MODEL RUNS. Only when somebody opens the hub, and only for a
// window with more than LIST_MAX changes: with three or fewer, their own
// titles are shorter than any sentence about them. A window's line is
// cached (app_since_summaries) with the newest change it covers. When
// main moves on, the cached line is still served, and it is rewritten at
// most once per REFRESH_MIN_MS, in the background. A viewer waits on the
// model only for a window nobody has asked about yet, and concurrent
// first askers share one call.
//
// WHEN IT CANNOT. No model configured, the call failed or was refused:
// the card falls back to the newest titles and the count. A failure is
// retried after RETRY_MS, not on every page view.

const llm = require('./llm');
const limits = require('./limits');
const log = require('./logger');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BLOCK_MS = 6 * HOUR_MS;
const LONGEST_DAYS = 14;
const LIST_MAX = 3;
// The newest changes the model reads. The total is always disclosed, and
// the prompt is told when the list is cut, so a cap reads as a hedge.
const WINDOW_MAX = 400;
const EXCERPT_MAX = 600;
const TITLE_MAX = 160;
const REFRESH_MIN_MS = HOUR_MS;
const RETRY_MS = HOUR_MS;
// Rows for windows this old can no longer be asked for (see windowStart).
const KEEP_DAYS = LONGEST_DAYS + 2;

/**
 * The start of the window a visit at `since` falls in, or null when there
 * is no visit to speak of (a first visit, or a clock in the future).
 */
function windowStart(since, now = Date.now()) {
  const at = Number(since);
  if (!Number.isFinite(at) || at <= 0 || at >= now) return null;
  const age = now - at;
  if (age < DAY_MS) return Math.floor(at / BLOCK_MS) * BLOCK_MS;
  if (age < LONGEST_DAYS * DAY_MS) return Math.floor(at / DAY_MS) * DAY_MS;
  return Math.floor((now - LONGEST_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const toMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * Everything merged into the app since `fromMs`, newest first, capped at
 * WINDOW_MAX, with the uncapped total.
 */
async function fetchWindow(pool, appId, fromMs) {
  const { rows } = await pool.query(
    `SELECT cs.pr_number, cs.pr_title, cs.pr_summary_md,
            COALESCE(cs.merged_at, cs.created_at) AS landed_at,
            COUNT(*) OVER () AS total
       FROM chat_sessions cs
      WHERE cs.app_id = $1 AND cs.status = 'merged'
        AND COALESCE(cs.merged_at, cs.created_at) >= $2::timestamptz
      ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC
      LIMIT $3`,
    [appId, new Date(fromMs).toISOString(), WINDOW_MAX]
  );
  const total = rows.length ? Number(rows[0].total) || rows.length : 0;
  return {
    total,
    truncated: total > rows.length,
    headAt: rows.length ? toMs(rows[0].landed_at) : null,
    changes: rows.map((r) => ({
      pr: r.pr_number || null,
      title: clip(r.pr_title, TITLE_MAX),
      summary: clip(r.pr_summary_md, EXCERPT_MAX) || null,
    })),
  };
}

async function readCached(pool, appId, start) {
  const { rows } = await pool.query(
    `SELECT head_at, change_count, summary, error, version, generated_at
       FROM app_since_summaries
      WHERE app_id = $1 AND window_start = $2::timestamptz`,
    [appId, new Date(start).toISOString()]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    headAt: toMs(r.head_at),
    count: Number(r.change_count) || 0,
    summary: r.summary || null,
    error: r.error || null,
    version: Number(r.version) || 0,
    generatedAt: toMs(r.generated_at),
  };
}

async function writeCached(pool, appId, start, row) {
  await pool.query(
    `INSERT INTO app_since_summaries
       (app_id, window_start, head_at, change_count, summary, error, model, version, generated_at)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (app_id, window_start) DO UPDATE SET
       -- A failed rewrite keeps the line it could not replace, and the
       -- head and count that line was written for: stamping the new head
       -- on the old line would pass it off as current.
       head_at = CASE WHEN EXCLUDED.summary IS NOT NULL OR app_since_summaries.summary IS NULL
                      THEN EXCLUDED.head_at ELSE app_since_summaries.head_at END,
       change_count = CASE WHEN EXCLUDED.summary IS NOT NULL OR app_since_summaries.summary IS NULL
                           THEN EXCLUDED.change_count ELSE app_since_summaries.change_count END,
       summary = COALESCE(EXCLUDED.summary, app_since_summaries.summary),
       model = COALESCE(EXCLUDED.model, app_since_summaries.model),
       version = CASE WHEN EXCLUDED.summary IS NOT NULL
                      THEN EXCLUDED.version ELSE app_since_summaries.version END,
       error = EXCLUDED.error,
       generated_at = NOW()`,
    [appId, new Date(start).toISOString(), new Date(row.headAt).toISOString(),
      row.count, row.summary || null, row.error || null, row.model || null, llm.SINCE_SUMMARY_VERSION]
  );
  await pool.query(
    `DELETE FROM app_since_summaries
      WHERE app_id = $1 AND window_start < NOW() - make_interval(days => $2)`,
    [appId, KEEP_DAYS]
  );
}

// Debited to the platform's own account, as the Workshop digest is:
// nobody clicked "generate".
async function recordSpend(pool, app, usage, model) {
  if (!usage) return;
  try {
    const { ensurePlatformUser } = require('./fleet-maintenance');
    const platformUserId = await ensurePlatformUser(pool);
    await limits.recordSpend(pool, platformUserId, llm.estimateCostCents(usage, model));
  } catch (err) {
    log.warn('since-summary', 'spend record failed', { app: app.slug, message: err.message });
  }
}

// One call per window per process at a time; later askers share it.
const inFlight = new Map();

function generate(pool, app, start, win) {
  const key = `${app.id}:${start}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const run = (async () => {
    try {
      const out = await llm.generateSinceSummary({
        changes: win.changes,
        total: win.total,
        truncated: win.truncated,
        fromDate: new Date(start).toISOString().slice(0, 10),
        telemetryContext: { pool, appId: app.id },
      });
      await recordSpend(pool, app, out.usage, out.model);
      await writeCached(pool, app.id, start, {
        headAt: win.headAt, count: win.total, summary: out.summary, model: out.model,
      });
      return { summary: out.summary, headAt: win.headAt, count: win.total };
    } catch (err) {
      log.warn('since-summary', 'generation failed', { app: app.slug, message: err.message });
      try {
        await writeCached(pool, app.id, start, {
          headAt: win.headAt, count: win.total, error: String(err.message || err).slice(0, 300),
        });
      } catch (writeErr) {
        log.warn('since-summary', 'failure record failed', { app: app.slug, message: writeErr.message });
      }
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

const listOf = (win) => win.changes.slice(0, LIST_MAX).map((c) => ({ pr: c.pr, title: c.title }));

/**
 * What the hub's card shows for a viewer whose last visit was `since`:
 *   { state: 'none' }                                   nothing landed
 *   { state: 'list', windowStart, headAt, count, items } their titles
 *   { state: 'ai',   windowStart, headAt, count, text }  the line
 */
async function getSummary(pool, app, { since, now = Date.now() } = {}) {
  const start = windowStart(since, now);
  if (start == null) return { state: 'none' };
  const win = await fetchWindow(pool, app.id, start);
  if (!win.total) return { state: 'none' };

  const base = { windowStart: start, headAt: win.headAt, count: win.total };
  const list = { ...base, state: 'list', items: listOf(win) };
  if (win.total <= LIST_MAX) return list;

  const cached = await readCached(pool, app.id, start);
  const current = cached && cached.version === llm.SINCE_SUMMARY_VERSION;
  const line = current && cached.summary
    ? { state: 'ai', windowStart: start, headAt: cached.headAt, count: cached.count, text: cached.summary }
    : null;

  // Written for the newest change there is: nothing to do.
  if (line && cached.headAt >= win.headAt) return line;
  if (!llm.isEnabled()) return line || list;
  // Failed recently, or written recently under this prompt: serve what
  // there is, and wait. A line from an older prompt is rewritten at once.
  const recent = !!cached && (cached.error
    ? now - cached.generatedAt < RETRY_MS
    : current && now - cached.generatedAt < REFRESH_MIN_MS);
  if (recent) return line || list;
  // Out of date: serve the old line now and rewrite it for the next viewer.
  if (line) {
    void generate(pool, app, start, win);
    return line;
  }
  const made = await generate(pool, app, start, win);
  return made ? { ...base, state: 'ai', text: made.summary } : list;
}

module.exports = {
  getSummary,
  windowStart,
  fetchWindow,
  LIST_MAX,
  WINDOW_MAX,
  REFRESH_MIN_MS,
  _inFlight: inFlight,
};
