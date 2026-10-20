// Regression coverage for issue #1549: a remix's source is found by the id
// its lineage records, and its lineage keeps what git did not give as null.
// A remix's setup (its failures, its resume from a copied repository, its
// empty database) is app-creator.js setUp's: tests/app-creator-failure.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadForker({ createDatabase, execFileAsync, githubEnabled = true } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    docker: require.resolve('../src/services/docker'),
    dbManager: require.resolve('../src/services/db-manager'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appCreator: require.resolve('../src/services/app-creator'),
    template: require.resolve('../src/services/template'),
    appForker: require.resolve('../src/services/app-forker'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];

  const queries = [];
  const statusPushes = [];
  const phases = [];
  const cleared = [];
  const createCalls = [];
  const finalizeCalls = [];
  let cloneCalls = 0;
  const createDbCalls = [];
  const secretReads = [];
  const secretWrites = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, {
    isEnabled: () => githubEnabled,
    parseGithubUrl: () => ({ owner: 'source-owner', repo: 'source-app' }),
    getCloneUrl: async () => 'https://github.com/source-owner/source-app.git',
    getBotUsername: async () => 'usernode-bot',
    createRepo: async () => ({ html_url: 'https://github.com/usernode-bot/forked-app' }),
  });
  stub(ids.docker, {
    execFileAsync: execFileAsync || (async () => ({ stdout: '', stderr: '' })),
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug.replace(/-/g, '_')}`,
    // A remix never reads the original's database: no row of anybody's
    // comes with it. Counted so a test can say so.
    cloneDatabase: async () => {
      cloneCalls++;
      return { password: 'cloned-password' };
    },
    createDatabase: async (...args) => {
      createDbCalls.push(args);
      if (createDatabase) return createDatabase(...args);
      return { password: 'fork-password' };
    },
    connectionUrl: () => 'postgres://fork',
  });
  stub(ids.appManifest, { read: () => ({ secrets: [{ key: 'PUBLIC_KEY', private: false }] }) });
  stub(ids.appSecrets, {
    getRawValues: async (...args) => { secretReads.push(args); return { PUBLIC_KEY: 'theirs' }; },
    setValue: async (...args) => { secretWrites.push(args); },
  });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, { pushAppStatusUpdate: (payload) => statusPushes.push(payload) });
  stub(ids.appCreator, {
    createApp: async (...args) => { createCalls.push(args); },
    finalizeDeploy: async (...args) => { finalizeCalls.push(args); },
    reportPhase: (...args) => phases.push(args),
    endPhases: (slug) => cleared.push(slug),
  });
  stub(ids.template, { getConnectorScaffoldFiles: () => [], getCanonicalRepoFile: () => null });

  const subject = require(ids.appForker);
  return {
    subject,
    pool,
    queries,
    statusPushes,
    phases,
    cleared,
    createCalls,
    finalizeCalls,
    cloneCalls: () => cloneCalls,
    createDbCalls,
    secretReads,
    secretWrites,
  };
}

const FORK = {
  id: 22,
  name: 'Forked App',
  slug: 'forked-app',
  status: 'creating',
  repo_url: null,
  forked_from: { appId: 11, slug: 'source-app' },
};

const SOURCE = {
  id: 11,
  name: 'Source App',
  slug: 'source-app',
  status: 'running',
  repo_url: 'https://github.com/source-owner/source-app',
  self_hosted: false,
};


test('source lookup treats a recorded app id as authoritative', async () => {
  const fx = loadForker();
  const lookupQueries = [];
  const reusedSlugRow = { ...SOURCE, id: 99 };
  const lookupPool = {
    async query(sql, params) {
      lookupQueries.push({ sql, params });
      if (/WHERE slug/.test(sql)) return { rows: [reusedSlugRow] };
      return { rows: [] };
    },
  };

  const result = await fx.subject.findForkSource(lookupPool, FORK);

  assert.equal(result, null, 'a deleted source id must not resolve to a reused slug');
  assert.equal(lookupQueries.length, 1);
  assert.match(lookupQueries[0].sql, /WHERE id = \$1/);
  assert.deepEqual(lookupQueries[0].params, [SOURCE.id]);
});

test('source lookup supports legacy slug-only lineage', async () => {
  const fx = loadForker();
  const lookupPool = {
    async query(sql, params) {
      assert.match(sql, /WHERE slug = \$1/);
      assert.deepEqual(params, [SOURCE.slug]);
      return { rows: [SOURCE] };
    },
  };
  const legacyFork = { ...FORK, forked_from: JSON.stringify({ slug: SOURCE.slug }) };

  const result = await fx.subject.findForkSource(lookupPool, legacyFork);

  assert.equal(result, SOURCE);
});

test('forkLineageShas stores what git did not give as null, never leaves it out', () => {
  const fx = loadForker();
  assert.deepEqual(fx.subject.forkLineageShas({ mainSha: 'b', sourceSha: 'a' }), { sourceSha: 'a', forkBaseSha: 'b' });
  assert.deepEqual(fx.subject.forkLineageShas({ mainSha: null }), { sourceSha: null, forkBaseSha: null });
  assert.deepEqual([...fx.subject.FORK_STRIPPED_MANIFEST_KEYS], ['admins', 'visibility', 'governance']);
});
