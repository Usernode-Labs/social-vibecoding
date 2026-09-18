'use strict';

/**
 * The Friday card (#1688): once a week, per app, one message in the app's
 * general chat saying what went live and who made it, and what is waiting
 * on votes.
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
 * The card is one system message in general chat, carrying its data as
 * metadata (`weekly`) for the transcript's card row, and a plain-text line
 * for everything that reads content. Each active member also gets a
 * `weekly_digest` notification (its own per-app category, on by default),
 * which is what reaches a phone.
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
// thirty changes a week, and a thirty-line card is a list, not a card.
const MAX_LISTED = 8;

let timer = null;

/** Friday at or after the posting hour, in UTC. */
function isPostingTime(now) {
  return now.getUTCDay() === POST_DAY_UTC && now.getUTCHours() >= POST_HOUR_UTC;
}

/** "alice", "alice and bob", "alice, bob and carol". */
function nameList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * What the card says, for one app: the changes that merged in the window
 * (newest first, with who made them and whose Yes counted) and the
 * proposals still open (oldest first — the ones waiting longest lead).
 */
async function gather(pool, app, now) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const { rows: merged } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.merged_at, u.username AS author,
            COALESCE((
              SELECT array_agg(bu.username ORDER BY pv.created_at ASC)
                FROM pr_votes pv
                JOIN users bu ON bu.id = pv.user_id
               WHERE pv.session_id = cs.id
                 AND pv.vote = 'yes'
                 AND pv.approval_epoch = cs.approval_epoch
                 AND pv.user_id IS DISTINCT FROM cs.user_id
            ), '{}') AS backers
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1
        AND cs.status = 'merged'
        AND cs.merged_at >= $2
      ORDER BY cs.merged_at DESC, cs.id DESC`,
    [app.id, since.toISOString()]
  );
  const { rows: open } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, u.username AS author
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1
        AND cs.status = 'promoted'
      ORDER BY cs.promoted_at ASC NULLS LAST, cs.created_at ASC, cs.id ASC`,
    [app.id]
  );
  const entry = (r) => ({
    id: r.id,
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    title: r.pr_title || `PR #${r.pr_number || r.id}`,
    author: r.author || '',
    backers: Array.isArray(r.backers) ? r.backers.filter(Boolean) : [],
  });
  return {
    app: app.name,
    slug: app.slug,
    since: since.toISOString(),
    merged: merged.slice(0, MAX_LISTED).map(entry),
    mergedTotal: merged.length,
    open: open.slice(0, MAX_LISTED).map((r) => ({ ...entry(r), backers: undefined })),
    openTotal: open.length,
  };
}

/** The plain-text line the message carries for readers without the card. */
function contentLine(digest) {
  const bits = [];
  if (digest.mergedTotal) {
    const listed = digest.merged.map((m) => {
      const who = m.author ? ` (${m.author}${m.backers.length ? `, backed by ${nameList(m.backers)}` : ''})` : '';
      return `${m.title}${who}`;
    });
    const more = digest.mergedTotal - digest.merged.length;
    bits.push(`${digest.mergedTotal} ${digest.mergedTotal === 1 ? 'change' : 'changes'} went live: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`);
  } else {
    bits.push('Nothing landed this week.');
  }
  if (digest.openTotal) {
    const listed = digest.open.map((o) => (o.prNumber ? `${o.title} (PR #${o.prNumber})` : o.title));
    const more = digest.openTotal - digest.open.length;
    bits.push(`${digest.openTotal === 1 ? 'One proposal is' : `${digest.openTotal} proposals are`} waiting for eyes: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`);
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

  const { sendSystemMessage } = require('./ws');
  await sendSystemMessage(pool, app.id, contentLine(digest), 'system', { weekly: digest }, null);

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
