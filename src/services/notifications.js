// Notifications service: generic Social persistence + Activity occurrences.
//
// The DB shape (`kind` column) is generic so different notification types
// share one table + pipeline. Kinds today: 'mention' (group-chat @mention),
// 'kudos' (PR kudos), 'reply' (#15 — someone quoted your message/PR in
// group chat), 'reaction' (#25 — someone reacted to your message;
// `detail` carries the emoji), 'stale_pr' (a promoted PR going quiet),
// 'pr_proposed' (a PR was promoted for voting — fanned out to the app's
// active users + creator + favoriters so they come vote; self-app PRs
// go to creator + favoriters only), 'session_done'
// (#161 — a dev-session turn finished after its owner left),
// 'auto_solve_done' (#161 — a headless auto-solve run finished; `detail`
// holds the outcome: spec | code | spec_code (#170) | question | failed)
// and 'spec_shared' (#86 — someone privately shared a spec version with
// you; `detail` carries the version number as a string).

const log = require('./logger');
const { listActiveUserIds } = require('./active-users');

// Usernames in this app are [A-Za-z0-9_]+, length-restricted on signup.
// Match @token that is NOT preceded by a word character (so emails don't
// trigger mentions) and capture up to 32 chars.
const MENTION_RE = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;
const ACTIVITY_NOTIFICATION_KINDS = new Set([
  'mention',
  'reply',
  'reaction',
  'kudos',
  'stale_pr',
  'check_failed',
  'pr_proposed',
  'session_done',
  'auto_solve_done',
  'spec_shared',
  'collab_invite',
  'collab_invite_accepted',
  'approver_invite',
  'approver_invite_accepted',
]);
const WORK_NOTIFICATION_KINDS = Object.freeze([
  'session_done', 'auto_solve_done', 'stale_pr', 'check_failed',
]);
const WORK_NOTIFICATION_KIND_SET = new Set(WORK_NOTIFICATION_KINDS);
const NOTIFICATION_SECTION_SCOPES = Object.freeze({
  work: 'social.notification-surface:1',
  bell: 'social.notification-surface:2',
});

let notificationReadPath = 'legacy';
let activityService = null;

function configureActivity(service, readPath = 'legacy') {
  if (!['legacy', 'activity'].includes(readPath)) {
    throw new Error('notification read path must be legacy or activity');
  }
  activityService = service || null;
  notificationReadPath = readPath;
}

function socialId(value) {
  if (value == null) return null;
  const out = String(value);
  return /^[1-9][0-9]{0,18}$/.test(out) ? out : null;
}

function boundedNullable(value, max) {
  if (value == null) return null;
  const out = String(value).slice(0, max);
  return out.length ? out : null;
}

function positiveSafeInteger(value) {
  if (value == null) return null;
  const out = Number(value);
  return Number.isSafeInteger(out) && out > 0 ? out : null;
}

function notificationSectionForKind(kind) {
  return WORK_NOTIFICATION_KIND_SET.has(kind) ? 'work' : 'bell';
}

function readScopeForNotificationSection(section) {
  return NOTIFICATION_SECTION_SCOPES[section] || null;
}

function readScopesFor(row) {
  const scopes = [readScopeForNotificationSection(notificationSectionForKind(row.kind))];
  const appId = socialId(row.app_id);
  const messageId = socialId(row.chat_message_id);
  const sessionId = socialId(row.session_id);
  if (appId) scopes.push(`social.app:${appId}`);
  if (['mention', 'reply', 'reaction'].includes(row.kind)) {
    if (messageId) scopes.push(`social.chat-message:${messageId}`);
    if (appId) scopes.push(`social.chat-engagement:${appId}`);
  }
  if (['pr_proposed', 'stale_pr'].includes(row.kind) && sessionId) {
    scopes.push(`social.vote-request:${sessionId}`);
  }
  if (row.kind === 'session_done' && sessionId) {
    scopes.push(`social.session-completion:${sessionId}`);
  }
  if (row.kind === 'auto_solve_done' && sessionId) {
    scopes.push(`social.auto-solve-completion:${sessionId}`);
  }
  if (row.kind === 'collab_invite' && appId) {
    scopes.push(`social.collab-invite:${appId}`);
  }
  if (row.kind === 'approver_invite' && appId) {
    scopes.push(`social.approver-invite:${appId}`);
  }
  return [...new Set(scopes)].sort();
}

function buildActivityEvent(row) {
  const notificationId = socialId(row.id);
  const recipientId = socialId(row.user_id);
  if (!notificationId || !recipientId) {
    throw new Error('notification and recipient ids must be positive decimals');
  }
  if (!ACTIVITY_NOTIFICATION_KINDS.has(row.kind)) {
    throw new Error(`notification kind is not registered with Activity: ${row.kind}`);
  }
  const identity = `social.notification:${notificationId}`;
  const occurredAt = new Date(row.created_at).toISOString();
  return {
    envelopeVersion: 1,
    sourceEventId: identity,
    kind: 'social.notification.occurred',
    schemaVersion: 1,
    recipient: {
      relation: 'social.user',
      subject: recipientId,
      scope: 'account',
    },
    resource: { type: 'notification', id: notificationId, version: 1 },
    occurredAt,
    status: 'occurred',
    canonicality: 'source_confirmed',
    facts: {
      kind: row.kind,
      appId: socialId(row.app_id),
      appSlug: boundedNullable(row.app_slug, 128),
      appName: boundedNullable(row.app_name, 512),
      chatMessageId: socialId(row.chat_message_id),
      messageContent: boundedNullable(row.message_content, 1024),
      threadType: boundedNullable(row.thread_type, 32),
      threadRef: socialId(row.thread_ref),
      sessionId: socialId(row.session_id),
      prTitle: boundedNullable(row.pr_title, 512),
      prNumber: positiveSafeInteger(row.pr_number),
      headlessIssueNumber: positiveSafeInteger(row.headless_issue_number),
      branchName: boundedNullable(row.branch_name, 512),
      sourceUserId: socialId(row.source_user_id),
      sourceUsername: boundedNullable(row.source_username, 32),
      detail: boundedNullable(row.detail, 32),
      readScopes: readScopesFor(row),
    },
    aggregateKey: identity,
  };
}

async function invalidateUsersBestEffort(userIds) {
  if (notificationReadPath !== 'legacy') return;
  try {
    const { pushNotificationToUser } = require('./ws');
    for (const userId of new Set(userIds)) {
      pushNotificationToUser(userId, { type: 'notifications_changed' });
    }
  } catch (err) {
    log.warn('notifications', 'legacy invalidation failed', { err: err.message });
  }
}

// Insert legacy Social feed rows or, while Activity is authoritative, freeze
// generic Activity source events atomically into the delivery outbox. Activity
// mode uses the legacy row only as transaction-local staging for its allocated
// id and joined renderer facts, then deletes it before commit. Social therefore
// has no second durable feed/read record for an Activity notification.
// Enabling Activity starts at that explicit cutover instead of silently
// publishing notifications previously read only in Social.
// A pg Pool gets a private transaction; callers already holding a transaction
// may pass its client directly.
async function insertNotificationRows(pool, sql, params) {
  const ownsClient = typeof pool.connect === 'function';
  const client = ownsClient ? await pool.connect() : pool;
  let inserted = [];
  try {
    if (ownsClient) await client.query('BEGIN');
    ({ rows: inserted } = await client.query(sql, params));
    if (inserted.length && notificationReadPath === 'activity') {
      const ids = inserted.map((row) => row.id);
      const { rows: hydrated } = await client.query(
        `SELECT n.id, n.user_id, n.kind, n.created_at,
                n.app_id, a.slug AS app_slug, a.name AS app_name,
                n.chat_message_id, cm.content AS message_content,
                cm.thread_type, cm.thread_ref,
                n.session_id, cs.pr_title, cs.pr_number,
                cs.headless_issue_number, cs.branch_name,
                n.source_user_id, su.username AS source_username,
                n.detail
           FROM notifications n
           LEFT JOIN apps a ON a.id = n.app_id
           LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
           LEFT JOIN chat_sessions cs ON cs.id = n.session_id
           LEFT JOIN users su ON su.id = n.source_user_id
          WHERE n.id = ANY($1::int[])`,
        [ids]
      );
      if (hydrated.length !== inserted.length) {
        throw new Error('could not hydrate every inserted notification');
      }
      const frozen = hydrated.map((row) => ({
        notification_id: row.id,
        recipient_user_id: row.user_id,
        event: buildActivityEvent(row),
      }));
      const enqueued = await client.query(
        `INSERT INTO activity_notification_outbox
           (notification_id, recipient_user_id, event)
         SELECT payload.notification_id, payload.recipient_user_id, payload.event
           FROM jsonb_to_recordset($1::jsonb)
             AS payload(notification_id integer, recipient_user_id integer, event jsonb)`,
        [JSON.stringify(frozen)]
      );
      if (enqueued.rowCount !== inserted.length) {
        throw new Error('could not enqueue every inserted notification');
      }
      const removed = await client.query(
        `DELETE FROM notifications
          WHERE id = ANY($1::int[])`,
        [ids]
      );
      if (removed.rowCount !== inserted.length) {
        throw new Error('could not remove every staged notification');
      }
    }
    if (ownsClient) await client.query('COMMIT');
  } catch (err) {
    if (ownsClient) {
      try { await client.query('ROLLBACK'); } catch { /* connection lost */ }
    }
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
  if (inserted.length) await invalidateUsersBestEffort(inserted.map((row) => row.user_id));
  return inserted;
}

function parseMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.add(m[2].toLowerCase());
  }
  return [...out];
}

async function resolveUsers(pool, usernames) {
  if (!usernames.length) return [];
  const { rows } = await pool.query(
    `SELECT id, username FROM users WHERE LOWER(username) = ANY($1::text[])`,
    [usernames]
  );
  return rows;
}

// Visibility scoping: for a collab-private app, restrict a candidate
// recipient-id list to its collaborators (status='member'). Public-collab
// apps pass through unchanged. Keeps notification deep links from landing
// people on chats they can't read (mentions) or PRs they can't vote on
// (pr_proposed).
async function filterToCollaborators(pool, appId, userIds) {
  if (!appId || !userIds.length) return userIds;
  const { rows: appRows } = await pool.query(
    'SELECT collab_visibility FROM apps WHERE id = $1',
    [appId]
  );
  if (appRows[0]?.collab_visibility !== 'private') return userIds;
  const { rows } = await pool.query(
    `SELECT user_id FROM app_collaborators
      WHERE app_id = $1 AND status = 'member' AND user_id = ANY($2::int[])`,
    [appId, userIds]
  );
  const members = new Set(rows.map((r) => r.user_id));
  return userIds.filter((id) => members.has(id));
}

// Creates notification rows for every mention in `content` that resolves to
// a real user and freezes one generic occurrence for each inserted row.
async function createMentionNotifications(pool, { appId, chatMessageId, senderId, content }) {
  const names = parseMentions(content);
  if (!names.length) return [];

  const users = await resolveUsers(pool, names);
  // Self-mentions are allowed (useful for testing and also as a "remind
  // me" pattern). If this becomes noisy we can put it behind a flag.
  // For collab-private apps, drop mentioned users who aren't members —
  // their notification would deep-link to a chat they can't read.
  const allowedIds = new Set(
    await filterToCollaborators(pool, appId, users.map((u) => u.id))
  );
  const recipients = users.filter((u) => allowedIds.has(u.id));
  if (!recipients.length) return [];

  const values = [];
  const params = [];
  recipients.forEach((u, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(u.id, appId, chatMessageId, senderId, 'mention');
  });

  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     VALUES ${values.join(', ')}
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    params
  );
  return rows;
}

// #15: reply notification. Fired when a user quotes someone's message or
// PR in group chat. `replyMessageId` is the NEW reply message, so clicking
// the notification lands the recipient on the app's group chat where the
// reply lives. No-op for self-replies or authorless (system) targets.
async function createReplyNotification(pool, { appId, replyMessageId, senderId, recipientId }) {
  if (!recipientId || recipientId === senderId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     VALUES ($1, $2, $3, $4, 'reply')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, replyMessageId, senderId]
  );
  return rows;
}

// #25: reaction notification. Fired when a user adds an emoji reaction to
// someone else's message. `messageId` is the reacted message (so clicking
// lands on the app's group chat); `emoji` rides in the `detail` column.
// No-op for self-reactions or authorless (system) targets.
async function createReactionNotification(pool, { appId, messageId, senderId, recipientId, emoji }) {
  if (!recipientId || recipientId === senderId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, $4, 'reaction', $5)
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, messageId, senderId, (emoji || '').slice(0, 32)]
  );
  return rows;
}

async function createKudosNotification(pool, { userId, appId, sessionId, sourceUserId }) {
  if (!userId || !sessionId || userId === sourceUserId) return [];
  return insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, $4, 'kudos')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at, read_at`,
    [userId, appId, sessionId, sourceUserId]
  );
}

// Stale-PR warning. Fired by the stale-promoted-PR sweeper when a PR
// proposed to the group has had no voting interest for the configured
// window. Addressed to the PR author (session.user_id) so they can nudge
// the group or merge/withdraw before the grace period elapses and it's
// auto-archived. System-generated, so source_user_id is null; references
// the session so the dropdown can render the PR title + a deep link.
async function createStalePrNotification(pool, { userId, appId, sessionId }) {
  if (!userId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'stale_pr')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #237: staging preview failed to boot, so proposal checks can't run and the
// PR is merge-blocked. Addressed to the proposal owner (system-generated, so
// source_user_id is NULL). The staging-recovery streak gate determines when
// this business occurrence exists. Creation deliberately does not consult
// Social read state because Activity owns it after cutover.
async function createCheckFailedNotification(pool, { userId, appId, sessionId }) {
  if (!userId || !sessionId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'check_failed')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #161: dev-session completion notification (kind='session_done').
// Fired by the chat handler's done hook when the session owner armed
// notify_on_done (they left mid-turn), and unconditionally by
// server.js's resumeDetachedTurn (the pre-restart SSE is guaranteed
// dead, so nobody was watching). System-generated, so source_user_id
// is null. Each terminal business occurrence becomes one notification;
// creation does not depend on Social's legacy read_at column.
async function createSessionDoneNotification(pool, { userId, appId, sessionId }) {
  if (!userId || !sessionId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'session_done')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// #161: headless auto-solve completion (kind='auto_solve_done').
// Always created at runHeadlessSession's terminal writes (no arming —
// starting an auto-solve opts you into its completion notification).
// `detail` carries the outcome: 'spec' | 'code' | 'spec_code' (#170) |
// 'question' | 'failed'.
// Resume re-fires are tolerated as distinct Social occurrences; preventing
// them would require workflow identity outside this migration.
async function createAutoSolveDoneNotification(pool, { userId, appId, sessionId, detail }) {
  if (!userId || !sessionId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, NULL, 'auto_solve_done', $4)
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [userId, appId, sessionId, (detail || '').slice(0, 32) || null]
  );
  return rows;
}

// #86: private spec share (kind='spec_shared'). Fired by the
// share-user endpoint after a NEW chat_session_spec_user_shares row is
// inserted (the endpoint skips this entirely on a duplicate share, so
// a recipient is pinged at most once per spec version). `session_id`
// points at the dev session; occurrence hydration joins chat_sessions so
// prTitle/branchName are frozen for the row label.
// `detail` carries the spec version as a string (same generic-detail
// pattern as 'reaction') so the click handler can open the exact
// version in the read-only spec panel.
async function createSpecSharedNotification(pool, { recipientId, appId, sessionId, sharerId, version }) {
  if (!recipientId || !sessionId || version == null) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, $4, 'spec_shared', $5)
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, detail, created_at`,
    [recipientId, appId, sessionId, sharerId || null, String(version).slice(0, 32)]
  );
  return rows;
}

// PR-proposed (vote-request) notification. Fired when a session is
// promoted — the genuine "please come vote on this" moment, NOT raw PR
// creation (which happens automatically after the first commit and would
// be far noisier). References the session so the dropdown renders the PR
// title + a group-chat deep link, exactly like the kudos/stale_pr kinds.
//
// Targeting (deliberately narrower than "every registered user", which
// would be a platform-wide firehose since membership is global): the
// app's currently-active users (the people whose votes actually count
// per services/active-users.js), plus the app creator and anyone who
// favorited it — so stakeholders who aren't currently "active" still get
// nudged. The proposer is always excluded. For the platform self-app,
// active users are skipped entirely (see inline comment below) — only
// creator + favoriters are pinged.
//
// Legacy mode de-dupes recipients who already have a pr_proposed row for this
// session. Activity mode deliberately treats each re-promotion as a fresh
// occurrence: preserving the old durable per-session suppression would require
// a separate family-specific ledger in Social. `source_user_id` is the proposer
// so the dropdown can render "@user proposed a PR…".
async function createPrProposedNotifications(pool, { appId, sessionId, proposerId }) {
  if (!appId || !sessionId) return [];

  // Self-app exception: active-users.js counts everyone active on ANY
  // app as "active" on the platform self-app (it has no App tab of its
  // own), so including activeIds here would ping the entire user base
  // on every platform self-edit PR. Scope those to opt-in stakeholders
  // only — creator + favoriters; favoriting the platform app is the
  // subscription. Child apps keep the active-users fan-out: active-on-
  // that-app is already a meaningful audience.
  const { rows: appRows } = await pool.query(
    'SELECT self_hosted FROM apps WHERE id = $1',
    [appId]
  );
  const selfHosted = !!appRows[0]?.self_hosted;
  const activeIds = selfHosted ? [] : await listActiveUserIds(pool, appId);

  // App creator + favoriters as a stakeholder floor. Either may already
  // be in activeIds; we dedupe via the Set below.
  const { rows: extraRows } = await pool.query(
    `SELECT created_by AS id FROM apps WHERE id = $1 AND created_by IS NOT NULL
     UNION
     SELECT user_id AS id FROM app_favorites WHERE app_id = $1`,
    [appId]
  );

  let recipientIds = new Set([...activeIds, ...extraRows.map((r) => r.id)]);
  recipientIds.delete(proposerId);
  // Collab-private apps: only collaborators can vote, so only they get
  // nudged (a favoriter of a view-public/collab-private app would
  // otherwise be asked to vote on a PR they can't act on).
  recipientIds = new Set(await filterToCollaborators(pool, appId, [...recipientIds]));
  if (!recipientIds.size) return [];

  // INSERT ... SELECT with a NOT EXISTS guard keeps legacy-mode de-dupe atomic
  // (no read-then-write race on concurrent promotes). Activity-mode staging
  // rows are removed before commit, so a later re-promotion emits again.
  const ids = [...recipientIds];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     SELECT u, $2, $3, $4, 'pr_proposed'
       FROM UNNEST($1::int[]) AS u
      WHERE $5::boolean OR NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.user_id = u AND n.session_id = $3 AND n.kind = 'pr_proposed'
      )
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [ids, appId, sessionId, proposerId || null, notificationReadPath === 'activity']
  );
  return rows;
}

// Collaborator-invite notification (kind='collab_invite'). One row per
// outstanding invite; the actionable accept/decline UI lives in the
// drawer's pinned Invites section (driven by listPendingInvites below,
// the authoritative "still actionable" source) — this row is the badge
// bump + the history entry that remains after the invite resolves.
async function createCollabInviteNotification(pool, { appId, recipientId, inviterId }) {
  if (!recipientId || !appId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'collab_invite')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, inviterId || null]
  );
  return rows;
}

// Inviter feedback (kind='collab_invite_accepted'): "@x accepted your
// invite". Informational only — renders in the normal grouped list with
// the standard click-through, no buttons.
async function createCollabInviteAcceptedNotification(pool, { appId, recipientId, accepterId }) {
  if (!recipientId || !appId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'collab_invite_accepted')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, accepterId || null]
  );
  return rows;
}

// Approver-invite notification (kind='approver_invite', issue #646).
// Mirror of createCollabInviteNotification: badge bump + history row;
// the actionable accept/decline UI lives in the drawer's pinned
// Invites section (listPendingInvites below).
async function createApproverInviteNotification(pool, { appId, recipientId, inviterId }) {
  if (!recipientId || !appId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'approver_invite')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, inviterId || null]
  );
  return rows;
}

// Inviter feedback (kind='approver_invite_accepted'): "@x accepted your
// approver invite". Informational only, like collab_invite_accepted.
async function createApproverInviteAcceptedNotification(pool, { appId, recipientId, accepterId }) {
  if (!recipientId || !appId) return [];
  const rows = await insertNotificationRows(pool,
    `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
     VALUES ($1, $2, $3, 'approver_invite_accepted')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, accepterId || null]
  );
  return rows;
}

// Pending invites for the drawer's pinned Invites section. Sourced from
// app_collaborators / app_approvers (NOT the notifications table) so
// the section is authoritative about what's still actionable — a
// collab_invite / approver_invite notification row alone can't tell
// whether the invite was already accepted/declined in another tab.
// Each row carries `kind: 'collab' | 'approver'` so the drawer wires
// the right accept/decline endpoints and copy.
async function listPendingInvites(pool, userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT 'collab' AS kind, ac.app_id, a.slug AS app_slug, a.name AS app_name,
            ac.created_at, inv.username AS invited_by
       FROM app_collaborators ac
       JOIN apps a ON a.id = ac.app_id
       LEFT JOIN users inv ON inv.id = ac.invited_by
      WHERE ac.user_id = $1 AND ac.status = 'invited'
     UNION ALL
     SELECT 'approver' AS kind, ap.app_id, a.slug AS app_slug, a.name AS app_name,
            ap.created_at, inv.username AS invited_by
       FROM app_approvers ap
       JOIN apps a ON a.id = ap.app_id
       LEFT JOIN users inv ON inv.id = ap.invited_by
      WHERE ap.user_id = $1 AND ap.status = 'invited'
      ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    kind: r.kind,
    appId: r.app_id,
    appSlug: r.app_slug,
    appName: r.app_name,
    invitedBy: r.invited_by,
    createdAt: r.created_at,
  }));
}

// Resolve (mark read) the collab_invite notification rows for one
// (user, app) pair — called when the invite is accepted, declined, or
// auto-resolved by the app going collab-public. Idempotent.
async function markInviteNotificationsRead(pool, userId, appId) {
  if (!userId || !appId) return 0;
  if (notificationReadPath === 'activity') {
    if (!activityService) throw new Error('Activity service is not configured');
    const result = await activityService.readScope(userId, `social.collab-invite:${appId}`);
    return result.changed || 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND kind = 'collab_invite' AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Same for approver_invite rows (issue #646) — accepted, declined,
// revoked, or auto-resolved by the app's policy flipping back to
// 'anyone'. Idempotent.
async function markApproverInviteNotificationsRead(pool, userId, appId) {
  if (!userId || !appId) return 0;
  if (notificationReadPath === 'activity') {
    if (!activityService) throw new Error('Activity service is not configured');
    const result = await activityService.readScope(userId, `social.approver-invite:${appId}`);
    return result.changed || 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND kind = 'approver_invite' AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Fetch up to `limit` recent notifications for a user, newest first.
// Joins app + sender + message content so the UI dropdown can render in a
// single round-trip.
//
// Kudos notifications reference a chat_session instead of a chat_message,
// so we join both tables and the FE renderer picks the right one based on
// `kind`. Both joins are LEFT so mentions still render fine without a
// session and kudos still render fine without a message.
//
// Pagination (scroll-to-load-more): pass `before = { createdAt, id }` to
// fetch the page strictly older than that cursor. We compare the
// `(created_at, id)` tuple so rows sharing a `created_at` don't get
// skipped or repeated across page boundaries — the id is a stable
// tiebreak. Ordering + the keyset comparison ride the existing
// idx_notifications_user_recent index on (user_id, created_at DESC).
async function listForUser(pool, userId, { limit = 100, before = null } = {}) {
  const params = [userId];
  let cursorClause = '';
  if (before && before.createdAt && before.id != null) {
    params.push(before.createdAt, before.id);
    // $2 = cursor created_at, $3 = cursor id.
    cursorClause = `AND (n.created_at, n.id) < ($2, $3)`;
  }
  params.push(limit);
  const limitIdx = params.length; // last param is the limit
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            cm.thread_type, cm.thread_ref,
            n.session_id,
            cs.pr_title, cs.pr_number, cs.headless_issue_number, cs.branch_name,
            su.username AS source_username,
            n.detail
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN users su ON su.id = n.source_user_id
     WHERE n.user_id = $1
     ${cursorClause}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

async function countUnread(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rows[0]?.c || 0;
}

// "Action-completed" registry — the reusable auto-dismiss mechanism.
//
// Each entry names a moment in the app where some user action resolves a
// set of notification kinds, and which notifications column scopes that
// action's target. Adding a new auto-dismiss is a one-line entry here plus
// a call to markReadForAction() at the action site — no new bespoke
// function per trigger.
//
//   vote_cast    — user voted on a PR; clears the vote-request nudge
//                  (pr_proposed) + the author's going-quiet warning
//                  (stale_pr) for that PR. Scoped by session_id.
//                  Triggered in src/routes/votes.js after the vote upsert.
//   message_sent — user posted a message in an app's group chat; clears
//                  every unread chat-actionable notification (mention /
//                  reply / reaction) they have for that app. Scoped by
//                  app_id. Triggered in src/services/ws.js on chat send.
//
// `kudos` is deliberately excluded from both: it reports kudos received
// and is resolved by clicking its own dropdown row, not by voting or
// posting. `scope` is the notifications column name — it comes from this
// hardcoded table, never from request input, so there is no
// SQL-injection surface in markReadForAction's interpolation.
const ACTION_COMPLETIONS = {
  vote_cast: { kinds: ['pr_proposed', 'stale_pr'], scope: 'session_id' },
  message_sent: { kinds: ['mention', 'reply', 'reaction'], scope: 'app_id' },
  // #161: opening a dev session is the canonical "user saw it" signal —
  // it resolves that session's completion notification even when the
  // user navigated there on their own. Triggered in GET /api/sessions/:id.
  session_opened: { kinds: ['session_done'], scope: 'session_id' },
  // #161: cloning a ready auto-solve session resolves its completion
  // notification. Triggered in POST /api/sessions/:id/clone-headless,
  // scoped to the SOURCE (headless) session id.
  headless_cloned: { kinds: ['auto_solve_done'], scope: 'session_id' },
};

// The scope columns the registry is allowed to target. A defensive
// allowlist so a typo in ACTION_COMPLETIONS can never widen the set of
// interpolatable column names beyond these two.
const SCOPE_COLUMNS = new Set(['session_id', 'app_id']);
const ACTIVITY_ACTION_SCOPES = {
  vote_cast: 'social.vote-request',
  message_sent: 'social.chat-engagement',
  session_opened: 'social.session-completion',
  headless_cloned: 'social.auto-solve-completion',
};

// Generic auto-dismiss primitive. Activity mode translates the business
// action to an opaque read scope; the temporary legacy branch updates
// Social read_at. Returns the number of entries actually changed.
async function markReadForAction(pool, userId, action, scopeId) {
  const def = ACTION_COMPLETIONS[action];
  if (!def) throw new Error(`unknown notification action: ${action}`);
  if (!SCOPE_COLUMNS.has(def.scope)) throw new Error(`bad scope column: ${def.scope}`);
  if (!userId || !scopeId) return 0;
  if (notificationReadPath === 'activity') {
    if (!activityService) throw new Error('Activity service is not configured');
    const scopePrefix = ACTIVITY_ACTION_SCOPES[action];
    if (!scopePrefix) throw new Error(`missing Activity scope for action: ${action}`);
    const result = await activityService.readScope(userId, `${scopePrefix}:${scopeId}`);
    return result.changed || 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND ${def.scope} = $2 AND kind = ANY($3) AND read_at IS NULL`,
    [userId, scopeId, def.kinds]
  );
  return rowCount || 0;
}

// Thin back-compat wrapper so src/routes/votes.js keeps calling the
// session-scoped vote dismiss unchanged.
async function markReadForSession(pool, userId, sessionId) {
  return markReadForAction(pool, userId, 'vote_cast', sessionId);
}

// Clear a single notification by the chat message it points at — the
// in-chat "click a dotted message" path. Scoped to the requesting user
// and to the chat-actionable kinds so clicking a message can't clear an
// unrelated kind that happens to reference it. Idempotent via WHERE
// read_at IS NULL; returns rows cleared.
async function markReadForMessage(pool, userId, chatMessageId) {
  if (!userId || !chatMessageId) return 0;
  if (notificationReadPath === 'activity') {
    if (!activityService) throw new Error('Activity service is not configured');
    const result = await activityService.readScope(
      userId, `social.chat-message:${chatMessageId}`
    );
    return result.changed || 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND chat_message_id = $2
        AND kind = ANY($3) AND read_at IS NULL`,
    [userId, chatMessageId, ACTION_COMPLETIONS.message_sent.kinds]
  );
  return rowCount || 0;
}

// Given a page of chat message ids, return the subset that currently have
// an unread chat-actionable notification for `userId` — so the messages
// endpoint can flag which rows render an unread dot. Returns a Set of ids.
async function unreadMessageIdsForUser(pool, userId, messageIds) {
  if (!userId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return new Set();
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT chat_message_id
       FROM notifications
      WHERE user_id = $1
        AND chat_message_id = ANY($2::int[])
        AND kind = ANY($3)
        AND read_at IS NULL`,
    [userId, messageIds, ACTION_COMPLETIONS.message_sent.kinds]
  );
  return new Set(rows.map((r) => r.chat_message_id));
}

// Per-app mark-read — backs the notifications dropdown's per-group
// "Mark read" affordance (#84 grouping). Clears every unread
// notification this user has for one app, regardless of kind, in a
// single round-trip. Unlike markReadForAction (which is scoped to a
// fixed set of kinds tied to a user action), this is a deliberate
// "I've seen everything from this app" gesture, so it spans all kinds.
// Idempotent via the read_at IS NULL guard; returns rows cleared so the
// route can decide whether to fan out a cross-tab refresh.
async function markReadForApp(pool, userId, appId) {
  if (!userId || !appId) return 0;
  if (notificationReadPath === 'activity') {
    if (!activityService) throw new Error('Activity service is not configured');
    const result = await activityService.readScope(userId, `social.app:${appId}`);
    return result.changed || 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND read_at IS NULL`,
    [userId, appId]
  );
  return rowCount || 0;
}

// Single-id and mark-all clears. Returns rows actually cleared (like the
// scoped helpers above) so the route can decide whether to fan out a
// cross-tab `notifications_changed` refresh.
async function markRead(pool, userId, { id, all = false, kinds = null, excludeKinds = null } = {}) {
  if (all) {
    // Optional kind scoping for the split drawers: the header cog's
    // "Mark all read" sends kinds=[the session-related set] so it only
    // clears its own rows; the bell's sends excludeKinds=[same set] so
    // it never clears the cog's. No scope = the historical clear-all.
    if (Array.isArray(kinds) && kinds.length) {
      const { rowCount } = await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL AND kind = ANY($2)`,
        [userId, kinds]
      );
      return rowCount || 0;
    }
    if (Array.isArray(excludeKinds) && excludeKinds.length) {
      const { rowCount } = await pool.query(
        `UPDATE notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL AND NOT (kind = ANY($2))`,
        [userId, excludeKinds]
      );
      return rowCount || 0;
    }
    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    );
    return rowCount || 0;
  }
  if (!id) return 0;
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId]
  );
  return rowCount || 0;
}

// Decorate a legacy Social row with the fields the client dropdown wants.
//
// Kudos extension: sessionId / prTitle / prNumber ride along whenever the
// row carries a session reference. The FE renderer keys off `kind` to
// decide which fields to use — kudos rows ignore chatMessageId /
// messageContent, mention rows ignore sessionId / prTitle.
function serialize(row) {
  return {
    id: row.id,
    // Stable source identity used only to detect newly materialized browser
    // alerts. The legacy id and Activity inboxSequence remain read handles.
    occurrenceId: `social.notification:${row.id}`,
    kind: row.kind,
    readAt: row.read_at,
    createdAt: row.created_at,
    appId: row.app_id,
    appSlug: row.app_slug,
    appName: row.app_name,
    chatMessageId: row.chat_message_id,
    messageContent: row.message_content,
    // #194 parity: when the referenced chat message lives in a topic
    // thread, these route the click to that topic instead of general chat.
    threadType: row.thread_type || null,
    threadRef: row.thread_ref != null ? row.thread_ref : null,
    sessionId: row.session_id,
    prTitle: row.pr_title,
    prNumber: row.pr_number,
    // #161: auto_solve_done rows route back to their issue row; the
    // session_done renderer falls back to the branch name when the
    // session has no LLM-generated PR title yet.
    headlessIssueNumber: row.headless_issue_number,
    branchName: row.branch_name,
    sourceUsername: row.source_username,
    detail: row.detail,
  };
}

module.exports = {
  parseMentions,
  resolveUsers,
  configureActivity,
  insertNotificationRows,
  buildActivityEvent,
  WORK_NOTIFICATION_KINDS,
  notificationSectionForKind,
  readScopeForNotificationSection,
  createMentionNotifications,
  createReplyNotification,
  createReactionNotification,
  createKudosNotification,
  createStalePrNotification,
  createCheckFailedNotification,
  createSessionDoneNotification,
  createAutoSolveDoneNotification,
  createSpecSharedNotification,
  createPrProposedNotifications,
  createCollabInviteNotification,
  createCollabInviteAcceptedNotification,
  createApproverInviteNotification,
  createApproverInviteAcceptedNotification,
  listPendingInvites,
  markInviteNotificationsRead,
  markApproverInviteNotificationsRead,
  filterToCollaborators,
  listForUser,
  countUnread,
  markRead,
  markReadForSession,
  markReadForAction,
  markReadForApp,
  markReadForMessage,
  unreadMessageIdsForUser,
  ACTION_COMPLETIONS,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
