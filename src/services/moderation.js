'use strict';

const appAccess = require('./app-access');
const REMOVED = 'Removed by moderation';
const REASONS = new Set(['spam', 'scam', 'harassment', 'hate', 'threats', 'sexual_content', 'impersonation', 'unsafe_avatar', 'unsafe_content', 'other']);
const TYPES = new Set(['app', 'user', 'app_message', 'conversation_message']);
const STATUSES = new Set(['new', 'in_review', 'resolved', 'dismissed']);
const ACTIONS = {
  app: ['suspend_app', 'restore_app'],
  user: ['hide_profile', 'restore_profile', 'restrict_user', 'restore_user'],
  app_message: ['hide_message', 'restore_message'],
  conversation_message: ['hide_message', 'restore_message'],
};
class ModerationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ModerationError(status, message); };
function id(value) {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) <= 2147483647 ? Number(text) : null;
}
function details(value, required = false) {
  if (value != null && typeof value !== 'string') fail(400, 'Details must be text');
  const text = (value || '').trim();
  if (text.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail(400, 'Details must contain at most 1,000 characters');
  if (required && !text) fail(400, 'Please explain the reason');
  return text;
}
async function transaction(pool, fn) {
  const db = await pool.connect();
  let result, notifications = [];
  try {
    await db.query('BEGIN'); result = await fn(db); await db.query('COMMIT');
    notifications = db.moderationNotifications || [];
  } catch (err) { await db.query('ROLLBACK').catch(() => {}); throw err; }
  finally { delete db.moderationNotifications; db.release(); }
  await Promise.all(notifications.map(id => require('./notifications').hydrateAndPush(pool, { id }).catch(() => {})));
  return result;
}

// Only visible content enters evidence; account secrets and whole private
// conversations are never selected. Row locks serialize snapshots with edits.
async function resolveTarget(db, user, type, key, lock = false) {
  if (!TYPES.has(type)) fail(400, 'Invalid report target');
  if (!user?.id) fail(401, 'Sign in to report');
  if (type === 'app') {
    const { rows } = await db.query(
      `SELECT id, slug, name, created_by, self_hosted, main_sha, collab_visibility, view_visibility, moderation_suspended_at
         FROM apps WHERE slug = $1 ${lock ? 'FOR SHARE' : ''}`, [String(key)]);
    const app = rows[0];
    if (!app || !(await appAccess.checkAppAccess(db, app, user, 'view'))) fail(404, 'Target unavailable');
    if (Number(app.created_by) === Number(user.id)) fail(400, 'You cannot report your own app.');
    return { id: app.id, userId: app.created_by, label: app.name, blockAppSlug: app.self_hosted ? null : app.slug,
      evidence: { name: app.name, slug: app.slug, deployedVersion: app.main_sha }, files: [] };
  }
  if (type === 'user') {
    const { rows } = await db.query(
      `SELECT id, username, display_name, bio, profile_published, profile_disabled_at
         FROM users WHERE username = $1 ${lock ? 'FOR SHARE' : ''}`, [String(key)]);
    const row = rows[0];
    if (!row || row.id === user.id) fail(404, 'Target unavailable');
    // A non-public profile can still be reported by someone who has actually
    // encountered this person. The lookup does not become a user directory.
    if (!row.profile_published || row.profile_disabled_at) {
      const visible = await db.query(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM conversation_members mine JOIN conversation_members theirs
             ON mine.conversation_id = theirs.conversation_id
            WHERE mine.user_id = $1 AND theirs.user_id = $2
              AND mine.status IN ('member','invited') AND theirs.status = 'member'
         ) OR EXISTS (
           SELECT 1 FROM chat_messages m JOIN apps a ON a.id = m.app_id
            WHERE m.user_id = $2 AND (a.view_visibility = 'public' OR EXISTS (
              SELECT 1 FROM app_collaborators ac WHERE ac.app_id = a.id
                AND ac.user_id = $1 AND ac.status = 'member'))
         )`, [user.id, row.id]);
      if (!visible.rows.length) fail(404, 'Target unavailable');
    }
    const published = row.profile_published && !row.profile_disabled_at;
    const avatars = await db.query(
      `SELECT id, 'Profile avatar'::text AS filename, content_type, data FROM user_avatars WHERE user_id = $1`, [row.id]);
    return { id: row.id, userId: row.id, label: `@${row.username}`,
      evidence: { username: row.username, ...(published ? { displayName: row.display_name, bio: row.bio } : {}) }, files: avatars.rows };
  }
  const messageId = id(key);
  if (!messageId) fail(404, 'Target unavailable');
  const conversation = type === 'conversation_message';
  const table = conversation ? 'conversation_messages' : 'chat_messages';
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [messageId]);
  const row = rows[0];
  if (!row || (conversation ? row.sender_id : row.user_id) === user.id) fail(404, 'Target unavailable');
  let location;
  if (conversation) {
    const membership = await require('./conversations').loadMembership(db, row.conversation_id, user.id);
    if (!membership || !(await require('./conversations').canDirectInteract(db, membership, user.id))) fail(404, 'Target unavailable');
    location = membership.title || (membership.kind === 'direct' ? 'Direct conversation' : 'Group conversation');
  } else {
    const apps = await db.query(`SELECT ${appAccess.ACCESS_COLUMNS} FROM apps WHERE id = $1`, [row.app_id]);
    if (!apps.rows[0] || !(await appAccess.checkAppAccess(db, apps.rows[0], user, 'view'))) fail(404, 'Target unavailable');
    location = apps.rows[0].name || apps.rows[0].slug || `App #${row.app_id}`;
    // Private coding-session discussions have an additional owner/share gate.
    if (row.thread_type === 'session') {
      const s = await db.query('SELECT user_id, shared_at FROM chat_sessions WHERE id = $1 AND app_id = $2', [row.thread_ref, row.app_id]);
      if (!s.rows[0] || (s.rows[0].user_id !== user.id && !s.rows[0].shared_at && !user.isAdmin)) fail(404, 'Target unavailable');
    }
  }
  const authorId = conversation ? row.sender_id : row.user_id;
  const blocked = await db.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2', [user.id, authorId]);
  if (blocked.rows.length) fail(404, 'Target unavailable');
  const author = await db.query('SELECT username FROM users WHERE id = $1', [authorId]);
  const objects = conversation && !row.moderation_hidden_at
    ? (await require('./shared-objects').hydrateForMessages(db, user, [row.id])).get(row.id) || [] : [];
  const files = await db.query(
    `SELECT id, filename, content_type, data FROM ${conversation ? 'conversation_message_attachments' : 'chat_message_attachments'} WHERE message_id = $1`, [row.id]);
  return { id: row.id, userId: conversation ? row.sender_id : row.user_id,
    label: `${conversation ? 'Private' : 'App'} message #${row.id}`,
    evidence: { author: author.rows[0]?.username || null, location, content: row.content, createdAt: row.created_at, editedAt: row.edited_at,
      conversationId: row.conversation_id || null, appId: row.app_id || null,
      threadType: row.thread_type || null, threadRef: row.thread_ref || null, objects },
    files: row.moderation_hidden_at ? [] : files.rows };
}
function blockActions(type, target, userId) {
  if (type === 'app') return { blockUserId: null, blockAppSlug: target.blockAppSlug || null };
  return { blockAppSlug: null, blockUserId: target.userId !== userId ? target.userId : null,
    blockUsername: type === 'user' ? target.evidence.username : target.evidence.author };
}
async function notify(db, userId, kind, detail) {
  if (!userId) return;
  const { rows } = await db.query('INSERT INTO notifications (user_id, kind, detail) VALUES ($1, $2, $3) RETURNING id', [userId, kind, detail.slice(0, 1200)]);
  (db.moderationNotifications ||= []).push(rows[0].id);
}
async function submitReport(pool, user, input) {
  if (!user?.id) fail(401, 'Sign in to report');
  if (!input || !REASONS.has(input.reason)) fail(400, 'Choose a report reason');
  const detail = details(input.detail, input.reason === 'other');
  return transaction(pool, async (db) => {
    // Per-user transactional rate guard includes all target types and devices.
    await db.query('SELECT pg_advisory_xact_lock(2721, $1)', [user.id]);
    let target = await resolveTarget(db, user, input.targetType, input.target);
    await db.query(
      `INSERT INTO moderation_cases (target_type, target_id, target_label, target_user_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (target_type,target_id) DO NOTHING`,
      [input.targetType, target.id, target.label, target.userId]);
    const { rows: cases } = await db.query(
      'SELECT * FROM moderation_cases WHERE target_type = $1 AND target_id = $2 FOR UPDATE', [input.targetType, target.id]);
    const c = cases[0];
    // Case before target row: same lock order as moderator actions. Recheck
    // access and snapshot only after both have been locked.
    target = await resolveTarget(db, user, input.targetType, input.target, true);
    if (['new', 'in_review'].includes(c.status)) {
      const existing = await db.query(`SELECT id FROM moderation_reports WHERE case_id = $1 AND (cycle = $2 OR (cycle = 0 AND evidence->>'legacyStatus' = 'pending')) AND reporter_user_id = $3`, [c.id, c.cycle, user.id]);
      if (existing.rows.length) return { id: existing.rows[0].id, received: true, duplicate: true, ...blockActions(input.targetType, target, user.id) };
    }
    const rate = await db.query(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS hourly, COUNT(*) AS daily
         FROM moderation_reports WHERE reporter_user_id = $1 AND created_at > NOW() - INTERVAL '1 day'`, [user.id]);
    if (Number(rate.rows[0].hourly) >= 10 || Number(rate.rows[0].daily) >= 30) fail(429, 'Reporting limit reached. Please try again later.');
    if (['resolved', 'dismissed'].includes(c.status)) {
      c.cycle++;
      await db.query("UPDATE moderation_cases SET cycle = $2, status = 'new', closed_at = NULL, revision = revision + 1, updated_at = NOW() WHERE id = $1", [c.id, c.cycle]);
    }
    const { rows } = await db.query(
      `INSERT INTO moderation_reports (case_id, cycle, reporter_user_id, reason, detail, evidence)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [c.id, c.cycle, user.id, input.reason, detail, JSON.stringify(target.evidence)]);
    for (const file of target.files) {
      const saved = await db.query(
        `INSERT INTO moderation_evidence_files (source_type, source_id, filename, content_type, data)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_type,source_id) DO UPDATE SET source_id = EXCLUDED.source_id RETURNING id`,
        [input.targetType, file.id, file.filename, file.content_type, file.data]);
      await db.query('INSERT INTO moderation_report_files (report_id,file_id) VALUES ($1,$2)', [rows[0].id, saved.rows[0].id]);
    }
    await db.query('UPDATE moderation_cases SET revision = revision + 1, updated_at = NOW() WHERE id = $1', [c.id]);
    await notify(db, user.id, 'moderation_report', `Report #${rows[0].id} received. We’ll review it.`);
    return { id: rows[0].id, received: true, duplicate: false, ...blockActions(input.targetType, target, user.id) };
  });
}

async function moderate(pool, actor, caseId, input) {
  if (!actor?.canAdminWrite) fail(403, 'Administrator write access required');
  const action = input?.action;
  const reason = details(input?.reason, true);
  if (!Number.isSafeInteger(input?.revision)) fail(400, 'Case revision required');
  return transaction(pool, async (db) => {
    if (action === 'restrict_user') await db.query('SELECT pg_advisory_xact_lock($1)', [require('./advisory-locks').ADMIN_MUTATION_LOCK]);
    const { rows } = await db.query('SELECT * FROM moderation_cases WHERE id = $1 FOR UPDATE', [caseId]);
    const c = rows[0];
    if (!c) fail(404, 'Case not found');
    if (c.revision !== input.revision) fail(409, 'This case changed. Refresh before acting.');
    const caseAction = ['review', 'resolve', 'dismiss', 'reopen', 'note'].includes(action);
    if (!caseAction && !ACTIONS[c.target_type].includes(action)) fail(400, 'Action does not apply to this target');
    if (['resolved', 'dismissed'].includes(c.status) && action === 'review') fail(409, 'Reopen this case first');
    if (['resolve', 'dismiss'].includes(action) && ['resolved', 'dismissed'].includes(c.status)) fail(409, 'Case already closed');
    if (action === 'reopen' && !['resolved', 'dismissed'].includes(c.status)) fail(409, 'Case is already open');
    let effect = null;
    if (action === 'hide_message' || action === 'restore_message') {
      const table = c.target_type === 'app_message' ? 'chat_messages' : 'conversation_messages';
      const message = await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [c.target_id]);
      const m = message.rows[0];
      if (!m) fail(404, 'Message no longer exists');
      if (action === 'hide_message') {
        if (m.moderation_hidden_at) fail(409, 'Message is already hidden');
        await db.query(
          `INSERT INTO moderation_message_originals (target_type,target_id,content,metadata)
           VALUES ($1,$2,$3,$4) ON CONFLICT (target_type,target_id) DO NOTHING`,
          [c.target_type, m.id, m.content, m.metadata ? JSON.stringify(m.metadata) : null]);
        await db.query(`UPDATE ${table} SET content = $2, moderation_hidden_at = NOW()${c.target_type === 'app_message' ? ", metadata = '{}'::jsonb" : ''} WHERE id = $1`, [m.id, REMOVED]);
        await db.query(`DELETE FROM notifications WHERE ${c.target_type === 'app_message' ? 'chat_message_id' : 'conversation_message_id'} = $1`, [m.id]);
      } else {
        if (!m.moderation_hidden_at) fail(409, 'Message is not hidden');
        const original = await db.query('SELECT content, metadata FROM moderation_message_originals WHERE target_type = $1 AND target_id = $2', [c.target_type, m.id]);
        if (!original.rows[0]) fail(409, 'Original content is unavailable');
        const o = original.rows[0];
        await db.query(`UPDATE ${table} SET content = $2, moderation_hidden_at = NULL${c.target_type === 'app_message' ? ', metadata = $3' : ''} WHERE id = $1`, c.target_type === 'app_message' ? [m.id, o.content, o.metadata] : [m.id, o.content]);
        await db.query('DELETE FROM moderation_message_originals WHERE target_type = $1 AND target_id = $2', [c.target_type, m.id]);
      }
      effect = { type: c.target_type, id: m.id, appId: m.app_id, conversationId: m.conversation_id };
    } else if (action === 'suspend_app' || action === 'restore_app') {
      const result = await db.query(`UPDATE apps SET moderation_suspended_at = ${action === 'suspend_app' ? 'NOW()' : 'NULL'} WHERE id = $1 AND self_hosted IS NOT TRUE AND moderation_suspended_at IS ${action === 'suspend_app' ? 'NULL' : 'NOT NULL'} RETURNING id`, [c.target_id]);
      if (!result.rows.length) fail(409, 'App unavailable, already in this state, or the platform app cannot be suspended here');
      effect = { type: 'app', appId: c.target_id, suspended: action === 'suspend_app' };
    } else if (action === 'restrict_user' || action === 'restore_user') {
      if (action === 'restrict_user') {
        if (Number(c.target_id) === Number(actor.id)) fail(409, 'You cannot restrict your own account');
        const target = await db.query('SELECT is_admin, admin_readonly FROM users WHERE id = $1 FOR UPDATE', [c.target_id]);
        if (!target.rows[0]) fail(404, 'User no longer exists');
        if (target.rows[0].is_admin && !target.rows[0].admin_readonly) {
          const others = await db.query('SELECT id FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE AND participation_restricted_at IS NULL AND id <> $1', [c.target_id]);
          if (!others.rows.length) fail(409, 'Cannot restrict the last full administrator');
        }
      }
      const changed = await db.query(`UPDATE users SET participation_restricted_at = ${action === 'restrict_user' ? 'NOW()' : 'NULL'} WHERE id = $1 AND participation_restricted_at IS ${action === 'restrict_user' ? 'NULL' : 'NOT NULL'} RETURNING id`, [c.target_id]);
      if (!changed.rows.length) fail(409, 'User unavailable or participation state already changed');
    } else if (action === 'hide_profile' || action === 'restore_profile') {
      const changed = await db.query(`UPDATE users SET profile_disabled_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END, profile_disabled_by = CASE WHEN $2::boolean THEN $3::integer ELSE NULL END, profile_disabled_reason = CASE WHEN $2::boolean THEN $4::text ELSE NULL END, profile_updated_at = NOW() WHERE id = $1 AND (profile_disabled_at IS NOT NULL) <> $2::boolean RETURNING id`, [c.target_id, action === 'hide_profile', actor.id, reason.slice(0,240)]);
      if (!changed.rows.length) fail(409, 'User unavailable or profile state already changed');
    }
    const status = { review: 'in_review', resolve: 'resolved', dismiss: 'dismissed', reopen: 'new' }[action] || c.status;
    await db.query(
      `UPDATE moderation_cases SET status = $2::varchar(16), revision = revision + 1, updated_at = NOW(),
         closed_at = CASE WHEN $2::varchar(16) IN ('resolved','dismissed') THEN COALESCE(closed_at,NOW()) ELSE NULL END WHERE id = $1`, [c.id, status]);
    await db.query('INSERT INTO moderation_actions (case_id,actor_id,action,reason) VALUES ($1,$2,$3,$4)', [c.id, actor.id, action, reason]);
    if (action === 'resolve' || action === 'dismiss') {
      const reporters = await db.query('SELECT DISTINCT reporter_user_id FROM moderation_reports WHERE case_id = $1 AND (cycle = $2 OR (cycle = 0 AND evidence->>\'legacyStatus\' = \'pending\'))', [c.id, c.cycle]);
      await db.query(`UPDATE profile_reports old SET status = $2, resolved_at = NOW(), resolved_by = $3 FROM moderation_reports r WHERE r.case_id = $1 AND r.legacy_type = 'profile' AND r.legacy_id = old.id AND old.status = 'pending'`, [c.id,status,actor.id]);
      await db.query(`UPDATE conversation_message_reports old SET status = $2, resolved_at = NOW(), resolved_by = $3 FROM moderation_reports r WHERE r.case_id = $1 AND r.legacy_type = 'conversation' AND r.legacy_id = old.id AND old.status = 'pending'`, [c.id,status,actor.id]);
      await db.query(`UPDATE chat_message_reports old SET status = $2, resolved_at = NOW(), resolved_by = $3 FROM moderation_reports r WHERE r.case_id = $1 AND r.legacy_type = 'app_message' AND r.legacy_id = old.id AND old.status = 'pending'`, [c.id,status,actor.id]);
      await db.query(`UPDATE app_reports old SET status = $2, resolved_at = NOW(), resolved_by = $3 FROM moderation_reports r WHERE r.case_id = $1 AND r.legacy_type = 'app' AND r.legacy_id = old.id AND old.status = 'pending'`, [c.id,status,actor.id]);
      for (const r of reporters.rows) await notify(db, r.reporter_user_id, 'moderation_report', `Your report has been reviewed. ${action === 'resolve' ? 'Review completed.' : 'The case was dismissed.'}`);
    } else if (!caseAction) {
      const labels = { hide_message: 'Your message was hidden', restore_message: 'Your message was restored', suspend_app: 'Your app was suspended', restore_app: 'Your app was restored', hide_profile: 'Your public profile was hidden', restore_profile: 'Your public profile was restored', restrict_user: 'Your participation was restricted', restore_user: 'Your participation was restored' };
      await notify(db, c.target_user_id, 'moderation_action', `${labels[action]}. Reason: ${reason}`);
    }
    return { id: c.id, revision: c.revision + 1, status, effect };
  });
}

async function isRestricted(db, userId) {
  if (!userId) return false;
  const { rows } = await db.query('SELECT participation_restricted_at FROM users WHERE id = $1', [userId]);
  return !!rows[0]?.participation_restricted_at;
}
async function purgeExpired(db) {
  // Migrated records have one retention clock. Remove old copies before
  // dropping unified metadata, so boot-time import cannot resurrect them.
  await db.query(`DELETE FROM profile_reports old USING moderation_reports r, moderation_cases c WHERE r.case_id = c.id AND r.legacy_type = 'profile' AND r.legacy_id = old.id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query(`DELETE FROM conversation_message_reports old USING moderation_reports r, moderation_cases c WHERE r.case_id = c.id AND r.legacy_type = 'conversation' AND r.legacy_id = old.id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query(`DELETE FROM chat_message_reports old USING moderation_reports r, moderation_cases c WHERE r.case_id = c.id AND r.legacy_type = 'app_message' AND r.legacy_id = old.id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query(`DELETE FROM app_reports old USING moderation_reports r, moderation_cases c WHERE r.case_id = c.id AND r.legacy_type = 'app' AND r.legacy_id = old.id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query(`DELETE FROM moderation_report_files f USING moderation_reports r, moderation_cases c
    WHERE f.report_id = r.id AND r.case_id = c.id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query(`UPDATE moderation_reports r SET evidence = NULL, detail = NULL FROM moderation_cases c
    WHERE c.id = r.case_id AND c.closed_at < NOW() - INTERVAL '180 days'`);
  await db.query('DELETE FROM moderation_evidence_files f WHERE NOT EXISTS (SELECT 1 FROM moderation_report_files r WHERE r.file_id = f.id)');
  await db.query("DELETE FROM moderation_actions WHERE created_at < NOW() - INTERVAL '1 year'");
  await db.query(`DELETE FROM moderation_reports r USING moderation_cases c WHERE r.case_id = c.id AND c.closed_at < NOW() - INTERVAL '1 year'`);
  // Hidden originals are retained live content needed for restoration, not
  // report evidence. Once their message is deleted they have no purpose.
  await db.query(`DELETE FROM moderation_message_originals o WHERE o.target_type = 'app_message' AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = o.target_id)`);
  await db.query(`DELETE FROM moderation_message_originals o WHERE o.target_type = 'conversation_message' AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = o.target_id)`);
}
module.exports = { REMOVED, REASONS, TYPES, STATUSES, ACTIONS, ModerationError, id, details, transaction, resolveTarget, submitReport, moderate, isRestricted, purgeExpired };
