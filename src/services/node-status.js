// Lightweight probe over the sidecar Usernode `GET /status` endpoint.
//
// Pattern is copied from `examples/lib/dapp-server.js::createNodeStatusProbe`
// in the usernode-dapp-starter repo. Same single-poller-many-readers
// model: one Node process polls the sidecar on a self-adapting cadence,
// every other consumer (status dashboard, public /api/node-status, etc.)
// just reads the cached snapshot. Without this, every connected `/status`
// tab would do its own sidecar request — N tabs ≠ N sidecar requests.
//
// Exposes a single snapshot:
//   {
//     status:           "Synced" | "Syncing" | "Connected" | "Connecting"
//                      | "unreachable" | "unknown" | "mock"
//     peers:            number of connected peers
//     bestTipHeight:    our local tip's block height
//     peerBestTipHeight: max best_tip_height across connected peers
//     hasBeenSynced:    latched true once we ever observe Synced. Lets the
//                       UI say "trust this node" after first sync, instead
//                       of re-blocking every time the chain tip ticks.
//     hasFullUtxoDb:    parsed from `node.flags`. False here means the
//                       sidecar's recent-tx stream may silently drop tx
//                       from non-tracked senders (PARTIAL_LEDGER bug).
//                       Surfaced so operators can see the warning even
//                       when stdout isn't being tailed.
//     error:            last error message if `status === "unreachable"`
//     at:               Date.now() of last successful update
//   }

const https = require('https');
const http = require('http');
const log = require('./logger');

// `usernode-node` is the docker compose service name (see docker-compose.yml).
// In local dev (no sidecar), the snapshot stays "unknown" forever and the
// dashboard renders an explicit "no NODE_RPC_URL configured" hint instead
// of pretending the node is broken.
const DEFAULT_NODE_RPC_URL = process.env.NODE_RPC_URL || null;

// Cadence — fast during boot so the dashboard sees the
// Connecting → Connected → Syncing → Synced transitions, slow once
// Synced so we don't spam the sidecar in steady state.
const BOOT_INTERVAL_MS = 500;
const STEADY_INTERVAL_MS = 2000;

let snapshot = {
  status: 'unknown',
  peers: 0,
  bestTipHeight: null,
  peerBestTipHeight: null,
  hasBeenSynced: false,
  hasFullUtxoDb: null,
  error: null,
  at: Date.now(),
};

let nodeRpcUrl = null;
let timer = null;
let started = false;
let lastLoggedStatus = 'unknown';

function httpJson(method, urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      // Hard timeout — the sidecar's /status is normally <50ms; if it
      // takes >5s something is genuinely wrong and we want to surface
      // that as `unreachable` instead of stalling the polling loop.
      timeout: 5000,
      headers: { accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout (5000ms)'));
    });
    req.end();
  });
}

function logStatusChange(newStatus, errMsg) {
  if (newStatus === lastLoggedStatus) return;
  lastLoggedStatus = newStatus;
  if (errMsg) log.info('node-status', `-> ${newStatus} (${errMsg})`);
  else log.info('node-status', `-> ${newStatus}`);
}

async function tick() {
  if (!nodeRpcUrl) return;

  try {
    const data = await httpJson('GET', `${nodeRpcUrl}/status`);
    const status = (data && typeof data.node_sync_status === 'string')
      ? data.node_sync_status
      : 'unknown';

    const peerInfos = (data && Array.isArray(data.peers)) ? data.peers : [];
    const connectedPeers = peerInfos.filter(
      (p) => p && p.connection_status === 'Connected',
    );

    let peerBestTipHeight = null;
    for (const p of connectedPeers) {
      const h = p && p.best_tip_height;
      if (typeof h === 'number' && (peerBestTipHeight == null || h > peerBestTipHeight)) {
        peerBestTipHeight = h;
      }
    }

    const ourTipHeight = (data && data.blockchain && data.blockchain.best_tip
      && typeof data.blockchain.best_tip.height === 'number')
      ? data.blockchain.best_tip.height
      : null;

    // Parse `node.flags` (e.g. "HAS_FULL_UTXO_DB | HAS_FULL_IDENTITY_DB")
    // for the partial-ledger downgrade signal. Absence means the sidecar
    // is operating in partial mode — see the upstream comment in
    // dapp-server.js for the full failure mode.
    const flagsStr = (data && data.node && typeof data.node.flags === 'string')
      ? data.node.flags
      : '';
    const hasFullUtxoDb = flagsStr ? flagsStr.includes('HAS_FULL_UTXO_DB') : null;

    const hasBeenSynced = snapshot.hasBeenSynced || status === 'Synced';

    snapshot = {
      status,
      peers: connectedPeers.length,
      bestTipHeight: ourTipHeight,
      peerBestTipHeight,
      hasBeenSynced,
      hasFullUtxoDb,
      error: null,
      at: Date.now(),
    };
    logStatusChange(status, null);
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    snapshot = {
      status: 'unreachable',
      peers: 0,
      bestTipHeight: null,
      peerBestTipHeight: null,
      hasBeenSynced: snapshot.hasBeenSynced,
      hasFullUtxoDb: snapshot.hasFullUtxoDb,
      error: errMsg,
      at: Date.now(),
    };
    logStatusChange('unreachable', errMsg);
  }
}

function scheduleNext() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  // Boot cadence until we ever see Synced — same logic as dapps-starter.
  // Once latched, stay slow even if the node briefly drops to Syncing
  // (it's just applying new tip blocks).
  const inBoot = !snapshot.hasBeenSynced;
  const delay = inBoot ? BOOT_INTERVAL_MS : STEADY_INTERVAL_MS;
  timer = setTimeout(() => {
    tick().then(scheduleNext, scheduleNext);
  }, delay);
  if (timer.unref) timer.unref();
}

function start(opts = {}) {
  if (started) return;
  started = true;
  nodeRpcUrl = opts.nodeRpcUrl || DEFAULT_NODE_RPC_URL;

  if (!nodeRpcUrl) {
    log.info('node-status', 'NODE_RPC_URL not set — node status disabled (snapshot stays "unknown")');
    return;
  }

  log.info('node-status', `polling sidecar at ${nodeRpcUrl}`);
  tick().then(scheduleNext, scheduleNext);
}

function stop() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
}

function get() {
  // Hand callers a fresh shallow copy so they can't accidentally mutate
  // the cached snapshot in the dashboard's render path.
  return { ...snapshot };
}

module.exports = { start, stop, get };
