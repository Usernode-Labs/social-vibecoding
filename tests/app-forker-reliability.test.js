// Regression coverage for issue #1549. Fork setup used to swallow its real
// error, leaving last_failure null and a bare "Error" tile. Retrying then ran
// the ordinary create path and could seed the starter template. These tests
// pin the worker half: useful failures are persisted/broadcast, and a fork
// whose repository was already copied resumes from that repository.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadForker({ cloneDatabase, execFileAsync, githubEnabled = true } = {}) {
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
    cloneDatabase: async (...args) => {
      cloneCalls++;
      if (cloneDatabase) return cloneDatabase(...args);
      return { password: 'fork-password' };
    },
    connectionUrl: () => 'postgres://fork',
  });
  stub(ids.appManifest, { read: () => ({ secrets: [] }) });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    setValue: async () => {},
  });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, { pushAppStatusUpdate: (payload) => statusPushes.push(payload) });
  stub(ids.appCreator, {
    createApp: async (...args) => { createCalls.push(args); },
    finalizeDeploy: async (...args) => { finalizeCalls.push(args); },
    reportPhase: (...args) => phases.push(args),
    endPhases: (slug) => cleared.push(slug),
  });
  stub(ids.template, { getConnectorScaffoldFiles: () => [] });

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

function recordedFailure(queries) {
  const write = queries.find((q) => /last_failure = \$2/.test(q.sql));
  assert.ok(write, 'fork failure should persist status and last_failure together');
  assert.equal(write.params[0], 'error');
  assert.equal(write.params[2], FORK.id);
  return JSON.parse(write.params[1]);
}

test('database-copy failure is persisted and broadcast with its real reason', async () => {
  const fx = loadForker({
    cloneDatabase: async () => { throw new Error('source database is still being prepared'); },
  });

  await fx.subject.forkApp({}, { ...FORK }, SOURCE);

  const failure = recordedFailure(fx.queries);
  assert.equal(failure.stage, 'database');
  assert.match(failure.reason, /source database is still being prepared/);
  assert.deepEqual(fx.phases.map((p) => p[2]), ['database']);
  assert.deepEqual(fx.cleared, [FORK.slug]);
  assert.deepEqual(fx.statusPushes, [{
    id: FORK.id,
    slug: FORK.slug,
    status: 'error',
    errorReason: failure.reason,
  }]);
});

test('source-repository clone failure is classified instead of becoming a generic error', async () => {
  const previousToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-only-token';
  const fx = loadForker({
    execFileAsync: async (command) => {
      if (command === 'git') {
        const err = new Error("fatal: repository 'source-app' not found");
        err.stderr = "fatal: repository 'source-app' not found";
        throw err;
      }
      return { stdout: '', stderr: '' };
    },
  });
  try {
    await fx.subject.forkApp({}, { ...FORK }, SOURCE);

    const failure = recordedFailure(fx.queries);
    assert.equal(failure.stage, 'clone');
    assert.match(failure.reason, /not found/);
    assert.deepEqual(fx.phases.map((p) => p[2]), ['database', 'repository']);
    assert.equal(fx.finalizeCalls.length, 0);
    assert.equal(fx.statusPushes[0].errorReason, failure.reason);
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = previousToken;
  }
});

test('retry resumes a copied fork repository and never enters the fresh-template branch', async () => {
  const fx = loadForker();
  const copiedFork = {
    ...FORK,
    status: 'error',
    repo_url: 'https://github.com/usernode-bot/forked-app',
  };

  await fx.subject.forkApp({}, copiedFork, null);

  assert.equal(fx.createCalls.length, 1, 'the existing fork repo is treated as an import');
  assert.equal(fx.createCalls[0][1], copiedFork);
  assert.equal(fx.cloneCalls(), 0, 'the source DB snapshot is not repeated after the repo copy');
  assert.equal(fx.finalizeCalls.length, 0, 'createApp owns the resumed deploy');
});

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

test('a successful fork deploys the cloned source tree, not starter-template files', async () => {
  const previousToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-only-token';
  const tempDir = `/tmp/usernode-fork-${FORK.slug}`;
  const fx = loadForker({
    execFileAsync: async (command, args, options = {}) => {
      if (command === 'rm') {
        fs.rmSync(args[1], { recursive: true, force: true });
      } else if (command === 'git') {
        const destination = args[args.length - 1];
        fs.mkdirSync(`${destination}/public`, { recursive: true });
        fs.writeFileSync(`${destination}/dapp.json`, JSON.stringify({ name: 'Source App' }));
        fs.writeFileSync(`${destination}/public/index.html`, '<main>SOURCE APP CONTENT</main>');
      } else if (command === 'bash' && options.env?.PUSHURL) {
        return { stdout: 'source-copy-sha\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await fx.subject.forkApp({}, { ...FORK }, SOURCE);

    assert.equal(fx.finalizeCalls.length, 1);
    const deploy = fx.finalizeCalls[0][1];
    assert.equal(deploy.repoUrl, 'https://github.com/usernode-bot/forked-app');
    assert.equal(deploy.mainSha, 'source-copy-sha');
    const html = fs.readFileSync(`${deploy.tempDir}/public/index.html`, 'utf8');
    assert.match(html, /SOURCE APP CONTENT/);
    assert.doesNotMatch(html, /Starter template/);
    const manifest = JSON.parse(fs.readFileSync(`${deploy.tempDir}/dapp.json`, 'utf8'));
    assert.equal(manifest.name, FORK.name, 'only the copied manifest name is rewritten');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = previousToken;
  }
});
