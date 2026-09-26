'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { ADMIN_MUTATION_LOCK } = require('./advisory-locks');
const { acquireUserLock } = require('./cli-auth');
const { revokeNativeSessionCredentials } = require('./native-session-revocation');

class AccountDeletionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function reject(status, code, message) { throw new AccountDeletionError(status, code, message); }

async function queueTask(db, deletionId, kind, target, state = 'pending') {
  await db.query(
    `INSERT INTO account_deletion_tasks (deletion_id, kind, target, state)
     VALUES ($1, $2, $3, $4) ON CONFLICT (deletion_id, kind, target) DO NOTHING`,
    [deletionId, kind, String(target), state]
  );
}

// Account deletion anonymises the users row instead of deleting it (both the
// self-service and the admin paths). Contributions — proposals, messages,
// votes, reactions, accounting — keep a nameless author; the identity, its
// sign-in material and its private data go exactly as a DELETE's cascades
// took them. Rows of these ON DELETE CASCADE tables are the contributions
// and STAY on the anonymised row. Every other cascading table is emptied for
// the account. SET NULL tables keep pointing at the anonymised row.
const KEEP_ON_ANONYMISE = Object.freeze(new Set([
  'public.app_activity',
  'public.conversation_direct_pairs',
  'public.conversation_members',
  'public.conversation_message_reactions',
  'public.feedback_reports',
  'public.leaderboard_snapshots',
  'public.local_agent_turns',
  'public.message_reactions',
  'public.support_actions',
  'public.topic_attribute_votes',
  'public.user_activities',
  'public.user_enrollments',
]));

const ANON_EMAIL_DOMAIN = 'onhomeroom.com';
function anonymisedEmail(userId) {
  return `support+anonym+${userId}@${ANON_EMAIL_DOMAIN}`;
}

async function cascadingUserColumns(db) {
  const { rows } = await db.query(
    `SELECT n.nspname AS schema_name, r.relname AS table_name, a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
        AND c.confdeltype = 'c' AND cardinality(c.conkey) = 1
      ORDER BY n.nspname, r.relname, a.attname`
  );
  return rows.filter(r => !KEEP_ON_ANONYMISE.has(`${r.schema_name}.${r.table_name}`));
}

const ident = name => `"${String(name).replace(/"/g, '""')}"`;

// Separate statements, unlike one cascading DELETE, see foreign keys between
// the purged tables one at a time. Each delete runs under a savepoint and a
// blocked one (23503) is retried after the others, until nothing is left.
async function purgeCascadingRows(db, userId) {
  let pending = await cascadingUserColumns(db);
  while (pending.length) {
    const blocked = [];
    for (const col of pending) {
      await db.query('SAVEPOINT anonymise_purge');
      try {
        await db.query(`DELETE FROM ${ident(col.schema_name)}.${ident(col.table_name)} WHERE ${ident(col.column_name)} = $1`, [userId]);
        await db.query('RELEASE SAVEPOINT anonymise_purge');
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT anonymise_purge');
        if (err.code !== '23503') throw err;
        blocked.push(col);
      }
    }
    if (blocked.length === pending.length) throw new Error('Account anonymisation is blocked by a foreign key');
    pending = blocked;
  }
}

async function placeholderUsername(db, userId) {
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? `deleted-user-${userId}` : `deleted-user-${userId}-${crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)) OR
              EXISTS (SELECT 1 FROM username_history WHERE LOWER(username) = LOWER($1)) OR
              EXISTS (SELECT 1 FROM deleted_username_reservations
                       WHERE fingerprint = encode(sha256(convert_to(LOWER($1), 'UTF8')), 'hex')) AS taken`,
      [candidate]
    );
    if (!rows[0].taken) return candidate;
  }
  throw new Error('No free placeholder username for the anonymised account');
}

async function anonymiseUser(db, userId, unusablePassword) {
  // What the users BEFORE DELETE trigger did: hand group ownership on,
  // archive direct conversations. Then leave the remaining groups.
  await db.query('SELECT prepare_conversations_for_user_exit($1)', [userId]);
  await db.query(`UPDATE conversation_members cm SET status = 'removed', role = 'member', left_at = NOW()
    FROM conversations c WHERE c.id = cm.conversation_id AND c.kind = 'group'
      AND cm.user_id = $1 AND cm.status = 'member'`, [userId]);
  await db.query(`UPDATE conversation_members cm SET status = 'declined', responded_at = NOW()
    FROM conversations c WHERE c.id = cm.conversation_id AND c.kind = 'group'
      AND cm.user_id = $1 AND cm.status = 'invited'`, [userId]);
  await purgeCascadingRows(db, userId);
  const username = await placeholderUsername(db, userId);
  await db.query(
    `UPDATE users SET username = $2, password = $3, password_set = FALSE,
            password_reset_token_hash = NULL, password_reset_expires_at = NULL,
            email = $4, email_confirmed = FALSE, email_confirmed_at = NULL,
            email_confirmation_token = NULL, email_confirmation_sent_at = NULL,
            display_name = NULL, telegram = NULL, discord = NULL, github = NULL, x = NULL,
            country = NULL, city = NULL, bio = NULL, locale = NULL, referrer = NULL, referrer_handle = NULL,
            device_info = NULL, waitlist_ip = NULL, waitlist_answers = NULL, waitlist_submitted_at = NULL,
            is_in_waitlist = FALSE, profile_published = FALSE, profile_updated_at = NULL,
            home_panel_positions = '{}'::jsonb, dev_flow_preference = NULL,
            is_admin = FALSE, admin_readonly = FALSE, can_create_apps = FALSE, app_quota = 0,
            app_quota_requested_at = NULL, has_platform_access = FALSE, exclude_podium = TRUE,
            anthropic_key_enc = NULL, anthropic_key_last4 = NULL,
            usernode_pubkey = NULL, wallet_link_token = NULL, wallet_link_expires_at = NULL,
            github_login = NULL, github_oauth_token_enc = NULL, github_linked_at = NULL,
            needs_username_choice = FALSE, anonymised_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [userId, username, unusablePassword, anonymisedEmail(userId)]
  );
}

// Every entry point uses this transaction, including both admin consoles.
// No remote calls occur while locks are held. Their durable tasks commit with
// the erasure so a crash or provider outage cannot lose the cleanup request.
async function deleteAccount(pool, { userId, actorId, mode, confirmation, password, sessionToken }) {
  if (!Number.isSafeInteger(userId) || userId <= 0) reject(400, 'invalid_user', 'Invalid user.');
  if (mode !== 'self' && mode !== 'admin') reject(400, 'invalid_mode', 'Invalid deletion mode.');
  if (mode === 'self' && actorId !== userId) reject(403, 'forbidden', 'You can only delete your own account.');
  if (mode === 'admin' && actorId === userId) reject(400, 'self_delete', 'Use Settings → Account → Delete account to delete your own account.');
  // Hashed before the transaction: bcrypt must not run while locks are held.
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const db = await pool.connect();
  let result;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
    await acquireUserLock(db, userId);
    const { rows: actors } = await db.query('SELECT is_admin, admin_readonly FROM users WHERE id = $1', [actorId]);
    if (!actors.length || (mode === 'admin' && (!actors[0].is_admin || actors[0].admin_readonly))) {
      reject(403, 'forbidden', 'A full administrator is required.');
    }
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows[0];
    // A retry finds the anonymised row (or, for an account deleted before
    // anonymisation, no row) and returns the first receipt.
    const prior = user && !user.anonymised_at ? { rows: [] }
      : await db.query('SELECT id FROM account_deletions WHERE user_id = $1', [userId]);
    if (!user || user.anonymised_at) {
      if (mode === 'admin' && confirmation === 'DELETE' && prior.rows.length) {
        await db.query('COMMIT');
        return { ok: true, deletionId: prior.rows[0].id };
      }
      reject(404, 'not_found', 'User not found.');
    }
    if (user.is_admin && !user.admin_readonly) {
      const count = await db.query('SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE');
      if (count.rows[0].n <= 1) reject(400, 'last_admin', "Can't delete the last full admin.");
    }
    if (confirmation !== 'DELETE') reject(400, 'confirmation_required', 'Type DELETE to confirm account deletion.');
    if (mode === 'self') {
      const sessions = await db.query(
        `SELECT created_at FROM sessions WHERE token = $1 AND user_id = $2 AND expires_at > NOW() FOR UPDATE`,
        [sessionToken || '', userId]
      );
      if (!sessions.rows.length) reject(401, 'session_required', 'Sign in again before deleting your account.');
      if (user.password_set) {
        if (typeof password !== 'string' || password.length > 1024 || !await bcrypt.compare(password, user.password)) {
          reject(403, 'password_required', 'Your current password is incorrect.');
        }
      } else if (Date.now() - new Date(sessions.rows[0].created_at).getTime() > 10 * 60 * 1000) {
        reject(403, 'reauth_required', 'Sign out and sign in again, then delete your account within 10 minutes.');
      }
    }

    // Manifest-admin rosters have explicit authority; never silently remove
    // their last member. The user/admin can assign a successor first.
    const stranded = await db.query(
      `SELECT a.slug FROM app_admins mine JOIN apps a ON a.id = mine.app_id
       WHERE mine.user_id = $1 AND NOT EXISTS
         (SELECT 1 FROM app_admins other WHERE other.app_id = mine.app_id AND other.user_id <> $1)`, [userId]
    );
    if (stranded.rows.length) reject(409, 'app_admin_successor_required',
      'Assign another app administrator before deleting this account: ' + stranded.rows.map(r => r.slug).join(', '));

    const deletionId = crypto.randomBytes(16).toString('hex');
    await db.query(`INSERT INTO account_deletions (id, user_id, requested_by, mode) VALUES ($1, $2, $3, $4)`,
      [deletionId, userId, actorId, mode]);
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('deleted-username:' || LOWER(username), 0)) FROM
      (SELECT username FROM users WHERE id = $1 UNION SELECT username FROM username_history WHERE user_id = $1) names
      ORDER BY LOWER(username)`, [userId]);
    await db.query(`INSERT INTO deleted_username_reservations (fingerprint)
      SELECT encode(sha256(convert_to(LOWER(username), 'UTF8')), 'hex') FROM
        (SELECT username FROM users WHERE id = $1 UNION SELECT username FROM username_history WHERE user_id = $1) names
      ON CONFLICT DO NOTHING`, [userId]);
    const keys = await db.query(
      `SELECT id, remote_key_hash, status FROM credentials.managed_openrouter_keys
       WHERE user_id = $1 AND status <> 'deleted' FOR UPDATE`, [userId]
    );
    for (const key of keys.rows) {
      if (key.remote_key_hash) await queueTask(db, deletionId, 'openrouter_key', key.remote_key_hash);
      else await queueTask(db, deletionId, 'key_reconciliation', key.id, 'review');
    }
    const sessions = await db.query('SELECT id FROM chat_sessions WHERE user_id = $1 FOR UPDATE', [userId]);
    for (const session of sessions.rows) await queueTask(db, deletionId, 'worker', session.id);
    const files = await db.query(`DELETE FROM app_files WHERE user_id = $1 AND visibility = 'private' RETURNING id, app_id`, [userId]);
    for (const file of files.rows) await queueTask(db, deletionId, 'object', `${file.app_id}/${file.id}`);

    await revokeNativeSessionCredentials(db, { reason: 'account_recovery', userId });
    // These credentials otherwise have an indirect NO ACTION dependency via
    // retained agent usage. Keep costs, never the credential/thread identity.
    await db.query(`UPDATE agent_turns SET credential_id = NULL, credential_revision = NULL,
      agent_thread_id = NULL, error_detail = NULL, metadata = '{}',
      status = CASE WHEN completed_at IS NULL THEN 'cancelled' ELSE status END,
      completed_at = COALESCE(completed_at, NOW()) WHERE user_id = $1`, [userId]);
    await db.query(`UPDATE chat_sessions SET status = CASE WHEN status = 'active' THEN 'paused' ELSE status END,
      active_turn = NULL, cc_session_id = NULL, agent_thread_id = NULL,
      headless_status = CASE WHEN headless_status = 'generating' THEN 'failed' ELSE headless_status END WHERE user_id = $1`, [userId]);
    // A proposal/spec may be public while its assistant transcript is not.
    await db.query(`DELETE FROM chat_session_messages WHERE session_id IN
      (SELECT id FROM chat_sessions WHERE user_id = $1 AND transcript_shared_at IS NULL)`, [userId]);
    await db.query(`UPDATE chat_sessions SET spec_md = '', pr_title = NULL, session_title = NULL, proposed_pr_title = NULL,
      pr_summary_md = NULL, pr_body = NULL, testing_md = NULL, local_agent_label = NULL
      WHERE user_id = $1 AND shared_at IS NULL AND pr_number IS NULL`, [userId]);
    await db.query(`DELETE FROM chat_session_specs WHERE session_id IN
      (SELECT id FROM chat_sessions WHERE user_id = $1 AND shared_at IS NULL AND pr_number IS NULL
       AND NOT EXISTS (SELECT 1 FROM chat_session_spec_user_shares WHERE session_id = chat_sessions.id)
       AND NOT EXISTS (SELECT 1 FROM chat_session_spec_conversation_shares WHERE session_id = chat_sessions.id))`, [userId]);

    for (const table of ['chat_message_attachments', 'chat_session_attachments', 'conversation_message_attachments']) {
      await db.query(`DELETE FROM ${table} WHERE user_id = $1 AND message_id IS NULL`, [userId]);
    }
    await db.query('DELETE FROM issue_screenshots WHERE user_id = $1 AND issue_number IS NULL', [userId]);

    // Freeze only previously accepted, unblocked direct histories. The
    // existing BEFORE DELETE trigger transfers group ownership and archives
    // directs; the new flag permits reading those archives, never sending.
    await db.query(`UPDATE conversations c SET deleted_peer = TRUE FROM conversation_direct_pairs p
      WHERE p.conversation_id = c.id AND c.status = 'active'
        AND $1 IN (p.user_low_id, p.user_high_id)
        AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.status = 'member') = 2
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_id = p.user_low_id AND b.blocked_user_id = p.user_high_id) OR
          (b.blocker_id = p.user_high_id AND b.blocked_user_id = p.user_low_id))`, [userId]);

    // Withdraw live decisions; historical outcomes and accounting stay intact.
    await db.query(`DELETE FROM pr_votes WHERE user_id = $1 AND session_id IN
      (SELECT id FROM chat_sessions WHERE status NOT IN ('merged', 'archived'))`, [userId]);
    await db.query(`DELETE FROM issue_votes WHERE user_id = $1 AND issue_id IN
      (SELECT id FROM issues WHERE status <> 'closed')`, [userId]);
    await db.query('DELETE FROM notifications WHERE source_user_id = $1', [userId]);
    await db.query('DELETE FROM title_heal_queue WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM progress_estimates WHERE user_id = $1', [userId]);
    await db.query(`UPDATE global_chat_usage SET metadata = '{}' WHERE user_id = $1`, [userId]);
    await db.query(`UPDATE conversation_message_reports SET evidence_snapshot =
      jsonb_set(evidence_snapshot, '{reactions}', COALESCE((
        SELECT jsonb_agg(r - 'userId') FROM jsonb_array_elements(evidence_snapshot->'reactions') r
      ), '[]'::jsonb)) WHERE reported_user_id = $1 OR reporter_user_id = $1`, [userId]);
    await db.query('DELETE FROM cli_auth_audit_events WHERE user_id = $1 OR actor_user_id = $1', [userId]);
    await db.query('DELETE FROM mcp_auth_audit_events WHERE user_id = $1 OR actor_user_id = $1', [userId]);
    await db.query(`UPDATE db_exports SET username = 'Deleted user', ip = NULL, user_agent = NULL, error = NULL WHERE user_id = $1`, [userId]);
    // Preserve the invocation receipt to prevent double billing on replay.
    await db.query(`UPDATE events SET metadata = CASE WHEN event_type = 'llm_invocation'
      THEN jsonb_strip_nulls(jsonb_build_object('invocation_key', metadata->'invocation_key')) ELSE '{}'::jsonb END
      WHERE user_id = $1`, [userId]);
    await db.query('UPDATE token_allocation SET description = NULL WHERE user_id = $1', [userId]);
    await db.query(`UPDATE onchain_accounts SET description = NULL, secret_key = '',
      registration_code = 'deleted-' || id WHERE user_id = $1`, [userId]);
    await db.query('DELETE FROM waitlist_signups WHERE linked_user_id = $1', [userId]);
    // Addresses this person invited into a project and nobody has claimed:
    // somebody else's email, typed by the account being deleted.
    await db.query('DELETE FROM app_email_invites WHERE invited_by = $1 AND claimed_at IS NULL', [userId]);
    // Only a confirmed address proves ownership of records not keyed by id.
    if (user.email && user.email_confirmed) {
      for (const table of ['waitlist_signups', 'mobile_otp_codes', 'waitlist_verification_codes', 'app_email_invites']) {
        await db.query(`DELETE FROM ${table} WHERE LOWER(email) = LOWER($1)` +
          (table === 'waitlist_signups' ? ' AND linked_user_id IS NULL' : ''), [user.email]);
      }
      await db.query('DELETE FROM mail_deliveries WHERE LOWER(recipient) = LOWER($1)', [user.email]);
    }
    // #2779: an agent session's conversation-only rows (no change named)
    // would outlive their owner as orphans once agent_sessions cascades and
    // the column is nulled, so they go first. A change's own rows are kept
    // or removed with the change, as above.
    await db.query(`DELETE FROM chat_session_messages WHERE session_id IS NULL
      AND agent_session_id IN (SELECT id FROM agent_sessions WHERE user_id = $1)`, [userId]);
    await anonymiseUser(db, userId, unusablePassword);
    await db.query(`UPDATE account_deletions SET completed_at = NOW() WHERE id = $1
      AND NOT EXISTS (SELECT 1 FROM account_deletion_tasks WHERE deletion_id = $1 AND state <> 'completed')`, [deletionId]);
    await db.query('COMMIT');
    result = { deletionId, sessionIds: sessions.rows.map(r => r.id) };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { db.release(); }
  // The database is authoritative even if a process is restarting. This
  // fast path also interrupts current streams and sockets on every pod.
  try { require('./account-deletion-runtime').revoke(userId, result.sessionIds); }
  catch { require('./logger').warn('account-deletion', 'Live disconnect will be reconciled', { userId }); }
  return { ok: true, deletionId: result.deletionId };
}

// Provisioning may finish after the account and its reservation disappeared.
// Hand the known remote key to the durable receipt instead of orphaning it.
async function recordLateManagedKey(pool, userId, hash) {
  const { rows } = await pool.query('SELECT id FROM account_deletions WHERE user_id = $1', [userId]);
  if (!rows.length) return false;
  await queueTask(pool, rows[0].id, 'openrouter_key', hash);
  await pool.query(`UPDATE account_deletion_tasks SET state = 'completed', completed_at = NOW()
    WHERE deletion_id = $1 AND kind = 'key_reconciliation'`, [rows[0].id]);
  await pool.query('UPDATE account_deletions SET completed_at = NULL WHERE id = $1', [rows[0].id]);
  return true;
}

module.exports = { AccountDeletionError, deleteAccount, queueTask, recordLateManagedKey, anonymisedEmail, KEEP_ON_ANONYMISE };
