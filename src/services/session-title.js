'use strict';

// #249: meaningful default session names — the display-name layer over
// machine-generated branch names. Sessions are titled:
//   1. From their first interactive message (maybeTitleFirstMessage).
//   2. At pre-PR turn ends, from the full request history + latest
//      spec draft (refreshFromHistory) so the name sharpens as the
//      session's focus develops.
//   3. Once a PR exists, applyPrMetadata (pr-metadata.js) mirrors
//      pr_title into session_title and owns the name from then on —
//      every UPDATE here is guarded on `pr_number IS NULL` so a slow
//      in-flight early-title call can never clobber a PR-mirrored one.
//   4. Headless auto sessions get the deterministic, LLM-free
//      "#N · issue title" at creation (headlessTitle), inherited by
//      clones.
//
// Every entry point is fire-and-forget: the returned promise ALWAYS
// resolves (with the new title, or null on failure/skip) and never
// rejects, so callers can ignore it without risking an unhandled
// rejection — title generation must never fail or block a turn.

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');

// Deterministic headless display name: "#N · <issue title>", truncated
// to fit the VARCHAR(256) column. Returns null when the issue fetch
// degraded to number-only (no title to show — the branch-name fallback
// is better than a bare "#N · ").
function headlessTitle(issueNumber, issueTitle) {
  const n = parseInt(issueNumber, 10);
  const t = String(issueTitle || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(n) || n <= 0 || !t) return null;
  return `#${n} · ${t}`.slice(0, 256);
}

// Token-optimization (#): deterministic, LLM-free title from the user's
// first message. Titling never needed a model call — a session name is a
// short label, not a reasoning task. Take the first non-empty line, strip
// markdown/URLs/code, collapse whitespace, cut to a word boundary near the
// column cap, drop trailing punctuation, and upper-case the first letter.
// Returns '' when nothing usable is left (caller falls back to no title).
function deriveFromRequest(firstMessage, { maxChars = 60 } = {}) {
  let s = String(firstMessage || '');
  // First non-empty line — opening asks lead with the request.
  const firstLine = s.split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = firstLine
    .replace(/`+/g, '')                       // inline code fences
    .replace(/https?:\/\/\S+/g, '')           // URLs
    .replace(/[*_#>~]+/g, ' ')                // markdown emphasis/heading marks
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  // Prefer the first sentence when it's a reasonable length.
  const sentenceEnd = s.search(/[.!?](\s|$)/);
  if (sentenceEnd > 12 && sentenceEnd <= maxChars) s = s.slice(0, sentenceEnd);
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const bound = cut.lastIndexOf(' ');
    s = (bound > maxChars * 0.5 ? cut.slice(0, bound) : cut).trim();
  }
  s = s.replace(/[\s.,;:!?-]+$/, '').trim();
  if (!s) return '';
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 256);
}

// Core generate → debit → persist → broadcast path. `send` is the
// chat turn's event emitter (SSE + global WS + session bus), so open
// session lists update live via the `session_titled` event.
function generateAndApply({ pool, session, requests, specs, issueTitle, userId, apiKey, send }) {
  return (async () => {
    const meta = await llm.generateSessionTitle({ requests, specs, issueTitle, apiKey });

    // Debit the Haiku call to the requesting user — BYOK bucket when
    // their own key paid for it, same as the PR-metadata call.
    if (meta.usage && userId != null && pool) {
      const costCents = llm.estimateCostCents(meta.usage, meta.model);
      await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
    }

    // pr_number IS NULL guard: once applyPrMetadata mirrored a PR title
    // in, a slower in-flight early-title call must lose the race.
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions SET session_title = $1 WHERE id = $2 AND pr_number IS NULL`,
      [meta.title, session.id]
    );
    if (!rowCount) return null;
    session.session_title = meta.title;
    if (send) send('session_titled', { sessionTitle: meta.title });
    return meta.title;
  })().catch((err) => {
    log.warn('session-title', 'Title generation failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 1 — first interactive message: only a brand-new session (no
// title yet, no PR) gets named from its opening ask. Existing untitled
// sessions also land here on their next message, which is the
// backfill story for pre-#249 rows.
function maybeTitleFirstMessage({ pool, session, message, userId, apiKey, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  // Token-optimization (#): derive the title deterministically instead of
  // spending a Haiku call. No debit, no round-trip. pr_number guard still
  // applies so a PR-mirrored title can't be clobbered.
  const title = deriveFromRequest(message);
  if (!title) return Promise.resolve(null);
  return (async () => {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions SET session_title = $1 WHERE id = $2 AND pr_number IS NULL AND session_title IS NULL`,
      [title, session.id]
    );
    if (!rowCount) return null;
    session.session_title = title;
    if (send) send('session_titled', { sessionTitle: title });
    return title;
  })().catch((err) => {
    log.warn('session-title', 'Deterministic first-message title failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 2 — pre-PR turn-end refresh: re-title from everything known so
// far (every user message plus the live spec draft). Callers gate on
// "no PR yet" and "didn't already title this turn"; the UPDATE guard
// above covers the race where a PR landed mid-generation.
function refreshFromHistory({ pool, session, userId, apiKey, send }) {
  return (async () => {
    const { rows: reqRows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC`,
      [session.id]
    );
    const { rows: csRows } = await pool.query(
      `SELECT spec_md FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const specMd = ((csRows[0] && csRows[0].spec_md) || '').trim();
    return generateAndApply({
      pool, session,
      requests: reqRows.map((r) => r.content).filter(Boolean),
      specs: specMd ? [specMd] : [],
      userId, apiKey, send,
    });
  })().catch((err) => {
    log.warn('session-title', 'Turn-end title refresh failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

module.exports = { headlessTitle, deriveFromRequest, generateAndApply, maybeTitleFirstMessage, refreshFromHistory };
