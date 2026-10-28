'use strict';

// Real sockets on two independently loaded web instances, and the complete
// production schema in a disposable database. All identities/content are
// synthetic. Relay tests enter the same receiver a committed bus message
// enters; they deliberately send no access invalidation to either instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { WebSocket } = require('ws');
const { AUTHORIZE_SQL } = require('../src/services/ws-delivery');
const notifications = require('../src/services/notifications');
const conversations = require('../src/services/conversations');
const pushes = require('../src/workflow/pushes.ts');
const { waitFor } = require('./lib/wait-for');
const DSN = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL
  || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('current WebSocket authority against the full PostgreSQL schema', {
  timeout: 120000,
}, async t => {
  const database = `ws_access_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL || process.env.DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  let pool;
  const instances = [], sockets = [];
  const poolPath = require.resolve('../src/db/pool');
  const wsPath = require.resolve('../src/services/ws');
  const oldPool = require.cache[poolPath], oldWs = require.cache[wsPath];
  t.after(async () => {
    for (const sock of sockets) sock.terminate();
    await Promise.all(instances.map(i => new Promise(resolve => i.server.close(resolve))));
    if (oldPool) require.cache[poolPath] = oldPool; else delete require.cache[poolPath];
    if (oldWs) require.cache[wsPath] = oldWs; else delete require.cache[wsPath];
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
  const url = new URL(DSN); url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.href, max: 4, options: '-c jit=off' });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(AUTHORIZE_SQL, ['[]', notifications.MERGED_HIDDEN_KINDS]); // fail immediately on a catalog mismatch
  let outage = false, routeFailure = false, gateQueries = 0;
  let holdNext;
  const heldBatches = new Set();
  // open() waits for the server to finish authorizing its socket. The check
  // runs right after joinRoom (or, on /ws/events, right after the client is
  // added to globalClients), so its query arriving proves the socket is
  // registered for delivery. A fixed sleep was too short under load.
  const pendingOpens = [];
  const webPool = {
    connect: (...args) => pool.connect(...args),
    query: async (sql, params) => {
      if (sql === AUTHORIZE_SQL) {
        gateQueries++;
        for (const d of JSON.parse(params[0])) {
          const key = `${d.token}|${d.app_required ? 'app' : 'events'}`;
          const at = pendingOpens.findIndex(w => w.key === key);
          if (at !== -1) pendingOpens.splice(at, 1)[0].seen = true;
        }
        if (holdNext) {
          const hold = holdNext;
          holdNext = null;
          hold.started = true;
          await hold.waiting;
        }
        if (outage) return Promise.reject(new Error('fake authority unavailable'));
      }
      if (routeFailure && /FROM chat_sessions cs LEFT JOIN apps/.test(sql)) {
        return Promise.reject(new Error('fake route lookup failed'));
      }
      return pool.query(sql, params);
    },
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { getPool: () => webPool } };
  const { authRoutes } = require('../src/routes/auth');
  for (let n = 0; n < 2; n++) {
    delete require.cache[wsPath];
    const ws = require(wsPath);
    const app = express();
    app.use(cookieParser());
    app.use(authRoutes({}));
    const server = http.createServer(app);
    ws.attach(server, {}); // no bus connection: invoke the real receiver below
    await new Promise(resolve => server.listen(0, resolve));
    instances.push({ ws, server, port: server.address().port });
  }
  async function open(i, token, path = '/ws/events') {
    const appRequired = path.startsWith('/ws/chat/');
    const waiter = { key: `${token}|${appRequired ? 'app' : 'events'}`, seen: false };
    pendingOpens.push(waiter);
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${instances[i].port}${path}`, { headers: { cookie: `session=${token}` } });
      sockets.push(sock);
      sock.frames = [];
      sock.on('message', raw => sock.frames.push(JSON.parse(String(raw))));
      sock.on('close', code => { sock.closeCode = code; });
      await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
      if (path === '/ws/events') await waitFor(() => sock.frames.length, { label: 'platform handshake' });
      // The server closes a socket it refuses before it ever authorizes it
      // (a 4004 reconnect), so a close counts as settled too.
      await waitFor(() => waiter.seen || sock.readyState >= WebSocket.CLOSING, { label: 'post-upgrade authority check' });
      return sock;
    } finally {
      const at = pendingOpens.indexOf(waiter);
      if (at !== -1) pendingOpens.splice(at, 1);
    }
  }
  let seq = 0;
  async function fixture() {
    const slug = `fake-ws-${++seq}`;
    const f = { slug };
    for (const name of ['owner', 'member', 'stranger', 'admin']) {
      const { rows: [u] } = await pool.query(
        'INSERT INTO users (username, password, is_admin) VALUES ($1, $2, $3) RETURNING id',
        [`${slug}-${name}`, 'fake-unused-password', name === 'admin']);
      const token = `${slug}-${name}-session`;
      await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')", [token, u.id]);
      f[name] = { ...u, token };
    }
    const { rows: [a] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status, collab_visibility, view_visibility)
       VALUES ($1, $1, $2, 'running', 'private', 'private') RETURNING id`, [slug, f.owner.id]);
    f.appId = a.id;
    await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
      [a.id, f.owner.id, f.member.id]);
    const { rows: [cs] } = await pool.query('INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [a.id, f.owner.id]);
    f.sessionId = cs.id;
    return f;
  }
  const event = (label, extra = {}) => ({ type: 'private_fixture', label, ...extra });
  const frames = (sock, label) => sock.frames.filter(frame => frame.label === label);
  async function stallBatch(i, userId) {
    const hold = {};
    hold.waiting = new Promise(resolve => { hold.release = resolve; });
    heldBatches.add(hold);
    holdNext = hold;
    instances[i].ws.pushToUser(userId, event('unrelated-held-batch'));
    await waitFor(() => hold.started, { label: 'unrelated authorization batch held' });
    return () => { hold.release(); heldBatches.delete(hold); };
  }
  async function flushBatch(resume, i, userId, sock) {
    const label = `flushed-${++seq}`;
    instances[i].ws.pushToUser(userId, event(label));
    resume();
    await waitFor(() => frames(sock, label).length, { label: 'queued delivery batch finished' });
  }
  async function conversationFixture(f, { kind = 'group', memberStatus = 'member' } = {}) {
    const { rows: [c] } = await pool.query(
      'INSERT INTO conversations (kind, title, created_by) VALUES ($1, $2, $3) RETURNING id',
      [kind, kind === 'direct' ? null : 'Fake private chat', f.owner.id]);
    if (kind === 'direct') await pool.query(
      'INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id) VALUES ($1, $2, $3)',
      [c.id, Math.min(f.owner.id, f.member.id), Math.max(f.owner.id, f.member.id)]);
    await pool.query("INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, $4)",
      [c.id, f.owner.id, f.member.id, memberStatus]);
    const { rows: [m] } = await pool.query(
      'INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING id',
      [c.id, f.owner.id, 'FAKE_PRIVATE_QUEUED_NOTIFICATION']);
    const { rows: [n] } = await pool.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, conversation_id, conversation_message_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [f.member.id, f.owner.id, memberStatus === 'invited' ? 'conversation_invite' : 'conversation_message', c.id,
        memberStatus === 'invited' ? null : m.id]);
    return { conversationId: c.id, messageId: m.id, notificationId: n.id };
  }
  async function closeAll() {
    for (const hold of heldBatches) hold.release();
    heldBatches.clear();
    holdNext = null;
    // Each socket's own `close` event ends the teardown: a terminated socket
    // has finished with the server, not merely been asked to stop.
    await Promise.all(sockets.map(sock => new Promise(resolve => {
      if (sock.readyState === WebSocket.CLOSED) return resolve();
      sock.once('close', resolve);
      sock.terminate();
    })));
  }
  t.afterEach(closeAll);

  await t.test('removed private-project readers stop on both instances, without cache invalidation', async () => {
    const f = await fixture();
    const member = await Promise.all([0, 1].map(i => open(i, f.member.token, `/ws/chat/${f.slug}`)));
    const owner = await open(1, f.owner.token, `/ws/chat/${f.slug}`);
    instances[0].ws.broadcast(f.appId, event('before'));
    instances[1].ws._onBusMessage({ kind: 'room', routing: { appId: f.appId }, data: event('before') });
    await waitFor(() => member.every(s => frames(s, 'before').length === 1), { label: 'positive room delivery' });
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [f.appId, f.member.id]);
    instances[0].ws.broadcast(f.appId, event('after'));
    instances[1].ws._onBusMessage({ kind: 'room', routing: { appId: f.appId }, data: event('after') });
    await waitFor(() => frames(owner, 'after').length === 1 && member.every(s => s.readyState === WebSocket.CLOSED), { label: 'revoked room readers closed' });
    for (const sock of member) assert.equal(frames(sock, 'after').length, 0);
    const retry = await open(0, f.member.token, `/ws/chat/${f.slug}`);
    await waitFor(() => retry.readyState === WebSocket.CLOSED, { label: 'reconnect refused' });
    assert.equal(retry.frames.length, 0);
  });

  await t.test('actual logout revokes only that incarnation, on personal and room delivery across instances', async () => {
    const f = await fixture();
    const personal = await open(1, f.member.token);
    const room = await open(0, f.member.token, `/ws/chat/${f.slug}`);
    const otherToken = `${f.slug}-other-incarnation`;
    await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')", [otherToken, f.member.id]);
    const other = await open(1, otherToken);
    const response = await fetch(`http://127.0.0.1:${instances[0].port}/api/auth/logout`, {
      method: 'POST', headers: { cookie: `session=${f.member.token}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.member.id }, data: event('logout') });
    instances[0].ws.broadcast(f.appId, event('logout'));
    await waitFor(() => frames(other, 'logout').length === 1 && personal.readyState === 3 && room.readyState === 3, { label: 'logout authority checked' });
    assert.equal(frames(personal, 'logout').length, 0);
    assert.equal(frames(room, 'logout').length, 0);
    await assert.rejects(open(0, f.member.token), /401/);
  });

  await t.test('session expiry and deleted accounts cannot receive user or admin payloads', async () => {
    for (const kind of ['expire', 'erase']) {
      const f = await fixture();
      const sock = await open(1, f.admin.token);
      if (kind === 'expire') await pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token = $1", [f.admin.token]);
      else await pool.query('UPDATE users SET anonymised_at = NOW() WHERE id = $1', [f.admin.id]);
      instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.admin.id }, data: event(kind) });
      instances[1].ws._onBusMessage({ kind: 'admins', data: event(kind) });
      await waitFor(() => sock.readyState === 3, { label: `${kind} closes socket` });
      assert.equal(frames(sock, kind).length, 0);
    }
  });

  await t.test('a revoked cookie also stops incoming frames before any chat write', async () => {
    const f = await fixture();
    const sock = await open(0, f.member.token, `/ws/chat/${f.slug}`);
    await pool.query('DELETE FROM sessions WHERE token = $1', [f.member.token]);
    sock.send(JSON.stringify({ type: 'chat', content: 'FAKE_REVOKED_WRITE' }));
    await waitFor(() => sock.readyState === 3, { label: 'revoked writer closed' });
    assert.equal(sock.closeCode, 4001);
    const { rows: [row] } = await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1', [f.appId]);
    assert.equal(row.n, 0);
  });

  await t.test('native credential revocation closes restored-cookie sockets on both delivery paths', async () => {
    const f = await fixture();
    const opaque = prefix => prefix + crypto.randomBytes(32).toString('base64url');
    const incarnation = opaque('nsw_'), attempt = opaque('nsa_'), installation = opaque('nsi_'), credential = opaque('nsc_');
    const chain = 'utc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkmzk3k';
    await pool.query('INSERT INTO native_session_web_incarnations (id, user_id) VALUES ($1, $2)', [incarnation, f.member.id]);
    await pool.query(`INSERT INTO native_session_attempts (attempt_id, user_id, web_session_incarnation_id,
      desired_runtime, network_id, chain_id, request_digest)
      VALUES ($1, $2, $3, 'running', 'testnet', $4, $5)`, [attempt, f.member.id, incarnation, chain, 'a'.repeat(64)]);
    await pool.query(`INSERT INTO native_installation_key_generations (installation_id, key_generation,
      possession_key_id, possession_key_thumbprint, possession_public_jwk,
      envelope_key_id, envelope_key_thumbprint, envelope_public_jwk)
      VALUES ($1, 1, $2, $3, '{}', $4, $5, '{}')`, [installation, opaque('nskp_'),
      crypto.randomBytes(32).toString('base64url'), opaque('nske_'), crypto.randomBytes(32).toString('base64url')]);
    const { rows: [mobile] } = await pool.query(`INSERT INTO mobile_auth_tokens (user_id, token_hash, ability, expires_at)
      VALUES ($1, $2, 'session', NOW() + INTERVAL '1 day') RETURNING id, expires_at`, [f.member.id, crypto.randomBytes(32).toString('hex')]);
    await pool.query(`INSERT INTO native_session_credentials (credential_reference, attempt_id, user_id,
      web_session_incarnation_id, installation_id, installation_key_generation, mobile_auth_token_id,
      network_id, chain_id, exchange_request_digest, expires_at)
      SELECT $1, $2, $3, $4, $5, 1, t.id, 'testnet', $7, $8, t.expires_at
        FROM mobile_auth_tokens t WHERE t.id = $6`,
    [credential, attempt, f.member.id, incarnation, installation, mobile.id, chain, 'b'.repeat(64)]);
    await pool.query(`UPDATE sessions SET native_session_credential_reference = $1, native_session_incarnation_id = $2
      WHERE token = $3`, [credential, incarnation, f.member.token]);
    const personal = await open(1, f.member.token), room = await open(0, f.member.token, `/ws/chat/${f.slug}`);
    instances[1].ws.pushToUser(f.member.id, event('native-before'));
    instances[0].ws.broadcast(f.appId, event('native-before'));
    await waitFor(() => frames(personal, 'native-before').length && frames(room, 'native-before').length, { label: 'native positive controls' });
    const { revokeNativeSessionCredentials } = require('../src/services/native-session-revocation');
    const q = await pool.connect();
    try {
      await q.query('BEGIN');
      await revokeNativeSessionCredentials(q, { reason: 'web_logout', userId: f.member.id, webSessionIncarnationId: incarnation });
      await q.query('COMMIT');
    } catch (err) { await q.query('ROLLBACK'); throw err; } finally { q.release(); }
    instances[1].ws.pushToUser(f.member.id, event('native-after'));
    instances[0].ws.broadcast(f.appId, event('native-after'));
    await waitFor(() => personal.readyState === 3 && room.readyState === 3, { label: 'native revocation closes sockets' });
    assert.equal(frames(personal, 'native-after').length, 0);
    assert.equal(frames(room, 'native-after').length, 0);
  });

  await t.test('queued conversation content rechecks membership, while removal notices contain only an id', async () => {
    const f = await fixture();
    const { rows: [c] } = await pool.query("INSERT INTO conversations (kind, title, created_by) VALUES ('group', 'Fake private chat', $1) RETURNING id", [f.owner.id]);
    await pool.query("INSERT INTO conversation_members (conversation_id, user_id, status) VALUES ($1, $2, 'member'), ($1, $3, 'member')",
      [c.id, f.owner.id, f.member.id]);
    const member = await open(1, f.member.token), owner = await open(1, f.owner.token);
    const relay = label => instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.member.id, actorUserId: f.owner.id },
      data: { type: 'conversation_message_created', conversationId: c.id, label, content: 'FAKE_PRIVATE_CONVERSATION' } });
    relay('conversation-before');
    await waitFor(() => frames(member, 'conversation-before').length, { label: 'member positive control' });
    await pool.query("UPDATE conversation_members SET status = 'removed', left_at = NOW() WHERE conversation_id = $1 AND user_id = $2", [c.id, f.member.id]);
    relay('conversation-after');
    instances[1].ws.pushToUser(f.owner.id, event('conversation-control'));
    instances[1].ws.pushToUser(f.member.id, { type: 'conversation_membership_changed', conversationId: c.id, content: 'must be projected away' });
    await waitFor(() => frames(owner, 'conversation-control').length && member.frames.some(m => m.type === 'conversation_membership_changed'), { label: 'content batch processed' });
    assert.equal(frames(member, 'conversation-after').length, 0);
    assert.deepEqual(member.frames.find(m => m.type === 'conversation_membership_changed'), { type: 'conversation_membership_changed', conversationId: c.id });
  });

  await t.test('queued notifications rehydrate in the delivery snapshot and bind the row to its recipient', async () => {
    const f = await fixture(), c = await conversationFixture(f);
    const member = await open(1, f.member.token), stranger = await open(1, f.stranger.token);
    const stale = await notifications.hydrateNotification(pool, c.notificationId);
    const resume = await stallBatch(1, f.member.id);
    // Legacy peers can still carry a hydrated body. None of its fields,
    // including a forged recipient or snippet, are delivery authority.
    const data = { type: 'notification_new', notification: { ...stale.notification, messageContent: 'FAKE_STALE_BODY' } };
    instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.member.id }, data });
    instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.stranger.id }, data });
    await pool.query('UPDATE conversation_messages SET content = $2 WHERE id = $1', [c.messageId, 'FAKE_CURRENT_BODY']);
    await flushBatch(resume, 1, f.member.id, member);
    await waitFor(() => member.frames.some(m => m.type === 'notification_new'), { label: 'current notification delivered' });
    const delivered = member.frames.find(m => m.type === 'notification_new');
    assert.equal(delivered.notification.messageContent, 'FAKE_CURRENT_BODY');
    assert.equal(delivered.notification.conversationId, c.conversationId);
    assert.ok(!('notificationId' in delivered));
    assert.equal(stranger.frames.filter(m => m.type === 'notification_new').length, 0);
  });

  await t.test('a notification hydrated before removal is denied by a fresh delivery query after removal', async () => {
    const f = await fixture(), c = await conversationFixture(f);
    const member = await open(1, f.member.token);
    const resume = await stallBatch(1, f.member.id);
    await notifications.hydrateAndPush(pool, { id: c.notificationId });
    await pool.query("UPDATE conversation_members SET status = 'removed', left_at = NOW() WHERE conversation_id = $1 AND user_id = $2",
      [c.conversationId, f.member.id]);
    assert.equal(await notifications.hydrateNotification(pool, c.notificationId), null);
    await flushBatch(resume, 1, f.member.id, member);
    assert.equal(member.frames.filter(m => m.type === 'notification_new').length, 0);
  });

  await t.test('queued private-project notifications lose access with collaboration, blocks, and row deletion', async t => {
    for (const cause of ['collaboration', 'app-block', 'deleted']) await t.test(cause, async () => {
      const f = await fixture(), member = await open(1, f.member.token);
      const { rows: [n] } = await pool.query(
        "INSERT INTO notifications (user_id, source_user_id, kind, app_id, session_id) VALUES ($1, $2, 'pr_merged', $3, $4) RETURNING id",
        [f.member.id, f.owner.id, f.appId, f.sessionId]);
      const resume = await stallBatch(1, f.member.id);
      instances[1].ws.pushToUser(f.member.id, { type: 'notification_new', notificationId: n.id });
      if (cause === 'collaboration') await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [f.appId, f.member.id]);
      if (cause === 'app-block') await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [f.member.id, f.appId]);
      if (cause === 'deleted') await pool.query('DELETE FROM notifications WHERE id = $1', [n.id]);
      await flushBatch(resume, 1, f.member.id, member);
      assert.equal(member.frames.filter(m => m.type === 'notification_new').length, 0);
    });
  });

  await t.test('pending conversation and private-project invitations reach nonmembers through current authority', async () => {
    const f = await fixture(), c = await conversationFixture(f, { memberStatus: 'invited' });
    const member = await open(1, f.member.token), stranger = await open(1, f.stranger.token);
    await pool.query("INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'invited')", [f.appId, f.stranger.id]);
    await pool.query("INSERT INTO app_approvers (app_id, user_id, status) VALUES ($1, $2, 'invited')", [f.appId, f.stranger.id]);
    const { rows: invites } = await pool.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, app_id)
       VALUES ($1, $2, 'collab_invite', $3), ($1, $2, 'approver_invite', $3) RETURNING id`,
      [f.stranger.id, f.owner.id, f.appId]);
    instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.member.id },
      data: { type: 'notification_new', notificationId: c.notificationId }, fromWorkflow: true });
    for (const n of invites) instances[1].ws.pushToUser(f.stranger.id, { type: 'notification_new', notificationId: n.id });
    await waitFor(() => stranger.frames.filter(m => m.type === 'notification_new').length === 2
      && member.frames.some(m => m.type === 'notification_new'), { label: 'all pending invitations delivered' });
    const invited = member.frames.find(m => m.type === 'notification_new').notification;
    assert.equal(invited.kind, 'conversation_invite');
    assert.equal(invited.messageContent, null);
    const resume = await stallBatch(1, f.stranger.id);
    for (const n of invites) instances[1].ws.pushToUser(f.stranger.id, { type: 'notification_new', notificationId: n.id });
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [f.appId, f.stranger.id]);
    await pool.query('DELETE FROM app_approvers WHERE app_id = $1 AND user_id = $2', [f.appId, f.stranger.id]);
    await flushBatch(resume, 1, f.stranger.id, stranger);
    assert.equal(stranger.frames.filter(m => m.type === 'notification_new').length, 2, 'withdrawn invitations cannot reuse the old row');
  });

  await t.test('a direct block committed after withLockedAudience suppresses queued typing in either direction', async t => {
    for (const blocker of ['owner', 'member']) await t.test(blocker, async () => {
      const f = await fixture(), c = await conversationFixture(f, { kind: 'direct' });
      const member = await open(1, f.member.token);
      const ws = instances[1].ws;
      const data = { type: 'conversation_typing', conversationId: c.conversationId, userId: f.owner.id, typing: true };
      await conversations.withLockedAudience(pool, f.owner, c.conversationId, ids => {
        ws.pushConversationEvent(ids, data, { excludeUserId: f.owner.id, actorUserId: f.owner.id });
      });
      await waitFor(() => member.frames.some(m => m.type === data.type), { label: 'direct positive control' });
      member.frames.length = 0;
      const resume = await stallBatch(1, f.member.id);
      await conversations.withLockedAudience(pool, f.owner, c.conversationId, ids => {
        ws.pushConversationEvent(ids, data, { excludeUserId: f.owner.id, actorUserId: f.owner.id });
      });
      await conversations.setBlock(pool, f[blocker].id, f[blocker === 'owner' ? 'member' : 'owner'].id, true);
      const membership = await conversations.loadMembership(pool, c.conversationId, f.member.id);
      assert.equal(membership.membership_status, 'member', 'accepted direct membership deliberately survives a block');
      assert.equal(await conversations.canReadConversation(pool, membership, f.member.id), false);
      await flushBatch(resume, 1, f.member.id, member);
      assert.equal(member.frames.filter(m => m.type === data.type).length, 0);
    });
  });

  await t.test('actor routing survives the bus and shared rooms recheck sender blocks, membership, and archival', async t => {
    for (const cause of ['sender-block', 'actor-removed', 'archived']) await t.test(cause, async () => {
      const f = await fixture(), c = await conversationFixture(f);
      const member = await open(1, f.member.token);
      const bus = require('../src/services/ws-bus'), saved = bus.publishBatched;
      bus.publishBatched = (_batch, kind, routing, data) => instances[1].ws._onBusMessage({ kind, routing, data });
      try {
        const data = { type: 'conversation_reaction_updated', conversationId: c.conversationId, messageId: c.messageId };
        instances[0].ws.pushConversationEvent([f.member.id], data, { actorUserId: f.owner.id });
        await waitFor(() => member.frames.some(m => m.type === data.type), { label: 'relayed reaction positive control' });
        assert.deepEqual(member.frames.find(m => m.type === data.type), data, 'actor metadata stays off the browser wire');
        member.frames.length = 0;
        const resume = await stallBatch(1, f.member.id);
        await conversations.withLockedAudience(pool, f.owner, c.conversationId, ids => {
          instances[0].ws.pushConversationEvent(ids, data, { actorUserId: f.owner.id });
        });
        if (cause === 'sender-block') await conversations.setBlock(pool, f.member.id, f.owner.id, true);
        if (cause === 'actor-removed') await pool.query("UPDATE conversation_members SET status = 'removed' WHERE conversation_id = $1 AND user_id = $2", [c.conversationId, f.owner.id]);
        if (cause === 'archived') await pool.query("UPDATE conversations SET status = 'archived' WHERE id = $1", [c.conversationId]);
        await flushBatch(resume, 1, f.member.id, member);
        assert.equal(member.frames.filter(m => m.type === data.type).length, 0);
      } finally { bus.publishBatched = saved; }
    });
  });

  await t.test('legacy conversation actors are resolved safely and missing scope fails closed', async () => {
    const f = await fixture(), c = await conversationFixture(f), member = await open(1, f.member.token);
    const relay = data => instances[1].ws._onBusMessage({ kind: 'user', routing: { userId: f.member.id }, data });
    relay({ type: 'conversation_message_created', conversationId: c.conversationId, messageId: c.messageId });
    relay({ type: 'conversation_read', conversationId: c.conversationId, userId: f.owner.id });
    await waitFor(() => member.frames.filter(m => m.type.startsWith('conversation_')).length === 2, { label: 'safe legacy actors resolved' });
    member.frames.length = 0;
    const resume = await stallBatch(1, f.member.id);
    relay({ type: 'conversation_reaction_updated', conversationId: c.conversationId, messageId: c.messageId });
    relay({ type: 'conversation_typing', conversationId: 'invalid', userId: f.owner.id, typing: true });
    relay({ type: 'conversation_typing', userId: f.owner.id, typing: true });
    await flushBatch(resume, 1, f.member.id, member);
    assert.equal(member.frames.filter(m => m.type.startsWith('conversation_')).length, 0);
  });

  await t.test('demotion removes existing admin watches and admin-only delivery', async () => {
    const f = await fixture();
    const sock = await open(1, f.admin.token);
    sock.send(JSON.stringify({ type: 'watch_session', sessionId: f.sessionId }));
    await waitFor(() => sock.frames.some(frame => frame.type === 'session_watch' && frame.watching), { label: 'admin watch accepted' });
    const relay = label => {
      instances[1].ws._onBusMessage({ kind: 'session', routing: { sessionId: f.sessionId, userId: f.owner.id, appId: f.appId },
        data: { type: 'session_event', sessionId: f.sessionId, event: 'cc_progress', label } });
      instances[1].ws._onBusMessage({ kind: 'admins', data: event(label) });
    };
    relay('admin-before');
    await waitFor(() => frames(sock, 'admin-before').length === 2, { label: 'admin positive controls' });
    await pool.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [f.admin.id]);
    relay('admin-after');
    // A control frame on the same socket after the demoted payload: one FIFO
    // delivery queue decides both, so the control arriving proves the
    // demoted socket's decision has already been made.
    instances[1].ws.pushToUser(f.admin.id, event('admin-control'));
    await waitFor(() => frames(sock, 'admin-control').length, { label: 'post-demotion delivery batch processed' });
    assert.equal(frames(sock, 'admin-after').length, 0);
  });

  await t.test('session owners also require current project access, including cached routing', async () => {
    const f = await fixture();
    const sock = await open(0, f.owner.token);
    const progress = label => instances[0].ws.broadcastGlobal({ type: 'session_event', event: 'cc_progress', sessionId: f.sessionId, label });
    progress('owner-before');
    await waitFor(() => frames(sock, 'owner-before').length, { label: 'owner positive control' });
    await pool.query('DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [f.appId, f.owner.id]);
    progress('owner-after');
    // The control follows the revoked event through the same FIFO delivery
    // queue; its arrival proves the revoked event was already decided.
    instances[0].ws.pushToUser(f.owner.id, event('owner-control'));
    await waitFor(() => frames(sock, 'owner-control').length, { label: 'post-revocation delivery batch processed' });
    assert.equal(frames(sock, 'owner-after').length, 0);
  });

  await t.test('session routing cannot grant a former owner or promote a private stream to app fan-out', async () => {
    const f = await fixture();
    const member = await open(1, f.member.token), owner = await open(1, f.owner.token);
    const ws = instances[1].ws;
    ws._onBusMessage({ kind: 'session', routing: { sessionId: f.sessionId, userId: f.member.id, appId: f.appId, fanout: true },
      data: { type: 'session_event', sessionId: f.sessionId, event: 'cc_progress', label: 'stale-owner' } });
    ws._onBusMessage({ kind: 'session', routing: { sessionId: f.sessionId, userId: f.member.id, appId: f.appId },
      data: { type: 'session_event', sessionId: f.sessionId + 1, event: 'cc_progress', label: 'wrong-session' } });
    ws.pushToUser(f.owner.id, event('routing-control'));
    await waitFor(() => frames(owner, 'routing-control').length, { label: 'routing batch processed' });
    assert.equal(frames(member, 'stale-owner').length, 0);
    assert.equal(frames(member, 'wrong-session').length, 0);
    ws._onBusMessage({ kind: 'session', routing: { sessionId: f.sessionId, userId: f.owner.id, appId: f.appId, fanout: true }, oversize: true });
    await waitFor(() => member.frames.some(m => m.type === 'resync_hint'), { label: 'oversize app audience still gets a content-free repair hint' });
  });

  await t.test('session working-state follows current ownership and sharing, even on a delayed workflow relay', async () => {
    const f = await fixture();
    const member = await open(1, f.member.token), owner = await open(1, f.owner.token);
    const ws = instances[1].ws;
    await pool.query('UPDATE chat_sessions SET shared_at = NOW() WHERE id = $1', [f.sessionId]);
    const state = { type: 'session_state', sessionId: f.sessionId, appId: f.appId, appSlug: f.slug, userId: f.owner.id, shared: true };
    ws.pushSessionState({ ...state, label: 'shared-before' });
    await waitFor(() => frames(member, 'shared-before').length && frames(owner, 'shared-before').length, { label: 'shared positive controls' });
    await pool.query('UPDATE chat_sessions SET shared_at = NULL WHERE id = $1', [f.sessionId]);
    ws._onBusMessage({ kind: 'scoped', routing: { appId: f.appId }, data: { ...state, label: 'shared-after' }, fromWorkflow: true });
    await waitFor(() => frames(owner, 'shared-after').length, { label: 'owner still receives' });
    assert.equal(frames(member, 'shared-after').length, 0);
    await pool.query('UPDATE chat_sessions SET user_id = $1 WHERE id = $2', [f.member.id, f.sessionId]);
    ws.pushSessionState({ ...state, shared: false, label: 'previous-owner' });
    ws.pushToUser(f.member.id, event('ownership-control'));
    await waitFor(() => frames(member, 'ownership-control').length, { label: 'ownership batch processed' });
    assert.equal(frames(owner, 'previous-owner').length, 0);
  });

  await t.test('private deploy status is scoped for workflow, legacy peers and rollover producers', async () => {
    const f = await fixture();
    const member = await open(1, f.member.token), stranger = await open(1, f.stranger.token);
    const push = pushes.redeployStatus({ appSlug: f.slug, deploying: false, startedAt: new Date().toISOString(),
      fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40), missingSecrets: ['FAKE_SECRET_NAME'] });
    assert.equal(push.kind, 'scoped');
    assert.deepEqual(push.routing, { appSlug: f.slug });
    instances[1].ws._onBusMessage({ kind: push.kind, routing: push.routing, data: { ...push.data, label: 'workflow' }, fromWorkflow: true });
    instances[1].ws._onBusMessage({ kind: 'global', data: { ...push.data, label: 'old-peer' } });
    // The rollover helper lazy-loads this instance's ws module.
    const deploy = require('../src/services/app-deploy-status');
    deploy.markStart(f.slug, { fromSha: 'a'.repeat(40) });
    deploy.markEnd(f.slug, { missingSecrets: ['FAKE_SECRET_NAME'] });
    await waitFor(() => member.frames.filter(frame => frame.type === 'app_redeploy_status').length === 4, { label: 'all deploy producers reach member' });
    assert.equal(stranger.frames.filter(frame => frame.type === 'app_redeploy_status').length, 0);
  });

  await t.test('public-to-private changes, app blocks and moderation are enforced without invalidation', async () => {
    const f = await fixture();
    await pool.query("UPDATE apps SET view_visibility = 'public' WHERE id = $1", [f.appId]);
    const outsider = await open(1, f.stranger.token);
    const member = await open(1, f.member.token);
    const emit = label => instances[1].ws.broadcastGlobalScoped(event(label), { appId: f.appId });
    emit('public');
    await waitFor(() => frames(outsider, 'public').length, { label: 'public positive control' });
    await pool.query("UPDATE apps SET view_visibility = 'private' WHERE id = $1", [f.appId]);
    emit('private');
    await waitFor(() => frames(member, 'private').length, { label: 'member remains authorized' });
    assert.equal(frames(outsider, 'private').length, 0);
    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [f.member.id, f.appId]);
    emit('blocked');
    instances[1].ws.pushToUser(f.member.id, { type: 'app_blocks_changed', appId: f.appId, slug: f.slug, blocked: true,
      content: 'must be projected away' });
    await waitFor(() => member.frames.some(m => m.type === 'app_blocks_changed'), { label: 'blocked person still receives their revocation notice' });
    assert.equal(frames(member, 'blocked').length, 0);
    assert.deepEqual(member.frames.find(m => m.type === 'app_blocks_changed'), { type: 'app_blocks_changed', appId: f.appId, slug: f.slug, blocked: true });
    await pool.query('UPDATE apps SET moderation_suspended_at = NOW() WHERE id = $1', [f.appId]);
    emit('suspended');
    // The control follows the suspended event through the same FIFO delivery
    // queue; its arrival proves the suspended event was already decided.
    instances[1].ws.pushToUser(f.member.id, event('suspended-control'));
    await waitFor(() => frames(member, 'suspended-control').length, { label: 'post-suspension delivery batch processed' });
    assert.equal(frames(member, 'suspended').length, 0);
  });

  await t.test('missing routes, failed metadata, and unknown globals never widen the audience', async () => {
    const f = await fixture();
    const sock = await open(1, f.stranger.token);
    const ws = instances[1].ws;
    ws.broadcastGlobalScoped(event('missing-scope'));
    ws._onBusMessage({ kind: 'scoped', routing: {}, data: event('missing-bus-scope') });
    ws.broadcastGlobal(event('unknown-global'));
    ws._onBusMessage({ kind: 'global', data: event('unknown-bus-global') });
    ws._onBusMessage({ kind: 'global', data: { type: 'resync_hint', label: 'unexpected-extra-content' } });
    ws.broadcastGlobalScoped(event('mismatched-app', { appId: f.appId }), { appId: f.appId + 1 });
    ws._onBusMessage({ kind: 'session', routing: { sessionId: f.sessionId, fanout: true },
      data: { type: 'session_event', event: 'checks_ready', label: 'missing-session-route' } });
    routeFailure = true;
    ws.broadcastGlobal({ type: 'session_event', sessionId: f.sessionId, event: 'checks_ready', label: 'route-failure' });
    // The failing route lookup is the event: once its cache entry has settled
    // the batch dropped it without a delivery, so nothing more can arrive.
    await waitFor(() => ws._sessionMetaCache.get(f.sessionId)?.settled === true,
      { label: 'the failed route lookup settled' });
    routeFailure = false;
    assert.deepEqual(sock.frames.filter(frame => frame.label), []);
    assert.deepEqual(sock.frames.find(frame => frame.type === 'resync_hint'), { type: 'resync_hint' });
  });

  await t.test('listener recovery revalidates idle sockets after a missed revocation', async () => {
    const f = await fixture();
    const sock = await open(1, f.member.token);
    await pool.query('DELETE FROM sessions WHERE token = $1', [f.member.token]);
    instances[1].ws._onBusListening();
    await waitFor(() => sock.readyState === 3, { label: 'idle revoked socket closed on recovery' });
  });

  await t.test('an unavailable delivery authority sends no content and closes candidates', async () => {
    const f = await fixture();
    const sock = await open(1, f.member.token);
    outage = true;
    instances[1].ws.pushToUser(f.member.id, event('outage'));
    await waitFor(() => sock.readyState === 3, { label: 'unavailable authority closes candidate' });
    outage = false;
    assert.equal(frames(sock, 'outage').length, 0);
  });

  await t.test('a burst uses a bounded number of authorization queries and preserves order', async () => {
    const f = await fixture();
    const sock = await open(1, f.member.token);
    const before = gateQueries;
    for (let n = 0; n < 50; n++) instances[1].ws.pushToUser(f.member.id, event(`burst-${n}`));
    await waitFor(() => sock.frames.filter(frame => frame.label?.startsWith('burst-')).length === 50, { label: 'all burst frames' });
    assert.equal(gateQueries - before, 1, 'one batch, not a query per frame');
    assert.deepEqual(sock.frames.filter(frame => frame.label).map(frame => frame.label), Array.from({ length: 50 }, (_, n) => `burst-${n}`));
  });
});
