'use strict';

// `revert.open`, a platform operation (services/platform-operations.js): an
// Undo's revert proposal, opened on a conductor. POST /api/sessions/:id/undo
// (routes/votes.js) checks the change and the requester, records this and
// answers at once, as it always did; the conductor reads them again, then
// makes the revert branch, the PR and its promoted session
// (routes/votes.js checkAndOpenRevert), announces it in the undone change's
// thread and refreshes the vote panel. A host failure is tried again from the
// last finished step; only the last try, or a revert that conflicts, gives
// the claim back and says so in the thread. One Undo of a change runs at a
// time (the machine's single-flight key), so a claim this request began is
// never another's.

const appAccess = require('./app-access');
const communities = require('./communities');

async function mergedSession(pool, request) {
  const { rows: [session] } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
      WHERE cs.id = $1 AND cs.status = 'merged'`,
    [request.input?.sessionId]
  );
  return session && session.app_id === request.appId ? session : null;
}

async function authorize({ pool }, request, user, { steps = null } = {}) {
  const session = await mergedSession(pool, request);
  if (!session) return { status: 404, error: 'Merged session not found' };
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
  if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'Merged session not found' };
  const join = await communities.appNeedsJoin(pool, app.slug, user);
  if (join) return { status: 403, ...join };
  // Another revert's, unless this request has begun its own claim.
  if (!steps?.has?.('claiming') && session.revert_of_session_id && session.revert_of_session_id !== session.id) {
    return { status: 409, error: 'A revert for this merge is already open' };
  }
  if (session.included_in_session_id) {
    return { status: 409, error: 'This change went live as part of another change. Undo that change instead.' };
  }
  return null;
}

// A request refused part way (its requester lost access) gives back its claim
// if it never got as far as linking a revert, so a later Undo can ask again.
async function abandon({ pool }, request, steps) {
  if (!steps.has('claim') && !steps.has('claiming')) return;
  if (steps.has('revert-session')) return;
  await pool.query(
    'UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1 AND revert_of_session_id = id',
    [request.input.sessionId]
  );
}

async function run({ config, pool }, request, user, steps) {
  const session = await mergedSession(pool, request);
  if (!session) return { ok: false, status: 404, error: 'Merged session not found' };
  const result = await require('../routes/votes').checkAndOpenRevert(config, pool, session, user, { steps });
  if (result?.reverted) {
    require('./ws').pushVoteUpdate({
      sessionId: session.id,
      appSlug: session.app_slug,
      merged: false,
      kind: 'undo',
      revertSessionId: result.revertSessionId,
      revertPrNumber: result.revertPrNumber,
    });
  }
  return { reverted: !!result?.reverted, ...(result?.revertSessionId ? { revertSessionId: result.revertSessionId } : {}) };
}

module.exports = { authorize, run, abandon };
