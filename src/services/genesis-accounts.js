const https = require('https');
const http = require('http');
const log = require('./logger');

const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || 'alpha2.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';

let genesisAddresses = new Set();
let loaded = false;

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

function explorerBase() {
  const isPrivate = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(EXPLORER_UPSTREAM);
  const proto = isPrivate ? 'http' : 'https';
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`;
}

async function fetchGenesisAccounts() {
  let chainId;
  try {
    const data = await httpJson('GET', `${explorerBase()}/active_chain`);
    chainId = data && data.chain_id;
  } catch (e) {
    log.warn('genesis', 'Could not discover chain', { err: e.message });
    return;
  }
  if (!chainId) return;

  const base = `${explorerBase()}/${chainId}`;
  const accounts = new Set();

  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const body = { to_height: 1, limit: 200 };
    if (cursor) body.cursor = cursor;
    const resp = await httpJson('POST', `${base}/transactions`, body);

    const items = (resp && Array.isArray(resp.items)) ? resp.items
      : (resp && Array.isArray(resp.transactions)) ? resp.transactions
      : [];

    for (const tx of items) {
      const dest = tx.destination || tx.to || tx.destination_pubkey;
      if (dest) accounts.add(dest);
    }

    if (!resp.has_more || !resp.next_cursor) break;
    cursor = resp.next_cursor;
  }

  genesisAddresses = accounts;
  loaded = true;
  log.info('genesis', `Loaded ${accounts.size} genesis account(s)`);
}

function start() {
  fetchGenesisAccounts().catch(e => {
    log.warn('genesis', 'Initial fetch failed — will retry in 30s', { err: e.message });
    setTimeout(() => fetchGenesisAccounts().catch(() => {}), 30_000);
  });
}

function isGenesisAddress(address) {
  if (!loaded || genesisAddresses.size === 0) return true;
  return genesisAddresses.has(address);
}

function isLoaded() { return loaded; }
function count() { return genesisAddresses.size; }

module.exports = { start, isGenesisAddress, isLoaded, count };
