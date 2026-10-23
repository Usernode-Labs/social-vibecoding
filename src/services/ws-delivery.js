'use strict';

const { nativeWebSessionIsLive } = require('./web-session-auth');
const platformJwt = require('./platform-jwt');

// One fresh database snapshot decides both identity and audience. Never use
// the handshake's admin flag, cached app visibility, or a bus recipient list
// as authority to disclose content. The bus only selects candidate sockets.
const AUTHORIZE_SQL = `
  SELECT d.n, u.username, u.is_admin, (cs.user_id = u.id) AS session_owner,
    (u.id IS NOT NULL AND (d.staging OR s.token IS NOT NULL)) AS authenticated,
    (
      (NOT d.admin OR u.is_admin)
      AND (d.session_id IS NULL OR (
        cs.id IS NOT NULL AND (
          cs.user_id = u.id OR (d.watching AND u.is_admin)
          OR (d.fanout AND cs.app_id IS NOT NULL AND (NOT d.shared_only OR cs.shared_at IS NOT NULL OR cs.is_headless))
        )
      ))
      AND (NOT d.app_required AND cs.app_id IS NULL OR (
        a.id IS NOT NULL AND a.moderation_suspended_at IS NULL
        AND (d.app_id IS NULL OR a.id = d.app_id)
        AND (d.app_slug IS NULL OR a.slug = d.app_slug)
        AND NOT EXISTS (
          SELECT 1 FROM user_app_blocks b WHERE b.app_id = a.id AND b.user_id = u.id
        )
        AND (a.view_visibility = 'public' OR u.is_admin OR EXISTS (
          SELECT 1 FROM app_collaborators m
           WHERE m.app_id = a.id AND m.user_id = u.id AND m.status = 'member'
        ))
      ))
      AND (d.conversation_id IS NULL OR EXISTS (
        SELECT 1 FROM conversation_members cm
         WHERE cm.conversation_id = d.conversation_id AND cm.user_id = u.id AND cm.status = 'member'
      ))
    ) AS allowed
    FROM jsonb_to_recordset($1::jsonb) AS d(
      n int, user_id int, token text, staging boolean, claim_username text, admin boolean,
      app_required boolean, app_id int, app_slug text,
      session_id int, watching boolean, fanout boolean, shared_only boolean, conversation_id int
    )
    LEFT JOIN users u ON u.id = d.user_id AND u.anonymised_at IS NULL
      AND (NOT d.staging OR d.claim_username IS NULL OR u.username = d.claim_username)
    LEFT JOIN sessions s ON s.token = d.token AND s.user_id = u.id
      AND s.expires_at > NOW() AND ${nativeWebSessionIsLive('s')}
    LEFT JOIN chat_sessions cs ON cs.id = d.session_id
    LEFT JOIN apps by_slug ON d.session_id IS NULL AND d.app_id IS NULL AND by_slug.slug = d.app_slug
    LEFT JOIN apps a ON a.id = CASE WHEN d.session_id IS NOT NULL THEN cs.app_id ELSE COALESCE(d.app_id, by_slug.id) END
`;

const MAX_BATCH = 512;
const MAX_CLIENT_BYTES = 1024 * 1024;
const MAX_CLIENT_FRAMES = 256;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

function descriptor(client, scope, n) {
  const auth = client.auth;
  let staging = false;
  let claimUsername = null;
  if (auth?.kind === 'staging' && process.env.USERNODE_ENV === 'staging') {
    try {
      // Re-verify expiry, audience and signature on every batch, including
      // an already connected socket. A JWT never substitutes for a cookie
      // session outside staging.
      const claims = platformJwt.verifyAppIdentityToken(auth.token, { appId: process.env.USERNODE_APP_ID });
      staging = claims.id === client.user.id;
      claimUsername = typeof claims.username === 'string' ? claims.username : null;
    } catch { /* expired or no longer valid */ }
  }
  return {
    n, user_id: positiveId(client.user.id), token: auth?.kind === 'cookie' ? auth.token : null,
    staging, claim_username: claimUsername, admin: !!scope.admin, app_required: !!scope.appRequired,
    app_id: positiveId(scope.appId), app_slug: scope.appSlug || null,
    session_id: positiveId(scope.sessionId),
    watching: !!scope.watchRequest || (!!scope.watching && !!client.watching?.has(Number(scope.sessionId))),
    fanout: !!scope.fanout, shared_only: !!scope.sharedOnly, conversation_id: positiveId(scope.conversationId),
  };
}

// Bounded FIFO: a burst shares one query, and the next batch must obtain a
// new snapshot. There is no positive authorization cache. Frames are sent
// synchronously after the query, without another await that could reorder
// them. A slow database cannot grow an unbounded queue behind a socket.
function createDelivery({ getPool, send, refuse, onError }) {
  const pending = [];
  const budgets = new Map();
  let pendingBytes = 0;
  let running = false;

  async function authorize(entries) {
    const pool = getPool();
    if (!pool) throw new Error('WebSocket authority unavailable');
    const inputs = entries.map((e, n) => descriptor(e.client, e.scope, n));
    const { rows } = await pool.query(AUTHORIZE_SQL, [JSON.stringify(inputs)]);
    return new Map(rows.map(row => [Number(row.n), row]));
  }

  function apply(client, row, scope) {
    if (!row?.authenticated) { refuse(client, 'identity'); return false; }
    // An unwatch received while the query was in flight wins as well.
    if (scope.watching && !scope.fanout && !row.session_owner && !client.watching?.has(Number(scope.sessionId))) return false;
    if (!row.allowed) {
      if (client.appId != null) refuse(client, 'app');
      return false;
    }
    return client.ws.readyState === 1;
  }

  async function drain() {
    try {
      while (pending.length) {
        const batch = pending.splice(0, MAX_BATCH);
        try {
          const decisions = await authorize(batch);
          for (let n = 0; n < batch.length; n++) {
            const entry = batch[n];
            if (apply(entry.client, decisions.get(n), entry.scope) && entry.json != null) send(entry.client, entry.json);
          }
        } catch (err) {
          // On an unavailable authority, no content is disclosed. Closing
          // candidates lets their normal reconnect/resync path recover.
          for (const { client } of batch) refuse(client, 'unavailable');
          onError(err);
        } finally {
          for (const entry of batch) {
            pendingBytes -= entry.bytes;
            const budget = budgets.get(entry.client);
            if (budget) {
              budget.bytes -= entry.bytes;
              budget.frames--;
              if (!budget.frames) budgets.delete(entry.client);
            }
          }
        }
      }
    } finally { running = false; }
  }

  function enqueue(client, json, scope = {}) {
    if (!client.ws || client.ws.readyState !== 1) return false;
    const bytes = json == null ? 0 : Buffer.byteLength(json);
    const budget = budgets.get(client) || { bytes: 0, frames: 0 };
    if (budget.bytes + bytes > MAX_CLIENT_BYTES || budget.frames >= MAX_CLIENT_FRAMES
        || pendingBytes + bytes > MAX_PENDING_BYTES) {
      refuse(client, 'overflow');
      return false;
    }
    budget.bytes += bytes;
    budget.frames++;
    budgets.set(client, budget);
    pendingBytes += bytes;
    pending.push({ client, json, scope: { ...scope }, bytes });
    if (!running) {
      running = true;
      setImmediate(() => { void drain(); });
    }
    return true;
  }

  async function check(client, scope = {}) {
    try {
      const decisions = await authorize([{ client, scope }]);
      const row = decisions.get(0);
      // Give an incoming action its own identity snapshot. Mutating the
      // shared handshake user would let an older concurrent check restore
      // a stale admin flag while another action is still awaiting a read.
      return apply(client, row, scope)
        ? { id: client.user.id, username: row.username, isAdmin: !!row.is_admin } : false;
    } catch (err) {
      refuse(client, 'unavailable');
      onError(err);
      return false;
    }
  }

  return { enqueue, check };
}

module.exports = { createDelivery, AUTHORIZE_SQL, MAX_BATCH, MAX_CLIENT_BYTES, MAX_CLIENT_FRAMES, MAX_PENDING_BYTES };
