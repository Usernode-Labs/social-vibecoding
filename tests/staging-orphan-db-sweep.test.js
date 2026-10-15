// Tests for the orphaned staging-DATABASE sweep (src/services/staging-reap.js
// selectOrphanDbs / sweepOrphanDbs).
//
// Context: every container-driven teardown path only drops a staging database
// alongside a matching container. Clones whose container was already gone
// accumulated forever — production reached 3,479 staging DBs (198 GB) with 8
// live previews by 2026-07-30. The sweep reconciles the other direction:
// enumerate `%_staging_%` databases and drop the ones no live preview, no
// session the preview machine holds (its attempts' databases exist before
// staging_url points at them), and no client connection can reach.
//
// All db-manager / pool work is stubbed via require.cache (same pattern as
// tests/staging-reap.test.js), so no real DB is touched.
//
// Run with: node --test tests/staging-orphan-db-sweep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  docker: require.resolve('../src/services/docker'),
  dbManager: require.resolve('../src/services/db-manager'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  stagingEnv: require.resolve('../src/services/staging-env'),
  pool: require.resolve('../src/db/pool'),
  reap: require.resolve('../src/services/staging-reap'),
};

let fx;

function freshFixture() {
  return {
    dropped: [],
    dropOptions: [],
    previewServer: null,
    retired: 0,
    dropError: null,
    // pg_database rows / live (or machine-held) sessions / connected
    // datnames served by the mock pool, mutated per test.
    dbRows: [],
    liveSessionRows: [],
    connectedRows: [],
    // What the per-database recheck just before a drop sees on top of the
    // census: sessions that went live (or the machine took) since, and
    // databases a client connected to since.
    liveSinceCensus: new Set(),
    connectedSinceCensus: new Set(),
  };
}

function loadReap() {
  for (const key of Object.values(ids)) delete require.cache[key];

  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.docker, {});
  stub(ids.events, { record: () => {}, EVENT_TYPES: {} });
  stub(ids.ws, { broadcastToAdmins: () => {} });
  stub(ids.stagingEnv, { expectedStagingFingerprint: () => 'fp' });
  stub(ids.dbManager, {
    dropDatabase: async (dbName, options) => {
      if (fx.dropError) throw new Error(fx.dropError);
      fx.dropped.push(dbName);
      fx.dropOptions.push(options);
    },
    // A second server for preview databases (STAGING_DB_ADMIN_URL). Absent
    // unless a test sets fx.previewServer.
    PRIMARY_SERVER: 'primary',
    PREVIEW_SERVER: 'preview',
    previewServerConfigured: () => !!fx.previewServer,
    listPreviewServerStagingDatabases: async () => {
      if (fx.previewServer.error) throw new Error(fx.previewServer.error);
      return { dbNames: fx.previewServer.dbNames, connectedDbNames: new Set(fx.previewServer.connected || []) };
    },
    previewServerDatabaseHasSessions: async (dbName) =>
      (fx.previewServer.connected || []).includes(dbName) || fx.connectedSinceCensus.has(dbName),
    retireStrayTemplates: async () => { fx.retired += 1; return { examined: 0, dropped: 0, failed: 0 }; },
  });
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql, params) => {
        if (/pg_database/.test(sql)) return { rows: fx.dbRows };
        // The recheck of one session / one database just before its drop.
        if (params && /staging_url IS NOT NULL/.test(sql)) {
          assert.match(sql, /wf_instances/, 'the recheck counts the sessions the machine holds');
          const id = Number(params[0]);
          const live = fx.liveSessionRows.some((r) => Number(r.id) === id) || fx.liveSinceCensus.has(id);
          return { rows: live ? [{ '?column?': 1 }] : [] };
        }
        if (params && /pg_stat_activity/.test(sql)) {
          const on = fx.connectedRows.some((r) => r.datname === params[0]) || fx.connectedSinceCensus.has(params[0]);
          return { rows: on ? [{ '?column?': 1 }] : [] };
        }
        if (/staging_url IS NOT NULL/.test(sql)) {
          assert.match(sql, /wf_instances/, 'the census counts the sessions the machine holds as live');
          return { rows: fx.liveSessionRows };
        }
        if (/pg_stat_activity/.test(sql)) return { rows: fx.connectedRows };
        throw new Error(`unexpected query: ${sql}`);
      },
    }),
  });

  return require('../src/services/staging-reap');
}

test.beforeEach(() => { fx = freshFixture(); });

// ─── selectOrphanDbs: pure classification ────────────────────────────────

test('drops only unreachable staging clones; every guard holds one back', () => {
  const reap = loadReap();
  const orphans = reap.selectOrphanDbs({
    dbNames: [
      'app_whiteboard_0d337f_staging_s12_ab12cd',   // orphan (hex tag)
      'app_usernode_2d5619_staging_s494_latest',    // orphan ('latest' tag)
      'app_usernode_2d5619_staging_s2823_e1f2a3',   // live preview → keep
      'app_guardian_2_99eba3_staging_s77_9908aa',   // held by the preview machine → keep
      'app_opinion_market_eb3f76_staging_s50_fb1931', // connected → keep
    ],
    // The census reads both into one set: staging_url set, or held by the
    // preview machine (a build under way).
    liveSessionIds: new Set([2823, 77]),
    connectedDbNames: new Set(['app_opinion_market_eb3f76_staging_s50_fb1931']),
  });
  assert.deepEqual(orphans, [
    'app_whiteboard_0d337f_staging_s12_ab12cd',
    'app_usernode_2d5619_staging_s494_latest',
  ]);
});

test('a live session keeps ALL its clones, not just the URL-derived one', () => {
  const reap = loadReap();
  // Session 100 has a live preview built from commit aaaaaa; an older clone
  // from bbbbbb still exists. Both must survive — mis-dropping the live
  // clone is unrecoverable, stale siblings are cleaned after teardown.
  const orphans = reap.selectOrphanDbs({
    dbNames: [
      'app_foo_staging_s100_aaaaaa',
      'app_foo_staging_s100_bbbbbb',
    ],
    liveSessionIds: new Set([100]),
    connectedDbNames: new Set(),
  });
  assert.deepEqual(orphans, []);
});

test('never touches names that do not parse as staging clones', () => {
  const reap = loadReap();
  const orphans = reap.selectOrphanDbs({
    dbNames: [
      'app_usernode_2d5619',              // production app DB
      'usernode',                          // cluster bootstrap DB
      'app_foo_staging_s12_ZZZZZZ',        // tag is neither 6-hex nor 'latest'
      'app_foo_staging_s12_abcdef0',       // 7-char tag — anchored RE rejects
      'app_foo_staging_sx_abcdef',         // non-numeric session id
    ],
    liveSessionIds: new Set(),
    connectedDbNames: new Set(),
  });
  assert.deepEqual(orphans, []);
});

// ─── sweepOrphanDbs: the pass itself ─────────────────────────────────────

test('sweep drops orphans via dbManager and reports a summary', async () => {
  const reap = loadReap();
  fx.dbRows = [
    { datname: 'app_a_staging_s1_aaaaaa' },
    { datname: 'app_b_staging_s2_bbbbbb' },
    { datname: 'app_c_staging_s3_cccccc' },
  ];
  fx.liveSessionRows = [{ id: 3 }];
  fx.connectedRows = [];

  const summary = await reap.sweepOrphanDbs({});
  assert.equal(summary.examined, 3);
  assert.equal(summary.orphaned, 2);
  assert.equal(summary.dropped, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(fx.dropped, ['app_a_staging_s1_aaaaaa', 'app_b_staging_s2_bbbbbb']);
});

test('the census is rechecked before each drop: a session that went live or a client that connected since keeps its database', async () => {
  const reap = loadReap();
  fx.dbRows = [
    { datname: 'app_a_staging_s1_aaaaaa' },
    { datname: 'app_b_staging_s2_bbbbbb' },
    { datname: 'app_c_staging_s3_cccccc' },
  ];
  fx.liveSinceCensus = new Set([1]);                         // the machine started building
  fx.connectedSinceCensus = new Set(['app_b_staging_s2_bbbbbb']);

  const summary = await reap.sweepOrphanDbs({});
  assert.equal(summary.orphaned, 3, 'all three looked orphaned at the census');
  assert.equal(summary.dropped, 1);
  assert.equal(summary.failed, 0, 'a database held back is not a failure');
  assert.deepEqual(fx.dropped, ['app_c_staging_s3_cccccc']);
});

test('one server: each drop is the plain call it always was', async () => {
  const reap = loadReap();
  fx.dbRows = [{ datname: 'app_a_staging_s1_aaaaaa' }];
  await reap.sweepOrphanDbs({});
  assert.deepEqual(fx.dropOptions, [undefined]);
  assert.equal(fx.retired, 0);
});

test('with a preview server, each server is classified on its own and each orphan is dropped where it was found', async () => {
  const reap = loadReap();
  // Main server: one orphan from before the switch, and a database a client
  // is still connected to.
  fx.dbRows = [
    { datname: 'app_a_staging_s1_aaaaaa' },
    { datname: 'app_b_staging_s2_bbbbbb' },
  ];
  fx.connectedRows = [{ datname: 'app_b_staging_s2_bbbbbb' }];
  fx.liveSessionRows = [{ id: 5 }];
  // Preview server: an orphan, a live preview, one with a client on it, and
  // the same name as the main server's connected database, idle here.
  fx.previewServer = {
    dbNames: [
      'app_c_staging_s3_cccccc',
      'app_d_staging_s5_dddddd',
      'app_e_staging_s6_eeeeee',
      'app_b_staging_s2_bbbbbb',
      'app_c_stgtmpl',
    ],
    connected: ['app_e_staging_s6_eeeeee'],
  };

  const summary = await reap.sweepOrphanDbs({});
  assert.equal(summary.examined, 7);
  assert.equal(summary.dropped, 3);
  const drops = fx.dropped.map((name, i) => `${name}@${fx.dropOptions[i].server}`);
  assert.deepEqual(drops, [
    'app_c_staging_s3_cccccc@preview',
    'app_b_staging_s2_bbbbbb@preview',
    'app_a_staging_s1_aaaaaa@primary',
  ], 'the copy of s2 still in use on the main server is not reached by the preview server\'s drop');
  assert.equal(fx.retired, 1, 'stray templates are retired in the same pass');
});

test('a preview server that cannot be listed is skipped; the main server is still swept', async () => {
  const reap = loadReap();
  fx.dbRows = [{ datname: 'app_a_staging_s1_aaaaaa' }];
  fx.previewServer = { error: 'connection refused' };
  const summary = await reap.sweepOrphanDbs({});
  assert.equal(summary.dropped, 1);
  assert.deepEqual(fx.dropOptions, [{ server: 'primary' }]);
});

test('sweep respects the per-pass limit and defers the rest', async () => {
  const reap = loadReap();
  fx.dbRows = Array.from({ length: 5 }, (_, i) => ({ datname: `app_x_staging_s${i + 10}_abc12${i}` }));

  const summary = await reap.sweepOrphanDbs({}, { limit: 2 });
  assert.equal(summary.orphaned, 5);
  assert.equal(summary.dropped, 2);
  assert.equal(fx.dropped.length, 2);
});

test('a failing drop is counted, not thrown', async () => {
  const reap = loadReap();
  fx.dbRows = [{ datname: 'app_a_staging_s1_aaaaaa' }];
  fx.dropError = 'database "app_a_staging_s1_aaaaaa" is being accessed by other users';

  const summary = await reap.sweepOrphanDbs({});
  assert.equal(summary.dropped, 0);
  assert.equal(summary.failed, 1);
});

test('sweep is a no-op inside a staging preview', async () => {
  const reap = loadReap();
  fx.dbRows = [{ datname: 'app_a_staging_s1_aaaaaa' }];
  process.env.USERNODE_ENV = 'staging';
  try {
    const summary = await reap.sweepOrphanDbs({});
    assert.equal(summary.examined, 0);
    assert.deepEqual(fx.dropped, []);
  } finally {
    delete process.env.USERNODE_ENV;
  }
});

test('orphanDbSweepDue: due once per interval, 0 disables', async () => {
  const reap = loadReap();
  assert.equal(reap.orphanDbSweepDue(), true);
  await reap.sweepOrphanDbs({});           // arms the throttle
  assert.equal(reap.orphanDbSweepDue(), false);

  process.env.STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS = '0';
  try {
    assert.equal(reap.orphanDbSweepDue(), false);
  } finally {
    delete process.env.STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS;
  }
});
