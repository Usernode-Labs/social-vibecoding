'use strict';

// What a full admin's connector session may read of the Homeroom bot and of
// the platform's recent before/after screenshots, beside the benchmark
// (services/bench/studio.js, routes/bench-studio.js): the same data the
// console's Homeroom bot section (services/homeroom-bot.js adminPayload) and
// its Screenshot gallery (routes/gallery.js) show, curated field by field so
// a field added to either screen later does not reach a connector by
// accident. Writes stay the console's, except a run's rating, which is how a
// run is labelled for the benchmark.

const clipText = (value, max) => {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const VERDICTS = Object.freeze(['question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise', 'budget']);
const SLUG_RE = /^[a-z0-9-]{1,120}$/;
const MAX_SHOT_IMAGES = 12;
const MAX_SHOT_IMAGE_BYTES = 8 * 1024 * 1024;

/** The run filters the console's verdict ledger takes, checked. Pure. */
function botFilters(q = {}) {
  const app = typeof q.app === 'string' && SLUG_RE.test(q.app) ? q.app : null;
  const verdict = VERDICTS.includes(q.verdict) ? q.verdict : null;
  const before = /^\d+$/.test(String(q.before || '')) ? Number(q.before) : null;
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  return {
    app, before, limit, budgetOnly: verdict === 'budget', verdict: verdict === 'budget' ? null : verdict,
  };
}

/**
 * The Homeroom bot as its console section shows it: its settings (models per
 * stage, mode, audience, clocks and caps), its spend this week, the last
 * seven days' verdicts, the queue, and a page of its runs (the verdict
 * ledger), newest first, with each run's replayable benchmark stages.
 */
async function botOverview(pool, config, query = {}, deps = {}) {
  const bot = deps.bot || require('../homeroom-bot');
  const f = botFilters(query);
  const p = await bot.adminPayload(pool, config, f);
  const s = p.settings || {};
  const runs = (p.runs || []).map((r) => ({
    id: Number(r.id),
    app: r.app_slug || null,
    issueNumber: num(r.issue_number),
    mode: r.mode || null,
    verdict: r.verdict || null,
    model: r.model || null,
    buildModel: r.build_model || null,
    costUsd: num(r.cost_usd),
    buildCostUsd: num(r.build_cost_usd),
    question: r.question ? clipText(r.question, 400) : null,
    buildNote: r.build_note ? clipText(r.build_note, 600) : null,
    reason: r.reason ? clipText(r.reason, 300) : null,
    error: r.error ? clipText(r.error, 300) : null,
    budgetStop: r.budget_stop || null,
    build: r.build_ok == null && !r.build_branch ? null : {
      ok: r.build_ok, branch: r.build_branch || null, sha: r.build_sha || null, commits: num(r.build_commits),
      error: r.build_error ? clipText(r.build_error, 300) : null, at: iso(r.build_at),
    },
    rating: r.rating || null,
    ratingNote: r.rating_note ? clipText(r.rating_note, 300) : null,
    labelVerdict: r.label_verdict || null,
    replayStages: Array.isArray(r.replayStages) ? r.replayStages : [],
    issueUrl: r.issueUrl || null,
    createdAt: iso(r.created_at),
  }));
  return {
    ok: true,
    settings: {
      mode: s.mode || null,
      audience: s.audience || null,
      models: p.bot?.models || null,
      defaultModel: p.defaultModel || null,
      turnSeconds: num(s.turnSeconds),
      concurrency: num(s.concurrency),
      buildConcurrency: num(s.buildConcurrency),
      liveAtOnce: num(s.liveAtOnce),
      perPerson: num(s.perPerson),
      shadowBuilds: !!s.shadowBuilds,
      dmChat: !!s.dmChat,
      proposalCeiling: num(s.proposalCeiling),
      userWeeklyCents: num(s.userWeeklyCents),
    },
    spend: p.bot ? {
      weeklyLimitCents: num(p.bot.weeklyLimitCents), weeklySpentCents: num(p.bot.weeklySpentCents), hasIncludedKey: !!p.bot.hasIncludedKey,
    } : null,
    totals: p.totals || null,
    queue: {
      depth: num(p.queue?.depth) || 0,
      items: (p.queue?.items || []).map((q) => ({
        app: q.app_slug || null, issueNumber: num(q.issue_number), reason: q.reason ? clipText(q.reason, 120) : null,
        enqueuedAt: iso(q.enqueued_at), startedAt: iso(q.started_at),
      })),
    },
    dmChat: p.dmChat ? {
      turns: num(p.dmChat.turns), failed: num(p.dmChat.failed), recovered: num(p.dmChat.recovered),
      people: num(p.dmChat.people), costUsd: num(p.dmChat.costUsd),
    } : null,
    runs,
    filters: { app: f.app, verdict: query.verdict && VERDICTS.includes(query.verdict) ? query.verdict : null },
    nextBefore: runs.length === f.limit ? runs[runs.length - 1].id : null,
  };
}

/** A person's rating of one bot run (the console's Rate), recorded under the connector's admin. */
async function rateRun(pool, { runId, rating, note, labelVerdict, actorId }, deps = {}) {
  const bot = deps.bot || require('../homeroom-bot');
  const out = await bot.rateRun(pool, { id: runId, rating, note, labelVerdict, actorId });
  if (!out.ok) return out;
  const r = out.run || {};
  return { ok: true, run: { id: Number(r.id), rating: r.rating || null, ratingNote: r.rating_note || null, labelVerdict: r.label_verdict || null } };
}

/**
 * The recent before/after screenshots, as the console's Screenshot gallery
 * lists them: merged proposals newest first (keyset paged), each with its
 * declared changes and the shots taken of them, and the legacy captures'
 * counts. Images are read one proposal at a time (shotImages).
 */
async function recentShots(pool, query = {}, deps = {}) {
  const gallery = deps.gallery || require('../../routes/gallery');
  const page = await gallery.listProposals(pool, {
    app: query.app, problem: query.problem, before: query.before, before_id: query.beforeId, limit: query.limit,
  });
  const proposals = (page.proposals || []).map((p) => {
    const shots = p.shots || null;
    const artifacts = Array.isArray(shots?.artifacts) ? shots.artifacts : [];
    return {
      sessionId: Number(p.id),
      app: p.appSlug || null,
      appName: p.appName || null,
      prNumber: num(p.prNumber),
      prUrl: p.prUrl || null,
      title: p.title ? clipText(p.title, 200) : null,
      mergedAt: iso(p.mergedAt),
      captureState: p.captureState || null,
      captureReason: p.captureReason ? clipText(p.captureReason, 200) : null,
      shots: shots ? {
        state: shots.state || null,
        claims: (Array.isArray(shots.claims) ? shots.claims : []).slice(0, 3).map((c) => ({
          id: c && c.id != null ? String(c.id).slice(0, 96) : null,
          claim: c && c.claim ? clipText(c.claim, 300) : null,
        })),
        images: artifacts.filter((a) => a.media === 'png').length,
        clips: artifacts.filter((a) => a.media !== 'png').length,
        failure: shots.failureReason ? clipText(shots.failureReason, 200) : null,
      } : null,
      legacyCaptures: Array.isArray(p.visuals) ? p.visuals.length : 0,
    };
  });
  return {
    ok: true,
    proposals,
    nextCursor: page.nextCursor ? { before: iso(page.nextCursor.before), beforeId: Number(page.nextCursor.before_id) } : null,
  };
}

/** The gallery's counters for a filter: how many proposals have each capture problem. */
async function shotStats(pool, query = {}, deps = {}) {
  const gallery = deps.gallery || require('../../routes/gallery');
  const out = await gallery.galleryStats(pool, { app: query.app, problem: query.problem });
  return { ok: true, stats: out.stats || {} };
}

/**
 * One merged proposal's before/after shots as images: its verified run's
 * stills (focus first, then context), before and after side by side, at
 * most MAX_SHOT_IMAGES and 8 MB. Captions name the declared change, the
 * screen size and the side; nothing else about the proposal.
 */
async function shotImages(pool, sessionId) {
  const { rows: [s] } = await pool.query(
    `SELECT cs.id, cs.status, cs.shots_run_id, cs.shots_state, cs.pr_number, a.slug AS app_slug
       FROM chat_sessions cs LEFT JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  if (!s) return { ok: false, status: 404, error: 'No such proposal' };
  if (!s.shots_run_id || s.shots_state !== 'verified') {
    return { ok: true, sessionId: Number(s.id), state: s.shots_state || null, images: [], note: 'This proposal has no verified before/after shots.' };
  }
  const { rows } = await pool.query(
    `SELECT id, story_id, viewport, side, variant, content_type, data, width, height
       FROM shot_artifacts
      WHERE run_id = $1 AND media = 'png' AND variant IN ('focus', 'context')
      ORDER BY CASE variant WHEN 'focus' THEN 0 ELSE 1 END, story_id, viewport, CASE side WHEN 'base' THEN 0 ELSE 1 END
      LIMIT 40`,
    [s.shots_run_id],
  );
  const images = [];
  let total = 0;
  let leftOut = 0;
  for (const r of rows) {
    const data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data || '');
    if (!data.length) continue;
    if (images.length >= MAX_SHOT_IMAGES || total + data.length > MAX_SHOT_IMAGE_BYTES) { leftOut += 1; continue; }
    total += data.length;
    images.push({
      caption: `${String(r.story_id).slice(0, 96)} · ${r.viewport} · ${r.side === 'base' ? 'before' : 'after'} · ${r.variant}`,
      mimeType: r.content_type || 'image/png',
      width: num(r.width),
      height: num(r.height),
      data: data.toString('base64'),
    });
  }
  return { ok: true, sessionId: Number(s.id), app: s.app_slug || null, prNumber: num(s.pr_number), state: s.shots_state, images, leftOut };
}

module.exports = {
  VERDICTS,
  MAX_SHOT_IMAGES,
  botFilters,
  botOverview,
  rateRun,
  recentShots,
  shotStats,
  shotImages,
};
