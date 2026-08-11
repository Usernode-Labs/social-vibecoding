// AI-generated progress report (Reporting tab). Builds a compact,
// SHARED-VISIBILITY-ONLY snapshot of an app's development state, hashes
// it, and turns it into narrative/risks/owner-blurbs via one Haiku call
// (llm.generateReportSummary). One cached row per app (app_report_ai) —
// which is exactly why nothing viewer-private may enter the input:
// every app member sees the same cached text.
//
// This is deliberately NOT a re-implementation of the board's
// _bucketDevItems classification: the deterministic task lists stay
// client-rendered from the board's own caches; the model only needs a
// faithful summary-grade snapshot to write prose about.
const crypto = require('crypto');
const github = require('./github');
const topicAttrs = require('./topic-attributes');
const { currentVotePredicateSql } = require('./pr-vote-revision');
const limits = require('./limits');
const llm = require('./llm');
const log = require('./logger');

// Caps keep the prompt bounded on huge apps; overflow is disclosed to the
// model via `truncated` so the narrative can say "and more" honestly.
const MAX_ISSUES = 150;
const MAX_REVIEW = 50;
const MAX_GOV = 20;
const MAX_SESSIONS = 30;
const MAX_MERGED = 200;
const TITLE_MAX = 140;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// Day-granular dates: enough for the narrative, and keeps the fingerprint
// from churning on every timestamp tick.
const day = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

function parseOwnerRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function buildReportInput(pool, app) {
  const appId = app.id;

  // Open GitHub issues — the same anonymous in-process cache the board's
  // github-issues endpoint reads (services/github.js), so a report
  // generation cannot trigger more GitHub traffic than a board paint.
  let ghIssues = [];
  let issuesTruncated = false;
  const or = parseOwnerRepo(app.repo_url);
  if (or) {
    try {
      const res = await github.fetchPublicIssues(or.owner, or.repo);
      ghIssues = Array.isArray(res && res.issues) ? res.issues : [];
      issuesTruncated = !!(res && res.truncatedList);
    } catch (err) {
      log.warn('report-ai', 'issue fetch failed', { app: app.slug, message: err.message });
    }
  }
  let attrs = new Map();
  if (ghIssues.length) {
    try {
      attrs = await topicAttrs.summarizeForTargets(
        pool, appId, 'issue', ghIssues.map((i) => i.number), null
      );
    } catch (err) {
      log.warn('report-ai', 'attribute summary failed', { app: app.slug, message: err.message });
    }
  }
  const top = (s) => (s && s.top) || null;
  const issues = ghIssues.slice(0, MAX_ISSUES).map((i) => {
    const a = attrs.get(i.number) || {};
    return {
      n: i.number,
      title: clip(i.title, TITLE_MAX),
      priority: top(a.priority),
      assignee: top(a.assignee),
      category: top(a.category),
      updated: day(i.updatedAt),
    };
  });

  // Proposals awaiting review/vote. Lean row set — the deterministic task
  // list renders the full shape client-side; the model only needs enough
  // to talk about momentum and stalls.
  const { rows: reviewRows } = await pool.query(
    `SELECT cs.pr_number, cs.pr_title, cs.status, cs.check_state, cs.created_at, u.username,
            (SELECT COUNT(*) FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
            (SELECT COUNT(*) FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
      ORDER BY cs.created_at DESC
      LIMIT ${MAX_REVIEW + 1}`,
    [appId]
  );
  const review = reviewRows.slice(0, MAX_REVIEW).map((r) => ({
    pr: r.pr_number,
    title: clip(r.pr_title, TITLE_MAX),
    by: r.username || null,
    yes: Number(r.yes_count) || 0,
    no: Number(r.no_count) || 0,
    checks: r.check_state || null,
    since: day(r.created_at),
  }));

  // Open governance proposals. payload is consulted ONLY for rename (the
  // new name) — secret_change payloads never leave the server.
  const { rows: govRows } = await pool.query(
    `SELECT i.kind, i.title, i.payload, u.username AS created_by_username, i.created_at
       FROM issues i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1 AND i.status = 'open'
      ORDER BY i.created_at DESC
      LIMIT ${MAX_GOV + 1}`,
    [appId]
  );
  const gov = govRows.slice(0, MAX_GOV).map((r) => ({
    kind: r.kind,
    title: clip(
      r.kind === 'rename' && r.payload && r.payload.newName
        ? `Rename to ${r.payload.newName}` : r.title,
      TITLE_MAX
    ),
    by: r.created_by_username || null,
    since: day(r.created_at),
  }));

  // Shared in-progress sessions ONLY (shared_at IS NOT NULL): the cache
  // is app-wide, so private sessions must never enter the input. No busy
  // flag on purpose — it flips constantly and would churn the fingerprint.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.session_title, cs.pr_title, cs.branch_name, u.username, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.shared_at IS NOT NULL
        AND cs.status IN ('active', 'paused') AND cs.is_headless = FALSE
      ORDER BY cs.shared_at ASC
      LIMIT ${MAX_SESSIONS + 1}`,
    [appId]
  );
  const sessions = sessionRows.slice(0, MAX_SESSIONS).map((r) => ({
    title: clip(r.session_title || r.pr_title || r.branch_name || 'Untitled session', TITLE_MAX),
    by: r.username || null,
    since: day(r.created_at),
  }));

  // Completed work, newest first.
  const { rows: mergedRows } = await pool.query(
    `SELECT cs.pr_number, cs.pr_title, u.username, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status = 'merged'
      ORDER BY cs.created_at DESC
      LIMIT ${MAX_MERGED + 1}`,
    [appId]
  );
  const merged = mergedRows.slice(0, MAX_MERGED).map((r) => ({
    pr: r.pr_number,
    title: clip(r.pr_title, TITLE_MAX),
    by: r.username || null,
    at: day(r.created_at),
  }));

  // The last locked report (app_report_snapshots): feeding it into the
  // input lets the model write "since the last report" highlights, and
  // makes the fingerprint change the moment a snapshot lands — so a
  // just-locked report immediately makes the draft regenerable. Bounded
  // clips: this is prompt context, not display data.
  let previousReport = null;
  try {
    const { rows: snapRows } = await pool.query(
      `SELECT ai_json, locked_at FROM app_report_snapshots
        WHERE app_id = $1 AND ai_json IS NOT NULL
        ORDER BY locked_at DESC, id DESC
        LIMIT 1`,
      [appId]
    );
    const snap = snapRows[0];
    if (snap && snap.ai_json) {
      previousReport = {
        lockedAt: day(snap.locked_at),
        narrative: clip(snap.ai_json.narrative, 1500),
        highlights: (Array.isArray(snap.ai_json.highlights) ? snap.ai_json.highlights : [])
          .slice(0, 8).map((h) => clip(h, 200)).filter(Boolean),
      };
    }
  } catch (err) {
    log.warn('report-ai', 'previous-report lookup failed', { app: app.slug, message: err.message });
  }

  const input = {
    appName: clip(app.name || app.slug, 120),
    previousReport,
    issues, review, gov, sessions, merged,
    counts: {
      openIssues: issues.length,
      awaitingReview: review.length + gov.length,
      inProgress: sessions.length,
      completed: merged.length,
    },
    truncated: {
      issues: issuesTruncated || ghIssues.length > MAX_ISSUES,
      review: reviewRows.length > MAX_REVIEW,
      gov: govRows.length > MAX_GOV,
      sessions: sessionRows.length > MAX_SESSIONS,
      merged: mergedRows.length > MAX_MERGED,
    },
  };

  const known = new Set();
  for (const list of [review, gov, sessions, merged]) {
    for (const r of list) if (r.by) known.add(r.by);
  }
  for (const i of issues) if (i.assignee) known.add(i.assignee);

  return { input, knownUsernames: [...known] };
}

// Canonical (key-sorted) JSON → sha256 hex. Pure.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
function fingerprint(input) {
  return crypto.createHash('sha256').update(canonical(input)).digest('hex');
}

function shapeRow(r) {
  if (!r) return null;
  return {
    inputHash: r.input_hash,
    narrative: r.narrative,
    highlights: Array.isArray(r.highlights_json) ? r.highlights_json : [],
    risks: Array.isArray(r.risks_json) ? r.risks_json : [],
    owners: Array.isArray(r.owners_json) ? r.owners_json : [],
    model: r.model || null,
    generatedBy: r.generated_by != null ? Number(r.generated_by) : null,
    generatedAt: r.generated_at,
  };
}

async function getCached(pool, appId) {
  const { rows } = await pool.query(
    'SELECT input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at FROM app_report_ai WHERE app_id = $1',
    [appId]
  );
  return shapeRow(rows[0]);
}

// One generation per app at a time. Module-local: a second concurrent
// click 409s instead of double-billing.
const inFlight = new Set();

async function generateForApp({ pool, config, app, userId }) {
  if (inFlight.has(app.id)) {
    const err = new Error('A report is already being generated for this app');
    err.code = 'generation_in_flight';
    throw err;
  }
  inFlight.add(app.id);
  try {
    const { input, knownUsernames } = await buildReportInput(pool, app);
    const hash = fingerprint(input);
    const cached = await getCached(pool, app.id);
    if (cached && cached.inputHash === hash) return { summary: cached, cached: true };

    const billing = await limits.resolveBillingPath(pool, config.dataEncryptionKey, userId);
    if (billing.error) {
      const err = new Error(billing.error);
      err.code = 'budget_exceeded';
      throw err;
    }
    let result;
    try {
      result = await llm.generateReportSummary({
        inputJson: JSON.stringify(input),
        appName: app.name || app.slug,
        knownUsernames,
        apiKey: billing.apiKey,
      });
    } catch (err) {
      if (/LLM not initialized/.test(err.message)) {
        const e = new Error('No AI model is configured on this server');
        e.code = 'llm_unavailable';
        throw e;
      }
      throw err;
    }

    const { rows } = await pool.query(
      `INSERT INTO app_report_ai (app_id, input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, NOW())
       ON CONFLICT (app_id) DO UPDATE SET
         input_hash = EXCLUDED.input_hash, narrative = EXCLUDED.narrative,
         highlights_json = EXCLUDED.highlights_json,
         risks_json = EXCLUDED.risks_json, owners_json = EXCLUDED.owners_json,
         model = EXCLUDED.model, generated_by = EXCLUDED.generated_by, generated_at = NOW()
       RETURNING input_hash, narrative, highlights_json, risks_json, owners_json, model, generated_by, generated_at`,
      [app.id, hash, result.narrative, JSON.stringify(result.highlights || []),
        JSON.stringify(result.risks), JSON.stringify(result.owners), result.model, userId]
    );

    // Debit the Haiku call to the clicking user — into the BYOK bucket
    // when their own key paid for it, mirroring pr-metadata.js.
    if (result.usage) {
      await limits.recordSpend(
        pool, userId, llm.estimateCostCents(result.usage, result.model),
        { byok: !!billing.apiKey }
      );
    }
    return { summary: shapeRow(rows[0]), cached: false };
  } finally {
    inFlight.delete(app.id);
  }
}

module.exports = {
  buildReportInput, fingerprint, getCached, generateForApp,
};
