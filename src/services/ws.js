const { WebSocketServer } = require('ws');
const { getPool } = require('../db/pool');
const log = require('./logger');
const notifications = require('./notifications');

let wss;
const rooms = new Map(); // appId -> Set<{ ws, user }>
const globalClients = new Set(); // Set<{ ws, user }> for /ws/events

function attach(server, config) {
  const pool = getPool(config);

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const user = await authenticateWs(req, pool);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (req.url?.startsWith('/ws/events')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, user };
        globalClients.add(client);
        log.debug('ws', 'Global events client connected', { userId: user.id });

        ws.on('close', () => {
          globalClients.delete(client);
          log.debug('ws', 'Global events client disconnected', { userId: user.id });
        });
      });
      return;
    }

    if (req.url?.startsWith('/ws/chat/')) {
      const appSlug = req.url.replace('/ws/chat/', '').split('?')[0];
      if (!appSlug) { socket.destroy(); return; }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, { user, appSlug });
      });
      return;
    }

    socket.destroy();
  });

  wss.on('connection', async (ws, req, { user, appSlug }) => {
    const appId = await resolveAppId(pool, appSlug);
    if (!appId) {
      ws.close(4004, 'App not found');
      return;
    }

    const client = { ws, user, appId, appSlug };
    joinRoom(appId, client);

    log.info('ws', 'Client connected', { userId: user.id, appSlug });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        await handleMessage(pool, client, msg);
      } catch (err) {
        log.warn('ws', 'Invalid message', { err: err.message });
      }
    });

    ws.on('close', () => {
      leaveRoom(appId, client);
      log.debug('ws', 'Client disconnected', { userId: user.id, appSlug });
    });
  });

  log.info('ws', 'WebSocket server attached');
}

async function authenticateWs(req, pool) {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session;
    if (!token) return null;

    const { rows } = await pool.query(
      `SELECT s.user_id, s.expires_at, u.username, u.is_admin
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = $1`,
      [token]
    );

    if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
      return null;
    }

    return { id: rows[0].user_id, username: rows[0].username, isAdmin: rows[0].is_admin };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = {};
  header.split(';').forEach((pair) => {
    const [key, ...vals] = pair.trim().split('=');
    if (key) result[key.trim()] = vals.join('=').trim();
  });
  return result;
}

async function resolveAppId(pool, slug) {
  const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [slug]);
  return rows[0]?.id || null;
}

function joinRoom(appId, client) {
  if (!rooms.has(appId)) rooms.set(appId, new Set());
  rooms.get(appId).add(client);
}

function leaveRoom(appId, client) {
  const room = rooms.get(appId);
  if (room) {
    room.delete(client);
    if (room.size === 0) rooms.delete(appId);
  }
}

function broadcast(appId, data, excludeWs = null) {
  const room = rooms.get(appId);
  if (!room) return;
  const payload = JSON.stringify(data);
  for (const client of room) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

// Broadcast to all connected clients (global events like app status changes)
function broadcastGlobal(data) {
  const payload = JSON.stringify(data);
  let sent = 0;
  for (const client of globalClients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
      sent++;
    }
  }
  if (data.event === 'cc_progress' && sent === 0 && globalClients.size === 0) {
    log.debug('ws', 'broadcastGlobal: no clients connected');
  }
}

async function handleMessage(pool, client, msg) {
  switch (msg.type) {
    case 'chat': {
      if (!msg.content?.trim()) return;
      const content = msg.content.trim().substring(0, 2000);

      const { rows } = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type)
         VALUES ($1, $2, $3, 'message')
         RETURNING id, created_at`,
        [client.appId, client.user.id, content]
      );

      const outMsg = {
        type: 'chat',
        id: rows[0].id,
        userId: client.user.id,
        username: client.user.username,
        content,
        msgType: 'message',
        createdAt: rows[0].created_at,
      };

      broadcast(client.appId, outMsg);

      // Fan out @mention notifications after the chat echo so UI order
      // stays predictable (everyone sees the message first, target user
      // then sees the bell-badge update).
      try {
        const notifRows = await notifications.createMentionNotifications(pool, {
          appId: client.appId,
          chatMessageId: rows[0].id,
          senderId: client.user.id,
          content,
        });
        if (notifRows.length) {
          // Hydrate with app/sender info so the client can render the
          // dropdown item immediately without another fetch. Mirror the
          // column set of notifications.listForUser so the same
          // serialize() works for both fresh and history rows — kudos
          // added session_id / pr_title / pr_number on top of the
          // original mention shape.
          const { rows: hydrated } = await pool.query(
            `SELECT n.id, n.kind, n.read_at, n.created_at,
                    n.app_id, a.slug AS app_slug, a.name AS app_name,
                    n.chat_message_id, cm.content AS message_content,
                    n.session_id, cs.pr_title, cs.pr_number,
                    su.username AS source_username, n.user_id
             FROM notifications n
             LEFT JOIN apps a ON a.id = n.app_id
             LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
             LEFT JOIN chat_sessions cs ON cs.id = n.session_id
             LEFT JOIN users su ON su.id = n.source_user_id
             WHERE n.id = ANY($1::int[])`,
            [notifRows.map((r) => r.id)]
          );
          for (const row of hydrated) {
            pushNotificationToUser(row.user_id, {
              type: 'notification_new',
              notification: notifications.serialize(row),
            });
          }
        }
      } catch (err) {
        log.warn('ws', 'mention notify failed', { err: err.message });
      }
      break;
    }

    case 'typing': {
      broadcast(client.appId, {
        type: 'typing',
        userId: client.user.id,
        username: client.user.username,
      }, client.ws);
      break;
    }

    default:
      break;
  }
}

async function sendSystemMessage(pool, appId, content, msgType = 'system') {
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (app_id, content, msg_type)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [appId, content, msgType]
  );

  broadcast(appId, {
    type: 'chat',
    id: rows[0].id,
    userId: null,
    username: null,
    content,
    msgType,
    createdAt: rows[0].created_at,
  });
}

function getOnlineUsers(appId) {
  const room = rooms.get(appId);
  if (!room) return [];
  const seen = new Set();
  const users = [];
  for (const client of room) {
    if (!seen.has(client.user.id)) {
      seen.add(client.user.id);
      users.push({ id: client.user.id, username: client.user.username });
    }
  }
  return users;
}

// Push an app status update to all connected clients
function pushAppStatusUpdate(app) {
  broadcastGlobal({
    type: 'app_status',
    appId: app.id,
    slug: app.slug,
    status: app.status,
    url: app.url || null,
  });
}

function pushSessionUpdate(data) {
  broadcastGlobal({ type: 'session_update', ...data });
}

function pushVoteUpdate(data) {
  broadcastGlobal({ type: 'vote_update', ...data });
}

// PR kudos count changed. Fan out the new total + the giver's username
// (so the receiving client can append the new giver to its popover
// cache without a refetch). Same broadcast model as vote_update —
// every connected client gets the message and decides whether it cares.
function pushKudosUpdate(data) {
  broadcastGlobal({ type: 'kudos_update', ...data });
}

// Notify all clients that an app's metadata changed (e.g. renamed via vote).
function pushAppUpdate(data) {
  broadcastGlobal({ type: 'app_update', ...data });
}

// Notify all clients that an issue/rename-proposal was created, voted on,
// or closed for a given app — so their open vote panel refreshes in real
// time instead of only on page reload.
function pushIssueUpdate(data) {
  broadcastGlobal({ type: 'issue_update', ...data });
}

// Send a payload to every /ws/events socket belonging to `userId`. Used for
// @mention delivery — a single user may have multiple tabs open.
function pushNotificationToUser(userId, payload) {
  const json = JSON.stringify(payload);
  let sent = 0;
  for (const client of globalClients) {
    if (client.user.id === userId && client.ws.readyState === 1) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

module.exports = { attach, broadcast, broadcastGlobal, sendSystemMessage, getOnlineUsers, pushAppStatusUpdate, pushSessionUpdate, pushVoteUpdate, pushKudosUpdate, pushAppUpdate, pushIssueUpdate, pushNotificationToUser };
