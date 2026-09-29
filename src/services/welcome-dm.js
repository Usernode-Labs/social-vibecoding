'use strict';

/**
 * Welcome messages: somebody let in gets a group conversation with the
 * people an admin chose, opened by a message from the first of them.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 *
 * The moment is a trigger, not a call site. A person is let in by an admin
 * release, an activation code, a wallet, a released email signup or the
 * invite tree, and every one of those flips users.has_platform_access; the
 * `users_enqueue_welcome_dm` trigger in schema.sql writes a welcome_dm_queue
 * row on that false → true edge, while the switch is on. So a path added
 * later is covered without anybody remembering this file.
 *
 * The leader's sweep (server.js becomeLeader) turns each row into:
 *   1. the group — everyone a `member` from the start, because an invited
 *      member sees no messages until they accept, and a welcome nobody can
 *      read until they say yes to it is not a welcome. The group's id is
 *      recorded on the row in the same commit, under the row's lock, so a
 *      retry never opens a second one;
 *   2. the message, sent as the first configured person through
 *      conversations.sendMessage with an idempotency key per person, so a
 *      retry after a crash between the two posts nothing twice;
 *   3. the same live fan-out a message sent from the app gets: the bell,
 *      the Messages list and a phone (the notification row's own trigger
 *      queues the push).
 *
 * A row waits while its person has not chosen a username yet (an email
 * signup starts on a placeholder), so the title and the @mention name the
 * person as everyone will know them. A row older than MAX_AGE_DAYS is let
 * go instead of greeting somebody weeks late.
 *
 * ── Who ─────────────────────────────────────────────────────────────────
 *
 * Stored as user ids, not handles: a rename retires the old handle, and a
 * setting that followed the handle would quietly stop matching. Anyone
 * configured who has since lost platform access, been deleted, or is
 * blocked either way by the new person is left out of that one group; with
 * nobody left, the row is skipped rather than sent from nobody.
 */

const log = require('./logger');
const conversations = require('./conversations');

const KEY_ENABLED = 'welcome_dm_enabled';
const KEY_MEMBERS = 'welcome_dm_members';
const KEY_TITLE = 'welcome_dm_title';
const KEY_MESSAGE = 'welcome_dm_message';
const SETTING_KEYS = Object.freeze([KEY_ENABLED, KEY_MEMBERS, KEY_TITLE, KEY_MESSAGE]);

const DEFAULT_TITLE = 'Welcome to Homeroom, {username}';
const DEFAULT_MESSAGE = 'Hi @{username}, welcome to Homeroom! This is a small group with a couple '
  + 'of the people who run the platform. Ask us anything here: questions, ideas, or anything '
  + 'that feels broken.';
const DEFAULTS = Object.freeze({
  enabled: false,
  memberIds: Object.freeze([]),
  title: DEFAULT_TITLE,
  message: DEFAULT_MESSAGE,
});

// Room for the placeholder's expansion inside the conversation's own
// limits (80 for a title, conversations.MAX_MESSAGE_LENGTH for a message).
const MAX_TITLE_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_MEMBERS = 10;
const MAX_ATTEMPTS = 3;
const MAX_AGE_DAYS = 14;
const BATCH_SIZE = 25;
const RECENT_LIMIT = 20;

const INTERVAL_MS = 30_000;
const FIRST_SWEEP_DELAY_MS = 20_000;

let timer = null;
let running = false;

function parseMemberIds(raw) {
  try {
    const parsed = JSON.parse(raw);
    return conversations.strictIds(parsed, { max: MAX_MEMBERS }) || [];
  } catch {
    return [];
  }
}

function parseSettings(rows) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const value = (key) => byKey.get(key)?.value;
  let updatedAt = null;
  let updatedBy = null;
  for (const row of rows) {
    if (row.updated_at && (!updatedAt || new Date(row.updated_at) > new Date(updatedAt))) {
      updatedAt = row.updated_at;
      updatedBy = row.updated_by_username || null;
    }
  }
  return {
    enabled: value(KEY_ENABLED) === 'on',
    memberIds: value(KEY_MEMBERS) != null ? parseMemberIds(value(KEY_MEMBERS)) : [...DEFAULTS.memberIds],
    title: value(KEY_TITLE) || DEFAULTS.title,
    message: value(KEY_MESSAGE) || DEFAULTS.message,
    updatedAt,
    updatedBy,
  };
}

async function readSettings(pool) {
  const { rows } = await pool.query(
    `SELECT ps.key, ps.value, ps.updated_at, u.username AS updated_by_username
       FROM platform_settings ps
       LEFT JOIN users u ON u.id = ps.updated_by
      WHERE ps.key = ANY($1)`,
    [SETTING_KEYS]
  );
  return parseSettings(rows);
}

/** `{username}` in a title or message becomes the new person's username. */
function render(template, { username }) {
  return String(template).split('{username}').join(username);
}

/** The group's title, kept inside the conversation's 80 characters. */
function renderTitle(template, person) {
  const title = render(template, person).trim().replace(/\s+/g, ' ');
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function normalizeHandle(raw) {
  if (typeof raw !== 'string') return null;
  const handle = raw.trim().replace(/^@/, '');
  return handle && handle.length <= 255 ? handle : null;
}

/**
 * Validate an admin's patch. `members` arrives as handles, in order (the
 * first sends the message); they are resolved to ids against live accounts
 * that can use the platform, so a typo is refused rather than saved.
 * Returns { ok: false, error } or { ok: true, updates: [[key, value], …] }.
 */
async function validatePatch(pool, patch) {
  const body = patch && typeof patch === 'object' ? patch : {};
  const updates = [];
  let memberIds = null;
  if (body.members !== undefined) {
    if (!Array.isArray(body.members) || body.members.length > MAX_MEMBERS) {
      return { ok: false, error: `members must be a list of up to ${MAX_MEMBERS} usernames` };
    }
    const handles = [];
    for (const raw of body.members) {
      const handle = normalizeHandle(raw);
      if (!handle) return { ok: false, error: 'members must be a list of usernames' };
      if (!handles.some((h) => h.toLowerCase() === handle.toLowerCase())) handles.push(handle);
    }
    const { rows } = handles.length ? await pool.query(
      `SELECT id, username FROM users
        WHERE LOWER(username) = ANY($1::text[])
          AND has_platform_access AND anonymised_at IS NULL AND NOT is_synthetic`,
      [handles.map((h) => h.toLowerCase())]
    ) : { rows: [] };
    const byLower = new Map(rows.map((row) => [row.username.toLowerCase(), row.id]));
    memberIds = [];
    for (const handle of handles) {
      const id = byLower.get(handle.toLowerCase());
      if (!id) return { ok: false, error: `No account named @${handle} that can use the platform` };
      memberIds.push(id);
    }
    updates.push([KEY_MEMBERS, JSON.stringify(memberIds)]);
  }
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > MAX_TITLE_LENGTH) {
      return { ok: false, error: `The title must be 1 to ${MAX_TITLE_LENGTH} characters` };
    }
    updates.push([KEY_TITLE, title]);
  }
  if (body.message !== undefined) {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `The message must be 1 to ${MAX_MESSAGE_LENGTH} characters` };
    }
    updates.push([KEY_MESSAGE, message]);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    if (body.enabled) {
      const effective = memberIds ?? (await readSettings(pool)).memberIds;
      if (!effective.length) {
        return { ok: false, error: 'Add at least one person to send the message before switching it on' };
      }
    }
    updates.push([KEY_ENABLED, body.enabled ? 'on' : 'off']);
  }
  if (!updates.length) return { ok: false, error: 'Nothing to update' };
  return { ok: true, updates };
}

async function writeSettings(pool, patch, actorId) {
  const valid = await validatePatch(pool, patch);
  if (!valid.ok) return valid;
  for (const [key, value] of valid.updates) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, value, actorId || null]
    );
  }
  return { ok: true };
}

/** What #admin/welcome-dm shows: the settings, and who was welcomed lately. */
async function adminPayload(pool) {
  const settings = await readSettings(pool);
  const { rows: people } = settings.memberIds.length ? await pool.query(
    `SELECT id, username, has_platform_access, anonymised_at IS NOT NULL AS deleted
       FROM users WHERE id = ANY($1::int[])`,
    [settings.memberIds]
  ) : { rows: [] };
  const byId = new Map(people.map((row) => [row.id, row]));
  const members = settings.memberIds.map((id) => {
    const row = byId.get(id);
    return {
      id,
      username: row ? row.username : null,
      active: !!row && row.has_platform_access && !row.deleted,
    };
  });
  const { rows: recent } = await pool.query(
    `SELECT q.user_id, u.username, q.status, q.enqueued_at, q.processed_at,
            q.conversation_id, q.detail, q.attempts, u.needs_username_choice
       FROM welcome_dm_queue q
       JOIN users u ON u.id = q.user_id
      ORDER BY q.enqueued_at DESC, q.user_id DESC
      LIMIT $1`,
    [RECENT_LIMIT]
  );
  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'sent')::int AS sent
       FROM welcome_dm_queue`
  );
  return {
    enabled: settings.enabled,
    members,
    title: settings.title,
    message: settings.message,
    defaults: { title: DEFAULT_TITLE, message: DEFAULT_MESSAGE },
    limits: { title: MAX_TITLE_LENGTH, message: MAX_MESSAGE_LENGTH, members: MAX_MEMBERS },
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    pending: counts.pending,
    sent: counts.sent,
    recent: recent.map((row) => ({
      userId: row.user_id,
      username: row.username,
      status: row.status,
      enqueuedAt: row.enqueued_at,
      processedAt: row.processed_at,
      conversationId: row.conversation_id,
      detail: row.detail,
      attempts: row.attempts,
      waitingForUsername: row.status === 'pending' && row.needs_username_choice === true,
    })),
  };
}

async function finish(pool, userId, status, detail = null) {
  await pool.query(
    `UPDATE welcome_dm_queue
        SET status = $2, detail = $3, processed_at = NOW()
      WHERE user_id = $1 AND status = 'pending'`,
    [userId, status, detail]
  );
}

/**
 * Step 1: lock the row and, the first time, open the group. Returns
 * { conversationId, senderId } to post into, or { done: status, detail }
 * when the row is finished without a message, or null when another sweep
 * holds the row or it is no longer pending.
 */
async function openGroup(pool, userId, settings) {
  return conversations.transaction(pool, async (db) => {
    const { rows: [row] } = await db.query(
      `SELECT q.conversation_id, q.attempts,
              q.enqueued_at < NOW() - make_interval(days => $2) AS expired,
              u.username, u.has_platform_access, u.anonymised_at IS NOT NULL AS deleted
         FROM welcome_dm_queue q
         JOIN users u ON u.id = q.user_id
        WHERE q.user_id = $1 AND q.status = 'pending'
          FOR UPDATE OF q SKIP LOCKED`,
      [userId, MAX_AGE_DAYS]
    );
    if (!row) return null;
    if (row.expired) return { done: 'skipped', detail: 'expired' };
    if (!row.has_platform_access || row.deleted) return { done: 'skipped', detail: 'left' };
    await db.query(
      'UPDATE welcome_dm_queue SET attempts = attempts + 1 WHERE user_id = $1', [userId]
    );
    if (row.conversation_id) {
      const { rows: [owner] } = await db.query(
        `SELECT user_id FROM conversation_members
          WHERE conversation_id = $1 AND role = 'owner' AND status = 'member'`,
        [row.conversation_id]
      );
      if (!owner) return { done: 'skipped', detail: 'group_closed' };
      return { conversationId: row.conversation_id, senderId: owner.user_id, username: row.username };
    }
    const configured = settings.memberIds.filter((id) => id !== userId);
    const { rows: eligible } = configured.length ? await db.query(
      `SELECT u.id FROM users u
        WHERE u.id = ANY($1::int[])
          AND u.has_platform_access AND u.anonymised_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_blocks b
                           WHERE (b.blocker_id = u.id AND b.blocked_user_id = $2)
                              OR (b.blocker_id = $2 AND b.blocked_user_id = u.id))`,
      [configured, userId]
    ) : { rows: [] };
    const eligibleIds = new Set(eligible.map((r) => r.id));
    const staff = configured.filter((id) => eligibleIds.has(id));
    if (!staff.length) return { done: 'skipped', detail: 'no_one_to_send' };
    const title = renderTitle(settings.title, { username: row.username });
    const group = await conversations.createAdmittedGroup(db, staff[0], title, [...staff, userId]);
    if (!group) return { done: 'failed', detail: 'group_refused' };
    await db.query(
      'UPDATE welcome_dm_queue SET conversation_id = $2 WHERE user_id = $1',
      [userId, group.conversationId]
    );
    return { conversationId: group.conversationId, senderId: staff[0], username: row.username };
  });
}

// What routes/conversations.js does after a create and a send, done here
// because the service itself pushes nothing.
async function pushLive(pool, result, conversationId) {
  const ws = require('./ws');
  const notificationSvc = require('./notifications');
  for (const row of result.notifications || []) await notificationSvc.hydrateAndPush(pool, row);
  ws.pushConversationEvent(result.memberIds, { type: 'conversation_membership_changed', conversationId });
  ws.pushConversationEvent(result.memberIds, {
    type: 'conversation_message_created',
    conversationId,
    messageId: result.message?.id ?? result.messageId,
    threadRootId: null,
  });
}

/**
 * Welcome one queued person. Returns the row's outcome: 'sent', 'skipped',
 * 'failed', 'retry' (left pending for the next sweep) or null (not ours).
 */
async function processOne(pool, userId, settings) {
  const step = await openGroup(pool, userId, settings);
  if (!step) return null;
  if (step.done) {
    await finish(pool, userId, step.done, step.detail);
    return step.done;
  }
  let result = null;
  let error = null;
  try {
    result = await conversations.sendMessage(pool, { id: step.senderId }, step.conversationId, {
      content: render(settings.message, { username: step.username }),
      idempotency_key: `welcome-dm:${userId}`,
    });
    if (!result) error = 'send_refused';
    else if (result.error) error = result.error;
  } catch (err) {
    error = err.message;
  }
  if (error) {
    const { rows: [row] } = await pool.query(
      'SELECT attempts FROM welcome_dm_queue WHERE user_id = $1', [userId]
    );
    if (!row || row.attempts >= MAX_ATTEMPTS) {
      await finish(pool, userId, 'failed', String(error).slice(0, 200));
      return 'failed';
    }
    await pool.query('UPDATE welcome_dm_queue SET detail = $2 WHERE user_id = $1', [userId, String(error).slice(0, 200)]);
    return 'retry';
  }
  await finish(pool, userId, 'sent');
  if (!result.duplicate) {
    try {
      await pushLive(pool, result, step.conversationId);
    } catch (err) {
      // The message is in and the bell row is written (a phone push rides
      // on its trigger); a missed live refresh catches up on the next load.
      log.warn('welcome-dm', 'Live fan-out failed', { userId, err: err.message });
    }
  }
  return 'sent';
}

/** One pass over the queue. Does nothing while the switch is off. */
async function sweep(pool) {
  const result = { sent: 0, skipped: 0, failed: 0, retry: 0 };
  const settings = await readSettings(pool);
  if (!settings.enabled) return { ...result, off: true };
  // A person still on a placeholder username waits: the title and the
  // @mention should name them as everyone will know them.
  const { rows } = await pool.query(
    `SELECT q.user_id
       FROM welcome_dm_queue q
       JOIN users u ON u.id = q.user_id
      WHERE q.status = 'pending'
        AND (u.needs_username_choice IS NOT TRUE
             OR q.enqueued_at < NOW() - make_interval(days => $2))
      ORDER BY q.enqueued_at, q.user_id
      LIMIT $1`,
    [BATCH_SIZE, MAX_AGE_DAYS]
  );
  for (const { user_id: userId } of rows) {
    try {
      const outcome = await processOne(pool, userId, settings);
      if (outcome) result[outcome] += 1;
    } catch (err) {
      // One person's welcome failing must not hold up the people behind
      // them; the row stays pending for the next pass.
      result.retry += 1;
      log.warn('welcome-dm', 'Welcome failed', { userId, err: err.message });
    }
  }
  return result;
}

function start(config) {
  if (timer) return;
  const { getPool } = require('../db/pool');
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweep(getPool(config));
      if (result.sent || result.failed) log.info('welcome-dm', 'Welcome messages sent', result);
    } catch (err) {
      log.error('welcome-dm', 'Sweep failed', { err: err.message });
    } finally {
      running = false;
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS).unref?.();
  timer = setInterval(run, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  sweep,
  processOne,
  readSettings,
  validatePatch,
  writeSettings,
  adminPayload,
  render,
  renderTitle,
  SETTING_KEYS,
  DEFAULT_TITLE,
  DEFAULT_MESSAGE,
  MAX_ATTEMPTS,
  MAX_AGE_DAYS,
  MAX_MEMBERS,
  INTERVAL_MS,
};
