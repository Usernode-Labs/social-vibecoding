// What a proposal's before & after shots read as on the proposal: the
// `chat_sessions.shots_detail` the shots machine writes in its transitions
// (src/workflow/shots/), and the same summary every reader builds from a
// run's row (services/shots-state.js re-exports these). Pure.

type Obj = Record<string, any>;

// Codes written before the rename name "evidence": runs, snapshots and turns
// recorded then. Read them as the codes this release writes.
const RENAMED_CODES: ReadonlyMap<string, string> = new Map([
  ['visual_evidence_intent_conflict', 'visible_changes_conflict'],
  ['invalid_visual_evidence', 'invalid_visible_changes'],
  ['evidence', 'shots'],
]);

export function currentCode(code: unknown): any {
  if (typeof code !== 'string' || !code.includes('evidence')) return code;
  return RENAMED_CODES.get(code) || code.replace(/visual_evidence/g, 'shots').replace(/evidence/g, 'shots');
}

// #4575: the codes a dispatch fails with when another turn (the Homeroom
// bot's, say) holds the proposal's agent. The worker's own wording means
// nothing to a person reading the card, so a run that ended on one of these
// says so in plain words.
const AGENT_BUSY_CODES: ReadonlySet<string> = new Set([
  'session_busy', 'TURN_IN_FLIGHT', 'durable_turn_persist_failed', 'durable_retry_persist_failed',
]);
export const AGENT_BUSY_REASON = 'The proposal’s agent was busy with another turn, so the shots didn’t start. Take the shots again.';
export function agentBusyCode(code: unknown): boolean {
  return typeof code === 'string' && AGENT_BUSY_CODES.has(code);
}

function clip(value: unknown, max: number): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

// services/visible-changes.js MAX_STORIES: a declaration names at most three.
const MAX_STORIES = 3;

export function claimsFromIntent(intent: Obj | null): Obj[] {
  return Array.isArray(intent?.stories)
    ? intent!.stories.slice(0, MAX_STORIES).map((story: Obj) => ({
      id: story.id,
      claim: story.claim,
      persona: story.persona,
      viewports: story.viewports.map((viewport: Obj) => viewport.name),
      steps: story.intent.steps,
      baseState: story.intent.baseState === 'not_present' ? 'not_present' : 'present',
      animation: story.intent.animation,
    }))
    : [];
}

// Each declared change's screens' widths in CSS pixels, keyed
// `<change id>:<screen name>`: a saved still's density is its width over its
// screen's (services/shots-files.js densityFor).
export function screenWidthsOf(intent: Obj | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const story of Array.isArray(intent?.stories) ? intent!.stories.slice(0, MAX_STORIES) : []) {
    for (const viewport of Array.isArray(story?.viewports) ? story.viewports : []) {
      if (Number.isSafeInteger(viewport?.width) && viewport.width > 0) out[`${story.id}:${viewport.name}`] = viewport.width;
    }
  }
  return out;
}

// The changed-file heuristic only decides whether a MISSING declaration is
// needed. It cannot overrule an explicit `impact: none`: that intent has no
// stories by contract.
export function requiredForIntent(intent: Obj | null, { heuristicUi = false }: { heuristicUi?: boolean } = {}): boolean {
  if (!intent) return !!heuristicUi;
  return intent.impact !== 'none';
}

export function pendingDetail(intent: Obj | null, options: { heuristicUi?: boolean; headSha?: string | null; reason?: string | null } = {}): Obj {
  const required = requiredForIntent(intent, options);
  return {
    version: 1,
    required,
    impact: intent?.impact || null,
    rationale: intent?.rationale || null,
    claims: claimsFromIntent(intent),
    ...(options.headSha ? { headSha: options.headSha } : {}),
    ...(options.reason ? { reason: clip(options.reason, 1000) } : {}),
    intent: intent || null,
  };
}

export const MISSING_INTENT_REASON = 'This proposal appears to change the UI but has not declared the change for before/after shots yet.';

export function missingIntentDetail({ headSha = null, reason = null }: { headSha?: string | null; reason?: string | null } = {}): Obj {
  return {
    version: 1,
    required: true,
    impact: null,
    rationale: null,
    claims: [],
    ...(headSha ? { headSha } : {}),
    reason: clip(reason, 1000) || MISSING_INTENT_REASON,
  };
}

const SHOTS_MODE = 'shots';
export function isShotsVerdict(verdict: unknown): verdict is Obj {
  return !!verdict && typeof verdict === 'object' && (verdict as Obj).mode === SHOTS_MODE;
}

// What a change's result reads as wherever results are read: ready,
// unchanged, skipped or failed (services/shots-files.js resultStatus, whose
// comment says why unchanged is stored as ready).
export function resultStatus(story: Obj | null): 'ready' | 'unchanged' | 'skipped' | 'failed' {
  if (story?.status === 'ready') return story.unchanged === true ? 'unchanged' : 'ready';
  return story?.status === 'failed' ? 'failed' : 'skipped';
}

/**
 * A run's row as the proposal reads it. `cleanConditions` tidies a stored
 * change's conditions (services/shots-files.js); the machine's verdicts are
 * already clean, so it passes none.
 */
export function runSummary(row: Obj | null, artifactSummary: unknown[] = [],
  { cleanConditions = (v: unknown) => (Array.isArray(v) ? v : []) }: { cleanConditions?: (v: unknown) => unknown[] } = {}): Obj | null {
  if (!row) return null;
  const intent = row.intent && typeof row.intent === 'object' ? row.intent : null;
  const trace = row.trace_summary && typeof row.trace_summary === 'object' ? row.trace_summary : null;
  const progress = trace?.progress;
  const verdict = isShotsVerdict(row.hard_verdict) ? row.hard_verdict : null;
  return {
    state: row.state,
    required: row.state !== 'not_required',
    claims: claimsFromIntent(intent),
    screenWidths: screenWidthsOf(intent),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    failureCode: currentCode(row.failure_code) || null,
    failureReason: agentBusyCode(row.failure_code) ? AGENT_BUSY_REASON : (row.failure_reason || null),
    // Any finished run on the current head can be taken again; an explicit
    // no-visible-change declaration has nothing to retry.
    repairAvailable: row.state === 'failed' && currentCode(row.failure_code) !== 'visible_changes_conflict',
    // A failed run the machine takes again on its own (a platform fault's
    // one retry): it marks the run so as it fails it.
    automaticRetryPending: row.state === 'failed' && trace?.automaticRetry === true,
    planHash: row.plan_hash || null,
    // The screens the card shows, with where each change's before and after
    // differ (services/shots-diff.js).
    screens: verdict && Array.isArray(verdict.screens) ? verdict.screens : [],
    // One result per declared change: ready (with the shots agent's note on
    // what its shots leave out, if any), unchanged, failed, or skipped with
    // the reason people see on the proposal.
    shotResults: verdict && Array.isArray(verdict.stories)
      ? verdict.stories.map((story: Obj) => {
        const status = resultStatus(story);
        const shown = status === 'ready' || status === 'unchanged';
        const conditions = Array.isArray(story?.conditions) && story.conditions.length ? cleanConditions(story.conditions) : [];
        return {
          id: story?.id,
          status,
          reason: shown ? null : (story?.reason || null),
          note: shown ? (story?.note || null) : null,
          ...(conditions.length ? { conditions } : {}),
        };
      })
      : [],
    // What the shots agent noticed broken on the after build besides the
    // declared changes. Advisory only.
    shotNotices: verdict && Array.isArray(verdict.notices) ? verdict.notices : [],
    // A project's first version: only the after side was taken.
    afterOnly: !!verdict && verdict.afterOnly === true,
    progress: progress && typeof progress.phase === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(progress.phase)
      ? { phase: progress.phase, at: progress.at || null } : null,
    verifiedReason: null,
    overriddenBy: row.override_user_id || null,
    overriddenAt: row.overridden_at || null,
    overrideReason: row.override_reason || null,
    artifactSummary,
    updatedAt: row.updated_at || row.completed_at || row.created_at || null,
  };
}
