// A new project's setup failing (src/services/app-creator.js setUp, the
// app-creation machine's `app.setup` work): what it resolves is the record
// the machine writes to apps.last_failure, with where it failed (#416). Its
// first deploy's failures are deployProduction's (tests/first-deploy.test.js,
// tests/rebuild-deploy-failed-notify-once.test.js).
//
// Same require.cache stubbing as tests/app-creation-timing.test.js: nothing
// real (GitHub, the database, WS) spins up.
//
// Run with: node --test tests/app-creator-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function workContext() {
  const kept = { value: null };
  return { signal: new AbortController().signal, steps: (o = {}) => makeSteps({ resumeFrom: kept.value, checkpoint: async (v) => { kept.value = v; }, ...o }) };
}

function loadAppCreator({ githubStubs = {}, forkerStubs = {}, app }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    dbManager: require.resolve('../src/services/db-manager'),
    template: require.resolve('../src/services/template'),
    sketch: require.resolve('../src/services/app-sketch'),
    forker: require.resolve('../src/services/app-forker'),
    ws: require.resolve('../src/services/ws'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT \* FROM apps WHERE id = \$1/.test(sql)) return { rows: [app] };
      return { rows: [], rowCount: 1 };
    },
  };
  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => true,
    getBotUsername: async () => 'usernode-bot',
    createRepo: async (owner, slug) => ({ html_url: `https://github.com/${owner}/${slug}` }),
    pushFiles: async () => ({ sha: 'a'.repeat(40) }),
    headCommit: async () => null,
    ...githubStubs,
  });
  stub(ids.dbManager, { appDbName: (slug) => `app_${slug}`, createDatabase: async () => ({ password: 'pw' }), connectionUrl: () => 'postgres://x' });
  stub(ids.template, { getTemplateFiles: () => [], getConnectorScaffoldFiles: () => [], getCanonicalRepoFile: () => null });
  stub(ids.sketch, { drawFor: async () => null, markCommitted: async () => {}, taglineOf: () => null });
  stub(ids.forker, {
    findForkSource: async () => null,
    copyRepoTree: async () => assert.fail('copied'),
    forkLineageShas: () => ({}),
    ...forkerStubs,
  });
  stub(ids.ws, { pushAppCreationPhase: () => {} });
  return { appCreator: require(ids.appCreator), pool, queries };
}

const row = (extra = {}) => ({ id: 42, name: 'Test App', slug: 'test-app', self_hosted: false, status: 'creating', ...extra });

// Session-2585 fix: with GitHub enabled, a repo-creation failure is FATAL
// (status='error', last_failure stage 'repo') instead of silently falling
// back to a local build that leaves repo_url NULL on a 'running' app.
test('GitHub enabled + createRepo failure fails the setup with stage repo, and no repo_url', async () => {
  const { appCreator, pool, queries } = loadAppCreator({
    app: row(),
    githubStubs: { createRepo: async () => { throw new Error('API rate limit exceeded'); } },
  });
  const out = await appCreator.setUp({}, pool, 42, workContext());
  assert.equal(out.failed.stage, 'repo');
  assert.ok(out.failed.reason.includes('GitHub repo creation failed'));
  assert.ok(out.failed.reason.includes('API rate limit exceeded'));
  assert.ok(!queries.some((q) => /SET repo_url/.test(q.sql)), 'repo_url must not be written when provisioning failed');
});

// Adopt-existing (mypage-777ed2 incident): a Retry after a create that died
// between the GitHub create call and the repo_url write has the SAME slug.
test('a repository that already exists is adopted, and the starter is pushed onto it', async () => {
  let sawAdoptOption = false;
  const pushed = [];
  const { appCreator, pool, queries } = loadAppCreator({
    app: row(),
    githubStubs: {
      createRepo: async (owner, slug, opts = {}) => {
        sawAdoptOption = !!opts.adoptExisting;
        return { html_url: `https://github.com/${owner}/${slug}`, adopted: true };
      },
      headCommit: async () => ({ sha: 'b'.repeat(40), message: 'Initial commit' }),
      pushFiles: async (owner, repo, files, opts) => { pushed.push(opts.message); return { sha: 'c'.repeat(40) }; },
    },
  });
  const out = await appCreator.setUp({}, pool, 42, workContext());
  assert.equal(sawAdoptOption, true, 'setUp must opt into adopt-existing');
  assert.deepEqual(pushed, ['Initialize Test App from Homeroom template'], 'GitHub\'s own first commit is not ours');
  assert.equal(out.sha, 'c'.repeat(40));
  assert.equal(queries.find((q) => /SET repo_url = \$1/.test(q.sql)).params[0], 'https://github.com/usernode-bot/test-app');
});

test('a remix whose source is gone, or not ready to copy, fails without touching the starter', async () => {
  let made = loadAppCreator({ app: row({ forked_from: { appId: 7, slug: 'source-app' } }) });
  let out = await made.appCreator.setUp({}, made.pool, 42, workContext());
  assert.match(out.failed.reason, /no longer exists/);
  made = loadAppCreator({
    app: row({ forked_from: { appId: 7, slug: 'source-app' } }),
    forkerStubs: { findForkSource: async () => ({ id: 7, slug: 'source-app', repo_url: null }) },
  });
  out = await made.appCreator.setUp({}, made.pool, 42, workContext());
  assert.match(out.failed.reason, /not ready to copy/);
  assert.ok(!made.queries.some((q) => /SET repo_url/.test(q.sql)));
});

test('a remix copies its source into its own repository, and records the lineage with it in one write', async () => {
  const { appCreator, pool, queries } = loadAppCreator({
    app: row({ forked_from: { appId: 7, slug: 'source-app' } }),
    forkerStubs: {
      findForkSource: async () => ({ id: 7, slug: 'source-app', repo_url: 'https://github.com/acme/source-app' }),
      copyRepoTree: async (args) => ({ repoUrl: `https://github.com/${args.botUsername}/${args.forkSlug}`, mainSha: 'D'.repeat(40), sourceSha: 'e'.repeat(40) }),
      forkLineageShas: (c) => ({ sourceSha: c.sourceSha, forkBaseSha: c.mainSha }),
    },
  });
  const out = await appCreator.setUp({}, pool, 42, workContext());
  assert.equal(out.sha, 'd'.repeat(40));
  assert.equal(out.offer, null, 'somebody\'s app, not a starter');
  const write = queries.find((q) => /SET repo_url = \$1/.test(q.sql));
  assert.match(write.sql, /forked_from = CASE/);
  assert.deepEqual(JSON.parse(write.params[1]), { sourceSha: 'e'.repeat(40), forkBaseSha: 'D'.repeat(40) });
});

test('a project that is no longer being made is not set up', async () => {
  const { appCreator, pool } = loadAppCreator({ app: row({ status: 'running' }) });
  const out = await appCreator.setUp({}, pool, 42, workContext());
  assert.match(out.failed.reason, /no longer being set up/);
});
