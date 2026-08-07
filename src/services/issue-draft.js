// Shared issue-report DRAFT creation (#1037).
//
// Two callers create the same human-gated draft card:
//
//   1. The build-turn coding agent, through the worker's
//      `usernode-report-platform-issue` CLI →
//      POST /api/internal/sessions/:id/platform-issue (src/routes/internal.js).
//      Source 'agent'.
//   2. The Mayor's in-process `draft_issue_report` tool, when the user
//      explicitly asks for an issue to be created (src/routes/sessions.js).
//      Source 'user_request'.
//
// Both land here so they cannot drift apart. NOTHING in this module
// touches GitHub: it persists a pending draft as a `system` row in the
// session timeline (metadata.platformIssueDraft) and pushes a live
// session event so an open dev-chat renders a card with "Report to
// platform" / "Dismiss" buttons. The GitHub issue is created only when a
// user taps confirm — see POST /api/sessions/:id/platform-issue/:msgId/confirm
// in src/routes/sessions.js.
//
// Every failure comes back as a plain `{ ok: false, code }` object rather
// than a throw: the Mayor tool feeds the result straight into the model's
// context, and the internal route maps codes to its historical HTTP
// statuses.

const log = require('./logger');
const github = require('./github');
const sessionBus = require('./session-bus');
// Called through the module object (ws.broadcastGlobal) rather than
// destructured, so tests can monkey-patch the live push — the same
// pattern the route suites use for worker.isInFlight / statusSvc.gather.
const ws = require('./ws');

const TITLE_MAX = 160;
const BODY_MAX = 4000;

// Per-session draft caps, counted over a rolling window. The express
// limiter on the internal route counts REQUESTS; this counts drafts that
// actually landed, so both callers are bounded uniformly. A draft the
// user explicitly asked for gets a looser cap than one an agent raised on
// its own initiative — throttling an answer to "create an issue for this"
// at the agent's spam rate would be its own bug.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = { agent: 3, user_request: 10 };

// Status-line / timeline copy. A user-requested draft reads as
// fulfilment ("here it is, confirm it"); an agent-raised one reads as a
// suggestion, which is what it is.
const CONTENT_AGENT = 'The AI suggests reporting this to the platform';
const CONTENT_USER = 'Drafted an issue for you to confirm';

function draftRowContent(source) {
  return source === 'user_request' ? CONTENT_USER : CONTENT_AGENT;
}

// Normalised-title comparison key for both de-dupes. Deliberately loose
// (case + punctuation insensitive) and deliberately title-only: two
// differently-worded reports of the same problem still both draft, which
// costs one Dismiss tap rather than silently swallowing a real report.
function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseRepoUrl(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Resolve where a draft with this target would be filed. Kept separate
// from createDraft so the Mayor turn can decide whether to OFFER the tool
// at all without writing anything.
//
//   platform → the platform's own repo, filed with the bot PAT (the
//              platform repo is not behind the per-app GitHub App
//              installation).
//   app      → the session app's own repo, filed through the GitHub App
//              installation, exactly like routes/feedback.js's app path.
function resolveTarget(config, target, appRepoUrl) {
  if (target === 'app') {
    if (!github.isEnabled()) return { ok: false, code: 'not_configured' };
    const parsed = parseRepoUrl(appRepoUrl);
    if (!parsed) return { ok: false, code: 'no_repo' };
    return { ok: true, target: 'app', ...parsed };
  }
  if (!process.env.GITHUB_BOT_TOKEN) return { ok: false, code: 'not_configured' };
  const parsed = parseRepoUrl(config && config.platformRepoUrl);
  if (!parsed) return { ok: false, code: 'no_repo' };
  return { ok: true, target: 'platform', ...parsed };
}

// True when at least one destination could actually be filed on this
// deployment. The Mayor only sees draft_issue_report when this holds —
// offering a tool whose every result is `not_configured` just burns a
// turn.
function canDraft(config, appRepoUrl) {
  return resolveTarget(config, 'platform', appRepoUrl).ok
    || resolveTarget(config, 'app', appRepoUrl).ok;
}

/**
 * Create a pending draft card in a session's timeline.
 *
 * @param {import('pg').Pool} pool
 * @param {object} config platform config (needs platformRepoUrl)
 * @param {object} opts
 * @param {number} opts.sessionId
 * @param {string} opts.title
 * @param {string} [opts.body]
 * @param {'platform'|'app'} [opts.target='platform']
 * @param {'agent'|'user_request'} [opts.source='agent']
 * @returns {Promise<object>} result object, never throws
 */
async function createDraft(pool, config, opts = {}) {
  const sessionId = parseInt(opts.sessionId, 10);
  if (!Number.isFinite(sessionId)) return { ok: false, code: 'bad_session_id' };

  const source = opts.source === 'user_request' ? 'user_request' : 'agent';
  const target = opts.target === 'app' ? 'app' : 'platform';
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  const body = typeof opts.body === 'string' ? opts.body.trim() : '';

  if (!title) return { ok: false, code: 'bad_title' };
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long' };
  if (body.length > BODY_MAX) return { ok: false, code: 'body_too_long' };

  let session;
  try {
    const { rows } = await pool.query(
      `SELECT cs.id, cs.app_id, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1`,
      [sessionId]
    );
    if (!rows.length) return { ok: false, code: 'session_not_found' };
    session = rows[0];
  } catch (err) {
    log.error('issue-draft', 'Session lookup failed', { sessionId, err: err.message });
    return { ok: false, code: 'db_error' };
  }

  // Refuse up front when the confirm tap could never succeed, so the
  // caller gets a clear "not supported here" instead of the user hitting
  // a dead button later.
  const dest = resolveTarget(config, target, session.repo_url);
  if (!dest.ok) return { ok: false, code: dest.code };

  // Rate cap. Counts drafts already in this session's timeline within the
  // window; a count failure is never a reason to refuse a legitimate
  // report, so it falls through.
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM chat_session_messages
        WHERE session_id = $1
          AND metadata ? 'platformIssueDraft'
          AND created_at > NOW() - ($2::int * INTERVAL '1 millisecond')`,
      [sessionId, RATE_WINDOW_MS]
    );
    if ((rows[0]?.n || 0) >= RATE_MAX[source]) {
      log.warn('issue-draft', 'Draft rate cap hit', { sessionId, source, n: rows[0]?.n });
      return { ok: false, code: 'rate_limited' };
    }
  } catch (err) {
    log.warn('issue-draft', 'Rate-cap check failed', { sessionId, err: err.message });
  }

  // De-dupe #1: an open issue with the same normalised title already
  // exists on the DESTINATION repo (cached fetch, never throws).
  // Best-effort — a fetch miss still lets a genuine report through.
  try {
    const existing = await github.fetchPublicIssues(dest.owner, dest.repo);
    if (!existing.note && Array.isArray(existing.issues)) {
      const dupe = existing.issues.find((i) => normTitle(i.title) === normTitle(title));
      if (dupe) {
        log.info('issue-draft', 'Draft deduped against open issue', {
          sessionId, number: dupe.number,
        });
        return { ok: true, deduped: true, number: dupe.number, url: dupe.htmlUrl };
      }
    }
  } catch (err) {
    log.warn('issue-draft', 'Open-issue dedup check failed', { sessionId, err: err.message });
  }

  // De-dupe #2: this session already carries a draft with the same
  // normalised title. An agent is blocked by ANY prior state — re-raising
  // a card the user already dismissed is exactly the spam the human gate
  // exists to prevent. A user asking again for something they dismissed
  // earlier is a change of mind, not spam, so a dismissed draft does not
  // block a user-requested one.
  try {
    const { rows } = await pool.query(
      `SELECT id, metadata FROM chat_session_messages
        WHERE session_id = $1 AND metadata ? 'platformIssueDraft'
        ORDER BY id DESC LIMIT 20`,
      [sessionId]
    );
    const prior = rows.find((r) => {
      const d = r.metadata?.platformIssueDraft;
      if (!d || normTitle(d.title) !== normTitle(title)) return false;
      if (source === 'user_request' && d.status === 'dismissed') return false;
      return true;
    });
    if (prior) {
      const d = prior.metadata.platformIssueDraft;
      return {
        ok: true,
        deduped: true,
        draftStatus: d.status,
        ...(d.issueUrl ? { url: d.issueUrl, number: d.issueNumber } : {}),
      };
    }
  } catch (err) {
    log.warn('issue-draft', 'Draft-dedup check failed', { sessionId, err: err.message });
  }

  // Persist the pending draft as a system row in the session timeline
  // (the same table every other card rehydrates from). owner/repo are
  // stamped now so confirm files exactly where the card said it would,
  // even if the app's repo_url changes in between.
  const draft = {
    title,
    body,
    status: 'pending',
    target: dest.target,
    source,
    owner: dest.owner,
    repo: dest.repo,
    appSlug: session.app_slug,
    appName: session.app_name,
  };
  const content = draftRowContent(source);
  let msgId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3) RETURNING id`,
      [sessionId, content, JSON.stringify({ platformIssueDraft: draft })]
    );
    msgId = rows[0].id;
  } catch (err) {
    log.error('issue-draft', 'Draft insert failed', { sessionId, err: err.message });
    return { ok: false, code: 'db_error' };
  }

  // Live push. A dedicated event type (NOT 'status') so the client
  // handlers don't run the status side effects — a draft can land
  // mid-build-turn, and a status event would deactivate the live
  // "Claude Code is running" spinner line. Same envelope contract as
  // sendStatus / sync-main.js otherwise.
  try {
    const event = {
      type: 'platform_issue_draft',
      _seq: `pi${Date.now().toString(36)}`,
      text: content,
      platformIssueDraft: { ...draft, msgId },
    };
    ws.broadcastGlobal({ ...event, sessionId, event: 'platform_issue_draft', type: 'session_event' });
    sessionBus.publish(sessionId, event);
  } catch (_) { /* live push is best-effort; reload rehydrates */ }

  log.info('issue-draft', 'Issue report drafted', {
    sessionId, appSlug: session.app_slug, msgId, target: dest.target, source,
  });
  return {
    ok: true,
    suggested: true,
    msgId,
    target: dest.target,
    owner: dest.owner,
    repo: dest.repo,
  };
}

module.exports = {
  createDraft,
  resolveTarget,
  canDraft,
  normTitle,
  parseRepoUrl,
  draftRowContent,
  TITLE_MAX,
  BODY_MAX,
  RATE_WINDOW_MS,
  RATE_MAX,
  CONTENT_AGENT,
  CONTENT_USER,
};
