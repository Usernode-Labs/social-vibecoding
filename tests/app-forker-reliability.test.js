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

function recordedFailure(queries) {
  const write = queries.find((q) => /last_failure = \$2/.test(q.sql));
  assert.ok(write, 'fork failure should persist status and last_failure together');
  assert.equal(write.params[0], 'error');
  assert.equal(write.params[2], FORK.id);
  return JSON.parse(write.params[1]);
}

test('database-setup failure is persisted and broadcast with its real reason', async () => {
  const fx = loadForker({
    createDatabase: async () => { throw new Error('could not create the database'); },
  });

  await fx.subject.forkApp({}, { ...FORK }, SOURCE);

  const failure = recordedFailure(fx.queries);
  assert.equal(failure.stage, 'database');
  assert.match(failure.reason, /could not create the database/);
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
      } else if (command === 'git' && args[0] === 'clone') {
        const destination = args[args.length - 1];
        fs.mkdirSync(`${destination}/public`, { recursive: true });
        fs.writeFileSync(`${destination}/dapp.json`, JSON.stringify({ name: 'Source App' }));
        fs.writeFileSync(`${destination}/public/index.html`, '<main>SOURCE APP CONTENT</main>');
      } else if (command === 'git' && args[0] === 'rev-parse') {
        // The squashed commit's sha, read back after the push: its own git
        // step now, not the last line of a bash script's stdout.
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

// A remix (what people call a fork) is the original's code and look, and
// nothing of its people: an empty database of its own, none of the
// original's keys, and dapp.json without the original's audience, approval
// rule or admins. It also records the two commits it was cut from, written
// with the repository in one statement, so a later diff of the copy can be
// told apart from what it copied.
test('a remix gets an empty database, no keys, and records the commits it was cut from', async () => {
  const previousToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-only-token';
  const tempDir = `/tmp/usernode-fork-${FORK.slug}`;
  let revParses = 0;
  const fx = loadForker({
    execFileAsync: async (command, args) => {
      if (command === 'rm') {
        fs.rmSync(args[1], { recursive: true, force: true });
      } else if (command === 'git' && args[0] === 'clone') {
        const destination = args[args.length - 1];
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(`${destination}/dapp.json`, JSON.stringify({
          name: 'Source App',
          visibility: { build: 'public', view: 'public' },
          governance: { approvers: 'invited' },
          admins: ['source-admin'],
          secrets: [{ key: 'PUBLIC_KEY', private: false }],
        }));
      } else if (command === 'git' && args[0] === 'rev-parse') {
        revParses += 1;
        // First the clone's HEAD (before the flatten), then the copy's own
        // first commit (after the push).
        return { stdout: revParses === 1 ? `${'a'.repeat(40)}\n` : `${'b'.repeat(40)}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  try {
    await fx.subject.forkApp({}, { ...FORK }, SOURCE);

    assert.equal(fx.cloneCalls(), 0, 'the original\'s database is never copied');
    assert.deepEqual(fx.createDbCalls, [['app_forked_app']], 'a new, empty database of its own');
    assert.equal(fx.secretReads.length, 0, 'the original\'s stored keys are never read');
    assert.equal(fx.secretWrites.length, 0, 'and none are written into the copy');

    const lineage = fx.queries.find((q) => /forked_from/.test(q.sql));
    assert.ok(lineage, 'the lineage shas are written');
    assert.match(lineage.sql, /SET repo_url = \$1,/, 'in the same write as the repository');
    assert.match(lineage.sql, /jsonb_typeof\(forked_from\) = 'object'/, 'merged into the stored reference');
    assert.equal(lineage.params[0], 'https://github.com/usernode-bot/forked-app');
    assert.deepEqual(JSON.parse(lineage.params[1]), {
      sourceSha: 'a'.repeat(40),
      forkBaseSha: 'b'.repeat(40),
    });
    assert.equal(lineage.params[2], FORK.id);

    assert.equal(fx.finalizeCalls.length, 1, 'the shared deploy tail runs (its secrets gate decides awaiting_secrets)');
    const manifest = JSON.parse(fs.readFileSync(`${fx.finalizeCalls[0][1].tempDir}/dapp.json`, 'utf8'));
    assert.equal(manifest.name, FORK.name);
    assert.equal(manifest.visibility, undefined, 'the copy starts as Just you, not the original\'s audience');
    assert.equal(manifest.governance, undefined, 'the original\'s approval rule stays with it');
    assert.equal(manifest.admins, undefined, 'and so do its admins');
    assert.deepEqual(manifest.secrets, [{ key: 'PUBLIC_KEY', private: false }],
      'the keys the code needs are still declared, for the owner to fill');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = previousToken;
  }
});

test('forkLineageShas stores what git did not give as null, never leaves it out', () => {
  const fx = loadForker();
  assert.deepEqual(fx.subject.forkLineageShas({ mainSha: 'b', sourceSha: 'a' }), { sourceSha: 'a', forkBaseSha: 'b' });
  assert.deepEqual(fx.subject.forkLineageShas({ mainSha: null }), { sourceSha: null, forkBaseSha: null });
  assert.deepEqual([...fx.subject.FORK_STRIPPED_MANIFEST_KEYS], ['admins', 'visibility', 'governance']);
});
