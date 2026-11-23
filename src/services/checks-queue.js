'use strict';

// The checks queue: how many checks runs have their Jobs on the cluster at
// once, across every platform process.
//
// Red checks follow load, not rollouts. Across 701 runs from 5 Oct 2026 that
// no rollout overlapped, 9% came back red while the check Jobs used under 10
// cores of the cluster and 24 to 29% above that. The bottleneck is the one
// Postgres primary that production and every preview's database share: each
// preview under test commits 150 to 280 transactions a second on it, and in
// the 7 Oct storm (about 20 proposals checking, their Jobs using 35 to 40
// cores) it was CPU-throttled for 40 minutes while the previews, waiting on
// it, used a third of a core each. Nothing bounded how many runs went at
// once: each is a capture Job and a unit-suite Job of 4 CPU requested each,
// and the only bound was the worker namespace's ResourceQuota, which made
// the Jobs over it wait for pod creation while their deadlines ran, and
// refused the coding workers' pods.
//
// So a run asks for a slot after its preview is built and before it creates
// any Job, and waits until it has one. Its Jobs' deadlines start when it
// creates them, so the wait costs a run nothing but time.
//
// The slots are the check_runs rows (services/check-runs.js), which already
// live for exactly as long as a run has Jobs worth reading: a row is written
// when the run asks (admitted_at NULL) and admitted by stamping admitted_at.
// An admitted row holds its slot until it is deleted, which is when the run
// settles, is superseded, or is cleared by the harvest; so a run the harvest
// collects after a restart holds its slot until its verdict is stored. Rows
// are counted under one advisory lock (CHECKS_QUEUE_LOCK), so two processes
// can never fill one free slot twice. A row whose owner stopped heartbeating
// (check-runs.ORPHAN_MS) is dead: a dead waiting row is not in line (the
// harvest, or main-watch's sweep for a merge of main, re-drives it in the
// place it had), and a dead admitted row holds its slot only until its Jobs'
// deadlines must have ended them. A row whose run is known to be over holds
// nothing, alive or not, and the admission pass deletes it: its preview work
// item reported, or its session ended (runOver, sweepReason). On 23 Nov 2026
// one such row, its delete lost on a draining conductor, held one of four
// slots for nine minutes after its run had settled.
//
// Order: main-watch's whole-tree check of main first, since it gates merges
// for everyone; then promoted proposals, then submitted CLI hand-offs, then
// drafts; first come, first served within each. The class is read at every
// pass, so a draft promoted while it waits moves up.
//
// Main-watch has a slot of its own besides the cap, and goes first for any
// other free slot. Its run is one unit-suite Job against a Postgres inside
// its own pod, so it never loads the shared primary, and while it runs every
// merge on the app lands untested as a whole. Making it wait behind proposal
// runs of up to thirteen minutes each, exactly during the merge bursts that
// fill the slots, would leave more of those merges unchecked for longer. So
// the cluster holds at most CHECKS_MAX_CONCURRENT_RUNS proposal runs plus one
// main-watch run, or more main-watch runs only in slots no proposal is using.
//
// A pass is cheap (one small table, read under a lock) and any process may
// run one: every waiter runs one each poll, and admits the head of the line
// wherever it lives. A slot freeing in this process wakes its waiters at
// once (slotFreed); a waiter elsewhere sees it at its next poll.
//
// Legacy placement fails open. A required batch pool fails closed: no lost
// queue row or unavailable admission pass may bypass the capacity envelope.

const log = require('./logger');
const checkRuns = require('./check-runs');
const { CHECKS_QUEUE_LOCK } = require('./advisory-locks');

const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const POLL_MS = Math.max(250, Number(process.env.CHECKS_QUEUE_POLL_MS) || 3000);
// Dead main and early-unit rows stop counting well before cleanup.
const ADMISSION_ROW_RETENTION_MS = 60 * 60 * 1000;
// Past the Jobs' own deadlines: room for the gap between admission and the
// Jobs' creation (the capture's preparation) and for a slow cluster.
const DEADLINE_SLACK_MS = 5 * 60 * 1000;

const CLASS = { main: 1, promoted: 2, handoff: 3, draft: 4 };

// How many proposal runs may have their Jobs on the cluster at once.
// 0 turns the queue off: every run starts at once, as before it existed.
function maxConcurrentRuns() {
  const raw = process.env.CHECKS_MAX_CONCURRENT_RUNS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_CONCURRENT_RUNS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CONCURRENT_RUNS;
}

function isEnabled() {
  return maxConcurrentRuns() > 0;
}

// How long an admitted row whose owner died may still be holding Jobs on the
// cluster: the longer of the two Jobs' deadlines, plus slack. Read lazily,
// because both modules this reads from load this one.
function jobHoldMs() {
  const captureMs = Number(require('./visuals').RUN_TIMEOUT_MS) || 770 * 1000;
  const unitMs = Number(require('./unit-suite').UNIT_SUITE_TIMEOUT_MS) || 600 * 1000;
  return Math.max(captureMs, unitMs) + DEADLINE_SLACK_MS;
}

// Ask for a slot: write the run's row, waiting. A dead waiting row of the
// same run (a proposal's session and commit, or main-watch's app and commit)
// is taken over, and the earliest place among it and `queuedSince` is kept:
// that is how a run a restart interrupted while it waited keeps its turn.
// The row is also the run's provisional manifest (`manifest`), so a run the
// owner dies holding is re-driven by the harvest like any other. Returns the
// place it holds, or null when the row could not be written (the caller then
// runs without the queue).
async function enqueue(pool, {
  runId, kind = 'proposal', sessionId = null, appId = null, commitSha = null,
  manifest = {}, queuedSince = null,
} = {}) {
  if (!pool || !runId) return null;
  const since = queuedSince ? new Date(queuedSince) : null;
  try {
    const { rows } = await pool.query(
      `WITH taken AS (
         DELETE FROM check_runs
          WHERE run_id <> $1::uuid
            AND kind = $4::text
            AND admitted_at IS NULL
            AND heartbeat_at < NOW() - ($9::int * INTERVAL '1 millisecond')
            AND commit_sha IS NOT DISTINCT FROM $5::text
            AND ((kind = 'proposal' AND session_id = $2::int) OR (kind = 'main' AND app_id = $3::int))
         RETURNING queued_at
       )
       INSERT INTO check_runs (run_id, session_id, app_id, kind, commit_sha, owner, manifest,
                               started_at, heartbeat_at, queued_at, admitted_at)
       SELECT $1::uuid, $2::int, $3::int, $4::text, $5::text, $6::text, $7::jsonb, NOW(), NOW(),
              LEAST(NOW(), COALESCE($8::timestamptz, NOW()),
                    COALESCE((SELECT MIN(queued_at) FROM taken), NOW())),
              NULL
       ON CONFLICT (run_id) DO UPDATE
         SET manifest = EXCLUDED.manifest, owner = EXCLUDED.owner, heartbeat_at = NOW()
       RETURNING queued_at`,
      [runId, sessionId == null ? null : Number(sessionId), appId == null ? null : Number(appId),
        kind, commitSha || null, checkRuns.selfOwner(), JSON.stringify(manifest || {}),
        since && Number.isFinite(since.getTime()) ? since.toISOString() : null,
        Math.round(checkRuns.ORPHAN_MS)]
    );
    return rows[0] ? rows[0].queued_at : null;
  } catch (err) {
    if (require('./check-pool').required()) throw err;
    log.warn('checks-queue', 'Could not join the checks queue; running without it', {
      runId, kind, sessionId, appId, err: err.message,
    });
    // It goes ahead without a slot, which the status page counts. The row
    // may have been refused for naming a session or app that is gone, which
    // would refuse the event's foreign keys too: the metadata names them.
    recordSlotGranted(pool, { runId, kind, sessionId, appId, waitedMs: 0, failedOpen: true, attribute: false });
    return null;
  }
}

const CLASS_NAME = { 1: 'main', 2: 'promoted', 3: 'handoff', 4: 'draft' };

// Note that a run got its slot, or went ahead without one (`failedOpen`),
// in the events log (CHECKS_SLOT_GRANTED). A run's check_runs row goes when
// it settles, so this is all the queue remembers of a wait once it is over;
// Admin → Health & status reads the last day of them. A wait that ended
// without a slot (superseded) records nothing. Fire-and-forget:
// events.record never rejects, and the run never waits on it. `attribute:
// false` leaves the event's app and session columns (foreign keys) empty.
function recordSlotGranted(pool, {
  runId = null, kind = 'proposal', cls = null, sessionId = null, appId = null,
  waitedMs = 0, failedOpen = false, attribute = true,
} = {}) {
  const events = require('./events');
  const app = appId == null ? null : Number(appId);
  const session = sessionId == null ? null : Number(sessionId);
  events.record(pool, {
    type: events.EVENT_TYPES.CHECKS_SLOT_GRANTED,
    appId: attribute ? app : null,
    sessionId: attribute ? session : null,
    metadata: {
      runId,
      kind: kind === 'main' ? 'main' : 'proposal',
      class: cls == null ? null : (CLASS_NAME[Number(cls)] || null),
      waitedMs: Math.max(0, Math.round(Number(waitedMs) || 0)),
      failedOpen: !!failedOpen,
      ...(attribute ? {} : { sessionId: session, appId: app }),
    },
  });
}

// Every run that holds or wants a slot, in the order slots go to them. The
// class is the session's as it stands now: the CLI hand-off rule is
// staging-recovery.isStuckCheckRecoveryScope's (a submitted head, no upload
// waiting on proposal_submit_build), so "submitted" means one thing.
//
// A preview machine's run (`workflow: true`) is also read against its work
// item, the preview instance's checks.run under the manifest's runKey (one
// lookup on wf_work's identity key): `run_status` is its status, and
// `run_finished` says its handler has returned (reported or settled), or the
// machine cancelled it and the clean-up that follows a cancel (checks.cancel)
// has run. Such a run's Jobs are nobody's to read, whatever its heartbeat
// or its admission says (planAdmission, sweepReason). `lingering` is a
// settled run whose early unit Jobs may still be stopping
// (check-runs.linger); `session_ended`, a proposal whose session merged, was
// archived or is gone.
const QUEUE_SQL = `
  SELECT cr.run_id, cr.kind, cr.session_id, cr.app_id, cr.commit_sha, cr.owner,
         cr.queued_at, cr.admitted_at, cr.heartbeat_at,
         (cr.manifest->>'earlyUnit' = 'true') AS early_unit,
         (cr.heartbeat_at >= NOW() - ($1::int * INTERVAL '1 millisecond')) AS alive,
         (cr.admitted_at IS NOT NULL
           AND cr.admitted_at >= NOW() - ($2::int * INTERVAL '1 millisecond')) AS within_deadline,
         (cr.heartbeat_at < NOW() - ($3::int * INTERVAL '1 millisecond')) AS expired,
         (cr.owner LIKE '%:exited') AS exited,
         (cr.manifest->>'settled' = 'true') AS lingering,
         (cr.kind = 'proposal' AND (cs.id IS NULL OR cs.status IN ('merged', 'archived'))) AS session_ended,
         wk.status AS run_status,
         (wk.status IN ('reported', 'settled') AND (NOT wk.cancelled OR wk.cancel_done)) AS run_finished,
         CASE
           WHEN cr.kind = 'main' THEN 1
           WHEN cs.status IN ('promoted', 'merging') THEN 2
           WHEN cs.status = 'active' AND cs.source = 'cli_handoff'
                AND COALESCE(cs.checks_commit_sha, cs.handoff_head_sha) IS NOT NULL
                AND NOT (cs.handoff_uploaded_sha IS NOT NULL
                         AND cs.handoff_uploaded_sha IS DISTINCT FROM cs.handoff_head_sha
                         AND cs.checks_commit_sha IS NOT DISTINCT FROM cs.handoff_upload_checked_sha)
             THEN 3
           ELSE 4
         END AS class
    FROM check_runs cr
    LEFT JOIN chat_sessions cs ON cs.id = cr.session_id
    LEFT JOIN LATERAL (
      SELECT w.status, COALESCE(w.result->>'cancelled' = 'true', FALSE) AS cancelled,
             EXISTS (SELECT 1 FROM wf_work c
                      WHERE c.machine = w.machine AND c.key = w.key AND c.kind = 'checks.cancel'
                        AND c.work_key = 'cancel:' || w.work_key
                        AND c.status IN ('reported', 'settled')) AS cancel_done
        FROM wf_work w
       WHERE cr.kind = 'proposal' AND cr.manifest->>'workflow' = 'true'
         AND w.machine = 'preview' AND w.key = 'session:' || cr.session_id::text
         AND w.kind = 'checks.run' AND w.work_key = cr.manifest->>'runKey'
    ) wk ON TRUE
   ORDER BY class, cr.queued_at, cr.run_id`;

// Pure: is the run a row stands for known to be over? Its work item says so
// (QUEUE_SQL `run_finished`), or its owner is gone and its session merged,
// was archived or is gone. Nobody reads such a run's Jobs, and the retire of
// an ended session stops them.
function runOver(row, alive) {
  return row.run_finished === true || (row.session_ended === true && !alive);
}

// Pure: does an admitted row hold its slot? While its owner is alive or its
// Jobs may still be on the cluster, unless its run is known to be over. A
// lingering row (check-runs.linger) holds only until its Jobs' deadline.
function holdsSlot(row, alive) {
  if (row.lingering === true) return row.within_deadline === true;
  if (runOver(row, alive)) return false;
  return alive || row.within_deadline === true;
}

// At most this many rows go in one admission pass.
const SWEEP_LIMIT = 50;

// Pure: why the admission pass deletes a row, or null to keep it. Never a
// main-watch row (main-watch's next attempt adopts it, and the hour-long
// expiry below clears it), never a row whose owner is alive while its run is
// going, and never one whose work item is still outstanding (queued or
// running: its next claim comes back for the row, to collect its Jobs or to
// ask for a slot in its place):
//   finished   its work item reported or settled (runOver): its finally
//              lost the delete, or a claim it outlived wrote it again;
//   deadline   lingering past its Jobs' deadline;
//   ended      its session merged, was archived or is gone, its owner gone
//              (the session's retire stops its Jobs);
//   abandoned  its owner gone (handed over on exit, or silent an hour) and
//              past its Jobs' deadline.
function sweepReason(row, alive) {
  if (row.kind === 'main') return null;
  if (row.lingering === true) return row.within_deadline === true ? null : 'deadline';
  if (row.run_finished === true) return 'finished';
  if (alive || row.run_status === 'queued' || row.run_status === 'running') return null;
  if (row.session_ended === true) return 'ended';
  if (row.within_deadline !== true && (row.exited === true || row.expired === true)) return 'abandoned';
  return null;
}

// Pure: given every row (QUEUE_SQL's shape) and the cap, which waiting runs
// get a slot now, and where every other waiting run stands. A row holds a
// slot once admitted, while its owner is alive or its Jobs may still be on
// the cluster, unless its run is known to be over (holdsSlot). The line is
// strict: when the run at its head cannot have a slot, nobody behind it gets
// one. `self` is the run asking, which counts as alive whatever its last
// heartbeat says, and is never over. `sweep` is the rows the pass deletes
// (sweepReason).
function planAdmission(rows, { cap = maxConcurrentRuns(), self = null, available = true } = {}) {
  const runs = (rows || []).map((row) => ({
    runId: row.run_id,
    kind: row.kind === 'main' ? 'main' : 'proposal',
    class: Number(row.class) || CLASS.draft,
    sessionId: row.session_id == null ? null : Number(row.session_id),
    appId: row.app_id == null ? null : Number(row.app_id),
    commitSha: row.commit_sha || null,
    queuedAt: row.queued_at,
    alive: row.alive === true || (self != null && row.run_id === self),
    holding: false,
    waiting: false,
    admitted: false,
    ahead: null,
    expired: row.expired === true && (row.kind === 'main' || row.early_unit === true) && row.run_id !== self,
  }));
  const sweep = [];
  for (const [i, run] of runs.entries()) {
    const row = rows[i];
    const mine = self != null && run.runId === self;
    const admittedAt = row.admitted_at;
    if (admittedAt) run.holding = mine ? true : holdsSlot(row, run.alive);
    else run.waiting = run.alive && (mine || !runOver(row, run.alive));
    run.admitted = !!admittedAt;
    const why = mine ? null : sweepReason(row, run.alive);
    if (why && sweep.length < SWEEP_LIMIT) sweep.push({ runId: run.runId, sessionId: run.sessionId, why });
  }
  let mains = runs.filter((r) => r.holding && r.kind === 'main').length;
  let proposals = runs.filter((r) => r.holding && r.kind === 'proposal').length;
  // The first main-watch run is in its own slot; any more use the shared ones.
  const sharedUsed = () => proposals + Math.max(0, mains - 1);
  const admit = [];
  for (const run of runs) {
    if (!run.waiting) continue;
    if (available && (run.kind === 'main' ? (mains === 0 || sharedUsed() < cap) : sharedUsed() < cap)) {
      if (run.kind === 'main') mains += 1; else proposals += 1;
      run.waiting = false;
      run.holding = true;
      run.admitted = true;
      admit.push(run.runId);
      continue;
    }
    break;
  }
  let ahead = 0;
  for (const run of runs) {
    if (!run.waiting) continue;
    run.ahead = ahead;
    ahead += 1;
  }
  return {
    cap,
    admit,
    expired: runs.filter((r) => r.expired).map((r) => r.runId),
    sweep,
    holding: { main: mains, proposal: proposals },
    waiting: ahead,
    runs,
    byRun: new Map(runs.map((r) => [r.runId, r])),
  };
}

// One admission pass, under the lock: admit the runs planAdmission names,
// clear main and early unit rows long dead, and delete the proposal rows
// whose runs are over or abandoned (planAdmission `sweep`, at most
// SWEEP_LIMIT a pass). A row a run's work item may still come back for is
// left to it.
// `self` also refreshes that run's heartbeat in the same transaction, so a
// waiter is never mistaken for dead by its own pass. Returns the plan.
async function admit(pool, { cap = maxConcurrentRuns(), self = null } = {}) {
  const capacity = await require('./kubernetes').checkPoolCapacity();
  cap = Math.min(cap, capacity.cap);
  const plan = await withAdmissionLock(pool, async (client) => {
    if (self) {
      await client.query(
        'UPDATE check_runs SET heartbeat_at = NOW() WHERE run_id = $1 AND owner = $2',
        [self, checkRuns.selfOwner()]
      );
    }
    const rows = await queueRows(client);
    const plan = planAdmission(rows, { cap, self, available: capacity.available });
    if (plan.admit.length) {
      await client.query(
        'UPDATE check_runs SET admitted_at = NOW() WHERE run_id = ANY($1::uuid[]) AND admitted_at IS NULL',
        [plan.admit]
      );
    }
    if (plan.expired.length) {
      await client.query(
        `DELETE FROM check_runs WHERE run_id = ANY($1::uuid[])
            AND (kind = 'main' OR manifest->>'earlyUnit' = 'true')
            AND heartbeat_at < NOW() - ($2::int * INTERVAL '1 millisecond')`,
        [plan.expired, ADMISSION_ROW_RETENTION_MS]
      );
    }
    if (plan.sweep.length) {
      const { rows: gone } = await client.query(
        `DELETE FROM check_runs WHERE run_id = ANY($1::uuid[]) AND kind = 'proposal' RETURNING run_id`,
        [plan.sweep.map((s) => s.runId)]
      );
      const removed = new Set(gone.map((r) => r.run_id));
      plan.swept = plan.sweep.filter((s) => removed.has(s.runId));
    }
    return plan;
  });
  if (plan.swept?.length) {
    log.info('checks-queue', 'Cleared the checks rows of runs that are over', {
      removed: plan.swept.length, runs: plan.swept,
    });
  }
  if (plan.admit.length) {
    log.info('checks-queue', 'Admitted checks runs', {
      runs: plan.runs.filter((r) => plan.admit.includes(r.runId))
        .map((r) => ({ runId: r.runId, kind: r.kind, class: r.class, sessionId: r.sessionId, appId: r.appId })),
      holding: plan.holding, waiting: plan.waiting, cap: plan.cap,
    });
  }
  return plan;
}

async function withAdmissionLock(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CHECKS_QUEUE_LOCK]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function queueRows(client) {
  const { rows } = await client.query(QUEUE_SQL,
    [Math.round(checkRuns.ORPHAN_MS), Math.round(jobHoldMs()), ADMISSION_ROW_RETENTION_MS]);
  return rows;
}

// Reserve one whole proposal slot for an early unit suite only when the
// regular queue is empty. Leave another shared slot available for arrivals.
// The preview row fences a late launcher against a completed or failed build.
async function reserveEarlyUnitSlot(config, pool, { runId, sessionId, appId, attempt, commitSha }) {
  const capacity = await require('./kubernetes').checkPoolCapacity(config);
  const cap = Math.min(maxConcurrentRuns(), capacity.cap);
  if (!capacity.available || cap < 2) return false;
  const reserved = await withAdmissionLock(pool, async (client) => {
    const rows = await queueRows(client);
    const plan = planAdmission(rows, { cap, available: false });
    const shared = plan.holding.proposal + Math.max(0, plan.holding.main - 1);
    if (plan.waiting || shared >= cap - 1 || rows.some((row) => {
      const run = plan.byRun.get(row.run_id);
      return run.holding && (row.early_unit === true || run.sessionId === sessionId);
    })) return false;
    const preparing = await client.query(
      `SELECT 1 FROM wf_instances WHERE machine = 'preview' AND key = $1
        AND data->'preparing'->>'n' = $2 AND data->'preparing'->>'head' = $3 FOR UPDATE`,
      [`session:${sessionId}`, String(attempt), commitSha]);
    if (!preparing.rowCount) return false;
    const created = await client.query(
      `INSERT INTO check_runs (run_id, session_id, app_id, kind, commit_sha, owner, manifest, admitted_at)
       VALUES ($1, $2, $3, 'proposal', $4, $5, '{"workflow":true,"earlyUnit":true}', NOW())
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, sessionId, appId, commitSha, checkRuns.selfOwner()]);
    return created.rowCount === 1;
  });
  if (reserved) log.info('checks-queue', 'Reserved an early unit-suite slot', { sessionId, runId, commitSha });
  return reserved;
}

// Transfer the slot and its accounting to the capture claim in one write,
// keeping the early suite's Job label in the new manifest for recovery.
async function takeEarlyUnitSlot(pool, { runId, sessionId, commitSha, manifest, earlyRunId }) {
  return withAdmissionLock(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE check_runs SET run_id = $1, owner = $2, manifest = $3,
          queued_at = NOW(), heartbeat_at = NOW(), admitted_at = NOW()
        WHERE run_id = $4 AND session_id = $5 AND commit_sha = $6
          AND kind = 'proposal' AND manifest->>'earlyUnit' = 'true'
          AND admitted_at >= NOW() - ($7::int * INTERVAL '1 millisecond')
        RETURNING queued_at`,
      [runId, checkRuns.selfOwner(), JSON.stringify({ ...manifest, unitRunId: earlyRunId }),
        earlyRunId, sessionId, commitSha, Math.round(jobHoldMs())]);
    return rows[0]?.queued_at || null;
  });
}

// Stamp a run admitted without a pass: the fail-open path, so a run that
// goes ahead without a slot is still counted while it runs.
async function markAdmitted(pool, runId) {
  try {
    await pool.query(
      'UPDATE check_runs SET admitted_at = NOW() WHERE run_id = $1 AND admitted_at IS NULL', [runId]);
  } catch { /* the run goes ahead regardless */ }
}

// This process's waiters, woken when a slot frees here.
const sleepers = new Set();

// A run in this process settled, was superseded, or left the line: every
// waiter here runs a pass now rather than at its next poll. Called by
// check-runs.finish, which is where every run's row goes.
function slotFreed() {
  for (const wake of [...sleepers]) wake();
}

function nap(ms, signal) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      sleepers.delete(done);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    sleepers.add(done);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

// Wait for `runId`'s slot. Resolves `{ outcome: 'admitted' | 'superseded',
// waitedMs, ahead }`: admitted once a pass gives it a slot, superseded once
// `stillWanted()` says nobody wants this run any more (its head moved, its
// session closed), in which case the caller leaves without a verdict and its
// row goes with its finally. Throws `signal.reason` when the signal aborts:
// under the preview lifecycle that is a newer revision taking the session.
// `onPosition({ ahead, queuedAt })` hears each change of place in line,
// including the first, for the card. A pass that fails lets the run go.
// Every admitted ending, failed-open ones included, is noted in the events
// log for the status page (recordSlotGranted).
async function waitForSlot(pool, {
  runId, signal = null, stillWanted = async () => true, onPosition = null, pollMs = POLL_MS,
  cap = undefined,
} = {}) {
  const startedAt = Date.now();
  let last;
  // The run as the last pass saw it, for the event.
  let seen = null;
  const granted = (extra = {}) => {
    const waitedMs = Date.now() - startedAt;
    recordSlotGranted(pool, {
      runId, kind: seen?.kind, cls: seen?.class, sessionId: seen?.sessionId, appId: seen?.appId,
      waitedMs, failedOpen: extra.failedOpen === true,
    });
    return { outcome: 'admitted', waitedMs, ahead: last ?? null, ...extra };
  };
  for (;;) {
    signal?.throwIfAborted();
    let wanted = true;
    try { wanted = await stillWanted(); } catch { wanted = true; }
    signal?.throwIfAborted();
    if (!wanted) return { outcome: 'superseded', waitedMs: Date.now() - startedAt, ahead: last ?? null };
    let plan;
    try {
      plan = await admit(pool, { self: runId, ...(cap === undefined ? {} : { cap }) });
    } catch (err) {
      if (require('./check-pool').required()) {
        log.warn('checks-queue', 'Dedicated checks admission unavailable; keeping the run queued', { runId, err: err.message });
        await nap(pollMs, signal);
        continue;
      }
      log.warn('checks-queue', 'Admission pass failed; letting the run go', { runId, err: err.message });
      await markAdmitted(pool, runId);
      return granted({ failedOpen: true });
    }
    signal?.throwIfAborted();
    const mine = plan.byRun.get(runId);
    if (!mine) {
      if (require('./check-pool').required()) throw new Error('Required checks admission lost its queue row');
      log.warn('checks-queue', 'The run is not in the checks queue; letting it go', { runId });
      return granted({ failedOpen: true });
    }
    seen = mine;
    if (mine.admitted) return granted();
    if (mine.ahead !== last) {
      last = mine.ahead;
      if (typeof onPosition === 'function') {
        try { await onPosition({ ahead: mine.ahead, queuedAt: mine.queuedAt }); } catch { /* card only */ }
      }
    }
    await nap(pollMs, signal);
  }
}

// ── The status page's view of the queue (Admin → Health & status) ────────

const CLASS_LABEL = { main: 'main', promoted: 'up for a vote', handoff: 'CLI hand-off', draft: 'draft' };

// QUEUE_SQL's own rows, so the page and the admission pass cannot read the
// queue two ways, with what a person needs to recognise each run.
const SNAPSHOT_SQL = `
  SELECT q.*, cs.pr_number, a.slug AS app_slug
    FROM (${QUEUE_SQL}) q
    LEFT JOIN chat_sessions cs ON cs.id = q.session_id
    LEFT JOIN apps a ON a.id = COALESCE(cs.app_id, q.app_id)
   ORDER BY q.class, q.queued_at, q.run_id`;

// The last day of CHECKS_SLOT_GRANTED events. A run "waited" when it waited
// at least one queue poll; a shorter wait is a run admitted at its first ask.
const LAST_DAY_SQL = `
  WITH granted AS (
    SELECT CASE WHEN metadata->>'waitedMs' ~ '^[0-9]+$' THEN (metadata->>'waitedMs')::bigint END AS waited_ms,
           metadata->>'failedOpen' = 'true' AS failed_open
      FROM events
     WHERE event_type = $1 AND created_at > NOW() - INTERVAL '24 hours'
  )
  SELECT COUNT(*)::int AS runs,
         COUNT(*) FILTER (WHERE waited_ms >= $2)::int AS waited,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY waited_ms) FILTER (WHERE waited_ms >= $2) AS median_wait_ms,
         MAX(waited_ms) FILTER (WHERE waited_ms >= $2) AS longest_wait_ms,
         COUNT(*) FILTER (WHERE failed_open)::int AS failed_open
    FROM granted`;

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Pure: SNAPSHOT_SQL's rows as the status page shows them. A row is
//   holding  admitted, and its owner is alive or its Jobs may still run;
//   waiting  in line, its owner alive (`place` 1 is next);
//   stale    neither: in line with its owner gone (the harvest re-drives it
//            in its place), admitted and past its Jobs' deadlines with its
//            owner gone, or a run known to be over (holdsSlot). Listed last,
//            so an admin sees what the admission pass has not cleared yet.
// Runs a pass would admit now are still waiting here, at the head of the
// line: nothing has admitted them. Slots are counted as planAdmission counts
// them: the first main-watch run has its own, every other run uses the
// shared CHECKS_MAX_CONCURRENT_RUNS (`sharedUsed`).
function describeQueue(rows, { cap = maxConcurrentRuns(), now = Date.now() } = {}) {
  const live = [];
  const stale = [];
  let place = 0;
  let oldestWaiting = null;
  let mains = 0;
  let proposals = 0;
  for (const row of rows || []) {
    const admitted = !!row.admitted_at;
    const alive = row.alive === true;
    const state = admitted
      ? (holdsSlot(row, alive) ? 'holding' : 'stale')
      : (alive && !runOver(row, alive) ? 'waiting' : 'stale');
    const kind = row.kind === 'main' ? 'main' : 'proposal';
    if (state === 'holding') {
      if (kind === 'main') mains += 1; else proposals += 1;
    }
    const queuedAt = isoOrNull(row.queued_at);
    if (state === 'waiting' && queuedAt && (!oldestWaiting || queuedAt < oldestWaiting)) {
      oldestWaiting = queuedAt;
    }
    const cls = CLASS_NAME[Number(row.class)] || 'draft';
    (state === 'stale' ? stale : live).push({
      runId: row.run_id,
      kind,
      class: cls,
      classLabel: CLASS_LABEL[cls],
      app: row.app_slug || null,
      prNumber: row.pr_number == null ? null : Number(row.pr_number),
      sessionId: row.session_id == null ? null : Number(row.session_id),
      state,
      place: state === 'waiting' ? ++place : null,
      queuedAt,
      admittedAt: isoOrNull(row.admitted_at),
      ownerAlive: alive,
      heartbeatAt: isoOrNull(row.heartbeat_at),
    });
  }
  return {
    enabled: cap > 0,
    cap,
    slots: { proposal: proposals, main: mains, sharedUsed: proposals + Math.max(0, mains - 1) },
    waiting: place,
    oldestWaitMs: oldestWaiting ? Math.max(0, now - new Date(oldestWaiting).getTime()) : null,
    runs: live.concat(stale),
  };
}

function lastDayFrom(row) {
  const num = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    runs: num(row?.runs) || 0,
    waited: num(row?.waited) || 0,
    medianWaitMs: num(row?.median_wait_ms),
    longestWaitMs: num(row?.longest_wait_ms),
    failedOpen: num(row?.failed_open) || 0,
  };
}

// The queue as Admin → Health & status shows it: the live rows and the last
// day's slots. Read-only, without CHECKS_QUEUE_LOCK, so it can never hold up
// an admission pass, and it may lag one pass behind. Never rejects: null
// when the queue cannot be read (the page says so), `last24h: null` when
// only the history cannot. With the queue off there is no line to read.
async function snapshot(pool, { cap = maxConcurrentRuns() } = {}) {
  if (!pool) return null;
  let last24h = null;
  try {
    const events = require('./events');
    const { rows: [row] } = await pool.query(LAST_DAY_SQL,
      [events.EVENT_TYPES.CHECKS_SLOT_GRANTED, POLL_MS]);
    last24h = lastDayFrom(row);
  } catch (err) {
    log.warn('checks-queue', 'Could not read the last day of checks slots for the status page', { err: err.message });
  }
  if (cap <= 0) return { ...describeQueue([], { cap: 0 }), last24h };
  try {
    const { rows } = await pool.query(SNAPSHOT_SQL,
      [Math.round(checkRuns.ORPHAN_MS), Math.round(jobHoldMs()), ADMISSION_ROW_RETENTION_MS]);
    return { ...describeQueue(rows, { cap }), last24h };
  } catch (err) {
    log.warn('checks-queue', 'Could not read the checks queue for the status page', { err: err.message });
    return null;
  }
}

// Is this check_runs row a run still waiting for its slot? To
// check-harvest.runOnCluster, a waiting run of the commit is the run a new
// request for it is asking for, dead or alive: a dead one is the harvest's
// to re-drive in its place. A row that does not say is not waiting.
function isWaitingRow(row) {
  return !!row && row.admitted_at === null;
}

module.exports = {
  CLASS,
  DEFAULT_MAX_CONCURRENT_RUNS,
  POLL_MS,
  maxConcurrentRuns,
  isEnabled,
  jobHoldMs,
  enqueue,
  planAdmission,
  holdsSlot,
  sweepReason,
  admit,
  reserveEarlyUnitSlot,
  takeEarlyUnitSlot,
  markAdmitted,
  waitForSlot,
  slotFreed,
  isWaitingRow,
  describeQueue,
  snapshot,
};
