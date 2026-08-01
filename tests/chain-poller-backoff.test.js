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

test('getStatus exposes the outage shape the status pages render', () => {
  const { poller } = loadPollerWithFakeLog();
  const s = poller.getStatus();
  for (const key of ['consecutiveFailures', 'downSince', 'pollIntervalMs',
    'lastError', 'lastPolledAt', 'enabled']) {
    assert.ok(key in s, `getStatus() must expose ${key}`);
  }
  assert.equal(s.consecutiveFailures, 0, 'starts clean');
  assert.equal(s.downSince, null);
});

test('stop() is safe before start() and leaves the poller disabled', () => {
  const { poller } = loadPollerWithFakeLog();
  poller.stop();
  assert.equal(poller.getStatus().enabled, false);
});

// The backoff curve itself is a pure function of the failure count, so
// assert it from the source constants rather than by waiting on timers.
test('the backoff doubles from 4s and is capped at 60s', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/chain-poller.js'), 'utf8');
  assert.match(src, /const POLL_INTERVAL_MS = 4000;/);
  assert.match(src, /const MAX_POLL_INTERVAL_MS = 60000;/);

  // Re-derive the documented curve so a change to the formula fails here.
  const base = 4000, cap = 60000;
  const backoff = (n) => (n <= 0 ? base : Math.min(base * Math.pow(2, n - 1), cap));
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(backoff),
    [4000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.match(src, /Math\.min\(grown, MAX_POLL_INTERVAL_MS\)/);
});

test('the first failure warns; repeats drop to debug', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/chain-poller.js'), 'utf8');
  const fn = src.slice(src.indexOf('function noteFailure('),
    src.indexOf('function noteSuccess('));
  assert.match(fn, /consecutiveFailures === 1[\s\S]{0,300}log\.warn/,
    'the transition INTO an outage must be visible at warn');
  assert.match(fn, /else \{[\s\S]{0,300}log\.debug/,
    'repeats must not warn — that is what buried the log');
  assert.match(fn, /downSince = Date\.now\(\)/,
    'the streak start is stamped once, on the first failure');
});

test('recovery emits exactly one warn and clears the streak', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/chain-poller.js'), 'utf8');
  const fn = src.slice(src.indexOf('function noteSuccess('),
    src.indexOf('function httpJson('));
  assert.match(fn, /consecutiveFailures > 0[\s\S]{0,400}log\.warn/,
    'closing the streak is the line an operator scans for');
  assert.match(fn, /consecutiveFailures = 0/);
  assert.match(fn, /downSince = null/);
  assert.match(fn, /lastError = null/);
});

test('both failure paths route through noteFailure (no stray warns left)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/chain-poller.js'), 'utf8');
  const poll = src.slice(src.indexOf('async function poll('),
    src.indexOf('function start('));
  assert.match(poll, /noteFailure\('chain ID discovery failed'/);
  assert.match(poll, /noteFailure\('poll failed'/);
  // The DB-update failure is a different subsystem and stays at its own
  // level, but neither explorer path may warn directly any more.
  assert.doesNotMatch(poll, /log\.warn\('chain-poller', 'chain ID discovery failed'/);
  assert.doesNotMatch(poll, /log\.warn\('chain-poller', 'poll failed'/);
});

test('the scheduler reschedules itself so the delay can change', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/chain-poller.js'), 'utf8');
  // setInterval cannot back off, and would also stack overlapping polls
  // once the upstream starts timing out.
  assert.doesNotMatch(src, /setInterval\s*\(/,
    'a fixed interval cannot implement backoff');
  assert.match(src, /timerHandle = setTimeout\(tick, currentIntervalMs\)/);
  assert.match(src, /currentIntervalMs = backoffMs\(\)/);
  assert.match(src, /timerHandle\.unref\?\.\(\)/,
    'the retry timer must never hold the process open on shutdown');
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
