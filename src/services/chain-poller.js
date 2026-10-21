// Wallet linking: a person proves an address is theirs by sending the
// platform's APP_PUBKEY a transaction with memo
// { app: "vibecode", type: "link_wallet", token: "..." }; the sender's
// pubkey is stored against the user who generated that token.
//
// The wallet-links clock (src/workflow/clock/services.ts) reads the explorer
// for them: one run at a time across every process that runs the workflow,
// each run a poll(). What a run carries to the next (the chain, the highest
// block it has read, how many links it made, an outage's streak) is its
// result, which the clock hands the next run as `previous`. Before, every
// serving process polled on its own timer with its cursor in memory: N web
// Pods were N pollers, and every restart read the chain again from the
// start. Reading a block again changes nothing: a link spends its token.

const https = require('https');
const http = require('http');
const log = require('./logger');
const genesisAccounts = require('./genesis-accounts');

const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = process.env.EXPLORER_USE_HTTP === 'true';

const POLL_INTERVAL_MS = 4000;
// Ceiling for the failure backoff. When the explorer is down (it answers
// `HTTP 503: no available server` for hours at a time), a flat 4s retry
// produced ~900 warn lines an hour and buried every other log line in the
// platform's output. Backing off to a minute keeps the recovery latency
// acceptable while making the log readable again.
const MAX_POLL_INTERVAL_MS = 60000;
const MAX_PAGES = 5;
// Without an APP_PUBKEY nothing is linked: looked at again this seldom.
const OFF_REST_MS = 5 * 60 * 1000;

// Next run's delay: 4s while healthy, doubling per consecutive failure up to
// the ceiling (the clock's `restMs`).
function backoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  const grown = POLL_INTERVAL_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(grown, MAX_POLL_INTERVAL_MS);
}

// One failed poll, as the next run reads it. The FIRST failure of a streak
// logs at warn (an operator should see the transition); every repeat drops
// to debug so a long outage costs one line, not one per retry.
function noteFailure(previous, what, message) {
  const consecutiveFailures = (Number(previous.consecutiveFailures) || 0) + 1;
  const downSince = previous.downSince || Date.now();
  if (consecutiveFailures === 1) {
    log.warn('chain-poller', `${what} — retrying with backoff`, { err: message });
  } else {
    log.debug('chain-poller', `${what} (failure #${consecutiveFailures})`, {
      err: message,
      nextRetryMs: backoffMs(consecutiveFailures),
    });
  }
  return { ...previous, consecutiveFailures, downSince, lastError: message, restMs: backoffMs(consecutiveFailures) };
}

// Closing the streak is worth exactly one warn line: it is the event an
// operator scanning the log actually wants to find.
function noteSuccess(previous) {
  if (Number(previous.consecutiveFailures) > 0) {
    const downMs = previous.downSince ? Date.now() - previous.downSince : 0;
    log.warn('chain-poller', 'explorer recovered', {
      afterFailures: previous.consecutiveFailures,
      downSeconds: Math.round(downMs / 1000),
    });
  }
  return { ...previous, consecutiveFailures: 0, downSince: null, lastError: null, restMs: POLL_INTERVAL_MS };
}

function httpJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
      },
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function baseUrl() {
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(EXPLORER_UPSTREAM);
  const proto = EXPLORER_USE_HTTP || isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

function parseMemo(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// What a run carries on from the last good one's result.
function carried(previous) {
  const p = previous && typeof previous === 'object' ? previous : {};
  return {
    chainId: p.chainId || null,
    lastBlockHeight: Number(p.lastBlockHeight) || 0,
    walletLinkCount: Number(p.walletLinkCount) || 0,
    consecutiveFailures: Number(p.consecutiveFailures) || 0,
    downSince: p.downSince || null,
    lastError: p.lastError || null,
  };
}

/**
 * One poll (the wallet-links clock's run): the explorer's transactions to
 * APP_PUBKEY from the highest block a run has read, each link memo from a
 * genesis address applied. Resolves what the next run carries on from, with
 * when it should run (`restMs`). An explorer that fails is a result, never a
 * throw: the streak is carried, and the next run waits longer. A database
 * that cannot be written throws: the next run reads these blocks again.
 */
async function poll(config, pool, previous = null) {
  const appPubkey = config && config.usernodeAppPubkey;
  const state = { ...carried(previous), polledAt: Date.now() };
  if (!appPubkey) return { ...state, off: true, restMs: OFF_REST_MS };
  // A link is only for a genesis address, and until this process has loaded
  // the genesis set every address reads as not genesis: a transaction read
  // now would be skipped and never read again. Wait for the set instead.
  if (!genesisAccounts.isLoaded()) return { ...state, waiting: 'genesis', restMs: POLL_INTERVAL_MS };

  let next = state;
  if (!next.chainId) {
    let data;
    try { data = await httpJson('GET', `${baseUrl()}/active_chain`); } catch (e) {
      return noteFailure(next, 'chain ID discovery failed', e.message);
    }
    // Discovery succeeded but the explorer answered without a chain_id.
    // This is an outage too — without recording it the streak stays at 0,
    // the poller is pinned at the healthy 4s interval forever, and the
    // status pages report the explorer as fine while nothing is polled.
    if (!data || !data.chain_id) return noteFailure(next, 'chain ID missing', 'Explorer returned no chain_id');
    next = { ...next, chainId: data.chain_id };
  }

  const txUrl = `${baseUrl()}/${next.chainId}/transactions`;
  let cursor;
  let height = next.lastBlockHeight;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { recipient: appPubkey, limit: 50 };
    if (cursor) body.cursor = cursor;
    if (next.lastBlockHeight > 0) body.from_height = next.lastBlockHeight;

    let data;
    try { data = await httpJson('POST', txUrl, body); }
    catch (e) {
      return noteFailure({ ...next, lastBlockHeight: height }, 'poll failed', e.message);
    }

    const items = data.items || [];
    if (!items.length) break;
    for (const tx of items) {
      if (tx.block_height && tx.block_height > height) height = tx.block_height;

      const memo = parseMemo(tx.memo);
      if (!memo || memo.app !== 'vibecode' || memo.type !== 'link_wallet' || !memo.token) continue;

      const sender = tx.source || tx.from_pubkey || tx.from;
      if (!sender) continue;

      if (!genesisAccounts.isGenesisAddress(sender)) {
        log.info('chain-poller', 'Ignoring link from non-genesis address', { pubkey: sender.slice(0, 10) + '...' });
        continue;
      }

      const { rowCount } = await pool.query(
        `UPDATE users
           SET usernode_pubkey = $1,
               wallet_link_token = NULL,
               wallet_link_expires_at = NULL
         WHERE wallet_link_token = $2
           AND wallet_link_expires_at > NOW()`,
        [sender, memo.token]
      );
      if (rowCount > 0) {
        next = { ...next, walletLinkCount: next.walletLinkCount + 1 };
        log.info('chain-poller', 'Wallet linked', { pubkey: sender, token: memo.token.slice(0, 8) + '...' });
      }
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return noteSuccess({ ...next, lastBlockHeight: height });
}

/**
 * The status pages' shape, from the clock's last run (platform.clockStatus:
 * `result` its last good result, `lastSweepAt` when it ran).
 */
function statusOf(clock) {
  const r = (clock && clock.result) || {};
  return {
    chainId: r.chainId || null,
    lastBlockHeight: Number(r.lastBlockHeight) || 0,
    walletLinkCount: Number(r.walletLinkCount) || 0,
    lastPolledAt: r.polledAt || null,
    lastError: r.lastError || (clock && clock.lastError) || null,
    // Outage shape for the status pages: how many retries have failed in a
    // row, when the streak began, and how long the next one waits.
    consecutiveFailures: Number(r.consecutiveFailures) || 0,
    downSince: r.downSince || null,
    pollIntervalMs: Number(r.restMs) || POLL_INTERVAL_MS,
    enabled: !!(clock && clock.lastSweepAt) && !r.off,
  };
}

module.exports = { poll, statusOf, backoffMs, POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS };
