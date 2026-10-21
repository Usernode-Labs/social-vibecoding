// Chain-poller / genesis-accounts failure backoff.
//
// The bug this pins: both services retried a dead explorer on a flat
// interval and logged every failure at warn. In production
// (testnet-explorer answering `HTTP 503: no available server` for hours)
// that produced 267 of the last 400 platform log lines — the poller's
// retries buried every other log line in the process, and the outage
// itself was still invisible on the status pages.
//
// Two properties matter and are easy to regress independently:
//   1. the retry delay GROWS while failing and resets on success;
//   2. a long outage costs ONE warn line, not one per retry, but the
//      transitions into and out of it are both still visible at warn.
//
// Run with: node --test tests/chain-poller-backoff.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

// Load chain-poller with its logger replaced by a recorder, so we can
// assert on levels without a live explorer or DB.
function loadPollerWithFakeLog() {
  const logPath = require.resolve(path.join(ROOT, 'src/services/logger.js'));
  const pollerPath = require.resolve(path.join(ROOT, 'src/services/chain-poller.js'));
  const lines = [];
  const fake = {
    warn: (...a) => lines.push({ level: 'warn', args: a }),
    debug: (...a) => lines.push({ level: 'debug', args: a }),
    info: (...a) => lines.push({ level: 'info', args: a }),
    error: (...a) => lines.push({ level: 'error', args: a }),
  };

  const origLoad = Module._load;
  delete require.cache[pollerPath];
  require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: fake };
  let poller;
  try {
    poller = require(pollerPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[logPath];
    delete require.cache[pollerPath];
  }
  return { poller, lines };
}

// The poller is the wallet-links clock's run (src/workflow/clock/
// services.ts): what it carries to the next run, the streak included, is its
// result, handed back as `previous`. A process's timer and memory before.

const http = require('node:http');

// An explorer on a local port: `answer(req, body)` returns [status, json].
function fakeExplorer(answer) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      asked.push({ url: req.url, body: parsed });
      const [status, json] = answer(req, parsed);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, asked, host: `127.0.0.1:${srv.address().port}` })));
}

// The poller with its logger recorded and its explorer at `host`
// (EXPLORER_UPSTREAM is read at load), and the genesis set as told.
function pollerAt(host, { loaded = true, genesis = () => true } = {}) {
  const original = process.env.EXPLORER_UPSTREAM;
  process.env.EXPLORER_UPSTREAM = host;
  const genesisPath = require.resolve(path.join(ROOT, 'src/services/genesis-accounts.js'));
  const realGenesis = require.cache[genesisPath];
  require.cache[genesisPath] = { id: genesisPath, filename: genesisPath, loaded: true, exports: { isLoaded: () => loaded, isGenesisAddress: genesis } };
  try {
    return loadPollerWithFakeLog();
  } finally {
    if (realGenesis) require.cache[genesisPath] = realGenesis; else delete require.cache[genesisPath];
    if (original === undefined) delete process.env.EXPLORER_UPSTREAM; else process.env.EXPLORER_UPSTREAM = original;
  }
}

const CONFIG = { usernodeAppPubkey: 'utpk1testfakepubkey' };

test('the backoff doubles from 4s and is capped at 60s, as the next run\'s rest', () => {
  const { poller } = loadPollerWithFakeLog();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(poller.backoffMs), [4000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('an outage is carried from run to run: one warn into it, debug while it lasts, one warn out of it', async () => {
  let up = false;
  const explorer = await fakeExplorer((req) => {
    if (!up) return [503, { error: 'no available server' }];
    return req.url.endsWith('/active_chain') ? [200, { chain_id: 'c1' }] : [200, { items: [] }];
  });
  try {
    const { poller, lines } = pollerAt(explorer.host);
    const pool = { query: async () => ({ rowCount: 0 }) };
    const first = await poller.poll(CONFIG, pool, null);
    assert.deepEqual([first.consecutiveFailures, first.restMs], [1, 4000]);
    assert.ok(first.downSince && first.lastError, 'the streak start and why, for the status pages');
    const second = await poller.poll(CONFIG, pool, first);
    assert.deepEqual([second.consecutiveFailures, second.restMs, second.downSince], [2, 8000, first.downSince]);
    assert.deepEqual(lines.map((l) => l.level), ['warn', 'debug'], 'a long outage costs one warn line, not one per retry');
    up = true;
    const back = await poller.poll(CONFIG, pool, second);
    assert.deepEqual([back.consecutiveFailures, back.downSince, back.lastError, back.restMs, back.chainId], [0, null, null, 4000, 'c1']);
    assert.equal(lines.filter((l) => l.level === 'warn' && /recovered/.test(l.args[1])).length, 1, 'closing the streak warns once');
  } finally {
    explorer.srv.close();
  }
});

test('a 200 with no chain_id is an outage too', async () => {
  const explorer = await fakeExplorer(() => [200, {}]);
  try {
    const { poller } = pollerAt(explorer.host);
    const out = await poller.poll(CONFIG, { query: async () => ({ rowCount: 0 }) }, null);
    assert.equal(out.consecutiveFailures, 1);
    assert.equal(out.lastError, 'Explorer returned no chain_id');
  } finally {
    explorer.srv.close();
  }
});

test('a link memo from a genesis address links the wallet, and the next run reads on from its block', async () => {
  const explorer = await fakeExplorer((req) => (req.url.endsWith('/active_chain') ? [200, { chain_id: 'c1' }] : [200, { items: [
    { tx_id: 't1', block_height: 7, source: 'ut1genesis', memo: JSON.stringify({ app: 'vibecode', type: 'link_wallet', token: 'tok-1' }) },
    { tx_id: 't2', block_height: 9, source: 'ut1stranger', memo: JSON.stringify({ app: 'vibecode', type: 'link_wallet', token: 'tok-2' }) },
    { tx_id: 't3', block_height: 8, source: 'ut1genesis', memo: 'not json' },
  ] }]));
  try {
    const { poller } = pollerAt(explorer.host, { genesis: (a) => a === 'ut1genesis' });
    const updates = [];
    const pool = { query: async (sql, params) => { updates.push(params); return { rowCount: 1 }; } };
    const out = await poller.poll(CONFIG, pool, null);
    assert.deepEqual(updates, [['ut1genesis', 'tok-1']], 'only a genesis address links');
    assert.deepEqual([out.walletLinkCount, out.lastBlockHeight, out.chainId], [1, 9, 'c1']);
    await poller.poll(CONFIG, pool, out);
    const reads = explorer.asked.filter((a) => a.url.endsWith('/transactions'));
    assert.equal(reads[1].body.from_height, 9, 'its cursor is the last run\'s result');
    assert.equal(explorer.asked.filter((a) => a.url.endsWith('/active_chain')).length, 1, 'the chain is the last run\'s too');
  } finally {
    explorer.srv.close();
  }
});

test('a memo the database refuses as data is skipped, and the cursor passes it', async () => {
  const explorer = await fakeExplorer((req) => (req.url.endsWith('/active_chain') ? [200, { chain_id: 'c1' }] : [200, { items: [
    { tx_id: 't1', block_height: 7, source: 'ut1genesis', memo: JSON.stringify({ app: 'vibecode', type: 'link_wallet', token: 'bad\u0000token' }) },
    { tx_id: 't2', block_height: 8, source: 'ut1genesis', memo: JSON.stringify({ app: 'vibecode', type: 'link_wallet', token: 'tok-2' }) },
  ] }]));
  try {
    const { poller } = pollerAt(explorer.host);
    const linked = [];
    const pool = { query: async (_sql, [, token]) => {
      if (token.includes('\u0000')) throw Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
      linked.push(token);
      return { rowCount: 1 };
    } };
    const out = await poller.poll(CONFIG, pool, null);
    assert.deepEqual(linked, ['tok-2'], 'the next memo still links');
    assert.equal(out.lastBlockHeight, 8, 'the cursor passes the refused memo');
    // A failure that is not about the memo's data is the run's: it throws.
    const down = { query: async () => { throw Object.assign(new Error('connection terminated'), { code: '57P01' }); } };
    await assert.rejects(poller.poll(CONFIG, down, null), /connection terminated/);
  } finally {
    explorer.srv.close();
  }
});

test('until the genesis set is loaded nothing is read, so no link is skipped for good', async () => {
  const explorer = await fakeExplorer(() => [200, { chain_id: 'c1', items: [] }]);
  try {
    const { poller } = pollerAt(explorer.host, { loaded: false });
    const out = await poller.poll(CONFIG, { query: async () => assert.fail('nothing written') }, { lastBlockHeight: 5 });
    assert.equal(out.waiting, 'genesis');
    assert.equal(out.lastBlockHeight, 5, 'the cursor stays where it was');
    assert.equal(explorer.asked.length, 0);
    // No APP_PUBKEY: off, looked at again in five minutes.
    assert.deepEqual([(await poller.poll({}, null, null)).off, (await poller.poll({}, null, null)).restMs], [true, 300000]);
  } finally {
    explorer.srv.close();
  }
});

test('the status pages read the clock\'s last run', () => {
  const { poller } = loadPollerWithFakeLog();
  const s = poller.statusOf({ lastSweepAt: '2026-10-21T10:00:00Z', lastError: null,
    result: { chainId: 'c1', lastBlockHeight: 9, walletLinkCount: 2, polledAt: 1, consecutiveFailures: 3, downSince: 5, lastError: 'HTTP 503', restMs: 16000 } });
  assert.deepEqual(s, { chainId: 'c1', lastBlockHeight: 9, walletLinkCount: 2, lastPolledAt: 1, lastError: 'HTTP 503',
    consecutiveFailures: 3, downSince: 5, pollIntervalMs: 16000, enabled: true });
  assert.equal(poller.statusOf(null).enabled, false);
  // A run that failed (a database error) leaves the last good one's state.
  const failed = poller.statusOf({ lastSweepAt: '2026-10-21T10:01:00Z', lastError: 'connection terminated', result: null,
    kept: { chainId: 'c1', lastBlockHeight: 9, walletLinkCount: 2, polledAt: 1, restMs: 4000 } });
  assert.deepEqual([failed.chainId, failed.lastBlockHeight, failed.walletLinkCount, failed.lastError], ['c1', 9, 2, 'connection terminated']);
});

// ─── genesis-accounts ───────────────────────────────────────────────────

test('genesis-accounts retries indefinitely with backoff, not once', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/genesis-accounts.js'), 'utf8');
  // It used to do exactly one 30s retry and then give up silently, so with
  // the explorer down for hours the genesis set never loaded at all.
  assert.match(src, /retryHandle = setTimeout\(attempt, retryMs\(\)\)/,
    'the retry must re-arm itself');
  assert.match(src, /const RETRY_MAX_MS = 300_000;/);
  assert.doesNotMatch(src, /will retry in 30s/, 'the one-shot retry copy is gone');
});

test('genesis-accounts surfaces the same outage fields as chain-poller', () => {
  const genesis = require(path.join(ROOT, 'src/services/genesis-accounts.js'));
  const s = genesis.getStatus();
  for (const key of ['loaded', 'count', 'consecutiveFailures', 'downSince', 'lastError']) {
    assert.ok(key in s, `getStatus() must expose ${key}`);
  }
});

test('chain discovery failure propagates instead of being swallowed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/genesis-accounts.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchGenesisAccounts('),
    src.indexOf('function start('));
  // A swallowed error meant start()'s catch never ran, so the streak was
  // never recorded and the retry never armed.
  assert.match(fn, /throw new Error\(`Could not discover chain/);
  assert.match(fn, /throw new Error\('Explorer returned no chain_id'\)/);
});
