'use strict';

// #6305: the "file_many" card: one request on several projects, with a row
// for each and one File on all (services/homeroom-bot-cards/index.js).
//
//   { type: 'file_many', v: 1, state: 'open' | 'filing' | 'filed' | 'dropped',
//     forUserId, title, details,
//     rows: [{ named, match, slug, name, choices, done, disabled, ticked,
//              issueNumber?, error? }] }
//
// Only the person it was offered to decides it, once: File on all files every
// ticked row and nothing else (homeroom-bot-file-many.js); Not now puts the
// whole card away. A second tap, or one from another tab, files nothing more.

const log = require('../logger');

async function decide(pool, config, { user, card, action, value, message, deps = {} }) {
  if (Number(card?.forUserId) !== Number(user.id)) {
    return { ok: false, status: 403, error: 'That one is not yours to decide.' };
  }
  if (card.state && card.state !== 'open') {
    return { ok: false, status: 409, error: 'That one is already decided.' };
  }
  if (action === 'dismiss') {
    return { ok: true, state: 'dropped', patch: { state: 'dropped' } };
  }
  if (action !== 'file') return { ok: false, status: 400, error: 'Tap File on all or Not now.' };
  const picks = Array.isArray(value) ? value : [];
  if (!picks.length) return { ok: false, status: 400, error: 'Tick at least one project.' };
  // Claimed once: the first tap wins, and a retry of it finds the card filed.
  const { rows: claimed } = await pool.query(
    `UPDATE conversation_messages
        SET metadata = jsonb_set(metadata, '{homeroomBot,card,state}', '"filing"', true)
      WHERE id = $1
        AND metadata->'homeroomBot'->'card'->>'state' = 'open'
        AND metadata->'homeroomBot'->'card'->>'forUserId' = $2
      RETURNING metadata`,
    [Number(message.id), String(user.id)],
  );
  if (!claimed.length) return { ok: false, status: 409, error: 'That one is already decided.' };
  const cardNow = claimed[0]?.metadata?.homeroomBot?.card || card;
  const extras = claimed[0]?.metadata?.homeroomBot?.draftExtras || null;
  const out = await require('../homeroom-bot-file-many').fileMany(pool, config, {
    user,
    rows: cardNow.rows,
    picks,
    title: cardNow.title,
    details: cardNow.details,
    extras,
    messageId: Number(message.id),
    settings: deps.settings || null,
    deps,
  });
  if (out.ok === false) {
    // A bad pick changed nothing: put the card back open.
    await pool.query(
      `UPDATE conversation_messages
          SET metadata = jsonb_set(metadata, '{homeroomBot,card,state}', '"open"', true)
        WHERE id = $1`, [Number(message.id)],
    ).catch(() => {});
    return { ok: false, status: 400, error: 'Tick at least one project.' };
  }
  log.info('homeroom-bot-cards', 'A many-project offer was filed', {
    messageId: message.id, userId: user.id, rows: out.rows.length,
  });
  return {
    ok: true, state: 'filed', rows: out.rows,
    patch: { state: 'filed', rows: out.rows, filedAt: new Date().toISOString() },
  };
}

/** Pure: how the card reads in the model's history. */
function historyLine(card) {
  const rows = Array.isArray(card?.rows) ? card.rows : [];
  if (!rows.length) return null;
  const names = rows
    .map((r) => String(r?.name || r?.named || r?.slug || '').trim())
    .filter(Boolean).slice(0, 12);
  const filed = rows.filter((r) => r && Number.isInteger(Number(r.issueNumber)) && Number(r.issueNumber) > 0)
    .map((r) => `#${Number(r.issueNumber)}`);
  const state = card.state === 'filed'
    ? (filed.length ? `filed ${filed.join(', ')}` : 'filed, no request number came back')
    : card.state === 'dropped' ? 'the card was put away' : 'not filed yet';
  return `[Homeroom: under this reply you offered one request on ${rows.length} projects: ${names.join(', ')}; ${state}]`;
}

module.exports = { decide, historyLine };
