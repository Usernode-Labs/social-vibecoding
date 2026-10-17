'use strict';

// What one process changed about an app's visibility, governance or admins,
// for every other process's own caches of them (app-access.js visibility,
// governance.js, app-admins.js; each a 10-second in-process TTL cache). Sent
// on the WebSocket bus as 'app_access'; services/ws.js invalidates there with
// each module's Here variant, which publishes nothing. So a merged dapp.json
// that makes an app view-private, applied by the deploy work in one process,
// stops the scoped pushes every web process relays to non-members at once
// rather than after the TTL. Best-effort: a lost one is bounded by the TTL,
// and a process whose bus listener reconnects clears its caches (ws.js
// _onBusListening).

function shareAccessChange(appId, slug = null) {
  try {
    require('./ws-bus').publish('app_access', null, { appId: appId ?? null, slug: slug || null });
  } catch { /* the TTL still bounds it */ }
}

module.exports = { shareAccessChange };
