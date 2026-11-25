// The challenge page's itemized list — every report or proposal the viewer
// has for the challenge's current period, with the status the scorer's own
// rules give it (#7152).
//
// The count on "Send useful feedback" and "Get a proposal accepted" is a
// number with no way to see which of your reports or changes it counted, or
// why one did not. This reader answers it item by item, from the same rule
// row, the same eligibility test, the same junk filter and the same plan the
// scorer pays by, so the list can never disagree with what the next scheduled
// pass will do. Read-only: it writes nothing, grades nothing, and never calls
// the model.
'use strict';

const scorer = require('./challenge-scorer');
const rules = require('./challenge-rules');
const grader = require('./challenge-grader');
const { SELF_APP_SQL, repoMatches } = require('./feedback-links');

const ITEM_LIMIT = 50;

// The viewer's own ledger rows on this challenge: the source keys already
// paid, their points and (for a graded measure) the grader's reason, plus
// what loadCredited needs for the weekly cap.
const VIEWER_CREDITS_SQL = `
  SELECT metadata->>'source_key' AS source_key, points, activity_at, metadata->'grade' AS grade
    FROM user_activities
   WHERE challenge_id = $1 AND user_id = $2
`;

// The viewer's reports that reached GitHub inside the period, with the
// scorer's own eligibility test and the two reasons a report fails it.
const VIEWER_FEEDBACK_SQL = `
  SELECT fr.id, fr.created_at, fr.title, fr.description, fr.issue_number,
         fr.issue_owner, fr.issue_repo, fr.target,
         a.slug AS app_slug, a.name AS app_name,
         (${scorer.USEFUL_FEEDBACK_ELIGIBLE_SQL}) AS eligible,
         (a.id IS NOT NULL AND a.created_by = fr.user_id) AS own_project,
         (a.id IS NOT NULL
          AND a.view_visibility IS DISTINCT FROM 'public'
          AND (SELECT COUNT(*) FROM community_members o WHERE o.community_id = a.community_id) <= 1
          AND NOT EXISTS (SELECT 1 FROM app_collaborators ic
                           WHERE ic.app_id = a.id AND ic.status = 'invited')) AS solo
    FROM feedback_reports fr
    LEFT JOIN apps a ON a.id = fr.app_id
   WHERE fr.user_id = $3
     AND fr.created_at >= $1 AND fr.created_at <= $2
     AND fr.issue_number IS NOT NULL
   ORDER BY fr.created_at ASC, fr.id ASC
`;

// The changes the viewer earned: their own changes, and changes built for a
// request they filed (by the request's own author, or by whom the bot took
// the request from), the same relationships PROPOSAL_ACCEPTED_SQL credits.
// Sessions still up for a vote are kept whatever the window; merged and
// archived ones only inside it. The newest pr_merged event carries whether an
// admin forced the merge, which is the ledger's own distinction.
const VIEWER_PROPOSALS_SQL = `
  WITH viewer_sessions AS (
    SELECT cs.id AS session_id, cs.user_id, cs.status, cs.live_at, cs.pr_number,
           cs.pr_title, cs.promoted_at, cs.merged_at, cs.archived_at, cs.last_activity_at,
           cs.app_id, a.slug AS app_slug, a.name AS app_name,
           CASE WHEN cs.user_id = $3 THEN 'author' ELSE 'request' END AS via
      FROM chat_sessions cs
      LEFT JOIN apps a ON a.id = cs.app_id
     WHERE cs.is_headless = FALSE
       AND cs.promoted_at IS NOT NULL
       AND (
         cs.user_id = $3
         OR EXISTS (
           SELECT 1
             FROM requests rq
            WHERE rq.app_id = cs.app_id
              AND (rq.number = ANY(cs.linked_issues) OR rq.number = cs.created_from_issue_number)
              AND (rq.created_by = $3
                   OR EXISTS (SELECT 1 FROM homeroom_bot_requesters hbr
                               WHERE hbr.app_id = rq.app_id
                                 AND hbr.issue_number = rq.number
                                 AND hbr.user_id = $3))
         )
       )
  )
  SELECT vs.session_id, vs.user_id, vs.status, vs.live_at, vs.pr_number,
         vs.pr_title, vs.promoted_at, vs.merged_at, vs.archived_at, vs.last_activity_at,
         vs.app_slug, vs.app_name, vs.via,
         ev.id AS merge_event_id, ev.created_at AS merge_event_at,
         COALESCE(ev.forced, FALSE) AS merge_forced
    FROM viewer_sessions vs
    LEFT JOIN LATERAL (
      SELECT e.id, e.created_at,
             COALESCE((e.metadata->>'forced')::boolean, FALSE) AS forced
        FROM events e
       WHERE e.session_id = vs.session_id
         AND e.event_type = 'pr_merged'
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1
    ) ev ON TRUE
   WHERE vs.status IN ('promoted', 'merging')
      OR (vs.status = 'merged' AND vs.merged_at >= $1 AND vs.merged_at <= $2)
      OR (vs.status = 'archived'
          AND COALESCE(vs.archived_at, vs.last_activity_at) >= $1
          AND COALESCE(vs.archived_at, vs.last_activity_at) <= $2)
   ORDER BY vs.session_id ASC
`;

const FEEDBACK_ORDER = Object.freeze({ counted: 0, grading: 1 });
const PROPOSAL_ORDER = Object.freeze({
  up_for_vote: 0, going_live: 1, live: 2, closed: 3,
});

const tsOf = (v) => (v instanceof Date ? v.getTime() : (v == null ? NaN : Date.parse(v)));
const isoOf = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (v == null) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function ruleOf(row) {
  return {
    id: row.rule_id,
    name: row.rule_name,
    measure: row.measure,
    target: row.rule_target,
    points: row.rule_points,
    enabled: row.rule_enabled,
  };
}

// The period the list shows, the same window the count uses. A weekly
// challenge counts a week at a time (challenge-rules.weeklyWindows), so its
// list is this week's, clipped to the challenge's own dates.
function itemWindow(window, weekly, now) {
  let startMs = weekly ? rules.weekStartMs(now) : window.startMs;
  let endMs = weekly ? now : (window.endMs == null ? now : window.endMs);
  if (weekly && window.startMs != null) startMs = Math.max(startMs, window.startMs);
  if (weekly && window.endMs != null) endMs = Math.min(endMs, window.endMs);
  if (startMs == null) startMs = 0;
  return { startMs, endMs };
}

function creditedState(rows, viewer) {
  const state = { keys: new Set(), count: 0, weeks: new Map() };
  const byKey = new Map();
  for (const r of rows) {
    if (r.source_key == null) continue;
    state.keys.add(r.source_key);
    state.count += 1;
    const at = tsOf(r.activity_at);
    if (Number.isFinite(at)) {
      const week = rules.weekStartMs(at);
      state.weeks.set(week, (state.weeks.get(week) || 0) + 1);
    }
    // The newest row for a key wins; the unique index makes it one anyway.
    byKey.set(r.source_key, r);
  }
  const map = new Map();
  map.set(viewer, state);
  return { map, byKey };
}

function feedbackStatus(row, { credit, preFilterReason, planned }) {
  if (credit) {
    return {
      status: 'counted',
      points: Number(credit.points) || 0,
      reason_text: (credit.grade && typeof credit.grade.reason === 'string')
        ? credit.grade.reason : null,
    };
  }
  if (!row.eligible) {
    return { status: row.own_project ? 'own_project' : 'solo' };
  }
  if (preFilterReason === 'too short to act on') return { status: 'too_short' };
  if (preFilterReason) return { status: 'duplicate' };
  return { status: planned ? 'grading' : 'over_target' };
}

function proposalState(row) {
  const status = String(row.status || '');
  if (status === 'promoted') return 'up_for_vote';
  if (status === 'merging') return 'going_live';
  if (status === 'merged') return row.live_at != null ? 'live' : 'going_live';
  return 'closed';
}

async function challengeItems(pool, { userId, challengeId, now = Date.now() } = {}) {
  const viewer = Number(userId);
  const challenge = Number(challengeId);
  if (!Number.isFinite(viewer) || !viewer
      || !Number.isFinite(challenge) || !challenge) return null;

  // ── 1. The rule row for this challenge ────────────────────────────────
  const { rows: ruleRows } = await pool.query(scorer.RULE_CHALLENGES_SQL, [scorer.ONBOARDING_LIMIT]);
  const row = ruleRows.find((r) => Number(r.challenge_id) === challenge
    && (r.measure === 'USEFUL_FEEDBACK' || r.measure === 'PROPOSAL_ACCEPTED')
    && r.rule_enabled !== false);
  if (!row) return null;
  const rule = ruleOf(row);
  const window = rules.resolveWindow(row, { now });
  const target = rules.effectiveTarget(rule, row);
  const weekly = rules.isWeekly(row);
  const perItem = itemWindow(window, weekly, now);
  const startIso = new Date(perItem.startMs).toISOString();
  const endIso = new Date(perItem.endMs).toISOString();

  // ── 2. The viewer's credits on this challenge ─────────────────────────
  const { rows: creditRows } = await pool.query(VIEWER_CREDITS_SQL, [challenge, viewer]);
  const { map: credited, byKey: creditsByKey } = creditedState(creditRows, viewer);

  const measure = row.measure === 'PROPOSAL_ACCEPTED' ? 'PROPOSAL_ACCEPTED' : 'USEFUL_FEEDBACK';

  // The per-item ceiling the grader is given (challenge-rules.unitPoints).
  const points = rules.effectivePoints(rule, row);
  const max = measure === 'USEFUL_FEEDBACK'
    && Number.isFinite(points) && Number.isFinite(target) && target > 0
    ? rules.unitPoints({ payout: 'graded', points, target, index: 0 })
    : null;

  const items = measure === 'USEFUL_FEEDBACK'
    ? await feedbackItems(pool, {
      viewer, row, rule, startIso, endIso, credited, creditsByKey, max, now,
    })
    : await proposalItems(pool, {
      viewer, row, rule, startIso, endIso, perItem, credited, creditsByKey, now,
    });

  return {
    measure,
    target: Number.isFinite(target) ? target : null,
    weekly,
    items: items.slice(0, ITEM_LIMIT),
  };
}

async function feedbackItems(pool, {
  viewer, row, rule, startIso, endIso, credited, creditsByKey, max, now,
}) {
  const ownApps = row.first_challenge === true;
  const { rows } = await pool.query(VIEWER_FEEDBACK_SQL, [startIso, endIso, viewer, ownApps]);

  // One bag over the eligible reports in the scorer's own order, exactly as
  // scoreChallenge screens one person's candidates.
  const bag = new Set();
  const filtered = new Map();
  const eligibleCandidates = [];
  for (const r of rows) {
    if (creditsByKey.has(`feedback:${r.id}`)) {
      // A paid report is counted whatever the filters say now; its text still
      // joins the bag, as the scorer walks credited candidates through it.
      grader.preFilter('USEFUL_FEEDBACK', { text: r.description }, bag);
      continue;
    }
    if (!r.eligible) continue;
    const reason = grader.preFilter('USEFUL_FEEDBACK', { text: r.description }, bag);
    filtered.set(Number(r.id), reason);
    if (!reason) {
      eligibleCandidates.push({
        userId: viewer,
        sourceKey: `feedback:${r.id}`,
        activityAt: isoOf(r.created_at),
        description: r.app_name ? `Feedback on ${r.app_name}` : 'Feedback on Homeroom',
      });
    }
  }

  // Which of the remaining reports the next scheduled count would plan.
  const planned = new Set(
    rules.planCredits(rule, row, { candidates: eligibleCandidates, credited, now })
      .map((c) => c.sourceKey),
  );

  // A platform report links to the self-hosted app's board only when the
  // report really went to that repo.
  let selfApp = null;
  if (rows.some((r) => r.target === 'platform' && r.issue_number != null)) {
    const { rows: selfRows } = await pool.query(SELF_APP_SQL);
    selfApp = selfRows[0] || null;
  }

  const feedback = [];
  for (const r of rows) {
    const key = `feedback:${r.id}`;
    const credit = creditsByKey.get(key);
    const status = feedbackStatus(r, {
      credit, preFilterReason: filtered.get(Number(r.id)), planned: planned.has(key),
    });

    let link = null;
    const number = Number(r.issue_number);
    if (Number.isSafeInteger(number) && number > 0) {
      if (r.target === 'platform') {
        if (selfApp && repoMatches(selfApp.repo_url, r.issue_owner, r.issue_repo)) {
          link = { kind: 'request', slug: selfApp.slug, number };
        }
      } else if (r.app_slug) {
        link = { kind: 'request', slug: r.app_slug, number };
      }
    }

    feedback.push({
      key,
      title: r.title || r.description || '',
      app_name: r.target === 'platform' ? 'Homeroom' : (r.app_name || r.app_slug || null),
      at: isoOf(r.created_at),
      status: status.status,
      ...(status.points != null ? { points: status.points } : {}),
      ...(max != null ? { max } : {}),
      ...(status.reason_text ? { reason_text: status.reason_text } : {}),
      link,
    });
  }

  // Counted, then still grading, then everything the count will not take.
  feedback.sort((a, b) => (feedbackRank(a.status) - feedbackRank(b.status))
    || newestFirst(a, b));
  return feedback;
}

function feedbackRank(status) {
  return FEEDBACK_ORDER[status] ?? 2;
}

async function proposalItems(pool, {
  viewer, row, rule, startIso, endIso, perItem, credited, creditsByKey, now,
}) {
  const { rows } = await pool.query(VIEWER_PROPOSALS_SQL, [startIso, endIso, viewer]);

  const inWindow = (value) => {
    const at = tsOf(value);
    return Number.isFinite(at) && at >= perItem.startMs && at <= perItem.endMs;
  };

  const candidates = [];
  for (const r of rows) {
    if (r.merge_event_id == null) continue;
    const key = `merged:${r.merge_event_id}`;
    if (creditsByKey.has(key)) continue;
    if (r.merge_forced === true) continue;
    if (!inWindow(r.merge_event_at)) continue;
    candidates.push({
      userId: viewer,
      sourceKey: key,
      activityAt: isoOf(r.merge_event_at),
      via: r.via,
      description: r.app_name ? `Accepted proposal on ${r.app_name}` : 'Accepted proposal',
    });
  }
  const planned = new Set(
    rules.planCredits(rule, row, { candidates, credited, now })
      .map((c) => c.sourceKey),
  );

  const proposals = rows.map((r) => {
    const state = proposalState(r);
    const key = r.merge_event_id != null ? `merged:${r.merge_event_id}` : `change:${r.session_id}`;
    const credit = r.merge_event_id != null ? creditsByKey.get(key) : null;

    let status;
    if (credit) status = 'counted';
    else if (r.merge_forced === true) status = 'forced';
    else if (r.merge_event_id == null) status = state === 'closed' ? 'closed' : 'needs_accept';
    else if (!inWindow(r.merge_event_at)) status = state === 'closed' ? 'closed' : 'needs_accept';
    else status = planned.has(key) ? 'pending_count' : 'over_target';

    const number = Number(r.pr_number);
    const link = r.app_slug && Number.isInteger(Number(r.session_id)) && Number(r.session_id) > 0
      ? {
        kind: 'change',
        slug: r.app_slug,
        session_id: Number(r.session_id),
        pr_number: Number.isInteger(number) && number > 0 ? number : null,
      }
      : null;

    return {
      key: `change:${r.session_id}`,
      title: r.pr_title || '',
      app_name: r.app_name || r.app_slug || null,
      at: isoOf(r.merge_event_at || r.promoted_at || r.merged_at || r.archived_at || r.last_activity_at),
      status,
      state,
      via: r.via,
      ...(status === 'counted' ? { points: Number(credit.points) || 0 } : {}),
      link,
    };
  });

  // Up for vote, going live, live, then closed; newest first within a group.
  proposals.sort((a, b) => ((PROPOSAL_ORDER[a.state] ?? 9) - (PROPOSAL_ORDER[b.state] ?? 9))
    || newestFirst(a, b));
  return proposals;
}

// planCredits wants the rule/row pair, which the caller passes as the real
// challenge row (its `t_category`, target and window fields are what the
// helpers read).

function newestFirst(a, b) {
  const at = (x) => { const t = tsOf(x.at); return Number.isFinite(t) ? t : 0; };
  return at(b) - at(a);
}

module.exports = { challengeItems, VIEWER_FEEDBACK_SQL, VIEWER_PROPOSALS_SQL };
