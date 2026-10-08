'use strict';

// Specs posted on a request by a person (the connector's post_spec).
//
// Until this, only Homeroom's own agents wrote specs: the dev-chat scout, the
// headless platform build and the Homeroom bot. Somebody working through the
// MCP connector could plan a request in their own chat but had nowhere to put
// the plan where the group reviews it, so the before/after screens of an HTML
// spec (#3699) never reached the request it was for.
//
// A spec belongs to a session in every reader the platform has: the spec
// card opens GET /api/sessions/:id/specs/:version, the dev chat's spec panel
// reads chat_sessions.spec_md and spec_html, and the build prompt reads the
// same. So a posted spec lives on a PLANNING RECORD: a session owned by its
// author, linked to the request, with no branch and status 'paused'. Paused
// is the state that holds no worker container and counts against neither
// session cap (schema.sql, chat_sessions.status), which is what keeps
// planning several requests from using up anybody's slots. Resuming it in
// the browser makes it an ordinary dev session that starts from the spec.
// Like any paused session linked to a request, it shows its author on the
// request as at work on it for a week after the last post: posting a plan
// is taking the request on.
//
// Each post is one numbered version on the author's record for that request,
// so a review round is version 2 rather than a second record. The version is
// shared with the group at once (a spec posted for review is a spec to be
// read), the spec card goes in the request's own thread exactly as the
// Homeroom bot posts its spec there, and the markdown copy goes on the
// GitHub issue for the people who read the request there.
//
// Lengths are checked, never fixed: an HTML document over the viewer's cap
// is refused with the numbers rather than stored as its projection alone.

const crypto = require('crypto');
const log = require('./logger');
const specHtml = require('./spec-html');

const SPEC_SOURCE = 'request_spec';
// A markdown spec has no viewer cap of its own; this keeps one within what a
// GitHub comment can carry whole, since that copy is the spec for anyone
// reading the request on GitHub.
const MAX_SPEC_MARKDOWN_CHARS = 60000;
const MAX_SPEC_HTML_CHARS = specHtml.MAX_SPEC_HTML_CHARS;
// The GitHub copy of an HTML spec is its markdown projection. A projection
// that outgrows a comment is clipped there, said so, and points at Homeroom,
// where the whole spec is.
const MAX_COMMENT_SPEC_CHARS = 60000;
const MAX_LISTED_SPECS = 50;

class SpecError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** The first `# Title` line of a markdown spec, or null. */
function specTitle(markdown) {
  for (const line of String(markdown || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    return t.startsWith('# ') ? t.slice(2).trim().slice(0, 200) || null : null;
  }
  return null;
}

/** The card's preview: the body after the title, as the share route cuts it. */
function specSnippet(markdown, title) {
  const lines = String(markdown || '').split('\n');
  let start = 0;
  if (title) {
    while (start < lines.length && !lines[start].trim()) start += 1;
    if (start < lines.length && lines[start].trim().startsWith('# ')) start += 1;
  }
  while (start < lines.length && !lines[start].trim()) start += 1;
  return lines.slice(start).join('\n').slice(0, 280);
}

/**
 * Pure. What a posted spec stores: { ok, markdown, html, format } or
 * { ok: false, status, code, message, ... }. An HTML spec is an
 * <article data-spec> document (spec-html.js); anything else is markdown.
 */
function prepareSpec(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { ok: false, status: 400, code: 'invalid_request', message: 'spec is required.' };
  const doc = specHtml.extractHtmlSpec(raw);
  if (doc !== null) {
    if (doc.length > MAX_SPEC_HTML_CHARS) {
      return {
        ok: false, status: 400, code: 'spec_too_long',
        message: `The HTML spec is ${doc.length} characters, over the ${MAX_SPEC_HTML_CHARS}-character limit `
          + 'the spec viewer takes. Nothing was posted. Draw fewer or smaller screens, then post it again.',
        limitChars: MAX_SPEC_HTML_CHARS, actualChars: doc.length,
      };
    }
    const { markdown, html } = specHtml.normalizeSpecOutput(doc);
    if (!String(markdown || '').trim()) {
      return { ok: false, status: 400, code: 'invalid_request', message: 'The HTML spec has no readable text.' };
    }
    return { ok: true, markdown: markdown.trim(), html, format: 'html' };
  }
  if (raw.length > MAX_SPEC_MARKDOWN_CHARS) {
    return {
      ok: false, status: 400, code: 'spec_too_long',
      message: `The spec is ${raw.length} characters, over the ${MAX_SPEC_MARKDOWN_CHARS}-character limit. `
        + 'Nothing was posted. Shorten it, then post it again.',
      limitChars: MAX_SPEC_MARKDOWN_CHARS, actualChars: raw.length,
    };
  }
  return { ok: true, markdown: raw, html: null, format: 'markdown' };
}

/** The spec card for the request's thread: the same card the bot posts. */
function specCard({ sessionId, version, markdown, user }) {
  const title = specTitle(markdown);
  return {
    content: `📋 ${user.username || 'Someone'} posted a plan for this request`
      + `${title ? `: "${title}"` : ''} (version ${version}).`,
    msgType: 'spec_share',
    metadata: {
      specShare: {
        sessionId: Number(sessionId),
        version: Number(version),
        builtAt: null,
        commitSha: null,
        prNumber: null,
        title,
        snippet: specSnippet(markdown, title),
        totalChars: String(markdown || '').length,
        sharedBy: { id: Number(user.id), username: user.username },
      },
    },
  };
}

/** The GitHub comment: who posted it, where it is whole, then the markdown copy. */
function specCommentText({ username, version, markdown, format, webPath }) {
  const text = String(markdown || '');
  const clipped = text.length > MAX_COMMENT_SPEC_CHARS;
  const where = webPath ? ` on Homeroom: ${webPath}` : ' on Homeroom';
  return [
    `**${username || 'Someone'}** posted a plan for this request (version ${version}).`
      + (format === 'html'
        ? ` Its before/after screens are in the plan card${where}.`
        : ` It is in the plan card${where}.`),
    '',
    '<details><summary>The plan</summary>',
    '',
    clipped ? text.slice(0, MAX_COMMENT_SPEC_CHARS) : text,
    ...(clipped ? ['', `[The first ${MAX_COMMENT_SPEC_CHARS} of ${text.length} characters. The whole plan is${where}.]`] : []),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Post a spec on a request. `app` carries id, slug, self_hosted and the
 * owner/repo already parsed; the caller has checked membership, access and
 * that the request is open. Resolves { sessionId, version, createdRecord,
 * format, title, markdownChars, htmlChars, commentPosted }.
 */
async function postRequestSpec(pool, { app, repo, issueNumber, issueTitle = null, user, text, webPath = null }, deps = {}) {
  const ws = deps.ws || require('./ws');
  const github = deps.github || require('./github');
  const prepared = prepareSpec(text);
  if (!prepared.ok) {
    const { status, code, message, ...extra } = prepared;
    throw new SpecError(status, code, message, extra);
  }
  const html = prepared.html
    ? specHtml.stampSpecStyles(prepared.html, specHtml.specStylesFor(app))
    : null;

  const client = await pool.connect();
  let sessionId;
  let version;
  let createdRecord = false;
  try {
    await client.query('BEGIN');
    // One planning record per author per request, even under two posts at
    // once: the lock serialises the find-or-create for this triple only.
    const lockKey = crypto.createHash('sha256')
      .update(`request-spec:${app.id}:${issueNumber}:${user.id}`).digest().readInt32BE(0);
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    const { rows: existing } = await client.query(
      `SELECT id FROM chat_sessions
        WHERE app_id = $1 AND user_id = $2 AND source = $3
          AND created_from_issue_number = $4 AND status <> 'archived'
        ORDER BY id DESC LIMIT 1`,
      [app.id, user.id, SPEC_SOURCE, issueNumber]
    );
    if (existing.length) {
      sessionId = existing[0].id;
    } else {
      const title = String(issueTitle || '').trim();
      const { rows } = await client.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, source, created_from_issue_number,
            linked_issues, issue_link_seeded, session_title, is_headless)
         VALUES ($1, $2, NULL, 'paused', $3, $4, ARRAY[$4::int], TRUE, $5, FALSE)
         RETURNING id`,
        [app.id, user.id, SPEC_SOURCE, issueNumber,
          `Spec for #${issueNumber}${title ? ` ${title}` : ''}`.slice(0, 200)]
      );
      sessionId = rows[0].id;
      createdRecord = true;
    }
    // last_activity_at keeps the request showing its author at work on it,
    // the way a paused session does for 7 days after its last turn
    // (issue-progress.js): each revision is activity.
    await client.query(
      'UPDATE chat_sessions SET spec_md = $2, spec_html = $3, last_activity_at = NOW() WHERE id = $1',
      [sessionId, prepared.markdown, html]
    );
    const { rows: versionRows } = await client.query(
      `INSERT INTO chat_session_specs (session_id, version, content, content_html, shared_to_group_at)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM chat_session_specs WHERE session_id = $1), 0) + 1, $2, $3, NOW())
       RETURNING version`,
      [sessionId, prepared.markdown, html]
    );
    version = versionRows[0].version;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The card and the GitHub copy are announcements of a spec that is already
  // stored and readable, so neither can take the post back with it.
  const card = specCard({ sessionId, version, markdown: prepared.markdown, user });
  try {
    await ws.sendBotMessage(pool, app.id, {
      user, content: card.content, metadata: card.metadata,
      thread: { type: 'issue', ref: Number(issueNumber) }, msgType: card.msgType,
    });
  } catch (err) {
    log.warn('request-specs', 'Spec card not posted', { appId: app.id, issueNumber, sessionId, err: err.message });
  }
  let commentPosted = false;
  if (repo && github.isEnabled && github.isEnabled()) {
    try {
      await github.createIssueComment(repo.owner, repo.repo, Number(issueNumber), specCommentText({
        username: user.username, version, markdown: prepared.markdown, format: prepared.format, webPath,
      }));
      commentPosted = true;
    } catch (err) {
      log.warn('request-specs', 'Spec comment not posted', { appId: app.id, issueNumber, err: err.message });
    }
  }

  log.info('request-specs', 'Spec posted on request', {
    appId: app.id, issueNumber, sessionId, version, format: prepared.format, by: user.username,
  });
  return {
    sessionId: Number(sessionId),
    version: Number(version),
    createdRecord,
    format: prepared.format,
    title: specTitle(prepared.markdown),
    markdownChars: prepared.markdown.length,
    htmlChars: html ? html.length : 0,
    commentPosted,
  };
}

/**
 * The specs on a request that this viewer may read, newest first: every
 * session linked to it (a person's posted spec, the Homeroom bot's, a dev
 * chat's), versions shared with the group plus the viewer's own. Metadata
 * only; the text is GET /api/sessions/:id/specs/:version.
 */
async function listRequestSpecs(pool, { appId, issueNumber, viewerId }) {
  const { rows } = await pool.query(
    `SELECT s.session_id, s.version, s.created_at, s.shared_to_group_at,
            (s.content_html IS NOT NULL) AS is_html,
            LENGTH(s.content) AS markdown_chars, COALESCE(LENGTH(s.content_html), 0) AS html_chars,
            LEFT(s.content, 400) AS head,
            cs.user_id, cs.source, cs.status, u.username
       FROM chat_session_specs s
       JOIN chat_sessions cs ON cs.id = s.session_id
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1
        AND (cs.created_from_issue_number = $2 OR $2 = ANY(cs.linked_issues))
        AND (s.shared_to_group_at IS NOT NULL OR cs.user_id = $3)
      ORDER BY s.created_at DESC, s.version DESC
      LIMIT $4`,
    [appId, issueNumber, viewerId, MAX_LISTED_SPECS]
  );
  return rows.map((r) => ({
    sessionId: Number(r.session_id),
    version: Number(r.version),
    author: r.username || null,
    authorId: r.user_id == null ? null : Number(r.user_id),
    kind: r.source === SPEC_SOURCE ? 'posted' : 'session',
    format: r.is_html ? 'html' : 'markdown',
    title: specTitle(r.head),
    markdownChars: Number(r.markdown_chars) || 0,
    htmlChars: Number(r.html_chars) || 0,
    shared: !!r.shared_to_group_at,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

module.exports = {
  SPEC_SOURCE,
  MAX_SPEC_MARKDOWN_CHARS,
  MAX_SPEC_HTML_CHARS,
  MAX_COMMENT_SPEC_CHARS,
  MAX_LISTED_SPECS,
  SpecError,
  specTitle,
  specSnippet,
  prepareSpec,
  specCard,
  specCommentText,
  postRequestSpec,
  listRequestSpecs,
};
