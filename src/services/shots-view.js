'use strict';

// One public shape for every reviewer surface. Binary bytes, internal
// origins, fixture names, tokens, and model transcripts never enter this
// view model.

const state = require('./shots-state');
const { visualHeadForSession } = require('./pr-vote-revision');

const PUBLIC_STATES = new Set([
  'planned', 'provisioning', 'exploring', 'replaying', 'reviewing',
  'verified', 'failed', 'not_required', 'overridden', 'stale', 'cancelled',
]);
const ARTIFACT_ID_RE = /^[0-9a-f]{32}$/;
const STORY_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/;
const VIEWPORT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const MEDIA_TYPE = Object.freeze({ png: 'image/png', webm: 'video/webm', gif: 'image/gif' });

function cleanClaims(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((claim) => ({
    id: String(claim?.id || '').slice(0, 96),
    claim: String(claim?.claim || '').slice(0, 1000),
    persona: ['member', 'read_only_admin', 'full_admin', 'guest'].includes(claim?.persona)
      ? claim.persona : 'member',
    viewports: Array.isArray(claim?.viewports)
      ? claim.viewports.slice(0, 2).map((name) => String(name).slice(0, 32))
      : [],
    steps: Array.isArray(claim?.steps)
      ? claim.steps.slice(0, 40).map((step) => String(step).slice(0, 200))
      : [],
    baseState: claim?.baseState === 'not_present' ? 'not_present' : 'present',
    animation: ['none', 'steps', 'motion'].includes(claim?.animation) ? claim.animation : 'none',
  })).filter((claim) => claim.id && claim.claim);
}

// One result per declared change: its shots are ready, or the shots agent
// skipped it and says why, or it failed: the agent did the steps and the
// after build broke.
// The agent sometimes writes a quotation mark already escaped, as it would
// inside JSON (\"Continue\"); people should read the quotation mark.
const unescapeQuotes = (text) => text.replace(/\\+(["'])/g, '$1');

function cleanShotResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).filter((result) => STORY_ID_RE.test(String(result?.id || '')))
    .map((result) => ({
      id: String(result.id),
      status: result.status === 'ready' || result.status === 'failed' ? result.status : 'skipped',
      reason: result.status === 'ready' || typeof result.reason !== 'string'
        ? null : unescapeQuotes(result.reason).slice(0, 1000),
      note: result.status !== 'ready' || typeof result.note !== 'string'
        ? null : unescapeQuotes(result.note).slice(0, 500),
    }));
}

// The screens a verified run's card shows, and the areas that differ on
// each: integers and story ids from this run's own declaration, nothing else.
function cleanScreens(screens, claims) {
  const ids = new Set((claims || []).map((claim) => claim.id));
  const int = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 20000;
  const box = (value, size) => (Array.isArray(value) && value.length === size && value.every(int)
    ? value.slice() : null);
  return (Array.isArray(screens) ? screens : []).slice(0, 6)
    .filter((screen) => screen && typeof screen.viewport === 'string' && ids.has(screen.shot))
    .map((screen) => ({
      viewport: screen.viewport.slice(0, 32),
      shot: screen.shot,
      stories: (Array.isArray(screen.stories) ? screen.stories : []).filter((id) => ids.has(id)).slice(0, 3),
      width: int(screen.width) ? screen.width : null,
      heightBefore: int(screen.heightBefore) ? screen.heightBefore : null,
      heightAfter: int(screen.heightAfter) ? screen.heightAfter : null,
      regions: (Array.isArray(screen.regions) ? screen.regions : []).slice(0, 12)
        .map((region) => ({
          story: region && ids.has(region.story) ? region.story : null,
          b: box(region?.b, 4),
          a: box(region?.a, 4),
          bMark: box(region?.bMark, 3),
          aMark: box(region?.aMark, 3),
        }))
        .filter((region) => region.b || region.a),
    }));
}

function artifactUrl(slug, sessionId, artifactId) {
  if (!ARTIFACT_ID_RE.test(String(artifactId || ''))) return null;
  return `/api/apps/${encodeURIComponent(slug)}/proposals/${Number(sessionId)}/shots/${artifactId}`;
}

function cleanArtifacts(items, { slug, sessionId, verified }) {
  if (!verified || !Array.isArray(items)) return [];
  return items.slice(0, 36).filter((artifact) => {
    if (!artifact || !ARTIFACT_ID_RE.test(String(artifact.id || ''))
        || !STORY_ID_RE.test(String(artifact.storyId || ''))
        || !VIEWPORT_RE.test(String(artifact.viewport || ''))
        || !['base', 'head', 'paired'].includes(artifact.side)
        || !['focus', 'context', 'animation'].includes(artifact.variant)
        || !Object.hasOwn(MEDIA_TYPE, artifact.media)
        || artifact.contentType !== MEDIA_TYPE[artifact.media]) return false;
    // A clip is one recording per side; older runs stored one paired
    // before/after animation instead.
    if (artifact.variant === 'animation') {
      return artifact.side === 'paired' ? artifact.media !== 'png' : artifact.media === 'webm';
    }
    return artifact.side !== 'paired' && artifact.media === 'png';
  }).map((artifact) => ({
    id: String(artifact.id || ''),
    storyId: String(artifact.storyId || '').slice(0, 96),
    viewport: String(artifact.viewport || '').slice(0, 32),
    side: ['base', 'head', 'paired'].includes(artifact.side) ? artifact.side : null,
    variant: ['focus', 'context', 'animation'].includes(artifact.variant) ? artifact.variant : null,
    media: ['png', 'webm', 'gif'].includes(artifact.media) ? artifact.media : null,
    contentType: String(artifact.contentType || '').slice(0, 32),
    width: Number.isInteger(artifact.width) ? artifact.width : null,
    height: Number.isInteger(artifact.height) ? artifact.height : null,
    bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
    focusRect: artifact.focusRect && typeof artifact.focusRect === 'object' ? artifact.focusRect : null,
    stageLabels: Array.isArray(artifact.stageLabels)
      ? artifact.stageLabels.slice(0, 40).map((label) => String(label).slice(0, 100))
      : null,
    url: artifactUrl(slug, sessionId, artifact.id),
  }));
}

// #2601/#2558: why a run that is still 'planned' never got under way, as
// `shots-orchestrator.noteNotStarted` recorded it on the proposal.
// A sibling of `failureReason` rather than a reuse of it: a run that never
// started has not failed, and the two words reach different copy. It is
// dropped once the run has moved on, and on a superseded revision, where it
// would describe a schedule attempt nobody is looking at any more.
function notStartedReason(session, superseded) {
  const detail = session?.shots_detail;
  if (superseded || session?.shots_state !== 'planned') return null;
  const value = detail && typeof detail === 'object' ? detail.notStartedReason : null;
  return typeof value === 'string' && value.trim() ? value.slice(0, 300) : null;
}

function fromSnapshot(session, currentHead) {
  const detail = session?.shots_detail;
  if (!detail || typeof detail !== 'object') return null;
  const recordedHead = typeof detail.headSha === 'string' ? detail.headSha : null;
  const mismatched = !!(recordedHead && currentHead && recordedHead !== currentHead);
  return {
    state: mismatched ? 'stale' : (PUBLIC_STATES.has(session.shots_state)
      ? session.shots_state : 'planned'),
    required: detail.required !== false,
    impact: ['ui', 'motion', 'none'].includes(detail.impact) ? detail.impact : null,
    rationale: typeof detail.rationale === 'string' ? detail.rationale.slice(0, 1000) : null,
    claims: cleanClaims(detail.claims),
    baseSha: typeof detail.baseSha === 'string' ? detail.baseSha : null,
    headSha: recordedHead,
    failureCode: typeof detail.failureCode === 'string' ? state.currentCode(detail.failureCode) : null,
    failureReason: mismatched
      ? 'A newer revision of this proposal replaced these shots.'
      : (typeof detail.failureReason === 'string' ? detail.failureReason.slice(0, 2000) : null),
    notStartedReason: notStartedReason(session, mismatched),
    automaticRetryPending: false,
    repairAvailable: detail.repairAvailable === true,
    planHash: typeof detail.planHash === 'string' ? detail.planHash : null,
    shotResults: [],
    screens: [],
    progress: null,
    verifiedReason: null,
    overriddenBy: Number.isInteger(detail.overriddenBy) ? detail.overriddenBy : null,
    overriddenAt: detail.overriddenAt || null,
    overrideReason: typeof detail.overrideReason === 'string' ? detail.overrideReason.slice(0, 1000) : null,
    artifacts: [],
    startedAt: null,
    updatedAt: session.shots_updated_at || detail.updatedAt || null,
  };
}

function serialize(run, session, slug, currentHead) {
  if (!run) return fromSnapshot(session, currentHead);
  const matchesCurrent = !currentHead || run.headSha === currentHead;
  const publicState = matchesCurrent ? run.state : 'stale';
  return {
    state: PUBLIC_STATES.has(publicState) ? publicState : 'failed',
    required: run.required !== false,
    impact: session?.shots_detail?.impact || null,
    rationale: session?.shots_detail?.rationale || null,
    claims: cleanClaims(run.claims),
    baseSha: run.baseSha || null,
    headSha: run.headSha || null,
    failureCode: matchesCurrent ? (run.failureCode || null) : 'superseded',
    failureReason: matchesCurrent
      ? (run.failureReason || null)
      : 'A newer revision of this proposal replaced these shots.',
    notStartedReason: notStartedReason(session, !matchesCurrent),
    // A restart interrupted this run and the recovery sweep starts it again
    // by itself, so the card says it is trying again instead of asking a
    // person to. A merged or archived proposal gets no automatic retry.
    automaticRetryPending: matchesCurrent && run.automaticRetryPending === true
      && !['merged', 'archived'].includes(session?.status),
    repairAvailable: matchesCurrent && run.repairAvailable === true
      && !(run.automaticRetryPending === true && !['merged', 'archived'].includes(session?.status)),
    planHash: run.planHash || null,
    // When the run's agent actually picked the proposal up (#4452): the
    // change page's run bar ages its Shots part against this.
    startedAt: run.startedAt || null,
    // A failed run carries them only when a declared change failed
    // (shots_change_failed), so the change page can say which one.
    shotResults: matchesCurrent && (run.state === 'verified'
      || (run.state === 'failed' && run.failureCode === 'shots_change_failed'))
      ? cleanShotResults(run.shotResults) : [],
    screens: matchesCurrent && run.state === 'verified' ? cleanScreens(run.screens, cleanClaims(run.claims)) : [],
    progress: matchesCurrent && PUBLIC_STATES.has(run.state) ? (run.progress || null) : null,
    verifiedReason: null,
    overriddenBy: run.overriddenBy || null,
    overriddenAt: run.overriddenAt || null,
    overrideReason: run.overrideReason || null,
    artifacts: cleanArtifacts(run.artifactSummary, {
      slug, sessionId: session.id, verified: matchesCurrent && run.state === 'verified',
    }),
    updatedAt: run.updatedAt || session.shots_updated_at || null,
  };
}

async function getForSession(pool, session, slug = session?.app_slug) {
  if (!session || !session.id || !slug) return null;
  const currentHead = visualHeadForSession(session);
  let run = null;
  if (currentHead) run = await state.getForSession(pool, Number(session.id), { headSha: currentHead });
  return serialize(run, session, slug, currentHead);
}

async function getForSessions(pool, sessions, slug) {
  const list = Array.isArray(sessions) ? sessions : [];
  const runIds = list.map((session) => session.shots_run_id).filter(Boolean);
  const bySession = new Map();
  if (runIds.length) {
    const { rows } = await pool.query(
      `SELECT r.*,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id, 'storyId', a.story_id, 'viewport', a.viewport,
                  'side', a.side, 'variant', a.variant, 'media', a.media,
                  'contentType', a.content_type, 'width', a.width,
                  'height', a.height, 'bytes', a.bytes,
                  'focusRect', a.focus_rect, 'stageLabels', a.stage_labels
                ) ORDER BY a.story_id, a.viewport, a.side, a.variant)
                  FROM shot_artifacts a WHERE a.run_id = r.id
              ), '[]'::jsonb) AS artifact_summary,
              -- Its automatic retries, so the view can say one is coming.
              (SELECT COUNT(*) FROM shot_runs retry
                WHERE retry.session_id = r.session_id AND retry.head_sha = r.head_sha
                  AND retry.trigger = 'interrupted-retry')::int AS interrupted_retries,
              (SELECT COUNT(*) FROM shot_runs crash
                WHERE crash.session_id = r.session_id AND crash.head_sha = r.head_sha
                  AND crash.failure_code = 'shots_run_interrupted'
                  AND COALESCE(crash.trace_summary->>'interruptedBy', '') <> 'shutdown')::int AS unexplained_interruptions
         FROM shot_runs r WHERE r.id = ANY($1::varchar[])`,
      [runIds]
    );
    for (const row of rows) bySession.set(Number(row.session_id), state.runSummary(row, row.artifact_summary || []));
  }
  const result = new Map();
  for (const session of list) {
    const currentHead = visualHeadForSession(session);
    result.set(Number(session.id), serialize(
      bySession.get(Number(session.id)) || null,
      session,
      slug || session.app_slug,
      currentHead
    ));
  }
  return result;
}

module.exports = {
  PUBLIC_STATES,
  cleanClaims,
  cleanShotResults,
  cleanScreens,
  cleanArtifacts,
  artifactUrl,
  notStartedReason,
  fromSnapshot,
  serialize,
  getForSession,
  getForSessions,
};
