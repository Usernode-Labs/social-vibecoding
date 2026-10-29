'use strict';

// Projects made inside a platform preview, against a REAL git host and the
// preview's own app limit — the two things that broke on the first day
// previews were on by default.
//
// preview-projects-postgres.test.js stubs every git-host call, so the place
// a project's source is kept was never exercised: a build fetches it with no
// credential, and a repository left private fails every build with "could
// not read Username" (#5958). And its app count against the platform's
// MAX_APPS was never exercised, so a preview's sample tiles filled the limit
// and "Server is full" answered the first Make it (#5952).
//
// Here a git host stand-in (tests/lib/fake-git-host.js) keeps bare
// repositories in a temp folder behind a loopback server, so the source push
// and the build's fetch are real git over a real network, and only the image
// build (application-runtime.build) is stubbed. No database is needed.
//
// Run with: node --test tests/preview-projects-source-repo.test.js

// test:changed: when src/services/git-host.js (the push, the fetch and the repository's visibility)
// test:changed: when src/services/app-limit.js (the limit a preview's sample apps are counted against)
// test:changed: when src/services/staging-apps.js (the sample apps a preview seeds)
// test:changed: when src/services/preview-projects-setting.js (whether a preview gets a credential at all)
// test:changed: when src/db/migrate.js (the cap-filler sample apps)

const test = require('node:test');
const assert = require('node:assert/strict');

// Quiet: a failed build logs a warning, and the files below assert on state.
const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const { startFakeGitHost, fetchLikeABuild } = require('./lib/fake-git-host');

const SELF = 'usernode-2d5619';
const SOURCE_REPO = 'homeroom-preview-projects';
// A build runs under Docker here so build-retention-guard passes straight
// through: no Kubernetes lock, no database.
const CONFIG = { selfAppSlug: SELF, appRuntime: 'docker' };
const PLATFORM_CONFIG = { selfAppSlug: SELF, appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } };

// What checkFiles() hands runBuild.
const FILES = [
  { path: 'server.js', content: Buffer.from("require('http').createServer((req, res) => res.end('ok')).listen(3000);\n"), mode: '100644' },
  { path: 'bin/start', content: Buffer.from('#!/bin/sh\nexec node server.js\n'), mode: '100755' },
];

// preview-projects.js caches the source repository in a module-level
// variable, so each case starts from a module that has not pushed yet.
function freshProjects() {
  const id = require.resolve('../src/services/preview-projects');
  delete require.cache[id];
  return require('../src/services/preview-projects');
}

function recordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
}

// The one stubbed step: the image build. It fetches the source the way a
// real build does (fetchLikeABuild, no credential), so a source the build
// could not read fails the build instead of quietly succeeding.
function stubBuild(t, host) {
  const runtime = require('../src/services/application-runtime');
  const gitHost = require('../src/services/git-host');
  const calls = [];
  const saved = runtime.build;
  runtime.build = async (_config, args) => {
    const parsed = gitHost.parseRepoUrl(args.app.repo_url);
    const call = { args, privateBeforeFetch: parsed ? host.isPrivate(parsed.name) : null, fetched: null, error: null };
    calls.push(call);
    try {
      call.fetched = await fetchLikeABuild(args.app.repo_url, args.revision);
    } catch (err) {
      call.error = err;
      throw err;
    }
    return { imageRef: 'reg/pp@sha256:1', buildRef: 'b1' };
  };
  t.after(() => { runtime.build = saved; });
  return calls;
}

function row(overrides = {}) {
  return { id: 41, slug: 'tier', session_id: 500, builds: 1, source_branch: null, name: 'Tier', ...overrides };
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result;
  try { result = fn(); } catch (err) { restore(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ── The git host, for real ─────────────────────────────────────────────

test('the stand-in host refuses an anonymous fetch from a private repository, and answers once it is public', async (t) => {
  const host = await startFakeGitHost(t);
  const gitHost = require('../src/services/git-host');

  host.makeRepo('locked', { private: true });
  const sha = await gitHost.pushInitialFiles('locked', { 'README.md': '# locked\n' }, { branch: 'main' });

  // What a real build gets from a private repository: no credential is
  // offered and there is no terminal to ask, so git stops.
  await assert.rejects(fetchLikeABuild(gitHost.repoUrl('locked'), sha), /could not read Username/);

  await gitHost.setPrivate('locked', false);
  const checked = await fetchLikeABuild(gitHost.repoUrl('locked'), sha);
  assert.equal(checked.files['README.md'].toString(), '# locked\n');
});

test('a project\'s source is fetched with no credential, and the build gets the branch it was pushed to', async (t) => {
  const host = await startFakeGitHost(t);
  const projects = freshProjects();
  const pool = recordingPool();
  const builds = stubBuild(t, host);

  await projects.runBuild(CONFIG, pool, row(), FILES);

  assert.equal(host.isPrivate(SOURCE_REPO), false, 'the source repository is public, so a build can read it with no credential');
  const sha = host.branchSha(SOURCE_REPO, 'project-41-b1');
  assert.match(String(sha), /^[0-9a-f]{40}$/, 'the source is a real commit on the project\'s branch');

  assert.equal(builds.length, 1);
  assert.equal(builds[0].error, null, `the build could not read the source: ${builds[0].error && builds[0].error.message}`);
  assert.equal(builds[0].args.revision, sha);
  assert.deepEqual(Object.keys(builds[0].fetched.files).sort(), ['bin/start', 'server.js']);
  assert.equal(builds[0].fetched.files['server.js'].toString(), FILES[0].content.toString());
  assert.equal(builds[0].fetched.files['bin/start'].toString(), FILES[1].content.toString());
  assert.equal(builds[0].fetched.modes['bin/start'], '100755', 'the project\'s start script stays executable');

  const built = pool.queries.find((q) => q.sql.includes("state = 'built'"));
  assert.ok(built, 'the project is recorded as built');
  assert.equal(built.params[3], 'project-41-b1');
  assert.equal(built.params[4], sha);
  assert.equal(pool.queries.some((q) => q.sql.includes("state = 'failed'")), false);
});

test('a source repository left private by the first version is turned public before the build fetches it (#5958)', async (t) => {
  const host = await startFakeGitHost(t);
  host.makeRepo(SOURCE_REPO, { private: true });
  const projects = freshProjects();
  const pool = recordingPool();
  const builds = stubBuild(t, host);

  await projects.runBuild(CONFIG, pool, row(), FILES);

  assert.equal(builds.length, 1);
  assert.equal(builds[0].privateBeforeFetch, false, 'the build fetched a repository that is public');
  assert.equal(builds[0].error, null, `the build could not read the source: ${builds[0].error && builds[0].error.message}`);
  assert.equal(host.isPrivate(SOURCE_REPO), false);
  assert.ok(pool.queries.some((q) => q.sql.includes("state = 'built'")), 'the project is recorded as built');
});

test('a second build in the same process pushes a new branch and drops the old one', async (t) => {
  const host = await startFakeGitHost(t);
  const projects = freshProjects();
  const pool = recordingPool();
  const builds = stubBuild(t, host);

  await projects.runBuild(CONFIG, pool, row(), FILES);
  const first = host.branchSha(SOURCE_REPO, 'project-41-b1');
  await projects.runBuild(CONFIG, pool, row({ builds: 2, source_branch: 'project-41-b1' }), FILES);

  assert.equal(builds.length, 2);
  assert.equal(host.branchSha(SOURCE_REPO, 'project-41-b2'), builds[1].args.revision);
  assert.equal(host.branchSha(SOURCE_REPO, 'project-41-b1'), null, 'the branch the last build used is gone from the host');
  assert.notEqual(host.branchSha(SOURCE_REPO, 'project-41-b2'), first);
  assert.equal(host.requests.filter((r) => r.method === 'POST').length, 1, 'the source repository is made once per process');
});

// ── The app limit a preview boots under ────────────────────────────────

// A preview's database, in memory. `apps` is the set of live (non-errored)
// slugs, which is what the limit counts.
function appsPool(slugs) {
  const apps = new Set(slugs);
  return {
    apps,
    async query(sql, params = []) {
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.includes('FROM apps') && sql.includes('COUNT(*)')) return { rows: [{ n: apps.size }], rowCount: 1 };
      if (sql.includes('FROM apps WHERE slug')) return { rows: apps.has(params[0]) ? [{ id: 1 }] : [], rowCount: 1 };
      if (sql.includes('INSERT INTO apps')) { apps.add(params[1]); return { rows: [], rowCount: 1 }; }
      if (sql.includes('FROM platform_settings')) {
        // A preview's database is a clone of production's, so the admin's
        // stored limit comes with it.
        return { rows: params[0] === 'max_apps' ? [{ value: '50', updated_at: null, updated_by: null }] : [], rowCount: 1 };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

function silentLoad() {
  const config = require('../src/config');
  const realLog = console.log;
  console.log = () => {};
  try { return config.load(); } finally { console.log = realLog; }
}

test('a broker preview\'s sample apps leave room for the projects it may make (#5952)', async () => {
  const projects = freshProjects();
  const stagingApps = require('../src/services/staging-apps');
  const appTemplates = require('../src/services/app-templates');
  const appLimit = require('../src/services/app-limit');
  const { seedStagingAppCapApps } = require('../src/db/migrate');

  // What production deploys a preview with: no server-wide cap, because the
  // sample tiles alone fill it and nobody could press Make it.
  const envQueries = [];
  const envPool = {
    async query(sql) {
      envQueries.push(sql);
      if (sql.includes('INSERT INTO preview_project_tokens')) return { rows: [{ id: 9 }], rowCount: 1 };
      if (sql.includes('FROM platform_settings')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const previewEnv = await withEnv({ USERNODE_ENV: 'production' }, () => projects.previewEnv(PLATFORM_CONFIG, {
    app: { id: 2, slug: SELF }, sessionId: 500, pool: envPool,
  }));
  assert.equal(previewEnv.MAX_APPS, '0', 'the preview runs with no server-wide cap of its own');

  // The starters this preview makes as it boots, one per project it allows.
  const starterDirs = [...new Set(appTemplates.READY_IDS.map((id) => appTemplates.dirOf(id)))].slice(0, projects.maxPerPreview());
  assert.equal(starterDirs.length, projects.maxPerPreview());

  const seeded = [
    SELF,
    ...stagingApps.catalogFixtures(true).map((fixture) => fixture.slug),
    ...starterDirs.map((dir) => `preview-starter-${dir}`),
  ];
  const pool = appsPool(seeded);

  // The preview boots with that env, and its own seed tops the sample apps
  // up to the limit it is under.
  await withEnv({ MAX_APPS: null }, () => withEnv({
    ...previewEnv,
    USERNODE_ENV: 'staging',
    PREVIEW_PROJECTS_STARTER_DIRS: starterDirs.join(','),
    DATABASE_URL: 'postgres://localhost/preview',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
  }, async () => {
    const config = silentLoad();
    await seedStagingAppCapApps(pool, config);
    const cap = await appLimit.effective(pool, config);
    const room = cap === 0 ? Infinity : cap - pool.apps.size;
    assert.ok(room >= projects.maxPerPreview(),
      `the preview seeds ${pool.apps.size} live apps and its app limit is ${cap === 0 ? 'off' : cap}, `
      + `leaving room for ${room} more: making a project would answer "Server is full".`);
  }));
});
