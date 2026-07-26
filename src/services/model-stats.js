'use strict';

// #800: per-model "issues solved" outcome stats for the model selector.
//
// The dev-chat model dropdown used to label each model with its raw
// output-token price ($/MTok), which tells a non-technical builder
// nothing about whether that model will actually finish their change.
// This module computes the measured half of the replacement: for each
// model, the share of GitHub issues it was pointed at that ended up
// MERGED, expressed as a range rather than a point estimate.
//
// What counts as an attempt / a solve
// -----------------------------------
//   attempt = one chat session that was an attempt at a GitHub issue
//             (linked_issues non-empty, or created_from_issue_number,
//             or headless_issue_number), created inside WINDOW_DAYS.
//   solved  = that session's PR merged (chat_sessions.merged_at). Merge
//             is what closes the issue: services/pr-metadata.js writes a
//             deterministic `Closes #N` block from linked_issues and
//             services/issue-close-watcher.js reconciles the close, so
//             "merged issue-linked session" is a faithful proxy for
//             "issue solved".
//
// Why aggregate by TIER, not by model id
// --------------------------------------
// chat_sessions has no `model` column — the model lives on the assistant
// rows in chat_session_messages, and those rows carry PREVIOUS-GENERATION
// ids alongside current ones (claude-opus-4-8, claude-sonnet-4-6,
// claude-haiku-4-5-20251001, …). Aggregating by exact id would leave
// every currently-offered id below any usable sample size, so we fold ids
// into the tier families already declared in services/models.js and
// attach a tier's stats to every current model id sharing that tier. This
// is the same substring convention prettyModelLabel (routes/sessions.js)
// and llm.js's price table use.
//
// Honesty rules baked in
// ----------------------
//   - The band is a Wilson score interval (90%), so a small sample widens
//     the range instead of implying false precision, and the bounds can
//     never fall outside 0-100 the way p +/- z*sqrt(p(1-p)/n) can.
//   - Below MIN_ATTEMPTS the range is suppressed entirely
//     (hasEnoughData: false) and the UI shows a "new" state.
//   - These numbers are OBSERVATIONAL, not a benchmark: harder issues get
//     pointed at stronger models, and merging also depends on human
//     review. Restricting the denominator to issue-linked sessions and
//     surfacing the raw attempt count is the mitigation — do NOT widen
//     the denominator back to all sessions, which ranks the cheap tiers
//     above Opus purely through task-selection bias.

const log = require('./logger');
const models = require('./models');

// Only sessions created inside this window count. A no-op today (the
// platform's whole history is newer than 90 days) but it keeps the figure
// from calcifying as model generations turn over.
const WINDOW_DAYS = 90;

// Below this many finished attempts we refuse to show a percentage at
// all. 25 is the point where a Wilson band stops being wider than it is
// informative (at n=19 the band spans ~35 points).
const MIN_ATTEMPTS = 25;

// z for a 90% two-sided normal interval.
const Z = 1.645;

// The aggregate is a sequential scan over chat_session_messages (~76k
// rows in production, no index beyond the pkey until this change adds
// one), and GET /api/models is hit on every dev-chat load — so cache it.
// Same shape as the platform_settings cache in services/limits.js, just
// a much longer TTL: these counts move on human voting timescales.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null; // { at: <ms>, value: <stats map | null> }

// Fold a raw model id (current or previous generation) into one of the
// tier families declared in services/models.js. Returns null for an id
// that belongs to no known family, so unknown slugs are dropped from the
// aggregate rather than silently landing in some tier's bucket.
function tierOf(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  const id = modelId.toLowerCase();
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  if (id.includes('fable')) return 'fable';
  return null;
}

// Wilson score interval at 90%, in whole percents. Returns
// { lowPct, highPct } clamped to [0, 100]; null when there's nothing to
// compute from (n <= 0 or non-finite input).
function wilsonBand(solved, attempts) {
  const n = Number(attempts);
  const k = Number(solved);
  if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0) return null;

  const p = Math.min(Math.max(k / n, 0), 1);
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;

  const clamp = (v) => Math.min(100, Math.max(0, Math.round(v * 100)));
  return { lowPct: clamp(center - half), highPct: clamp(center + half) };
}

// Shape one tier's raw counts into the per-model payload the UI reads.
function entryFor(attempts, solved, extra) {
  const hasEnoughData = attempts >= MIN_ATTEMPTS;
  const band = hasEnoughData ? wilsonBand(solved, attempts) : null;
  return {
    attempts,
    solved,
    lowPct: band ? band.lowPct : null,
    highPct: band ? band.highPct : null,
    hasEnoughData: hasEnoughData && !!band,
    ...(extra || {}),
  };
}

// Attach each tier's counts to every currently-offered model id that
// shares that tier. A model whose tier has no rows at all still gets an
// entry (attempts 0) so the UI renders its "new" state rather than
// falling all the way back to a bare label.
function mapTiersToModels(byTier, extra) {
  const out = {};
  for (const [id, meta] of Object.entries(models.MODELS)) {
    const counts = byTier[meta.tier] || { attempts: 0, solved: 0 };
    out[id] = entryFor(counts.attempts, counts.solved, extra);
  }
  return out;
}

const IS_STAGING = () => process.env.USERNODE_ENV === 'staging';

// Staging previews clone chat_sessions / chat_session_messages
// SCHEMA-ONLY (both are staging:private), so the real query would report
// zero attempts for every model and the whole feature would be
// unreviewable. Per the "Staging mock data" convention this is
// request-time demo injection: fixed counts, no DB writes, strictly a
// no-op in production. Chosen so one preview exercises BOTH render
// states — Fable and Opus above the threshold, Sonnet below it.
const STAGING_DEMO_TIERS = {
  fable: { attempts: 401, solved: 221 },
  opus: { attempts: 312, solved: 149 },
  sonnet: { attempts: 19, solved: 10 },
};

function demoStats() {
  return mapTiersToModels(STAGING_DEMO_TIERS, { demo: true });
}

const STATS_SQL = `
    WITH per_tier AS (
      SELECT s.id AS session_id,
             s.merged_at,
             CASE
               WHEN m.model ILIKE '%haiku%'  THEN 'haiku'
               WHEN m.model ILIKE '%sonnet%' THEN 'sonnet'
               WHEN m.model ILIKE '%opus%'   THEN 'opus'
               WHEN m.model ILIKE '%fable%'  THEN 'fable'
             END AS tier,
             COUNT(*)  AS msg_count,
             MAX(m.id) AS last_msg_id
        FROM chat_sessions s
        JOIN chat_session_messages m ON m.session_id = s.id
       WHERE m.role = 'assistant'
         AND m.model IS NOT NULL
         AND s.created_at > NOW() - INTERVAL '${WINDOW_DAYS} days'
         AND (array_length(s.linked_issues, 1) > 0
              OR s.created_from_issue_number IS NOT NULL
              OR s.headless_issue_number IS NOT NULL)
       GROUP BY s.id, s.merged_at, tier
    ),
    dominant AS (
      -- One row per session: the tier that produced the most assistant
      -- turns, tie-broken by the most recent message. ~5% of sessions
      -- straddle tiers (a user escalating Sonnet -> Opus mid-change), so
      -- this has to be deterministic rather than double-counting them.
      SELECT DISTINCT ON (session_id) session_id, merged_at, tier
        FROM per_tier
       WHERE tier IS NOT NULL
       ORDER BY session_id, msg_count DESC, last_msg_id DESC
    )
    SELECT tier,
           COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE merged_at IS NOT NULL)::int AS solved
      FROM dominant
     GROUP BY tier`;

// Per-model outcome stats, keyed by model id. Cached for CACHE_TTL_MS.
// Returns null on any query failure — callers serialise that as
// `stats: null` and the UI degrades to plain model labels.
async function statsForModels(pool) {
  if (IS_STAGING()) return demoStats();

  if (cache && Date.now() - cache.at <= CACHE_TTL_MS) return cache.value;

  let value = null;
  try {
    const { rows } = await pool.query(STATS_SQL);
    const byTier = {};
    for (const row of rows) {
      if (!row || !row.tier) continue;
      byTier[row.tier] = {
        attempts: Number(row.attempts) || 0,
        solved: Number(row.solved) || 0,
      };
    }
    value = mapTiersToModels(byTier);
  } catch (err) {
    // Never fatal: the selector is still usable without the numbers.
    log.warn('model-stats', 'failed to aggregate per-model issue outcomes', {
      error: err.message,
    });
    value = null;
  }

  cache = { at: Date.now(), value };
  return value;
}

// Test seam only — drops the TTL cache so a suite can assert the
// query/caching contract without waiting five minutes.
function _resetCacheForTests() {
  cache = null;
}

module.exports = {
  statsForModels,
  tierOf,
  wilsonBand,
  MIN_ATTEMPTS,
  WINDOW_DAYS,
  CACHE_TTL_MS,
  STATS_SQL,
  _resetCacheForTests,
};
