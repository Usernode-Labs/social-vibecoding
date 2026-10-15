'use strict';

// The leader-lock connection reaps a dead peer within a minute, and a leader
// that cannot reach its lock steps down before the server can have let it go
// (src/services/leadership.js).
//
// The lock is a Postgres session lock. When the leader's node died hard, no
// FIN or RST reached the server, so the session (and the lock) lived until
// the server's OS keepalive gave up — two hours and more — and no Pod could
// be promoted: every sweeper and recovery in becomeLeader() stood still.
// The connection now has keepalives at both ends, set on that session, and
// while it leads it answers a heartbeat; one unanswered steps the process
// down the way a dropped connection always has (exit 1).
//
// The settings and the lost-connection path run against a REAL postgres
// (skipped when none is reachable: TEST_DATABASE_URL, else DATABASE_URL,
// else localhost); the heartbeat timeout runs against a client that never
// answers, which is what a partition looks like from the leader's side.
//
// Run with: node --test tests/leadership-keepalive.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const leadership = require('../src/services/leadership');
const log = require('../src/services/logger');

const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  log[level] = (cat, msg, data) => { logs.push({ level, cat, msg, data }); };
}

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

function withLeaderLock(fn) {
  const prev = process.env.PLATFORM_LEADER_LOCK;
  process.env.PLATFORM_LEADER_LOCK = '1';
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.PLATFORM_LEADER_LOCK;
    else process.env.PLATFORM_LEADER_LOCK = prev;
  });
}

async function reachable() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return { skip: 'the pg driver is not installed in this environment' }; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return { client };
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { skip: `no postgres reachable at ${DSN}: ${err.message || err.code}` };
  }
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

test('the lock client asks for TCP keepalive with a short idle delay', () => {
  const options = leadership.lockClientOptions('postgres://x@db/platform');
  assert.equal(options.connectionString, 'postgres://x@db/platform');
  assert.equal(options.keepAlive, true);
  assert.ok(options.keepAliveInitialDelayMillis > 0 && options.keepAliveInitialDelayMillis <= 15000,
    'probes start within seconds of silence, not the OS default two hours');
});

test('a dead leader is reaped within a minute, and a cut-off one steps down before that', () => {
  const reapMs = leadership.serverReapSeconds() * 1000;
  assert.ok(reapMs <= 60000, `the server drops a dead peer's session within a minute (${reapMs}ms)`);
  assert.ok(leadership.SERVER_KEEPALIVE.tcp_user_timeout <= 60000,
    'and gives up on a reply the dead peer never acknowledged as quickly');
  // Worst case for the leader: the partition begins just after a heartbeat
  // was answered. It notices one interval plus one timeout later, and must
  // be gone before the server could have released the lock to a new leader.
  const noticeMs = leadership.HEARTBEAT_MS + leadership.HEARTBEAT_TIMEOUT_MS;
  assert.ok(noticeMs < reapMs, `step-down (${noticeMs}ms) precedes the server's reap (${reapMs}ms)`);
  // And a heartbeat is traffic: it keeps a live leader's session from ever
  // looking idle long enough to be probed.
  assert.ok(leadership.HEARTBEAT_MS < leadership.SERVER_KEEPALIVE.tcp_keepalives_idle * 1000);
});

test('on a real server: the lock session carries the keepalive settings, and losing it steps the leader down', async (t) => {
  const probe = await reachable();
  if (probe.skip) return t.skip(probe.skip);
  const observer = probe.client;
  const { Client } = require('pg');
  const made = [];
  const exits = [];
  await withLeaderLock(async () => {
    const lead = leadership.createLeadership({
      databaseUrl: DSN,
      clientFactory: (options) => { made.push(options); const c = new Client(options); made.client = c; return c; },
      exit: (code) => { exits.push(code); },
      heartbeatMs: 0, // the lost-connection path alone here
    });
    let elected = 0;
    try {
      // Another holder (a dev server on this database) would make this a
      // follower; that is not what is under test.
      const { rows: [free] } = await observer.query('SELECT pg_try_advisory_lock($1) AS ok', [leadership.LEADER_LOCK_KEY]);
      if (!free.ok) return t.skip('another session holds the leader lock on this database');
      await observer.query('SELECT pg_advisory_unlock($1)', [leadership.LEADER_LOCK_KEY]);

      await lead.start(async () => { elected += 1; });
      assert.equal(elected, 1);
      assert.equal(lead.isLeader, true);
      assert.equal(made[0].keepAlive, true);

      const client = made.client;
      const show = async (name) => (await client.query(`SHOW ${name}`)).rows[0][name];
      const tcp = (await client.query('SELECT inet_client_addr() IS NOT NULL AS tcp')).rows[0].tcp;
      if (tcp) {
        // Over a unix socket these read 0 by definition; the platform always
        // connects over TCP.
        assert.equal(await show('tcp_keepalives_idle'), String(leadership.SERVER_KEEPALIVE.tcp_keepalives_idle));
        assert.equal(await show('tcp_keepalives_interval'), String(leadership.SERVER_KEEPALIVE.tcp_keepalives_interval));
        assert.equal(await show('tcp_keepalives_count'), String(leadership.SERVER_KEEPALIVE.tcp_keepalives_count));
        assert.match(await show('tcp_user_timeout'), /^(40s|40000ms|40000)$/);
      }

      // The lock is held, by that session.
      const { rows: [held] } = await observer.query('SELECT pg_try_advisory_lock($1) AS ok', [leadership.LEADER_LOCK_KEY]);
      assert.equal(held.ok, false, 'the leader holds the lock');

      // The server drops the session (as keepalive would for a dead peer):
      // the leader learns its lock is gone and steps down. The pid alone
      // does not name the session — test files run in parallel against one
      // server, and a pid can be stale or reused by the time the terminate
      // runs — so the terminate is scoped to that pid AND backend_start,
      // which a stranger's session does not match: it then fails this
      // assertion instead of killing another file's connection.
      const { rows: [{ pid, backend_start }] } = await client.query(
        'SELECT pid, backend_start::text AS backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()');
      const { rows: killed } = await observer.query(
        'SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz',
        [pid, backend_start]);
      assert.ok(killed.length === 1 && killed[0].killed === true, "terminated the leader's own session");
      assert.ok(await until(() => exits.length > 0), 'the leader exits');
      assert.deepEqual(exits, [1]);
      assert.ok(logs.some((l) => l.msg === 'Leader-lock connection ended unexpectedly' && l.data.wasLeader === true));

      // And the lock went with the session: a follower can now be promoted.
      assert.ok(await until(async () => {
        const { rows: [r] } = await observer.query('SELECT pg_try_advisory_lock($1) AS ok', [leadership.LEADER_LOCK_KEY]);
        return r.ok;
      }), 'the lock is free for the next leader');
      await observer.query('SELECT pg_advisory_unlock($1)', [leadership.LEADER_LOCK_KEY]);
    } finally {
      await lead.stop();
      await observer.end().catch(() => {});
    }
  });
});

// A client that answers the election and then goes silent: from the
// leader's side that is a network partition.
function partitionedClient() {
  const handlers = {};
  let silent = false;
  return {
    goSilent() { silent = true; },
    on(event, fn) { handlers[event] = fn; },
    async connect() {},
    async end() { if (handlers.end) handlers.end(); },
    query(sql) {
      if (silent && /^SELECT 1$/.test(sql)) return new Promise(() => {});
      if (/pg_try_advisory_lock/.test(sql)) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({ rows: [] });
    },
  };
}

test('a leader whose heartbeat goes unanswered steps down', async () => {
  const fake = partitionedClient();
  const exits = [];
  await withLeaderLock(async () => {
    const lead = leadership.createLeadership({
      databaseUrl: 'postgres://unused',
      clientFactory: () => fake,
      exit: (code) => { exits.push(code); },
      heartbeatMs: 20,
      heartbeatTimeoutMs: 40,
    });
    try {
      await lead.start(async () => {});
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(exits, [], 'answered heartbeats keep it leading');
      fake.goSilent();
      assert.ok(await until(() => exits.length > 0, 2000), 'an unanswered heartbeat steps it down');
      assert.deepEqual(exits, [1], 'exactly once');
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(exits, [1], 'and only once');
      assert.ok(logs.some((l) => l.msg === 'Leader-lock heartbeat failed; stepping down' && /no answer within 40ms/.test(l.data.err)));
    } finally {
      await lead.stop();
    }
  });
});

test('a server that refuses a keepalive setting keeps the rest, and the election goes on', async () => {
  const fake = partitionedClient();
  const sets = [];
  const query = fake.query.bind(fake);
  fake.query = (sql, params) => {
    if (/set_config/.test(sql)) {
      sets.push(params);
      if (params[0] === 'tcp_user_timeout') return Promise.reject(new Error('not supported by this platform'));
    }
    return query(sql, params);
  };
  logs.length = 0;
  await withLeaderLock(async () => {
    const lead = leadership.createLeadership({
      databaseUrl: 'postgres://unused', clientFactory: () => fake, exit: () => {}, heartbeatMs: 0,
    });
    let elected = 0;
    try {
      await lead.start(async () => { elected += 1; });
      assert.equal(elected, 1);
      assert.deepEqual(sets, [
        ['tcp_keepalives_idle', '20'],
        ['tcp_keepalives_interval', '5'],
        ['tcp_keepalives_count', '4'],
        ['tcp_user_timeout', '40000'],
      ]);
      assert.ok(logs.some((l) => l.msg === 'Leader-lock keepalive setting refused' && l.data.name === 'tcp_user_timeout'));
    } finally {
      await lead.stop();
    }
  });
});

test('a stopped leader never steps down for its own disconnect', async () => {
  const fake = partitionedClient();
  const exits = [];
  await withLeaderLock(async () => {
    const lead = leadership.createLeadership({
      databaseUrl: 'postgres://unused', clientFactory: () => fake, exit: (c) => exits.push(c), heartbeatMs: 10,
    });
    await lead.start(async () => {});
    await lead.stop(); // end() fires 'end' — the planned release
    fake.goSilent();
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(exits, []);
  });
});
