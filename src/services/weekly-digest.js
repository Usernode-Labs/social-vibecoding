'use strict';

/**
 * The Friday card (#1688): once a week, per app, one card saying what went
 * live and what is waiting on votes. It was a message in the app's general
 * chat; it is shown on the project's Workshop now.
 *
 * ── Why a card, and why every week ─────────────────────────────────────
 *
 * A merge announces itself the moment it lands, to whoever is looking. The
 * request behind this asked for a RHYTHM rather than a moment: the ritual
 * literature it cites finds that a repeated, plain, low-effort marker builds
 * cohesion where a one-off celebration does nothing. So the card is
 * deliberately repetitive — the same shape every Friday — and deliberately
 * quiet: a week with nothing merged and nothing open gets no card at all,
 * because an empty ritual is worse than none.
 *
 * ── Shape ──────────────────────────────────────────────────────────────
 *
 * The sweep runs HOURLY (services/vote-digest.js's shape: one interval on
 * every instance, an advisory lock so only one of them posts) and does
 * nothing until Friday at POST_HOUR_UTC. The platform stores no timezone
 * for an app or a person, so a fixed UTC hour is chosen to be daytime in
 * the most places: mid-afternoon in Europe, morning in the Americas.
 *
 * An app is due when its last card is more than six days old. The claim is
 * the UPDATE of apps.weekly_digest_at itself, guarded on that age, so two
 * instances that both find an app due can only stamp it once.
 *
 * The card is one `weekly_digest` event carrying its data as metadata, and
 * contentLine is its plain-text sentence. Each active member also gets a
 * `weekly_digest` notification (its own per-app category, on by default),
 * which is what reaches a phone.
 *
 * The card names CHANGES, never people (#3678). It used to credit each
 * change's author and everyone whose Yes carried it, which on a busy
 * project made one sentence a roll of usernames, and a card about the
 * project is not the place to say who voted. Neither is gathered now.
 *
 * A channel carries no activity now (ws.sendSystemMessage writes no line
 * without a thread), so the card is recorded as a `weekly_digest` event
 * instead, and a project's Workshop shows it for a few days after it is
 * made (services/app-notices.js), beside the notification.
 */

const log = require('./logger');
const { WEEKLY_DIGEST_LOCK } = require('./advisory-locks');

const INTERVAL_MS = 60 * 60 * 1000;      // sweep hourly
const FIRST_SWEEP_DELAY_MS = 7 * 60_000; // let boot settle first
const POST_DAY_UTC = 5;                  // Friday
const POST_HOUR_UTC = 15;                // from 15:00 UTC
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * DAY_MS;            // "this week" is the last seven days
const MIN_GAP_DAYS = 6;                  // never two cards in one week
// The card lists a handful and counts the rest: a busy platform app merges
// hundreds of changes a week, and the card is one sentence on the Workshop,
// not a changelog. Three of each (#3678): the newest that went live, the
// longest waiting. It was eight, each with its people, and read as a wall.
const MAX_LISTED = 3;

let timer = null;

/** Friday at or after the posting hour, in UTC. */
function isPostingTime(now) {
  return now.getUTCDay() === POST_DAY_UTC && now.getUTCHours() >= POST_HOUR_UTC;
}

/**
 * What the card says, for one app: the changes that merged in the window
 * (newest first) and the proposals still open (oldest first — the ones
 * waiting longest lead). Titles and numbers only: the card names nobody.
 */
async function gather(pool, app, now) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const { rows: merged } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.merged_at
       FROM chat_sessions cs
      WHERE cs.app_id = $1
        AND cs.status = 'merged' AND cs.live_at IS NOT NULL
        AND cs.merged_at >= $2
      ORDER BY cs.merged_at DESC, cs.id DESC`,
    [app.id, since.toISOString()]
  );
  const { rows: open } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title
       FROM chat_sessions cs
      WHERE cs.app_id = $1
        AND cs.status = 'promoted'
      ORDER BY cs.promoted_at ASC NULLS LAST, cs.created_at ASC, cs.id ASC`,
    [app.id]
  );
  const entry = (r) => ({
    id: r.id,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    title: r.pr_title || `PR #${r.pr_number || r.id}`,
  });
  return {
    app: app.name,
    slug: app.slug,
    since: since.toISOString(),
    merged: merged.slice(0, MAX_LISTED).map(entry),
    mergedTotal: merged.length,
    open: open.slice(0, MAX_LISTED).map(entry),
    openTotal: open.length,
  };
}

/**
 * "<a>; <b>; <c>; and N more": at most MAX_LISTED of `items`, counting the
 * rest of `total`. The card is drawn from the record (app-notices.js), and a
 * card stored before #3678 carries eight, so they are cut to the same few
 * here rather than only where a new card is gathered.
 */
function listLine(items, total, label) {
  const shown = (Array.isArray(items) ? items : []).slice(0, MAX_LISTED).map(label);
  const more = total - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

/**
 * The card as one plain sentence. Titles only: never who made a change or
 * who voted for it, even from a card stored while it still carried them.
 */
function contentLine(digest) {
  const bits = [];
  if (digest.mergedTotal) {
    const listed = listLine(digest.merged, digest.mergedTotal, (m) => m.title);
    bits.push(`${digest.mergedTotal} ${digest.mergedTotal === 1 ? 'change' : 'changes'} went live: ${listed}.`);
  } else {
    bits.push('Nothing landed this week.');
  }
  if (digest.openTotal) {
    const listed = listLine(digest.open, digest.openTotal, (o) => (o.prNumber ? `${o.title} (PR #${o.prNumber})` : o.title));
    bits.push(`${digest.openTotal === 1 ? 'One proposal is' : `${digest.openTotal} proposals are`} waiting for eyes: ${listed}.`);
  }
  return `This week on ${digest.app}: ${bits.join(' ')}`;
}

/**
 * Post one app's card, if it is still due. Returns what happened, so a test
 * can drive it directly: `posted`, `claimed` (false when another instance
 * stamped the app first), and how many notifications went out.
 */
async function post(pool, app, digest, now) {
  const { rows: claimed } = await pool.query(
    `UPDATE apps
        SET weekly_digest_at = $2
      WHERE id = $1
        AND (weekly_digest_at IS NULL OR weekly_digest_at < $2::timestamptz - ($3 || ' days')::interval)
      RETURNING id`,
    [app.id, now.toISOString(), String(MIN_GAP_DAYS)]
  );
  if (!claimed.length) return { posted: false, claimed: false, notified: 0 };

  // The card itself: a project's Workshop shows it for a few days
  // (services/app-notices.js), since a channel carries no activity.
  const events = require('./events');
  await events.record(pool, { type: events.EVENT_TYPES.WEEKLY_DIGEST, appId: app.id, metadata: digest });

  let notified = 0;
  try {
    const activeUsers = require('./active-users');
    const notificationPreferences = require('./notification-preferences');
    const notifications = require('./notifications');
    const memberIds = await activeUsers.listActiveUserIds(pool, app.id);
    const allowed = await notificationPreferences.filterUsersByCategory(pool, {
      userIds: memberIds, appId: app.id, categoryKey: 'weekly_digest',
    });
    const detail = `${digest.mergedTotal}:${digest.openTotal}`;
    for (const userId of allowed) {
      const { rows: created } = await pool.query(
        `INSERT INTO notifications (user_id, app_id, source_user_id, kind, detail)
         SELECT $1, $2, NULL, 'weekly_digest', $3
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications n
             WHERE n.user_id = $1 AND n.app_id = $2 AND n.kind = 'weekly_digest'
               AND n.created_at > $4::timestamptz - ($5 || ' days')::interval
          )
         RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
        [userId, app.id, detail, now.toISOString(), String(MIN_GAP_DAYS)]
      );
      if (created[0]) {
        notified += 1;
        await notifications.hydrateAndPush(pool, created[0]);
      }
    }
  } catch (err) {
    // The card is in the chat; a notification that fails to send is not a
    // reason to take it down or to try the whole app again next hour.
    log.warn('weekly-digest', 'Notifications failed (card posted)', { appId: app.id, err: err.message });
  }
  return { posted: true, claimed: true, notified };
}

/**
 * One sweep. `now` is injectable so a test can make it Friday.
 */
async function sweep(pool, now = new Date()) {
  const result = { due: 0, posted: 0, quiet: 0, notified: 0, busy: false, skipped: false };
  if (!isPostingTime(now)) {
    result.skipped = true;
    return result;
  }
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [WEEKLY_DIGEST_LOCK, 0]
    );
    if (lock.rows[0]?.acquired !== true) {
      result.busy = true;
      return result;
    }
    locked = true;

    const { rows: apps } = await client.query(
      `SELECT id, slug, name
         FROM apps
        WHERE weekly_digest_at IS NULL
           OR weekly_digest_at < $1::timestamptz - ($2 || ' days')::interval
        ORDER BY id ASC`,
      [now.toISOString(), String(MIN_GAP_DAYS)]
    );
    result.due = apps.length;
    for (const app of apps) {
      try {
        const digest = await gather(pool, app, now);
        if (!digest.mergedTotal && !digest.openTotal) {
          result.quiet += 1;
          continue;
        }
        const outcome = await post(pool, app, digest, now);
        if (outcome.posted) {
          result.posted += 1;
          result.notified += outcome.notified;
        }
      } catch (err) {
        // One app's card failing must not end the sweep for the apps
        // behind it in the list.
        log.warn('weekly-digest', 'Card failed', { appId: app.id, err: err.message });
      }
    }
    return result;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [WEEKLY_DIGEST_LOCK, 0])
        .catch(() => {});
    }
    client.release();
  }
}

function start(config) {
  if (timer) return;
  const { getPool } = require('../db/pool');
  const run = async () => {
    try {
      const result = await sweep(getPool(config));
      if (result.posted) log.info('weekly-digest', 'Cards posted', result);
    } catch (err) {
      log.error('weekly-digest', 'Sweep failed', { err: err.message });
    }
  };
  setTimeout(run, FIRST_SWEEP_DELAY_MS);
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
  gather,
  post,
  contentLine,
  isPostingTime,
  INTERVAL_MS,
  POST_DAY_UTC,
  POST_HOUR_UTC,
  WINDOW_MS,
  MIN_GAP_DAYS,
  MAX_LISTED,
};
