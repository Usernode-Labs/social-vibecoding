'use strict';

// WP-E: what an invite link brings back to the person who made it.
//
//   invite_opened   Somebody opened the link (a count of people; never a
//                   name: most are signed out, and nobody agreed to be
//                   named for looking).
//   member_joined   A signed-in person joined through it.
//   first_message   Somebody who joined through it wrote in the project's
//                   chat for the first time ("said hi").
//
// Only the link's maker hears, and only about people who came by THEIR
// link; the invite page tells a visitor that the maker sees when they join
// (features/auth/invite-card.tsx). Time spent is never said.
//
// One push per kind, per project, per day: the first moment inserts a
// notification (which is what rings, schema.sql
// enqueue_mobile_push_deliveries is AFTER INSERT); the rest of that day's
// moments fold into it, as a count in `detail`, newest person first, and
// bring it back unread without ringing again. The bell words the count
// ("Sam and 2 others joined"), the push only ever the first.
//
// AN OPEN COUNTS A PERSON ONCE (5 October: one person opening a link four
// times read "4 people opened your invite"), AND ONLY ONCE THEY ARE SOMEBODY
// (7 October: looking at a link page is not news on its own). Who opened is
// remembered per maker and project (community_invite_opens): an account when
// they were signed in, on any device, else the browser, by a random HttpOnly
// cookie kept only as its hash. An open made signed out is remembered but
// not told: its row waits without a notice, and the maker hears "Someone
// opened your invite" only when that browser signs in (noteSignedIn) or
// opens the link signed in. If the visitor never signs in, the maker never
// hears about the click. Opening again changes nothing: no count, no
// unread, no push. And an open is only news until the person joins: their
// join through the maker's link takes them off the open notice (the notice
// goes when nobody is left on it), and "Joined through your invite" says it
// instead. A person who opens signed out in two browsers is still two until
// one of them signs in or joins: nothing can tell them apart before then.
//
// Everything here is best-effort and never throws: a join, a page view or a
// message must not fail because telling somebody about it did.

const crypto = require('crypto');
const events = require('./events');
const log = require('./logger');

const KINDS = Object.freeze(['invite_opened', 'member_joined', 'first_message']);
// A first message counts as a hello for this long after joining. Past it, the
// maker has long since heard they joined, and "said hi" would be news about
// somebody who has been around for weeks.
const HELLO_WITHIN_DAYS = 30;

// The browser an open came from: a random value the invite page's reads set
// once, HttpOnly, and only ever stored as its SHA-256. It names nobody and
// says nothing about where the browser is; it only tells this browser's
// second open from somebody else's first.
const BROWSER_COOKIE = 'hr_iv';
const BROWSER_COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BROWSER_VALUE_RE = /^[A-Za-z0-9_-]{22,64}$/;
// The cookie a browser was counted with before an open counted a person
// once (one per link, valued '1'): that browser has been told about already.
const LEGACY_COOKIE_PREFIX = 'hr_io_';

/** This request's browser, as the hash an open is kept by, or null. */
function browserFrom(req) {
  const value = req?.cookies?.[BROWSER_COOKIE];
  if (typeof value !== 'string' || !BROWSER_VALUE_RE.test(value)) return null;
  return crypto.createHash('sha256').update(`invite-open:${value}`).digest('hex');
}

/** This request's browser, given a cookie first when it has none. */
function ensureBrowser(req, res) {
  const known = browserFrom(req);
  if (known) return known;
  const value = crypto.randomBytes(24).toString('base64url');
  res.cookie(BROWSER_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers?.['x-forwarded-proto'] === 'https',
    maxAge: BROWSER_COOKIE_MAX_AGE_MS,
    path: '/api',
  });
  // The rest of this request reads it as if it had arrived with it.
  if (req.cookies) req.cookies[BROWSER_COOKIE] = value;
  return browserFrom({ cookies: { [BROWSER_COOKIE]: value } });
}

/** Whether this browser was counted for the link `token` before. */
function countedBefore(req, token) {
  return !!(token && req?.cookies?.[`${LEGACY_COOKIE_PREFIX}${String(token).slice(0, 12)}`]);
}

function notifications() { return require('./notifications'); }

/**
 * Tell `userId` about one moment on `appId`: a new notification (it rings)
 * or, within a day of the last one of this kind there, that one counted up
 * and unread again (it does not). Resolves { row, fresh } or null.
 */
async function ring(pool, { userId, appId, kind, sourceUserId = null, chatMessageId = null }) {
  if (!KINDS.includes(kind) || !userId || !appId) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two joins at once must not both ring: one key per (person, project, kind).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite-activity:${userId}:${appId}:${kind}`]);
    const { rows: bumped } = await client.query(
      `UPDATE notifications
          SET detail = (CASE WHEN detail ~ '^[0-9]{1,6}$' THEN detail::int ELSE 1 END + 1)::text,
              source_user_id = COALESCE($4, source_user_id),
              chat_message_id = COALESCE($5, chat_message_id),
              read_at = NULL
        WHERE id = (SELECT id FROM notifications
                     WHERE user_id = $1 AND app_id = $2 AND kind = $3
                       AND created_at > NOW() - INTERVAL '24 hours'
                     ORDER BY id DESC LIMIT 1)
        RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
      [userId, appId, kind, sourceUserId, chatMessageId],
    );
    let row = bumped[0] || null;
    const fresh = !row;
    if (!row) {
      const { rows } = await client.query(
        `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
        [userId, appId, chatMessageId, sourceUserId, kind],
      );
      row = rows[0];
    }
    await client.query('COMMIT');
    await notifications().hydrateAndPush(pool, row);
    return { row, fresh };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.warn('invite-activity', 'Could not tell a link\'s maker', { kind, appId, err: err.message });
    return null;
  } finally {
    client.release();
  }
}

/**
 * The email that stands in for a push the maker cannot get
 * (services/activity-mail.js). Only for the first moment of the day.
 */
function mailFor(pool, result, { appName, appSlug, line }) {
  if (!result?.fresh) return;
  void require('./activity-mail').emailIfNoPush(pool, {
    userId: result.row.user_id, kind: 'invite_activity', appName, appSlug, line,
  });
}

/**
 * A signed-in person joined through `inviteId`. Its maker hears it, by
 * name, unless they are the one who joined, and the open that brought them
 * stops being news (settleOpen). `browser` is the browser they joined from
 * (browserFrom), which may be the one they opened the link in signed out.
 */
async function noteJoined(pool, { inviteId, user, browser = null }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.created_by, ci.app_id, a.slug, a.name, u.username
         FROM community_invites ci
         JOIN apps a ON a.id = ci.app_id
         LEFT JOIN users u ON u.id = $2
        WHERE ci.id = $1`,
      [inviteId, user?.id ?? null],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null || !user?.id || Number(invite.created_by) === Number(user.id)) return null;
    await settleOpen(pool, { makerId: invite.created_by, appId: invite.app_id, userId: user.id, browser });
    const result = await ring(pool, { userId: invite.created_by, appId: invite.app_id, kind: 'member_joined', sourceUserId: user.id });
    mailFor(pool, result, {
      appName: invite.name, appSlug: invite.slug,
      line: `${invite.username ? `@${invite.username}` : 'Someone'} joined ${invite.name} through your invite.`,
    });
    return result;
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a join', { inviteId, err: err.message });
    return null;
  }
}

// An open notice's push waits this long, so somebody who opens the link and
// joins straight away (seconds signed in, a few minutes through signing up)
// rings once, as a join, and not first as "Someone opened your invite". The
// bell shows the open at once; only the phone waits. The push is
// mobile_push_deliveries rows, which go with the notice when a join removes
// it (ON DELETE CASCADE), so a withdrawn open never buzzes.
const OPEN_PUSH_DELAY_MINUTES = 15;

// One lock per maker and project for everything that writes their opens: an
// open, and a join that takes somebody off the open notice. The same key
// ring() takes for invite_opened.
const opensLock = (makerId, appId) => `invite-activity:${makerId}:${appId}:invite_opened`;

/**
 * The rows that are this person, by account or browser, for `makerId`'s
 * links to `appId`, locked, the account's own row first.
 */
async function openersOf(client, { makerId, appId, userId = null, browser = null }) {
  const { rows } = await client.query(
    `SELECT id, user_id, browser, notification_id
       FROM community_invite_opens
      WHERE maker_id = $1 AND app_id = $2
        AND (($3::int IS NOT NULL AND user_id = $3::int) OR ($4::text IS NOT NULL AND browser = $4::text))
      ORDER BY COALESCE(user_id = $3::int, FALSE) DESC, id
      FOR UPDATE`,
    [makerId, appId, userId, browser],
  );
  return rows;
}

/**
 * Make `rows` (openersOf) one row, the first, which learns the account and
 * browser it was missing. Inside the caller's transaction. Resolves the ids
 * of the open notices a removed row was counted on.
 */
async function mergeOpeners(client, rows, { userId = null, browser = null }) {
  const [keep, ...rest] = rows;
  const touched = new Set();
  for (const extra of rest) {
    await client.query('DELETE FROM community_invite_opens WHERE id = $1', [extra.id]);
    if (extra.notification_id != null) touched.add(Number(extra.notification_id));
  }
  await client.query(
    `UPDATE community_invite_opens
        SET user_id = COALESCE(user_id, $2::int), browser = COALESCE(browser, $3::text)
      WHERE id = $1`,
    [keep.id, userId, browser],
  );
  return touched;
}

/**
 * Set open notice `id` to the number of people on it; one nobody is left on
 * is removed. Inside the caller's transaction. Resolves the count left.
 */
async function recountOpenNotice(client, id) {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM community_invite_opens WHERE notification_id = $1',
    [id],
  );
  const n = rows[0]?.n || 0;
  if (n === 0) {
    await client.query(`DELETE FROM notifications WHERE id = $1 AND kind = 'invite_opened'`, [id]);
  } else {
    await client.query(
      `UPDATE notifications SET detail = $2 WHERE id = $1 AND kind = 'invite_opened'`,
      [id, n > 1 ? String(n) : null],
    );
  }
  return n;
}

/**
 * Count the open row `rowId` on the day's `invite_opened` notice for
 * `makerId` and `appId`: the one from the last 24 hours if there is one,
 * else a new one (it rings; its push waits OPEN_PUSH_DELAY_MINUTES, for a
 * join to replace the open). Inside the caller's transaction, under
 * `opensLock`. The open notice's own form of ring(): it links the row to the
 * notice, which ring() cannot do. Resolves { row, fresh }: the notice as it
 * now stands, and whether this call made it.
 */
async function countOnOpenNotice(client, { makerId, appId, rowId }) {
  const { rows: latest } = await client.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND app_id = $2 AND kind = 'invite_opened'
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY id DESC LIMIT 1`,
    [makerId, appId],
  );
  let noticeId = latest[0]?.id ?? null;
  const fresh = noticeId == null;
  if (fresh) {
    const { rows: made } = await client.query(
      `INSERT INTO notifications (user_id, app_id, kind) VALUES ($1, $2, 'invite_opened') RETURNING id`,
      [makerId, appId],
    );
    noticeId = made[0].id;
    await client.query(
      `UPDATE mobile_push_deliveries
          SET available_at = NOW() + make_interval(mins => $2::int)
        WHERE notification_id = $1 AND status = 'pending'`,
      [noticeId, OPEN_PUSH_DELAY_MINUTES],
    );
  }
  await client.query(
    `UPDATE community_invite_opens SET notification_id = $2 WHERE id = $1`,
    [rowId, noticeId],
  );
  if (!fresh) {
    // Somebody new on today's notice: counted, and unread again, without
    // ringing again.
    await recountOpenNotice(client, noticeId);
    await client.query('UPDATE notifications SET read_at = NULL WHERE id = $1', [noticeId]);
  }
  const { rows: shown } = await client.query(
    `SELECT id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at
       FROM notifications WHERE id = $1`,
    [noticeId],
  );
  return { row: shown[0] || null, fresh };
}

/** The maker's bell, and their phone's badge, read again. */
function bellChanged(userId) {
  try {
    require('./ws').pushNotificationToUser(userId, { type: 'notifications_changed' });
  } catch (err) {
    log.warn('invite-activity', 'Could not refresh a maker\'s bell', { err: err.message });
  }
}

/**
 * `userId` joined through a link of `makerId`'s to `appId`, so their open is
 * not news any more: they come off the open notice they were counted on
 * (which goes when nobody is left on it, its waiting push with it), and keep
 * their row, with their account, so opening the link again stays quiet.
 * Never throws. Resolves the ids of the notices it changed.
 */
async function settleOpen(pool, { makerId, appId, userId, browser = null }) {
  const touched = new Set();
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opensLock(makerId, appId)]);
    const rows = await openersOf(client, { makerId, appId, userId, browser });
    if (rows.length) {
      for (const id of await mergeOpeners(client, rows, { userId, browser })) touched.add(id);
      if (rows[0].notification_id != null) {
        touched.add(Number(rows[0].notification_id));
        await client.query('UPDATE community_invite_opens SET notification_id = NULL WHERE id = $1', [rows[0].id]);
      }
      for (const id of touched) await recountOpenNotice(client, id);
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.warn('invite-activity', 'Could not settle an open on a join', { appId, err: err.message });
    return [];
  } finally {
    if (client) client.release();
  }
  if (touched.size) bellChanged(makerId);
  return [...touched];
}

/**
 * Somebody opened the live link `token`: counted for its maker once per
 * person, never named, and only once the person can be known. `viewerId` is
 * the signed-in visitor, when there is one: the maker opening their own
 * link, or somebody already in the community, is not news. `browser` is the
 * browser it was opened in (ensureBrowser); `seenBefore` says that browser
 * was counted for this link before opens were kept by person
 * (countedBefore), so it is remembered without being counted again.
 *
 * An open made signed out is remembered by its browser with no notice
 * (deferred): the maker is told about it when that browser signs in
 * (noteSignedIn), or when it opens the link signed in — a signed-in read of
 * a browser whose rows are all deferred counts them on the day's notice
 * then. A signed-out open still records the admin Journey's one event for
 * that person, here at the open (journey.js firstSession), so the sign-in
 * that later tells the maker does not record a second one.
 *
 * Resolves { row, fresh } when this call counted somebody on a notice
 * (`fresh`: it made the day's notice, whose push waits
 * OPEN_PUSH_DELAY_MINUTES), or { row: null, fresh: false } for somebody who
 * had opened it before and is counted already, or whose open is still
 * waiting to be somebody. Null for nobody at all.
 */
async function noteOpened(pool, { token, viewerId = null, browser = null, seenBefore = false }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.id, ci.created_by, ci.app_id, ci.community_id,
              ($2::int IS NOT NULL AND EXISTS (
                SELECT 1 FROM community_members m WHERE m.community_id = ci.community_id AND m.user_id = $2
              )) AS viewer_is_member
         FROM community_invites ci
        WHERE ci.token = $1 AND ci.revoked_at IS NULL
          AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
          AND (ci.max_uses IS NULL OR ci.uses < ci.max_uses)`,
      [token, viewerId],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null) return null;
    if (viewerId != null && (Number(viewerId) === Number(invite.created_by) || invite.viewer_is_member)) return null;
    // Nothing to know this person by again, so nothing to count once.
    if (viewerId == null && !browser) return null;
    const makerId = invite.created_by;
    const appId = invite.app_id;
    const person = { makerId, appId, userId: viewerId, browser };

    const touched = new Set();
    // What this call did: counted onto a notice (then its row, and whether
    // the notice was made now), and whether this was the person's one open
    // (so the Journey's event is recorded here).
    let counted = null;
    let firstOpen = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opensLock(makerId, appId)]);
      const known = await openersOf(client, person);
      // Joined since the read above (a signed-in Join can follow the read
      // that counted it within a second, and its join may have been settled
      // first): remembered, and not news.
      const { rows: joinedSince } = viewerId == null ? { rows: [] } : await client.query(
        `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2`,
        [invite.community_id, viewerId],
      );
      if (known.length) {
        // Opened before (here, on another device, or signed out in this
        // browser): one person, told about once.
        for (const id of await mergeOpeners(client, known, person)) touched.add(id);
        for (const id of touched) await recountOpenNotice(client, id);
        // A signed-out open was only remembered, so this read — which knows
        // who the person is — is when their browser's open is counted, if
        // it never was and they have not joined meanwhile.
        const allDeferred = known.every((r) => r.user_id == null && r.notification_id == null);
        if (viewerId != null && allDeferred && !joinedSince.length) {
          counted = await countOnOpenNotice(client, { makerId, appId, rowId: known[0].id });
        }
      } else if (seenBefore || joinedSince.length) {
        await client.query(
          `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser) VALUES ($1, $2, $3, $4)`,
          [makerId, appId, viewerId, browser],
        );
      } else if (viewerId == null) {
        // Signed out, and new to this maker and project: remembered only.
        // No notice, no push — looking at a link page is not news on its
        // own. The maker hears when this browser signs in or opens the
        // link signed in.
        await client.query(
          `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser) VALUES ($1, $2, $3, $4)`,
          [makerId, appId, viewerId, browser],
        );
        firstOpen = true;
      } else {
        const { rows: made } = await client.query(
          `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [makerId, appId, viewerId, browser],
        );
        counted = await countOnOpenNotice(client, { makerId, appId, rowId: made[0].id });
        firstOpen = true;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (touched.size) bellChanged(makerId);
    // The admin Journey's first session reads it too (journey.js
    // firstSession): one event per person. A signed-out open records its
    // own here, before any notice exists, with `signedIn: false`.
    if (firstOpen) {
      events.record(pool, {
        type: events.EVENT_TYPES.INVITE_OPENED,
        userId: viewerId ?? undefined,
        appId,
        metadata: { inviteId: invite.id, signedIn: viewerId != null },
      });
    }
    if (!counted?.row) return { row: null, fresh: false };
    await notifications().hydrateAndPush(pool, counted.row);
    return { row: counted.row, fresh: counted.fresh };
  } catch (err) {
    log.warn('invite-activity', 'Could not count an invite opened', { err: err.message });
    return null;
  }
}

/**
 * `userId` just signed in in `browser` (browserFrom): any open of a maker's
 * link that this browser made signed out, and that nobody has been told
 * about yet, is news now — that is the moment the maker hears "Someone
 * opened your invite", the same notice and the same delayed push as an open
 * made signed in. Rows already counted elsewhere are only given the
 * account, and the maker's own sign-in, or the sign-in of somebody already
 * in the community, tells nobody (their join, when it comes, says it
 * instead). Records nothing: the open's own event went out when it
 * happened. Never throws, and fire-and-forget by contract (routes/auth.js
 * noteSignIn).
 */
async function noteSignedIn(pool, { userId, browser = null }) {
  if (!userId || !browser) return;
  try {
    // Every maker and project this browser opened a link for signed out,
    // and was not told about.
    const { rows: pairs } = await pool.query(
      `SELECT DISTINCT o.maker_id, o.app_id, a.community_id
         FROM community_invite_opens o
         JOIN apps a ON a.id = o.app_id
        WHERE o.browser = $1 AND o.user_id IS NULL AND o.notification_id IS NULL`,
      [browser],
    );
    for (const pair of pairs) {
      let counted = null;
      let countedChanged = false;
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [opensLock(pair.maker_id, pair.app_id)]);
          const rows = await openersOf(client, {
            makerId: pair.maker_id, appId: pair.app_id, userId, browser,
          });
          if (rows.length) {
            const touched = await mergeOpeners(client, rows, { userId, browser });
            countedChanged = touched.size > 0;
            // The person is told when their rows here are all still
            // deferred, they are not the maker, and they are not already in
            // the community the link leads to.
            const allDeferred = rows.every((r) => r.user_id == null && r.notification_id == null);
            const { rows: member } = await client.query(
              'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2',
              [pair.community_id, userId],
            );
            if (allDeferred && Number(pair.maker_id) !== Number(userId) && member.length === 0) {
              counted = await countOnOpenNotice(client, {
                makerId: pair.maker_id, appId: pair.app_id, rowId: rows[0].id,
              });
            }
            // A notice a removed row was counted on is read again.
            for (const id of touched) await recountOpenNotice(client, id);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        log.warn('invite-activity', 'Could not count a deferred open on a sign-in', {
          appId: pair.app_id, err: err.message,
        });
        continue;
      }
      if (counted?.row) await notifications().hydrateAndPush(pool, counted.row);
      else if (countedChanged) bellChanged(pair.maker_id);
    }
  } catch (err) {
    log.warn('invite-activity', 'Could not settle a browser\'s opens on a sign-in', { err: err.message });
  }
}

/**
 * `userId` just wrote `chatMessageId` in `appId`'s chat. When it is their
 * first message there, within HELLO_WITHIN_DAYS of joining through
 * somebody's link, that somebody hears they said hi.
 */
async function noteFirstMessage(pool, { appId, userId, chatMessageId }) {
  try {
    if (!appId || !userId || !chatMessageId) return null;
    const { rows } = await pool.query(
      `SELECT ci.created_by, a.slug, a.name, u.username
         FROM community_invite_redemptions r
         JOIN community_invites ci ON ci.id = r.invite_id
         JOIN apps a ON a.id = ci.app_id
         JOIN users u ON u.id = r.user_id
        WHERE r.user_id = $1 AND ci.app_id = $2 AND r.status = 'joined'
          AND ci.created_by IS NOT NULL AND ci.created_by <> r.user_id
          AND COALESCE(r.applied_at, r.created_at) > NOW() - make_interval(days => $4::int)
          AND EXISTS (SELECT 1 FROM community_members m
                       WHERE m.community_id = ci.community_id AND m.user_id = ci.created_by)
          AND NOT EXISTS (SELECT 1 FROM chat_messages cm
                           WHERE cm.app_id = $2 AND cm.user_id = $1 AND cm.id <> $3)
        ORDER BY COALESCE(r.applied_at, r.created_at) DESC
        LIMIT 1`,
      [userId, appId, chatMessageId, HELLO_WITHIN_DAYS],
    );
    const hello = rows[0];
    if (!hello) return null;
    const result = await ring(pool, {
      userId: hello.created_by, appId, kind: 'first_message', sourceUserId: userId, chatMessageId,
    });
    mailFor(pool, result, {
      appName: hello.name, appSlug: hello.slug,
      line: `@${hello.username} said hi in ${hello.name}.`,
    });
    return result;
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a first message', { appId, err: err.message });
    return null;
  }
}

module.exports = {
  KINDS,
  HELLO_WITHIN_DAYS,
  OPEN_PUSH_DELAY_MINUTES,
  BROWSER_COOKIE,
  browserFrom,
  ensureBrowser,
  countedBefore,
  ring,
  noteJoined,
  noteOpened,
  noteSignedIn,
  settleOpen,
  noteFirstMessage,
};
