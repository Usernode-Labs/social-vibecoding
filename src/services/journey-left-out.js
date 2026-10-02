'use strict';

// People left out of the admin Journey page (#3369), edited by admins.
//
// One list, stored in platform_settings like the other admin switches, so it
// needs no column on accounts. Each entry names a person, a reason, a one-line
// note, who added it and when. Two reasons:
//
//   test      A test account. Left out of every Journey number; its UI
//             telemetry stays, because it costs nothing and an engineer may
//             want it.
//   objected  Somebody who asked not to be recorded. Adding them erases their
//             UI telemetry (observations and delivery receipts) in the same
//             transaction, and ui-telemetry.isRecordable() then answers false
//             for them: the shell stops sending (uiTelemetryEligible on
//             /api/auth/me) and the collector drops anything that still
//             arrives. Removing the entry starts recording again; nothing
//             erased comes back.
//
// Read through a short per-pool cache, so a change applies on every server
// within CACHE_MS without a deploy. The settings row is read and written under
// a row lock, so two admins adding at once cannot lose an entry.

const log = require('./logger');

const SETTING_KEY = 'journey_left_out';
const SETTING_DESCRIPTION = 'People left out of the admin Journey page (#3369): test accounts, '
  + 'and people who objected to being recorded (their UI telemetry is erased and no longer '
  + 'collected). Edited from Admin → Journey.';
const CACHE_MS = 10 * 1000;
const REASONS = Object.freeze(new Set(['test', 'objected']));
const NOTE_MAX = 200;
const UI_EVENT_TYPES = Object.freeze(['ui_experience', 'ui_telemetry_delivery']);

const caches = new WeakMap();

class LeftOutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseEntries(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const userId = Number(item.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0 || seen.has(userId)) continue;
    if (!REASONS.has(item.reason)) continue;
    seen.add(userId);
    entries.push({
      userId,
      reason: item.reason,
      note: typeof item.note === 'string' ? item.note.slice(0, NOTE_MAX) : '',
      addedBy: Number.isSafeInteger(Number(item.addedBy)) ? Number(item.addedBy) : null,
      addedAt: typeof item.addedAt === 'string' ? item.addedAt : null,
    });
  }
  return entries;
}

/**
 * The stored entries. Cached per pool. An unreadable list answers null and
 * is not cached, so the caller decides what an unknown list means.
 */
async function readEntries(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.entries;
  try {
    const { rows } = await pool.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [SETTING_KEY]
    );
    const entries = rows && rows[0] ? parseEntries(rows[0].value) : [];
    caches.set(pool, { at: Date.now(), entries });
    return entries;
  } catch (err) {
    log.warn('journey', 'Left-out list could not be read', { message: err.message });
    return null;
  }
}

/** Ids by reason: { test: Set, objected: Set }, or null when unreadable. */
async function idsByReason(pool) {
  const entries = await readEntries(pool);
  if (!entries) return null;
  const out = { test: new Set(), objected: new Set() };
  for (const e of entries) out[e.reason].add(e.userId);
  return out;
}

/** Every left-out id, whatever the reason; empty when unreadable. */
async function leftOutIds(pool) {
  const entries = await readEntries(pool);
  return entries ? entries.map((e) => e.userId) : [];
}

/**
 * Has this person objected? An unreadable list answers false: the telemetry
 * write that follows would fail on the same database anyway, and blocking
 * every person's telemetry on a transient read is the larger loss.
 */
async function hasObjected(pool, userId) {
  const ids = await idsByReason(pool);
  return !!ids && ids.objected.has(Number(userId));
}

/** The list for the admin screen, newest first, with usernames. */
async function list(pool) {
  const entries = await readEntries(pool);
  if (!entries) throw new LeftOutError(500, 'The list could not be read.');
  if (!entries.length) return [];
  const ids = entries.flatMap((e) => (e.addedBy != null ? [e.userId, e.addedBy] : [e.userId]));
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE id = ANY($1::int[])',
    [ids]
  );
  const names = new Map(rows.map((r) => [Number(r.id), r.username]));
  return entries
    .map((e) => ({
      userId: e.userId,
      username: names.get(e.userId) || null,
      reason: e.reason,
      note: e.note,
      addedBy: e.addedBy != null ? (names.get(e.addedBy) || null) : null,
      addedAt: e.addedAt,
    }))
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

function parseInput(body) {
  const userId = Number(body && body.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new LeftOutError(400, 'Choose a person.');
  }
  const reason = body && body.reason;
  if (!REASONS.has(reason)) throw new LeftOutError(400, 'Choose a reason: test account or objected.');
  const note = body && body.note != null ? String(body.note).trim() : '';
  if (note.length > NOTE_MAX) throw new LeftOutError(400, `Keep the note under ${NOTE_MAX} characters.`);
  return { userId, reason, note };
}

async function withLockedEntries(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO platform_settings (key, value, description) VALUES ($1, '[]', $2)
       ON CONFLICT (key) DO NOTHING`,
      [SETTING_KEY, SETTING_DESCRIPTION]
    );
    const { rows } = await client.query(
      'SELECT value FROM platform_settings WHERE key = $1 FOR UPDATE',
      [SETTING_KEY]
    );
    const entries = parseEntries(rows[0] ? rows[0].value : '[]');
    const result = await fn(client, entries);
    await client.query('COMMIT');
    caches.delete(pool);
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function save(client, entries, actorId) {
  await client.query(
    `UPDATE platform_settings SET value = $2, updated_at = NOW(), updated_by = $3
      WHERE key = $1`,
    [SETTING_KEY, JSON.stringify(entries), actorId]
  );
}

/**
 * Add or replace one person's entry as admin `actorId`. "objected" erases
 * their UI telemetry in the same transaction. Returns `{ entry, erased }`.
 */
async function add(pool, body, { actorId = null } = {}) {
  const { userId, reason, note } = parseInput(body);
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new LeftOutError(404, 'There is no such person.');
  return withLockedEntries(pool, async (client, entries) => {
    const entry = { userId, reason, note, addedBy: actorId, addedAt: new Date().toISOString() };
    const next = entries.filter((e) => e.userId !== userId).concat(entry);
    await save(client, next, actorId);
    let erased = 0;
    if (reason === 'objected') {
      const res = await client.query(
        'DELETE FROM events WHERE user_id = $1 AND event_type = ANY($2::text[])',
        [userId, UI_EVENT_TYPES]
      );
      erased = res.rowCount || 0;
    }
    return { entry, erased };
  });
}

/** Remove one person's entry. Nothing erased comes back. */
async function remove(pool, rawUserId, { actorId = null } = {}) {
  const userId = Number(rawUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new LeftOutError(400, 'Choose a person.');
  return withLockedEntries(pool, async (client, entries) => {
    const next = entries.filter((e) => e.userId !== userId);
    if (next.length === entries.length) throw new LeftOutError(404, 'That person is not on the list.');
    await save(client, next, actorId);
    return { removed: userId };
  });
}

module.exports = {
  NOTE_MAX,
  REASONS,
  SETTING_KEY,
  UI_EVENT_TYPES,
  LeftOutError,
  add,
  hasObjected,
  idsByReason,
  leftOutIds,
  list,
  parseEntries,
  remove,
};
