'use strict';

// The workflow side of a two-process test (tests/lib/workflow-processes.js):
// install the fixture's fakes for outside services, then boot server.js
// itself as a conductor (PROCESS_ROLE=conductor): what production runs where
// the workflow runs, its bus, its process row, its listener and the hooks its
// module registers included, so nothing a workflow process needs is set up
// by the test instead. There is no leader: every workflow process runs the
// same work, under the workflow's leases. It says when it is ready,
// and stops as a release stops it (SIGTERM: server.js cleanup). What it is
// given comes in WF_TEST_CHILD: { databaseUrl, env, fixture }.

const { Pool } = require('pg');

const spec = JSON.parse(process.env.WF_TEST_CHILD);
const pool = new Pool({ connectionString: spec.databaseUrl, max: 3 });
pool.on('error', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakes = {
  // Replace a module before anything loads it.
  stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  },
  // What the outside service now remembers, kept where a restarted process
  // sees it too.
  async record(kind, data = {}) {
    await pool.query('INSERT INTO wf_test_effects (kind, data, pid) VALUES ($1, $2, $3)', [kind, JSON.stringify(data), process.pid]);
  },
  async read(kind) {
    return (await pool.query('SELECT data FROM wf_test_effects WHERE kind = $1 ORDER BY id', [kind])).rows.map((r) => r.data);
  },
  // Stop here while the test has this point armed, until it releases it.
  async pause(name) {
    const { rowCount } = await pool.query(
      'UPDATE wf_test_pauses SET reached_at = now(), pid = $2 WHERE name = $1 AND NOT released AND reached_at IS NULL', [name, process.pid]);
    if (!rowCount) return;
    for (;;) {
      await sleep(25);
      const { rows: [p] } = await pool.query('SELECT released FROM wf_test_pauses WHERE name = $1', [name]);
      if (!p || p.released) return;
    }
  },
};

// The outside network is faked: a connection that would leave the machine
// through fetch, an http or https request, or net.connect is refused and
// recorded, so a test sees what it reached unfaked. Loopback is left alone,
// and a raw net.Socket (how pg reaches the database) is not intercepted.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const refused = (where) => {
  fakes.record('net.refused', { url: where }).catch(() => {});
  return Object.assign(new Error(`outside network refused in the workflow test process: ${where}`), { code: 'ECONNREFUSED' });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  throw refused(`${url.origin}${url.pathname}`);
};
for (const mod of [require('node:http'), require('node:https')]) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn];
    mod[fn] = function guarded(target, ...rest) {
      const host = typeof target === 'string' || target instanceof URL ? new URL(String(target)).hostname : (target?.hostname || target?.host || 'localhost');
      if (!LOOPBACK.has(String(host).replace(/:\d+$/, ''))) throw refused(`${fn} ${host}`);
      return real.call(this, target, ...rest);
    };
  }
}
const net = require('node:net');
for (const fn of ['connect', 'createConnection']) {
  const real = net[fn];
  net[fn] = function guarded(...args) {
    const o = typeof args[0] === 'object' && args[0] ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (!o.path && !LOOPBACK.has(String(o.host || 'localhost'))) throw refused(`net ${o.host}:${o.port}`);
    return real.apply(this, args);
  };
}

require(spec.fixture)(fakes);

process.on('unhandledRejection', (err) => { console.error('unhandled rejection:', err?.message || err); });
// What config.js reads, as the chart sets it for a conductor: the test's
// settings, then the platform keys server.js needs to boot at all
// (tests/platform-keys.js; existing values win).
const { randomBytes } = require('node:crypto');
Object.assign(process.env, {
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ADMIN_USERNAME: 'wf-admin',
  ADMIN_PASSWORD: randomBytes(16).toString('hex'),
  RUN_MIGRATIONS_ON_STARTUP: 'false',
  PROCESS_ROLE: 'conductor',
  PLATFORM_LEADER_LOCK: '1',
  ...spec.env,
  DATABASE_URL: spec.databaseUrl,
});
require('../platform-keys').setPlatformKeys();

const server = require('../../server.js');
server.start().then(
  () => process.send({ ready: true }),
  (err) => { console.error(err); process.exit(1); },
);
