// Polls the Usernode block explorer for wallet-linking transactions
// sent to the platform's APP_PUBKEY. When a tx with memo
// { app: "vibecode", type: "link_wallet", token: "..." } is found,
// the sender's pubkey is stored against the user who generated that token.

const https = require('https');
const http = require('http');
const log = require('./logger');
const genesisAccounts = require('./genesis-accounts');

const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'alpha2.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';

const POLL_INTERVAL_MS = 4000;
const MAX_PAGES = 5;
const MAX_SEEN = 5000;

let chainId = null;
let seenTxIds = new Set();
let lastBlockHeight = 0;
let intervalHandle = null;

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
  const proto = isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

async function discoverChainId() {
  const data = await httpJson('GET', `${baseUrl()}/active_chain`);
  if (data && data.chain_id) chainId = data.chain_id;
}

function parseMemo(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function boundSeenSet() {
  if (seenTxIds.size > MAX_SEEN) {
    const arr = [...seenTxIds];
    seenTxIds = new Set(arr.slice(arr.length - MAX_SEEN));
  }
}

async function poll(appPubkey, pool) {
  if (!chainId) {
    try { await discoverChainId(); } catch (e) {
      log.warn('chain-poller', 'chain ID discovery failed', { err: e.message });
      return;
    }
    if (!chainId) return;
  }

  const txUrl = `${baseUrl()}/${chainId}/transactions`;
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { recipient: appPubkey, limit: 50 };
    if (cursor) body.cursor = cursor;
    if (lastBlockHeight > 0) body.from_height = lastBlockHeight;

    let data;
    try { data = await httpJson('POST', txUrl, body); }
    catch (e) {
      log.warn('chain-poller', 'poll failed', { err: e.message });
      return;
    }

    const items = data.items || [];
    if (!items.length) break;

    let allSeen = true;
    for (const tx of items) {
      const txId = tx.tx_id || tx.id;
      if (!txId || seenTxIds.has(txId)) continue;
      allSeen = false;
      seenTxIds.add(txId);

      if (tx.block_height && tx.block_height > lastBlockHeight) {
        lastBlockHeight = tx.block_height;
      }

      const memo = parseMemo(tx.memo);
      if (!memo || memo.app !== 'vibecode' || memo.type !== 'link_wallet' || !memo.token) continue;

      const sender = tx.source || tx.from_pubkey || tx.from;
      if (!sender) continue;

      if (!genesisAccounts.isGenesisAddress(sender)) {
        log.info('chain-poller', 'Ignoring link from non-genesis address', { pubkey: sender.slice(0, 10) + '...' });
        continue;
      }

      try {
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
          log.info('chain-poller', 'Wallet linked', { pubkey: sender, token: memo.token.slice(0, 8) + '...' });
        }
      } catch (e) {
        log.warn('chain-poller', 'DB update failed', { err: e.message });
      }
    }

    boundSeenSet();
    if (allSeen || !data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
}

function start(config) {
  const appPubkey = config.usernodeAppPubkey;
  if (!appPubkey) {
    log.info('chain-poller', 'USERNODE_APP_PUBKEY not set — wallet linking disabled');
    return;
  }

  const { getPool } = require('../db/pool');
  const pool = getPool(config);

  log.info('chain-poller', 'Starting', { appPubkey: appPubkey.slice(0, 10) + '...' });

  discoverChainId().catch(() => {});
  intervalHandle = setInterval(() => poll(appPubkey, pool), POLL_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { start, stop };
