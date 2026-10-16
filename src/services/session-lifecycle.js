'use strict';

// A proposal's lifecycle moves, by the names their callers have always used.
//
// The proposal machine decides every one of them (src/workflow/proposal/):
// pause and resume (the session's slot), unpromote, archive (a close, for
// any reason) and unarchive (a reopen). Each name here reads what its caller
// decides on when the caller has not (the status it saw, as `from`), appends
// the machine's event, waits for its outcome, and answers as it always did.
// What a move does around it (the worker destroyed, the pull request closed
// or reopened, the preview retired, the work orders and the held secret
// discarded, the thread line, the bell) is the machine's: in the move's
// transaction, or durable work.

const log = require('./logger');
const staging = require('./staging');
const worker = require('./worker');
const github = require('./github');
const branchNames = require('./branch-names');

// Parse "owner/repo" out of a stored GitHub repo URL. Returns [owner,
// repo] or [] when the URL is missing/unparseable.
function ownerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? [owner, repo] : [];
}

function platform() {
  return require('../workflow/platform.ts');
}

const accepted = (out) => !!out && (out.status === 'accepted' || out.status === 'replayed');

async function appSlugOf(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT a.slug FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1', [sessionId]);
  return rows[0]?.slug || null;
}

// Give the session's slot back (status 'paused'): its worker goes; its CC
// volume, branch, pull request and preview are kept, so resuming it is
// cheap. `from` is the status the caller read ('active'); `reason` is
// 'manual' (the owner's /pause), 'park', 'lru' and 'pressure' (a slot freed
// for other work), 'rest', 'account-deletion', 'build-ended'. The platform's
// own reasons never pause a session somebody works on, nor one a durable
// build holds (the machine's guard). Returns { paused, appSlug? }.
async function pauseSession({ pool, sessionId, userId = null, reason = 'manual', from }) {
  const out = await platform().pauseProposal({ sessionId: Number(sessionId), reason, from, userId });
  if (!accepted(out)) return { paused: false, reason: out?.reason || out?.status || null };
  const appSlug = await appSlugOf(pool, sessionId);
  log.info('session-lifecycle', 'Session paused', { sessionId, reason });
  return { paused: true, appSlug };
}

// #3114: take a proposal out of review and back to Underway, for when its
// author wants to keep working on it before the group can merge it. Not a
// withdraw: its pull request, branch, preview and CC volume stay as they
// are, so a later promote reuses them. Its votes are voided (the approval
// epoch moves on); a session somebody works on, or one holding a secret
// declaration (discarded when it leaves review), is refused.
//
// Returns { ok: true, status, appSlug } on success, { ok: true, already: true,
// status } when the proposal is already Underway, or { ok: false, code } with
// code in 'not_found' | 'forbidden' | 'merging' | 'closed' | 'busy' |
// 'pending_secret'.
async function unpromoteSession({ pool, sessionId, userId, actorUsername = null }) {
  const { rows: [row] } = await pool.query(
    'SELECT status, user_id, app_id FROM chat_sessions WHERE id = $1 AND is_headless = FALSE', [sessionId]);
  if (!row) return { ok: false, code: 'not_found' };
  if (Number(row.user_id) !== Number(userId)) {
    // A proposal in review is public, so naming it as someone else's leaks
    // nothing; a private Underway session stays indistinguishable from a
    // missing one.
    return ['promoted', 'merging', 'merged'].includes(row.status)
      ? { ok: false, code: 'forbidden' } : { ok: false, code: 'not_found' };
  }
  if (row.status === 'active' || row.status === 'paused') return { ok: true, already: true, status: row.status };
  if (row.status === 'merging' || row.status === 'merged') return { ok: false, code: 'merging' };
  if (row.status !== 'promoted') return { ok: false, code: 'closed' };
  const out = await platform().unpromoteProposal({
    sessionId: Number(sessionId), appId: row.app_id, userId: Number(userId), username: actorUsername, from: row.status,
  });
  if (!accepted(out)) {
    const code = out?.reason;
    if (code === 'already_underway') return { ok: true, already: true, status: 'paused' };
    if (code === 'busy' || code === 'pending_secret' || code === 'closed' || code === 'merging') return { ok: false, code };
    // Changed under us (merging, merged): a conflict rather than a guess.
    return { ok: false, code: 'merging' };
  }
  log.info('session-lifecycle', 'Proposal moved back to Underway', { sessionId });
  return { ok: true, status: out.reply?.status || 'paused', appSlug: await appSlugOf(pool, sessionId) };
}

// Sessions to pause for a slot, least recently active first: holding one,
// not imported, and (for the platform-wide cap) idle past the grace window.
// The machine's guard skips any somebody works on or a durable build holds.
const GLOBAL_VICTIMS_SQL = `SELECT id FROM chat_sessions
   WHERE status = 'active'
     AND source IS DISTINCT FROM 'imported'
     AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
     AND id <> $2
   ORDER BY last_activity_at ASC
   LIMIT 20`;
const USER_VICTIMS_SQL = `SELECT id FROM chat_sessions
  WHERE user_id = $1 AND status = 'active' AND id <> $2
    AND source IS DISTINCT FROM 'imported'
    AND ($3::boolean OR is_headless = FALSE)
  ORDER BY last_activity_at ASC
  LIMIT 20`;

// The first of `ids` the machine pauses for `reason`.
async function pauseFirst(ids, reason) {
  for (const id of ids) {
    const out = await platform().pauseProposal({ sessionId: Number(id), reason, from: 'active' }).catch((err) => {
      log.warn('session-lifecycle', 'Could not ask to pause a session for a slot', { sessionId: id, reason, err: err.message });
      return null;
    });
    if (accepted(out)) return Number(id);
  }
  return null;
}

// Demand-driven global-cap eviction. Called when a new session is needed
// (create, resume, reopen) but the platform is at the global cap: the
// least recently active idle session anywhere, idle past `graceMs` and with
// nobody working on it, is paused, freeing a slot at once rather than
// making the requester wait for its idle check. Cross-user by design: its
// worker is long gone, and opening it resumes it. <= 0 disables.
// Returns { freed: boolean, sessionId?: number }.
async function freeGlobalSlot({ pool, graceMs, excludeSessionId = null }) {
  if (!graceMs || graceMs <= 0) return { freed: false };
  const { rows } = await pool.query(GLOBAL_VICTIMS_SQL, [graceMs, excludeSessionId == null ? 0 : excludeSessionId]);
  const id = await pauseFirst(rows.map((r) => r.id), 'pressure');
  if (id == null) return { freed: false };
  log.info('session-lifecycle', 'Freed global slot under pressure', { sessionId: id });
  return { freed: true, sessionId: id };
}

// The per-user cap, handled for the user rather than put to them: when
// their own work needs one of their slots and every slot is taken, their
// least recently active session nobody works on is paused. Pausing keeps the
// branch, the pull request, the preview and the agent's context, and opening
// or messaging the session resumes it: "paused" is not a state anybody is
// asked to manage (#2779 follow-up). `includeHeadless`: the resume route's
// count includes headless rows, so its victims may be headless too.
// Returns { freed: boolean, sessionId?: number }.
async function freeUserSlot({ pool, userId, excludeSessionId = null, includeHeadless = false }) {
  const { rows } = await pool.query(USER_VICTIMS_SQL, [userId, excludeSessionId == null ? 0 : excludeSessionId, !!includeHeadless]);
  const id = await pauseFirst(rows.map((r) => r.id), 'lru');
  if (id == null) return { freed: false };
  log.info('session-lifecycle', 'Freed a user slot', { userId, sessionId: id });
  return { freed: true, sessionId: id };
}

// The one thing a user is told when their slots cannot be freed: every other
// session of theirs is in the middle of a turn.
const USER_SLOTS_BUSY = 'Your other sessions are all busy finishing turns. Try again in a moment.';

// What anybody is told when the platform-wide cap is full and nothing idle
// could be paused to make room.
const PLATFORM_AT_CAPACITY = 'Platform is at capacity right now. Try again in a few minutes.';

/**
 * Somebody was turned away by a session cap: `cap` 'global' (the
 * platform-wide one) or 'user' (their own), `path` where they asked. One
 * event each (events.SESSION_CAPACITY_REFUSED), which the infra topic's
 * "Turned away at a session cap" figure counts: the admins' alert samples
 * the count every few minutes, so it shows how often a cap was full, not
 * how many people met it. Fire-and-forget, never throws.
 */
function recordCapacityRefusal(pool, { cap, path, userId = null, appId = null } = {}) {
  const events = require('./events');
  log.info('session-lifecycle', 'Turned away at a session cap', { cap, path, userId });
  return events.record(pool, {
    type: events.EVENT_TYPES.SESSION_CAPACITY_REFUSED, userId, appId, metadata: { cap, path },
  });
}

/**
 * The platform-wide gate every start, resume and reopen passes: under
 * config.maxGlobalSessions (session-caps.countGlobalSessions), or at it with
 * an idle session paused to make room (freeGlobalSlot). `discount` is a slot
 * the request gives back (a replaced session). Answers { ok } and, when not,
 * records the refusal; the caller answers 429 with PLATFORM_AT_CAPACITY.
 */
async function claimGlobalSlot({
  pool, config, path, userId = null, appId = null, excludeSessionId = null, discount = 0,
}) {
  const { countGlobalSessions } = require('./session-caps');
  const cap = config && config.maxGlobalSessions != null ? Number(config.maxGlobalSessions) : 100;
  if ((await countGlobalSessions(pool)) - discount < cap) return { ok: true };
  // Through the exports, as the routes called it before this gate existed,
  // so a test's stand-in applies here too.
  const { freed } = await module.exports.freeGlobalSlot({
    pool, graceMs: config && config.sessionPressureGraceMs, excludeSessionId,
  });
  if (freed) return { ok: true };
  await recordCapacityRefusal(pool, { cap: 'global', path, userId, appId });
  return { ok: false };
}

// Tear down a session's staging preview (container + cloned DB + Caddy
// route) WITHOUT changing the session's status. This is the staging GC
// path — pausing no longer does it, so a separate, longer-horizon
// sweeper reclaims staging from sessions that have gone cold. Nulls the
// staging_* columns so a repeat sweep treats it as already reclaimed and
// so a later /resume + push rebuilds fresh.
//
// Never call this for 'promoted'/'merging' sessions — their preview
// backs the group's PR vote. The sweeper query enforces that; this
// function just does the teardown it's told to.
async function teardownStagingForSession({ pool, sessionId, reason = 'idle' }) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = rows[0];
  if (!session || !(session.staging_runtime_name || session.staging_container_id)) return { torn: false };

  // #851: teardownStaging owns the nulling and now reports whether the
  // container actually went away. On a leak the row deliberately still names
  // the survivor so the stale-preview sweeper can retry through the same
  // chokepoint — so this must NOT null the columns behind its back (which is
  // exactly how ten production previews became untracked orphans) and must
  // not announce a teardown that didn't happen.
  const result = await staging.teardownStaging(session, { slug: session.app_slug })
    .catch((err) => {
      log.warn('session-lifecycle', 'Staging teardown threw', { sessionId, err: err.message });
      return { removed: false, leaked: true };
    });
  if (result && result.leaked) {
    log.warn('session-lifecycle', 'Staging GC left a container behind — link kept for retry', {
      sessionId, reason,
    });
    return { torn: false, leaked: true };
  }

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'staging_torn_down', sessionId, appSlug: session.app_slug });
  log.info('session-lifecycle', 'Staging torn down (GC)', { sessionId, reason });
  return { torn: true };
}

// Close a proposal (status 'archived'), for any reason: withdrawn by its
// owner ('manual'), voted down ('auto-rejected'), gone quiet ('stale-pr'),
// replaced, superseded, its request closed, red and untouched, the Homeroom
// bot's or a bench trial's own ending. One path for every close: the
// machine closes its pull request, retires its preview for good, destroys
// its worker, abandons its work orders, discards a secret it held, tells the
// conversation that started it and settles the bell, durably. Reversible
// (unarchiveSession). `from` is the status the caller read; a close a newer
// move overtook is refused. `userId` scopes it to the owner (the route).
// `purgeCc` destroys the CC volume at once instead of after the retention
// window. Returns { archived, appSlug?, reason? }.
async function archiveSession({ pool, sessionId, userId = null, reason = 'manual', purgeCc = false, from, username = null, waitMs }) {
  const out = await platform().closeProposal({
    sessionId: Number(sessionId), reason, from, userId, username, purgeCc, waitMs,
  });
  // Recorded and not yet applied (a slow pipeline): it closes once it is,
  // unless a newer move overtakes it.
  if (out?.status === 'pending') return { archived: true, pending: true };
  if (!accepted(out)) return { archived: false, reason: out?.reason || out?.status || null };
  log.info('session-lifecycle', 'Session archived', { sessionId, reason, purgeCc });
  return { archived: true, appSlug: await appSlugOf(pool, sessionId) };
}

// Reopen a closed proposal (within the retention window): it is Underway
// again, its slot given back ('paused'), so opening it resumes it through the
// usual caps. Its pull request is reopened (after a close still under way
// reports); one GitHub says is closed for good is forgotten, so the next
// promote opens a fresh one. Returns { unarchived, ccPurged? }.
async function unarchiveSession({ pool, sessionId, userId = null }) {
  const { rows: [row] } = await pool.query(
    `SELECT status, user_id, app_id, cc_purged FROM chat_sessions WHERE id = $1`, [sessionId]);
  if (!row || row.status !== 'archived' || (userId != null && Number(row.user_id) !== Number(userId))) return { unarchived: false };
  const out = await platform().reopenProposal({
    sessionId: Number(sessionId), appId: row.app_id, userId: Number(userId ?? row.user_id), from: row.status,
  });
  if (!accepted(out)) return { unarchived: false };
  log.info('session-lifecycle', 'Session unarchived', { sessionId, ccPurged: !!row.cc_purged });
  return { unarchived: true, ccPurged: !!row.cc_purged };
}

// ── A flow's own sessions (the Homeroom bot's, a bench trial's) ─────────

// Takes its own session's slot for a turn ('paused' → 'active'), through the
// proposal machine: never a closed session (bug 21), with no caps (the flow
// keeps its own). Its last activity moves to now either way. Answers whether
// the session holds its slot.
async function takeSlot({ pool, sessionId, source = 'own-turn' }) {
  const { rows: [now] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
  if (!now) return false;
  if (now.status === 'paused') {
    const out = await platform().resumeProposal({
      sessionId: Number(sessionId), from: 'paused', caps: null, source: { kind: 'system', name: source },
    });
    if (!accepted(out) && out?.reason !== 'already_active') {
      log.warn('session-lifecycle', 'A flow\'s own session did not take its slot', { sessionId, reason: out?.reason || out?.status });
      return false;
    }
    return true;
  }
  await pool.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [sessionId]);
  return now.status === 'active';
}

// ... and puts it back at rest once its turn is over ('active' → 'paused'),
// never under a turn record: restart recovery throws away a session it
// finds paused, so pausing one under a turn in flight is how a running turn
// gets lost (#1006). Answers whether it paused.
async function restSession({ pool, sessionId }) {
  const { rows: [now] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
  if (!now || now.status !== 'active') return false;
  const out = await platform().pauseProposal({ sessionId: Number(sessionId), reason: 'rest', from: 'active' })
    .catch((err) => {
      log.warn('session-lifecycle', 'Could not put a session back at rest', { sessionId, err: err.message });
      return null;
    });
  return accepted(out);
}

// Closes a session its own flow is done with (a build that failed, a plan
// with nothing to build, a bench trial), from whatever status it is open in,
// the way every close goes. Answers whether it closed.
async function closeOwnSession({ pool, sessionId, reason, waitMs }) {
  const { rows: [now] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
  if (!now || !['active', 'paused', 'promoted'].includes(now.status)) return false;
  const { archived } = await archiveSession({ pool, sessionId, reason, from: now.status, waitMs });
  return archived;
}

// Hard GC for the retention window: destroy the CC volume of an archived
// session so its conversation memory stops occupying disk. Idempotent —
// flips cc_purged so the sweeper won't revisit it. The row + branch
// survive; /unarchive still works but with fresh Claude memory.
async function purgeArchivedCc({ pool, sessionId }) {
  await worker.destroyCcVolume(sessionId).catch(() => {});
  await pool.query(`UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1`, [sessionId]);
  log.info('session-lifecycle', 'Archived CC volume purged (retention elapsed)', { sessionId });
  return { purged: true };
}


// ── Deferred branch creation (#1350) ────────────────────────────────────
//
// A native session no longer gets a git branch when it is created. Nothing
// is on the branch until an agent turn runs, and most created sessions
// never run one: the branch was an empty ref off main, plus a GitHub API
// call, minted for a session the owner might abandon on the start screen
// or hand straight over to an off-platform agent that pushes to its own
// fork. So the mint moved to the first thing that actually needs it.
//
// This helper is that mint, and it is the ONLY one on the deferred path.
// Three properties it has to have, because the callers below are a first
// chat turn, two worker-dispatch seams and the push proxy, any of which
// can be the first to arrive and two of which can arrive at once:
//
//   idempotent  - a session that already has a branch returns it untouched.
//   serialized  - SELECT ... FOR UPDATE holds the row for the whole mint,
//                 so two concurrent callers cannot mint two names for one
//                 session (the loser sees the winner's name on its read).
//   all-or-nothing - the name is persisted ONLY after GitHub has the ref.
//                 A stored branch_name whose ref does not exist is the one
//                 state the worker cannot survive: run-cc.sh dies on
//                 "branch missing upstream: origin/$BRANCH" for every
//                 build and sync turn, forever, with no way back.
//
// Off-platform venues (web-claude-code, web-codex, own-tools-pr) never run
// an on-platform turn, so they never reach any caller of this and never
// mint a branch at all. That is the second half of #1350, and it falls out
// of the deferral rather than needing its own switch.
//
// Params:
//   pool      - pg pool
//   sessionId - numeric session id
//   username  - optional; the branch's owner segment. Defaults to the
//               session owner's stored username.
//   label     - optional; words for what the session is about (#3229), the
//               first turn's deterministic title. Defaults to the session's
//               stored title, so a titled session (the bot's builds, a
//               dispatch backstop) is still named after its change.
//
// Returns { branchName, created }. Throws with `code` set when the session
// is gone ('no_session') or GitHub refused the ref ('branch_create_failed',
// carrying a userMessage safe to show in chat).
async function ensureSessionBranch({ pool, sessionId, username = null, label = null }) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const { rows } = await client.query(
      `SELECT cs.id, cs.branch_name, cs.user_id, cs.session_title, u.username, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
         LEFT JOIN users u ON u.id = cs.user_id
        WHERE cs.id = $1
        FOR UPDATE OF cs`,
      [sessionId]
    );
    const row = rows[0];
    if (!row) {
      await client.query('COMMIT');
      open = false;
      const err = new Error(`Session ${sessionId} not found`);
      err.code = 'no_session';
      throw err;
    }
    if (row.branch_name) {
      await client.query('COMMIT');
      open = false;
      return { branchName: row.branch_name, created: false };
    }

    const branchName = branchNames.devBranchName(
      username || row.username || `u${row.user_id}`, Date.now(), label || row.session_title || null,
    );
    const [owner, repo] = ownerRepo(row.repo_url);
    if (github.isEnabled() && owner && repo) {
      try {
        await github.createBranch(owner, repo, branchName);
      } catch (err) {
        await client.query('ROLLBACK');
        open = false;
        log.warn('session-lifecycle', 'Deferred branch creation failed', {
          sessionId, branch: branchName, err: err.message,
        });
        const wrapped = new Error(`Could not create branch ${branchName}: ${err.message}`);
        wrapped.code = 'branch_create_failed';
        wrapped.userMessage = 'Homeroom could not create this session\'s branch on GitHub. '
          + 'Send your message again in a moment. If it keeps failing, ask an admin to check '
          + 'the GitHub connection for this app.';
        throw wrapped;
      }
    }

    await client.query(`UPDATE chat_sessions SET branch_name = $2 WHERE id = $1`, [sessionId, branchName]);
    await client.query('COMMIT');
    open = false;
    log.info('session-lifecycle', 'Session branch created on first use', { sessionId, branch: branchName });
    return { branchName, created: true };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* already unwound */ } }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureSessionBranch,
  pauseSession,
  unpromoteSession,
  freeGlobalSlot,
  freeUserSlot,
  USER_SLOTS_BUSY,
  PLATFORM_AT_CAPACITY,
  recordCapacityRefusal,
  claimGlobalSlot,
  teardownStagingForSession,
  archiveSession,
  unarchiveSession,
  purgeArchivedCc,
  GLOBAL_VICTIMS_SQL,
  USER_VICTIMS_SQL,
  takeSlot,
  restSession,
  closeOwnSession,
};
