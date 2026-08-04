// Privacy-minimized feature engagement and drop-off detection (#917).
//
// This is intentionally server-side and catalog-only. Hosted apps do not get
// an ingestion endpoint, and callers cannot attach arbitrary metadata. Raw
// rows contain internal FKs plus a workflow/stage/timestamp and are deleted
// after 90 days (or immediately with account deletion via the FK).

const { getPool } = require('../db/pool');
const log = require('./logger');

const CATALOG_VERSION = 1;
const RAW_RETENTION_DAYS = 90;
const COMPLETION_WINDOW_DAYS = 7;
const RECENT_COHORT_DAYS = 7;
const BASELINE_COHORT_DAYS = 28;
const MIN_STARTS = 20;
const DROP_THRESHOLD_POINTS = 20;
const RETENTION_BATCH_SIZE = 5000;

const WORKFLOW_IDS = Object.freeze({
  ONBOARDING_FIRST_APP: 'onboarding_first_app',
  PROPOSAL_AUTHORING: 'proposal_authoring',
  PROPOSAL_SUBMISSION: 'proposal_submission',
  PROPOSAL_REVIEW: 'proposal_review',
  PROPOSAL_DELIVERY: 'proposal_delivery',
});

const CATALOG = Object.freeze({
  [WORKFLOW_IDS.ONBOARDING_FIRST_APP]: Object.freeze({
    label: 'Onboarding to first app use',
    startLabel: 'Account created',
    completionLabel: 'Recorded first app activity',
    subject: 'user',
  }),
  [WORKFLOW_IDS.PROPOSAL_AUTHORING]: Object.freeze({
    label: 'Proposal authoring',
    startLabel: 'Dev session started',
    completionLabel: 'Changes ready or pull request opened',
    subject: 'session',
  }),
  [WORKFLOW_IDS.PROPOSAL_SUBMISSION]: Object.freeze({
    label: 'Proposal submission',
    startLabel: 'Changes ready or pull request opened',
    completionLabel: 'Proposal promoted',
    subject: 'session',
  }),
  [WORKFLOW_IDS.PROPOSAL_REVIEW]: Object.freeze({
    label: 'Proposal review',
    startLabel: 'Proposal promoted',
    completionLabel: 'First external vote received',
    subject: 'session',
  }),
  [WORKFLOW_IDS.PROPOSAL_DELIVERY]: Object.freeze({
    label: 'Proposal delivery',
    startLabel: 'Proposal promoted',
    completionLabel: 'Proposal merged',
    subject: 'session',
  }),
});

function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') return poolOrConfig;
  return getPool(poolOrConfig);
}

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Fire-and-forget and fail-open, matching services/events.js: analytics must
// never make the originating product action fail. Invalid/non-catalog input
// is dropped before it reaches SQL.
function record(poolOrConfig, { workflow, stage, userId, appId, sessionId } = {}) {
  try {
    const definition = CATALOG[workflow];
    const uid = positiveId(userId);
    const sid = positiveId(sessionId);
    if (!definition || !['start', 'complete'].includes(stage) || !uid) {
      return Promise.resolve();
    }
    if (definition.subject === 'session' && !sid) return Promise.resolve();
    if (definition.subject === 'user' && sid) return Promise.resolve();

    const pool = resolvePool(poolOrConfig);
    const result = pool.query(
      `INSERT INTO feature_engagement_events
         (catalog_version, workflow, stage, user_id, app_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [CATALOG_VERSION, workflow, stage, uid, positiveId(appId), sid]
    );
    if (result && typeof result.then === 'function') {
      return result.then(() => {}).catch((err) => {
        log.debug('feature-engagement', 'record failed', { workflow, stage, err: err.message });
      });
    }
  } catch (err) {
    log.debug('feature-engagement', 'record skipped', {
      workflow, stage, err: err && err.message,
    });
  }
  return Promise.resolve();
}

function recordStart(poolOrConfig, workflow, ids) {
  return record(poolOrConfig, { ...ids, workflow, stage: 'start' });
}

function recordComplete(poolOrConfig, workflow, ids) {
  return record(poolOrConfig, { ...ids, workflow, stage: 'complete' });
}

function utcDay(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new TypeError('Invalid analytics date');
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function minusDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function cohortBounds(now = new Date()) {
  const anchor = utcDay(now);
  return {
    baselineStart: minusDays(anchor, COMPLETION_WINDOW_DAYS + RECENT_COHORT_DAYS + BASELINE_COHORT_DAYS),
    baselineEnd: minusDays(anchor, COMPLETION_WINDOW_DAYS + RECENT_COHORT_DAYS),
    recentStart: minusDays(anchor, COMPLETION_WINDOW_DAYS + RECENT_COHORT_DAYS),
    recentEnd: minusDays(anchor, COMPLETION_WINDOW_DAYS),
    completionCutoff: anchor,
  };
}

function rate(completed, starts) {
  return starts > 0 ? (completed / starts) * 100 : null;
}

function evaluateWorkflow(workflow, counts = {}) {
  const definition = CATALOG[workflow];
  if (!definition) return null;
  const recentStarts = Number(counts.recent_starts ?? counts.recentStarts) || 0;
  const recentCompletions = Number(counts.recent_completions ?? counts.recentCompletions) || 0;
  const baselineStarts = Number(counts.baseline_starts ?? counts.baselineStarts) || 0;
  const baselineCompletions = Number(counts.baseline_completions ?? counts.baselineCompletions) || 0;
  const recentRate = rate(recentCompletions, recentStarts);
  const baselineRate = rate(baselineCompletions, baselineStarts);
  const declinePoints = recentRate == null || baselineRate == null
    ? null
    : baselineRate - recentRate;
  const enoughData = recentStarts >= MIN_STARTS && baselineStarts >= MIN_STARTS;
  const isDropoff = enoughData && declinePoints >= DROP_THRESHOLD_POINTS;
  return {
    id: workflow,
    label: definition.label,
    startLabel: definition.startLabel,
    completionLabel: definition.completionLabel,
    recentStarts,
    recentCompletions,
    recentRate,
    baselineStarts,
    baselineCompletions,
    baselineRate,
    declinePoints,
    status: !enoughData ? 'insufficient_data' : isDropoff ? 'dropoff' : 'healthy',
    insight: isDropoff,
  };
}

// Fully matured cohorts prevent right-censoring: the newest start is already
// at least seven days old, and each start gets the same seven-day completion
// allowance. Only non-admin users contribute, so operator/test behavior does
// not manufacture insights.
async function insights(poolOrConfig, { now = new Date() } = {}) {
  const pool = resolvePool(poolOrConfig);
  const bounds = cohortBounds(now);
  const { rows } = await pool.query(
    `WITH starts AS (
       SELECT s.*,
              EXISTS (
                SELECT 1
                  FROM feature_engagement_events c
                 WHERE c.catalog_version = s.catalog_version
                   AND c.workflow = s.workflow
                   AND c.stage = 'complete'
                   AND c.occurred_at >= s.occurred_at
                   AND c.occurred_at < s.occurred_at + INTERVAL '7 days'
                   AND c.user_id = s.user_id
                   AND CASE WHEN s.workflow = $5
                            THEN c.session_id IS NULL
                            ELSE c.session_id = s.session_id END
              ) AS completed
         FROM feature_engagement_events s
         JOIN users u ON u.id = s.user_id AND u.is_admin = FALSE
        WHERE s.catalog_version = $1
          AND s.stage = 'start'
          AND s.occurred_at >= $2
          AND s.occurred_at < $4
     )
     SELECT workflow,
            COUNT(*) FILTER (WHERE occurred_at >= $2 AND occurred_at < $3)::int AS baseline_starts,
            COUNT(*) FILTER (WHERE occurred_at >= $2 AND occurred_at < $3 AND completed)::int AS baseline_completions,
            COUNT(*) FILTER (WHERE occurred_at >= $3 AND occurred_at < $4)::int AS recent_starts,
            COUNT(*) FILTER (WHERE occurred_at >= $3 AND occurred_at < $4 AND completed)::int AS recent_completions
       FROM starts
      GROUP BY workflow`,
    [
      CATALOG_VERSION,
      bounds.baselineStart,
      bounds.baselineEnd,
      bounds.recentEnd,
      WORKFLOW_IDS.ONBOARDING_FIRST_APP,
    ]
  );
  const byWorkflow = new Map(rows.map((row) => [row.workflow, row]));
  const workflows = Object.keys(CATALOG).map((id) => evaluateWorkflow(id, byWorkflow.get(id)));
  return {
    catalogVersion: CATALOG_VERSION,
    generatedAt: new Date(now).toISOString(),
    privacy: {
      scope: 'platform_server_milestones',
      rawRetentionDays: RAW_RETENTION_DAYS,
      excludesAdmins: true,
      hostedAppsInstrumented: false,
    },
    detector: {
      recentCohortDays: RECENT_COHORT_DAYS,
      baselineCohortDays: BASELINE_COHORT_DAYS,
      completionWindowDays: COMPLETION_WINDOW_DAYS,
      minimumStartsPerCohort: MIN_STARTS,
      dropThresholdPoints: DROP_THRESHOLD_POINTS,
      bounds: Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, value.toISOString()])),
    },
    workflows,
    insights: workflows.filter((item) => item.insight),
  };
}

// Bounded batches keep boot/periodic cleanup from monopolizing Postgres after
// a long outage. Repeated six-hour passes converge without affecting product
// requests. Account deletion is immediate and does not wait for this sweep.
async function cleanupExpired(poolOrConfig, { batchSize = RETENTION_BATCH_SIZE } = {}) {
  const pool = resolvePool(poolOrConfig);
  const limit = Math.max(1, Math.min(25000, Number(batchSize) || RETENTION_BATCH_SIZE));
  const result = await pool.query(
    `WITH doomed AS (
       SELECT id FROM feature_engagement_events
        WHERE occurred_at < NOW() - INTERVAL '90 days'
        ORDER BY occurred_at ASC
        LIMIT $1
     )
     DELETE FROM feature_engagement_events f
      USING doomed d
      WHERE f.id = d.id`,
    [limit]
  );
  return result.rowCount || 0;
}

module.exports = {
  CATALOG_VERSION,
  CATALOG,
  WORKFLOW_IDS,
  RAW_RETENTION_DAYS,
  COMPLETION_WINDOW_DAYS,
  RECENT_COHORT_DAYS,
  BASELINE_COHORT_DAYS,
  MIN_STARTS,
  DROP_THRESHOLD_POINTS,
  record,
  recordStart,
  recordComplete,
  cohortBounds,
  evaluateWorkflow,
  insights,
  cleanupExpired,
};
