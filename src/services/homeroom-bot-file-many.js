'use strict';

// #6305: File on all under a many-project offer. One request is filed on
// every ticked row and nothing else; an unticked row is skipped. Each row
// gets its own request, read and built on its own afterwards.
//
// A pick is "index:slug", where index is the row's place on the card and
// slug is its exact match or one of its "Did you mean ...?" choices. A pick
// that names anything else is refused and nothing files. The tap is claimed
// once by homeroom-bot-cards/file-many.js, so a second tap files nothing.

const log = require('./logger');

/** Pure: a pick as { index, slug }, or null when it is malformed. */
function parsePick(value) {
  const m = /^(\d{1,2}):([A-Za-z0-9][A-Za-z0-9_-]{0,80})$/.exec(String(value || '').trim());
  if (!m) return null;
  return { index: Number(m[1]), slug: m[2] };
}

/** Pure: the apps a row may be filed on: its match, or its choices. */
function rowSlugs(row) {
  const out = [];
  if (row && typeof row.slug === 'string' && row.slug) out.push(row.slug);
  for (const c of Array.isArray(row?.choices) ? row.choices : []) {
    if (c && typeof c.slug === 'string' && c.slug && !out.includes(c.slug)) out.push(c.slug);
  }
  return out;
}

/**
 * Pure: the picks that may file, as [{ index, slug, row }], or null when a
 * pick is bad (an index that is not a row, a row they cannot file on, or a
 * slug the row does not offer).
 */
function validPicks(rows, picks) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(picks) ? picks : []).slice(0, 12)) {
    const pick = parsePick(raw);
    if (!pick) return null;
    const row = Array.isArray(rows) ? rows[pick.index] : null;
    if (!row || row.disabled) return null;
    if (!rowSlugs(row).includes(pick.slug)) return null;
    const key = `${pick.index}:${pick.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...pick, row });
  }
  return out.length ? out : null;
}

/**
 * File every picked row. Resolves the card's rows with each filed request's
 * number, or why it was not filed. One row's failure never stops the others.
 */
async function fileMany(pool, config, {
  user, rows, picks, title, details, extras = null, messageId = null, fileKeyPrefix = null, settings = null, deps = {},
}) {
  const mayor = require('./homeroom-bot-mayor');
  const out = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
  const valid = validPicks(out, picks);
  if (!valid) return { ok: false, rows: out };
  // Sequential: each filing touches GitHub and the request's own records,
  // and the row order on the card is the order they named.
  for (const { index, slug, row } of valid) {
    const app = await mayor.findApp(pool, slug);
    if (!app) {
      out[index] = { ...row, error: 'failed' };
      continue;
    }
    if (!(await mayor.canFile(pool, app, user))) {
      out[index] = { ...row, error: 'not_member' };
      continue;
    }
    const keyOf = fileKeyPrefix || (messageId ? `file-many:${messageId}` : null);
    const fileKey = keyOf ? `${keyOf}:${app.id}` : null;
    let actionId = null;
    try {
      // One record per filed request, so a retry after a restart finds the
      // same fileKey and makes no second request (fileRequest reads it).
      const { rows: [action] } = await pool.query(
        `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title, details, status)
         VALUES ($1, $2, $3, 'file_request', $4, $5, 'open') RETURNING id`,
        [user.id, null, app.id, title, details || null],
      );
      actionId = action?.id || null;
      const filed = await mayor.fileRequest(pool, config, {
        user, app, title, details, settings: settings || await require('./homeroom-bot').readSettings(pool),
        deps, askedText: details || title, fileKey,
        // The draft's shared extras (pictures, Done when, where) go with
        // every row; the related list is per project, so it is left out.
        extras: extras ? { ...extras, related: [], project: app.name || app.slug } : null,
      });
      if (actionId) {
        await pool.query(
          `UPDATE homeroom_bot_dm_actions SET status = 'done', issue_number = $2, decided_at = NOW() WHERE id = $1`,
          [actionId, filed.issueNumber],
        );
      }
      out[index] = { ...row, slug: app.slug, name: app.name || app.slug, issueNumber: Number(filed.issueNumber), error: null };
      log.info('homeroom-bot-file-many', 'Filed one row of a many-project offer', {
        project: app.slug, issueNumber: filed.issueNumber, userId: user.id,
      });
    } catch (err) {
      log.warn('homeroom-bot-file-many', 'Could not file one row of a many-project offer', {
        project: app.slug, userId: user.id, err: err.message,
      });
      if (actionId) {
        await pool.query(
          `UPDATE homeroom_bot_dm_actions SET status = 'failed', error = $2 WHERE id = $1`,
          [actionId, String(err.message || 'failed').slice(0, 300)],
        ).catch(() => {});
      }
      out[index] = { ...row, error: 'failed' };
    }
  }
  return { ok: true, rows: out };
}

module.exports = { fileMany, parsePick, validPicks, rowSlugs };
