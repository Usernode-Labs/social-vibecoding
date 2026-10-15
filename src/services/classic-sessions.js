'use strict';

// #3976: classic dev sessions are read-only.
//
// A classic session is a change whose dev chat is its own: a chat_sessions
// row with no parent agent session (`agent_session_id` NULL) that is neither
// a headless run nor an imported pull request, which have no dev chat at all.
// #2779 stopped creating them (POST /api/apps/:slug/sessions answers
// `agent_sessions_only`); this stops continuing them. New work happens in an
// agent session, whose changes are revised in their conversation.
// Two kinds of row that are still created today are not old sessions and
// stay continuable: a CLI hand-off (`proposal_start`, whose local and web
// turns may alternate) and a request's planning record (request-specs.js).
//
// Reading one stays open, and so does everything about the proposal it
// became: the transcript, its specs, its previews (ensure-staging), its
// checks (recheck), proposing it (promote), the vote, sync with main,
// unpromote, archive, sharing and renaming. Proposing a classic session that
// was never proposed is allowed on purpose: it is finished work, and putting
// it up for a vote runs nothing new in its chat.
//
// What is refused is what would run more work in its own chat, with 409 and
// `classic_session_read_only`: a message (POST /api/sessions/:id/chat, which
// is where every Mayor turn, scout and coding run of a classic session
// started), an attachment for one, switching its coding agent or model
// (reset-agent-context) and choosing where it is built next (build-venue).
//
// GET /api/sessions/:id carries `classic_read_only`, which the dev chat
// reads to put its composer away and say why (features/dev-chat/banners).

const CODE = 'classic_session_read_only';

const MESSAGE = 'This is an older session. You can read it, but it can no longer be continued. '
  + 'Start an agent session to keep working.';

// Sources whose rows are never classic, whatever else they carry.
const NOT_CLASSIC_SOURCES = new Set(['imported', 'cli_handoff', 'request_spec']);

/** Whether a chat_sessions row is a classic session. */
function isClassicSession(row) {
  if (!row || typeof row !== 'object') return false;
  return row.agent_session_id == null
    && row.is_headless !== true
    && !NOT_CLASSIC_SOURCES.has(row.source);
}

/** The 409 body every refusing route answers with. */
function refusal() {
  return { error: MESSAGE, code: CODE };
}

/**
 * The owner's row, as much of it as `isClassicSession` reads, or null when
 * it is not theirs. Routes that load nothing else before refusing use it.
 */
async function loadOwned(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, agent_session_id, is_headless, source
       FROM chat_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

module.exports = { CODE, MESSAGE, isClassicSession, refusal, loadOwned };
