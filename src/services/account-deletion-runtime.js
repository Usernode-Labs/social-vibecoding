'use strict';

// Short-lived streams cannot keep an erased account alive. Ordinary HTTP
// requests unregister at finish; SSE streams unregister at close.
const responses = new Map();
function trackResponse(req, res, next) {
  if (req.user?.id) {
    const id = Number(req.user.id);
    if (!responses.has(id)) responses.set(id, new Set());
    const set = responses.get(id);
    set.add(res);
    const remove = () => { set.delete(res); if (!set.size) responses.delete(id); };
    res.once('close', remove);
    res.once('finish', remove);
  }
  next();
}

function revokeLocal(userId, sessionIds = []) {
  for (const res of responses.get(Number(userId)) || []) {
    if (!res.locals?.accountDeletionResponse) res.destroy();
  }
  require('./ws').disconnectUser(userId);
  require('./app-access').invalidateAllVisibility();
  require('./app-admins').invalidateAppAdmins();
  require('./agent-models').invalidateUser(userId);
  const registry = require('./stop-registry');
  for (const id of sessionIds) {
    const handle = registry.get(id);
    if (!handle) continue;
    handle.stopped = true;
    handle.stoppedBy = 'account_deleted';
    handle.stopRequestedAt = Date.now();
    handle.abort?.abort();
  }
}

function revoke(userId, sessionIds) {
  revokeLocal(userId, sessionIds);
  require('./ws').broadcastGlobal({ type: 'resync_hint' });
  require('./ws-bus').publish('account_deleted', { userId }, { type: 'account_deleted' });
}

async function reconcile(pool) {
  const ids = [...new Set([...responses.keys(), ...require('./ws').connectedUserIds()])];
  if (!ids.length) return;
  const { rows } = await pool.query('SELECT id FROM users WHERE id = ANY($1::int[])', [ids]);
  const live = new Set(rows.map(r => Number(r.id)));
  for (const id of ids) if (!live.has(id)) await receive(pool, id);
}

async function receive(pool, userId) {
  // Revoke live connections before the DB round trip, including during an
  // outage. The receipt survives deletion and names any running workers.
  revokeLocal(userId);
  if (!pool) return;
  const { rows } = await pool.query(`SELECT t.target FROM account_deletion_tasks t
    JOIN account_deletions d ON d.id = t.deletion_id WHERE d.user_id = $1 AND t.kind = 'worker'`, [userId]);
  revokeLocal(userId, rows.map(r => Number(r.target)));
}

module.exports = { trackResponse, revoke, revokeLocal, receive, reconcile };
