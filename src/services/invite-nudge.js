'use strict';

// The bring-a-friend nudge (Nov 2026): Homeroom bot asks somebody NEW to a
// project, once, after the first thing they did there, to invite one or two
// friends to it. A project grows by the people already in it, and the moment
// they first take part is when they are most likely to bring somebody.
//
// Who is asked: a person who joined the project's community in the last 14
// days (community_members.joined_at, or, for a private member, the invite
// redemption that let them in), whose first act in that project was in the
// last 48 hours. An act is what the admin Journey counts as one
// (journey.js PERSON_JOINS `fa`), narrowed to the project: a message in its
// chat, a vote on one of its changes or requests, a request filed there, a
// change started there, or a day they used its app. Never:
//   - the project's maker, whose first version's "live" already offers
//     Invite people (homeroom-bot-dm.js firstLiveActions);
//   - a test account, a synthetic account (the bot itself) or a service
//     identity (usernames.js SERVICE_IDENTITIES), nor one anonymised or
//     restricted from taking part;
//   - anybody the bot does not work for (homeroom-bot-dm.js hasBot);
//   - the platform's own community, which has no app of its own to share,
//     or a project that is not running.
//
// How often: once per person per project, ever (invite_nudges' UNIQUE key,
// claimed before the message is sent), and at most one nudge a person a week
// across every project (the claim counts the rows of the last 7 days, under
// a transaction lock on the person). The message's Not now records the
// dismissal (`dismiss`); the once is what keeps it from being asked again.
//
// The invite-nudge clock (src/workflow/clock/services.ts) runs `targets`,
// one target per person owed one, and each target's item runs `nudge`: the
// claim and the send are each a step (kernel/steps.ts), the send under an
// idempotency key, so a retry neither claims twice nor sends twice.
// INVITE_NUDGE=off switches it off.

const log = require('./logger');
const usernames = require('./usernames');
const { INVITE_NUDGE_LOCK } = require('./advisory-locks');

const JOINED_WITHIN_DAYS = 14;
const ACTED_WITHIN_HOURS = 48;
const ONE_A_WEEK_DAYS = 7;
const SERVICE_NAMES = Object.freeze([...usernames.SERVICE_IDENTITIES].map((name) => name.toLowerCase()));

/** Whether the nudge is on: INVITE_NUDGE=off switches it off. */
function enabled(env = process.env) {
  return String(env.INVITE_NUDGE || '').trim().toLowerCase() !== 'off';
}

// One person's first act in one project, with `u` (the person) and `a` (the
// project) in scope: the earliest of the records below, a tie going to the
// kind's name so there is one answer. Feedback on the platform and joining
// are acts on the Journey, not in a project.
const FIRST_ACT = `
      SELECT x.at, x.kind FROM (
        SELECT MIN(cmx.created_at) AS at, 'message' AS kind FROM chat_messages cmx
         WHERE cmx.user_id = u.id AND cmx.app_id = a.id AND cmx.msg_type = 'message' AND cmx.deleted_at IS NULL
        UNION ALL SELECT MIN(pv.created_at), 'vote' FROM pr_votes pv JOIN chat_sessions pvs ON pvs.id = pv.session_id
         WHERE pv.user_id = u.id AND pvs.app_id = a.id
        UNION ALL SELECT MIN(iv.created_at), 'vote' FROM issue_votes iv JOIN issues ivi ON ivi.id = iv.issue_id
         WHERE iv.user_id = u.id AND ivi.app_id = a.id
        UNION ALL SELECT MIN(i.created_at), 'request' FROM issues i WHERE i.created_by = u.id AND i.app_id = a.id
        UNION ALL SELECT MIN(cs.created_at), 'change' FROM chat_sessions cs WHERE cs.user_id = u.id AND cs.app_id = a.id
        UNION ALL SELECT MIN(aa.date)::timestamptz, 'app' FROM app_activity aa WHERE aa.user_id = u.id AND aa.app_id = a.id
      ) x WHERE x.at IS NOT NULL ORDER BY x.at, x.kind LIMIT 1`;

// $1 the person, $2 the project.
const FIRST_ACT_SQL = `SELECT fa.at, fa.kind
  FROM users u JOIN apps a ON a.id = $2::int
  CROSS JOIN LATERAL (${FIRST_ACT}) fa
 WHERE u.id = $1::int`;

// Who is owed a nudge, one project a person (their most recent first act),
// or, with $6 and $7, whether that one person is owed one for that project.
// $1 now, $2 the joining window in days, $3 the act window in hours, $4 the
// service identities, $5 the one-a-week window in days, $8 the most rows.
// The recent joins are read first (a membership joined in the window, or a
// private member's redemption applied in it), so the first act is looked
// for only there.
const DUE_SQL = `WITH fresh AS (
    SELECT cm.community_id, cm.user_id FROM community_members cm
     WHERE cm.joined_at > $1::timestamptz - make_interval(days => $2::int)
    UNION
    SELECT ra.community_id, x.user_id FROM community_invite_redemptions x
      JOIN community_invites ri ON ri.id = x.invite_id
      JOIN apps ra ON ra.id = ri.app_id
      JOIN users ru ON ru.id = x.user_id
     WHERE x.status = 'joined' AND ru.private_member_since IS NOT NULL
       AND x.applied_at > $1::timestamptz - make_interval(days => $2::int)
  )
  SELECT DISTINCT ON (u.id) u.id AS user_id, a.id AS app_id, fa.kind AS act, fa.at AS acted_at
    FROM fresh f
    JOIN community_members cm ON cm.community_id = f.community_id AND cm.user_id = f.user_id
    JOIN apps a ON a.community_id = cm.community_id
    JOIN users u ON u.id = cm.user_id
    CROSS JOIN LATERAL (${FIRST_ACT}) fa
   WHERE ($6::int IS NULL OR u.id = $6::int) AND ($7::int IS NULL OR a.id = $7::int)
     AND cm.source <> 'creator' AND a.created_by IS DISTINCT FROM u.id
     AND a.status = 'running' AND a.self_hosted IS NOT TRUE
     AND u.is_synthetic IS NOT TRUE AND u.test_account_created_at IS NULL
     AND u.anonymised_at IS NULL AND u.participation_restricted_at IS NULL
     AND NOT (LOWER(u.username) = ANY($4::text[]))
     AND (u.has_platform_access OR u.is_admin OR u.private_member_since IS NOT NULL)
     AND fa.at > $1::timestamptz - make_interval(hours => $3::int)
     AND NOT EXISTS (
       SELECT 1 FROM invite_nudges n
        WHERE n.user_id = u.id
          AND (n.app_id = a.id OR n.created_at > $1::timestamptz - make_interval(days => $5::int))
     )
   ORDER BY u.id, fa.at DESC, a.id
   LIMIT $8::int`;

function dueParams(now, { userId = null, appId = null, limit = 200 } = {}) {
  return [now, JOINED_WITHIN_DAYS, ACTED_WITHIN_HOURS, [...SERVICE_NAMES], ONE_A_WEEK_DAYS,
    userId == null ? null : Number(userId), appId == null ? null : Number(appId), limit];
}

/** One person's first act in one project, `{ at, kind }`, or null when they have done nothing there. */
async function firstActIn(pool, { userId, appId }) {
  const { rows } = await pool.query(FIRST_ACT_SQL, [Number(userId), Number(appId)]);
  return rows[0] ? { at: rows[0].at, kind: rows[0].kind } : null;
}

/** Who is owed a nudge now, one project each: `[{ userId, appId, act, actedAt }]`. Reads only. */
async function due(pool, { now = new Date(), limit = 200 } = {}) {
  const { rows } = await pool.query(DUE_SQL, dueParams(now, { limit }));
  return rows.map((r) => ({ userId: Number(r.user_id), appId: Number(r.app_id), act: r.act, actedAt: r.acted_at }));
}

/**
 * The invite-nudge clock's run: each person owed a nudge, a target of their
 * own (`invite-nudge:<person>`), so a person with one under way is not
 * given a second. Reads only.
 */
async function targets(pool, { now = new Date(), limit = 200 } = {}) {
  if (!enabled()) return { off: true };
  const owed = await due(pool, { now, limit });
  return {
    owed: owed.length,
    items: owed.map((o) => ({ target: `invite-nudge:${o.userId}`, input: { userId: o.userId, appId: o.appId } })),
  };
}

/**
 * Claim one person's nudge for one project: asked again, under a lock on the
 * person, whether it is still owed (the window, the once, the week, who they
 * are), then its row written. Its card is written with its message (send).
 * Resolves what the send needs, or `{ skipped }` with why nothing was
 * claimed.
 */
async function claim(pool, { userId, appId, now = new Date(), deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const settings = deps.settings || await require('./homeroom-bot').readSettings(pool, { strict: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [INVITE_NUDGE_LOCK, Number(userId)]);
    const { rows: [owed] } = await client.query(DUE_SQL, dueParams(now, { userId, appId, limit: 1 }));
    if (!owed) { await client.query('ROLLBACK'); return { skipped: 'not_due' }; }
    const { rows: [person] } = await client.query(
      `SELECT username, is_synthetic, has_platform_access, is_admin, private_member_since FROM users WHERE id = $1`, [Number(userId)]);
    const works = await require('./homeroom-bot-verified').worksFor(dm, client, settings, {
      id: Number(userId), username: person?.username, isSynthetic: !!person?.is_synthetic, hasPlatformAccess: !!person?.has_platform_access,
      isAdmin: !!person?.is_admin, privateMember: person?.private_member_since != null,
    });
    if (!works) { await client.query('ROLLBACK'); return { skipped: 'no_bot' }; }
    const { rows: [app] } = await client.query('SELECT slug, name FROM apps WHERE id = $1', [Number(appId)]);
    const name = String(app?.name || app?.slug || '');
    const { rows: [row] } = await client.query(
      `INSERT INTO invite_nudges (user_id, app_id, act) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, app_id) DO NOTHING RETURNING id`,
      [Number(userId), Number(appId), owed.act],
    );
    if (!row) { await client.query('ROLLBACK'); return { skipped: 'already' }; }
    await client.query('COMMIT');
    return { nudgeId: row.id, userId: Number(userId), appId: Number(appId), act: owed.act, slug: app.slug, name };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Send a claimed nudge in the person's chat with the bot (Main), under an
 * idempotency key of its row, its card (Not now) written with the message
 * and named on its row in the same transaction (step 3, dm.sendDm `card`).
 * Throws when the bot cannot be found (the item tries again). Resolves
 * `{ said }`: 'sent', or 'not_sent' when the chat refused it (the bot
 * blocked, the chat left), when no card is written either.
 */
async function send(pool, claimed, deps = {}) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot || await dm.botAccount(pool);
  if (!bot) throw new Error('Homeroom bot is not available');
  const content = dm.inviteNudgeText({ act: claimed.act, appName: claimed.name });
  const sent = content ? await dm.sendDm(pool, {
    bot,
    userId: claimed.userId,
    content,
    idempotencyKey: `hrbot-invite-nudge-${claimed.nudgeId}`,
    metadata: dm.inviteNudgeMeta({ slug: claimed.slug, appName: claimed.name, act: claimed.act, actionId: null }),
    threadRootId: false,
    card: {
      kind: dm.INVITE_NUDGE_KIND, appId: claimed.appId, title: `Invite friends to ${claimed.name}`.slice(0, 200),
      onInsert: (db, { cardId }) => db.query('UPDATE invite_nudges SET card_id = $2 WHERE id = $1', [claimed.nudgeId, cardId]),
    },
  }) : null;
  if (!sent?.messageId) {
    log.info('invite-nudge', 'A nudge was not sent', { userId: claimed.userId, appId: claimed.appId });
    return { said: 'not_sent' };
  }
  await pool.query('UPDATE invite_nudges SET sent_at = COALESCE(sent_at, NOW()), message_id = $2 WHERE id = $1',
    [claimed.nudgeId, sent.messageId]);
  return { said: 'sent', messageId: sent.messageId };
}

/**
 * One target's item: the claim, then the send, each a step, so a retry
 * carries on from the one it reached. Resolves what it did.
 */
async function nudge(pool, input, steps, deps = {}) {
  const userId = Number(input?.userId);
  const appId = Number(input?.appId);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(appId) || appId <= 0) return { skipped: 'bad_target' };
  if (!enabled()) return { skipped: 'off' };
  const claimed = await steps.once('claim', () => claim(pool, { userId, appId, deps }));
  if (!claimed?.nudgeId) return claimed;
  return steps.once('sent', () => send(pool, claimed, deps));
}

/**
 * Not now under a nudge (POST /api/conversations/homeroom-bot/actions/:id,
 * homeroom-bot-mayor.js decideOfferTap): its card decided once, as
 * declined, the dismissal written on its row, and the buttons give way to
 * "You chose Not now" on every device. Its row stays: it is never asked
 * again for that project. Resolves the route's answer.
 */
async function dismiss(pool, { user, action, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const { rows: decided } = await pool.query(
    `UPDATE bot_cards SET status = 'declined', decided_at = COALESCE(decided_at, NOW())
      WHERE id = $1 AND user_id = $2 AND status = 'open' RETURNING id`,
    [Number(action.id), Number(user.id)],
  );
  if (!decided.length) return { ok: false, status: 409, error: 'already_decided', code: 'already_decided' };
  await pool.query('UPDATE invite_nudges SET dismissed_at = COALESCE(dismissed_at, NOW()) WHERE card_id = $1', [Number(action.id)]);
  const label = dm.inviteNudgeActions().find((a) => a.id === 'no').label;
  if (action.message_id) {
    await dm.setQuestionState(pool, Number(action.message_id), { status: 'answered', answer: label, chosen: 'no' }, {
      ws: deps.ws || null, conversationId: action.conversation_id, userId: user.id,
    }).catch((err) => log.warn('invite-nudge', 'Could not settle a nudge\'s buttons', { cardId: action.id, err: err.message }));
  }
  return { ok: true, choice: 'no', label };
}

module.exports = {
  JOINED_WITHIN_DAYS,
  ACTED_WITHIN_HOURS,
  ONE_A_WEEK_DAYS,
  FIRST_ACT_SQL,
  DUE_SQL,
  enabled,
  firstActIn,
  due,
  targets,
  claim,
  send,
  nudge,
  dismiss,
};
