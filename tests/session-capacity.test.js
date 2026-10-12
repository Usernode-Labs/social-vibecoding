'use strict';

// The platform-wide session cap (config.maxGlobalSessions): one count, one
// gate, and a record of everybody it turns away.
//
// On 12 Oct 2026 every native proposal_start was refused "Platform is at
// capacity" for over an hour while the count the browser's starts and the
// admins' alert used read 62: routes/proposal-handoff.js had its own copy of
// the count, which included the Homeroom bot's proposals (105 of 100) where
// the others left them out. #4860 settled which is right (they hold preview
// pods like anyone's, and the cap is sized from the pod slots) and raised the
// cap; this keeps the count in one place so the copies cannot drift again.
// Nobody could see the refusals either: the alert samples its own count, and
// a refusal was recorded nowhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessionCaps = require('../src/services/session-caps');
const lifecycle = require('../src/services/session-lifecycle');
const events = require('../src/services/events');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('one count spends the budget: active and promoted, whoever owns them, not imported', () => {
  const sql = sessionCaps.GLOBAL_SESSIONS_SQL;
  assert.match(sql, /status IN \('active', 'promoted'\)/);
  assert.match(sql, /source IS DISTINCT FROM 'imported'/);
  assert.doesNotMatch(sql, /is_synthetic/, 'the bot\'s sessions hold preview pods like anyone\'s (#4860)');
  // Nothing counts its own copy any more.
  for (const file of ['src/routes/sessions.js', 'src/routes/proposal-handoff.js', 'src/services/platform-limit-alerts.js']) {
    assert.doesNotMatch(read(file), /COUNT\(\*\)[^`]*FROM chat_sessions\s+WHERE status IN \('active', 'promoted'\)/, file);
  }
  assert.match(read('src/services/platform-limit-alerts.js'), /count: \(pool\) => require\('\.\/session-caps'\)\.countGlobalSessions\(pool\)/,
    'the admins\' alert reads the count the refusals do');
  // What the count sees, the eviction can free: an idle session of the bot's
  // is paused to make room like anyone's.
  const free = read('src/services/session-lifecycle.js');
  const freeSql = free.slice(free.indexOf('async function freeGlobalSlot'), free.indexOf('async function freeUserSlot'));
  assert.doesNotMatch(freeSql, /is_synthetic/);
});

test('every start, resume and reopen passes the same gate, and says where it asked', () => {
  const sessions = read('src/routes/sessions.js');
  const paths = [...sessions.matchAll(/claimGlobalSlot\(\{ pool, config, path: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['resume', 'start', 'issue_headless', 'clone_headless']);
  const handoff = read('src/routes/proposal-handoff.js');
  assert.match(handoff, /claimGlobalSlot\(\{\s+pool, config, path: 'proposal_start', userId: req\.user\.id, appId: app\.id, discount: replacedActiveSlot,/);
  assert.match(handoff, /if \(!global\.ok\) return res\.status\(429\)\.json\(\{ error: sessionLifecycle\.PLATFORM_AT_CAPACITY \}\);/);
  // The per-user cap's refusals are recorded too.
  const userRefusals = [...`${sessions}\n${handoff}\n${read('src/services/connector-limits.js')}`
    .matchAll(/recordCapacityRefusal\(pool, \{\s*cap: 'user', path: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(userRefusals.sort(), ['clone_headless', 'connector', 'proposal_start', 'resume', 'resume', 'start']);
});

function capPool({ count, idle = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (sql === sessionCaps.GLOBAL_SESSIONS_SQL) return { rows: [{ cnt: count }] };
      if (/SELECT id FROM chat_sessions\s+WHERE status = 'active'/.test(sql)) return { rows: idle };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('under the cap a start goes ahead; at it, a refusal is recorded with its cap and path', async () => {
  const config = { maxGlobalSessions: 100, sessionPressureGraceMs: 15 * 60 * 1000 };
  const under = capPool({ count: 99 });
  assert.deepEqual(await lifecycle.claimGlobalSlot({ pool: under, config, path: 'start', userId: 7 }), { ok: true });
  assert.equal(under.calls.length, 1, 'one count, nothing paused, nothing recorded');

  const full = capPool({ count: 100 });
  assert.deepEqual(await lifecycle.claimGlobalSlot({ pool: full, config, path: 'proposal_start', userId: 7, appId: 10 }), { ok: false });
  const insert = full.calls.find((c) => /INSERT INTO events/.test(c.sql));
  assert.ok(insert, 'the refusal is an event');
  assert.deepEqual(insert.params.slice(0, 4), [7, 10, null, events.EVENT_TYPES.SESSION_CAPACITY_REFUSED]);
  assert.deepEqual(JSON.parse(insert.params[4]), { cap: 'global', path: 'proposal_start' });

  // A replaced session gives its slot back.
  const replacing = capPool({ count: 100 });
  assert.deepEqual(await lifecycle.claimGlobalSlot({ pool: replacing, config, path: 'proposal_start', discount: 1 }), { ok: true });
  assert.equal(PLATFORM_AT_CAPACITY_TEXT, lifecycle.PLATFORM_AT_CAPACITY);
});

const PLATFORM_AT_CAPACITY_TEXT = 'Platform is at capacity right now. Try again in a few minutes.';

test('recording a refusal never throws, even when the write fails', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  await assert.doesNotReject(lifecycle.recordCapacityRefusal(pool, { cap: 'user', path: 'resume', userId: 3 }));
});
