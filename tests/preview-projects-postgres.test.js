'use strict';

// Projects made inside a platform preview (services/preview-projects.js)
// against a real PostgreSQL: the credential, the caps, a project through
// create, build, deploy and removal, the retirement and the sweep, and the
// door (routes/preview-projects.js) with the shared rate limiter.
//
// The preview-projects block of src/db/schema.sql is lifted out and run as
// written (twice, since schema.sql runs on every boot), in a scratch schema
// beside the few tables it reads. The git host is NOT stubbed: a stand-in
// (tests/lib/fake-git-host.js) keeps bare repositories behind a loopback
// server, so the source push and the build's fetch are real git. Only the
// project database's creation, the image build and the runtime are stubbed.
// What production's web side asks a conductor for (preview-project-operation.js)
// runs in this process (tests/lib/inline-operations.js): a waited-for step at
// once, a build or a deploy when the test drains what the route appended.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { startFakeGitHost, fetchLikeABuild } = require('./lib/fake-git-host');
const { inlineOperations } = require('./lib/inline-operations');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `preview_projects_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const SELF = 'usernode-2d5619';
const CONFIG = { selfAppSlug: SELF, previewProjectsEnabled: true, appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } };

function previewProjectsBlock() {
  const start = SCHEMA_SQL.indexOf('-- ── Projects made inside a platform preview');
  assert.ok(start > 0, 'the preview-projects block must be findable in schema.sql');
  const next = SCHEMA_SQL.indexOf('\n-- ── ', start + 10);
  return SCHEMA_SQL.slice(start, next > start ? next : undefined);
}

function rateLimitTable() {
  const m = /CREATE TABLE IF NOT EXISTS cli_auth_rate_limits \([\s\S]*?\n\);/.exec(SCHEMA_SQL);
  assert.ok(m, 'the limiter table must be findable in schema.sql');
  return m[0];
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE chat_sessions (id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), user_id INTEGER, staging_url VARCHAR(512));
    CREATE TABLE wf_instances (machine TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL);
  `);
  await pool.query(previewProjectsBlock());
  await pool.query(previewProjectsBlock());
  await pool.query(rateLimitTable());
  await pool.query(`
    INSERT INTO apps (id, slug) VALUES (2, '${SELF}'), (7, 'recipe-box');
    INSERT INTO chat_sessions (id, app_id, user_id, staging_url) VALUES
      (500, 2, 900, 'https://usernode-2d5619--s500.example.test'),
      (501, 2, 900, NULL),
      (502, 7, 900, 'https://recipe-box--s502.example.test'),
      (503, 2, 900, NULL),
      (504, 2, NULL, 'https://usernode-2d5619--s504.example.test');
    INSERT INTO wf_instances (machine, key, state) VALUES ('preview', 'session:503', 'preparing');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('projects made inside a platform preview, against a real PostgreSQL', async (t) => {
  const setup = await connectPool();
  if (setup.skip) { t.skip(setup.skip); return; }
  const { pool } = setup;
  const host = await startFakeGitHost(t);
  const savedEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';

  const projects = require('../src/services/preview-projects');
  const dbManager = require('../src/services/db-manager');
  const runtime = require('../src/services/application-runtime');
  const retention = require('../src/services/build-retention-guard');
  const { previewProjectsRoutes } = require('../src/routes/preview-projects');

  const calls = [];
  const saved = {
    create: dbManager.createPreviewProjectDatabase, drop: dbManager.dropDatabase, url: dbManager.connectionUrl,
    build: runtime.build, deploy: runtime.deploy, remove: runtime.remove, withBuildUse: retention.withBuildUse,
  };
  dbManager.createPreviewProjectDatabase = async (name) => { calls.push(['db', name]); return { password: `pw-${name}`, server: 'preview', url: 'postgres://x' }; };
  dbManager.dropDatabase = async (name) => { calls.push(['drop', name]); };
  dbManager.connectionUrl = (name, password, { server }) => `postgres://${name}_owner:${password}@${server}.db.test/${name}`;
  retention.withBuildUse = async (_c, fn) => fn();
  // The build fetches the source the way a real one does: no credential
  // offered, git's own fetch, so a source it cannot read fails the build.
  runtime.build = async (_c, args) => {
    const checked = await fetchLikeABuild(args.app.repo_url, args.revision);
    calls.push(['build', args.app.slug, args.app.id, args.revision, args.environment, Object.keys(checked.files).sort()]);
    return { imageRef: 'reg/preview-project@sha256:1', buildRef: 'b1' };
  };
  runtime.deploy = async (_c, args) => {
    calls.push(['deploy', args.app.slug, args.environment, args.sessionId, args.runtimeName, args.env.USERNODE_ENV, args.env.DATABASE_URL.includes('pw-')]);
    return { runtimeName: args.runtimeName, hostname: `${args.app.slug}--s${args.sessionId}.example.test` };
  };
  runtime.remove = async (_c, ref) => { calls.push(['remove', ref.runtimeName]); };

  // The author is the requester only; the preview's credential is the authority.
  const conductor = inlineOperations({ pool: () => pool, user: () => ({ id: 900, username: 'author', hasPlatformAccess: false }), config: CONFIG });
  const app = express();
  app.use(previewProjectsRoutes(CONFIG, { pool, isInternal: () => true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (token, method, pathname, body) => fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  t.after(async () => {
    Object.assign(dbManager, { createPreviewProjectDatabase: saved.create, dropDatabase: saved.drop, connectionUrl: saved.url });
    Object.assign(runtime, { build: saved.build, deploy: saved.deploy, remove: saved.remove });
    retention.withBuildUse = saved.withBuildUse;
    conductor();
    if (savedEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = savedEnv;
    await new Promise((resolve) => server.close(resolve));
    await dropSchema(pool);
  });

  await t.test('a credential names one platform session, and only the newest few live', async () => {
    const tokens = [];
    for (let i = 0; i < 4; i += 1) tokens.push(await projects.issueToken(pool, 500));
    const { rows } = await pool.query('SELECT token_hash FROM preview_project_tokens WHERE session_id = 500');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
    assert.deepEqual(await projects.authenticate(CONFIG, pool, tokens[3]), { ok: true, sessionId: 500 });
    assert.equal((await projects.authenticate(CONFIG, pool, tokens[0])).status, 401, 'the oldest went');
    const other = await projects.issueToken(pool, 502);
    assert.equal((await projects.authenticate(CONFIG, pool, other)).status, 401, 'a session of another app gets nothing');
    await pool.query("UPDATE preview_project_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE session_id = 500");
    assert.equal((await projects.authenticate(CONFIG, pool, tokens[3])).status, 401, 'an expired one');
  });

  const token = await projects.issueToken(pool, 500);

  await t.test('a project goes through create, build, deploy and removal, on its own session only', async () => {
    let res = await call(token, 'PUT', '/api/preview-projects/tier', { appId: 41, name: 'Tier' });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.state, 'created');
    const again = await call(token, 'PUT', '/api/preview-projects/tier', { appId: 41, name: 'Tier' });
    assert.equal(again.body.project.state, 'created');
    assert.equal(calls.filter((c) => c[0] === 'db').length, 1, 'made once');
    const [{ db_name: dbName, db_password: password }] = (await pool.query("SELECT db_name, db_password FROM preview_projects WHERE slug = 'tier'")).rows;
    assert.match(dbName, /^app_pp\d+_staging_s500_[0-9a-f]{6}$/);
    assert.equal(password, `pw-${dbName}`);
    assert.equal(JSON.stringify(res.body).includes(password), false);

    res = await call(token, 'POST', '/api/preview-projects/tier/build', { files: [{ path: 'server.js', content: 'eA==' }] });
    assert.equal(res.status, 202);
    const busy = await call(token, 'POST', '/api/preview-projects/tier/build', { files: [{ path: 'server.js', content: 'eA==' }] });
    assert.equal(busy.status, 409, 'claimed by the first');
    assert.equal(calls.filter((c) => c[0] === 'build').length, 0, 'nothing is built on the web side');
    const [kept] = (await pool.query("SELECT files, files_request FROM preview_project_inputs i JOIN preview_projects p ON p.id = i.project_id WHERE p.slug = 'tier'")).rows;
    assert.deepEqual(kept.files, [{ path: 'server.js', content: 'eA==', mode: '100644' }], 'its files are kept for the conductor');
    await conductor.drain();
    const built = await until(async () => {
      const r = await call(token, 'GET', '/api/preview-projects/tier');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (r.body.project.state === 'failed') throw new Error(`the build failed: ${r.body.project.error}`);
      return r.body.project.state === 'built' ? r.body.project : null;
    });
    assert.equal(built.imageRef, 'reg/preview-project@sha256:1');
    const build = calls.find((c) => c[0] === 'build');
    assert.match(build[1], /^preview-project-\d+$/, 'built under a slug no app has');
    assert.match(build[2], /^pp-\d+$/);
    const [row] = (await pool.query("SELECT id, source_branch, source_sha FROM preview_projects WHERE slug = 'tier'")).rows;
    const branch = `project-${row.id}-b1`;
    assert.equal(row.source_branch, branch);
    assert.equal(host.exists(projects.SOURCE_REPO), true, 'the source repository is on the host');
    assert.equal(host.isPrivate(projects.SOURCE_REPO), false, 'and it is public: builds fetch it with no credential');
    assert.equal(host.branchSha(projects.SOURCE_REPO, branch), row.source_sha, 'the build fetched the branch the source was pushed to');
    assert.equal(build[3], row.source_sha);
    assert.deepEqual(build[5], ['server.js']);

    assert.equal((await call(token, 'POST', '/api/preview-projects/tier/deploy', { imageRef: 'reg/other@sha256:9', env: {} })).status, 409);
    assert.equal((await pool.query("SELECT 1 FROM preview_project_inputs WHERE files IS NOT NULL")).rows.length, 0, 'and cleared once built');
    res = await call(token, 'POST', '/api/preview-projects/tier/deploy', { imageRef: built.imageRef, env: { USERNODE_APP_ID: '41', USERNODE_ENV: 'production' } });
    assert.equal(res.status, 202);
    assert.equal(calls.filter((c) => c[0] === 'deploy').length, 0, 'nothing runs on the web side');
    await conductor.drain();
    const running = await until(async () => {
      const r = await call(token, 'GET', '/api/preview-projects/tier');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (r.body.project.state === 'failed') throw new Error(`the deploy failed: ${r.body.project.error}`);
      return r.body.project.state === 'running' ? r.body.project : null;
    });
    assert.equal(running.url, 'https://tier--s500.example.test');
    const deploy = calls.find((c) => c[0] === 'deploy');
    assert.deepEqual(deploy.slice(1), ['tier', 'staging', 500, deploy[4], 'staging', true]);
    assert.match(deploy[4], /^sv-pp-\d+-s500$/);

    const otherToken = await projects.issueToken(pool, 501);
    assert.equal((await call(otherToken, 'GET', '/api/preview-projects/tier')).status, 404, 'another preview cannot see it');
    assert.equal((await call(otherToken, 'DELETE', '/api/preview-projects/tier')).body.removed, false);

    res = await call(token, 'DELETE', '/api/preview-projects/tier');
    assert.equal(res.body.removed, true);
    assert.equal((await pool.query("SELECT 1 FROM preview_projects WHERE slug = 'tier'")).rows.length, 0);
    assert.ok(calls.some((c) => c[0] === 'drop' && c[1] === dbName));
    assert.equal(host.branchSha(projects.SOURCE_REPO, branch), null, 'its source branch went with it');
  });

  await t.test('a preview can make up to its cap', async () => {
    for (const slug of ['one', 'two', 'three']) assert.equal((await call(token, 'PUT', `/api/preview-projects/${slug}`, { appId: 1 })).status, 200);
    const fourth = await call(token, 'PUT', '/api/preview-projects/four', { appId: 1 });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.error, 'limit_reached');
    assert.equal((await call(token, 'PUT', `/api/preview-projects/${SELF}`, { appId: 1 })).body.error, 'invalid_slug');
  });

  await t.test('the conductor reads the preview\'s authority again; a newer claim or a removal stops an older step', async () => {
    const builds = () => calls.filter((c) => c[0] === 'build').length;
    const state = async () => (await pool.query("SELECT state, error FROM preview_projects WHERE slug = 'late'")).rows[0];
    const files = { files: [{ path: 'server.js', content: 'eA==' }] };
    // Room under the cap (the cap's own test made three); they come back at the end.
    for (const slug of ['one', 'two', 'three']) await call(token, 'DELETE', `/api/preview-projects/${slug}`);
    assert.equal((await call(token, 'PUT', '/api/preview-projects/late', { appId: 2 })).status, 200);

    // The credential expired after the build was asked for: refused on the
    // conductor, and the step ends failed, so the preview's poll stops.
    assert.equal((await call(token, 'POST', '/api/preview-projects/late/build', files)).status, 202);
    await pool.query("UPDATE preview_project_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE session_id = 500");
    const before = builds();
    const [refused] = await conductor.drain();
    assert.equal(refused.status, 401);
    await pool.query("UPDATE preview_project_tokens SET expires_at = NOW() + INTERVAL '1 day' WHERE session_id = 500");
    assert.equal(builds(), before, 'nothing built');
    assert.equal((await state()).state, 'failed');
    assert.match((await state()).error, /credential is no longer valid/);
    assert.equal((await pool.query('SELECT 1 FROM preview_project_inputs WHERE files IS NOT NULL')).rows.length, 0);

    // A build left behind (stale) and asked for again: the older request
    // finds its files replaced and does nothing; the newer one builds.
    assert.equal((await call(token, 'POST', '/api/preview-projects/late/build', files)).status, 202);
    await pool.query("UPDATE preview_projects SET op_started_at = NOW() - INTERVAL '2 hours' WHERE slug = 'late'");
    assert.equal((await call(token, 'POST', '/api/preview-projects/late/build', files)).status, 202);
    const [older, newer] = await conductor.drain();
    assert.deepEqual([older.built, newer.built], [false, true]);
    assert.equal(builds(), before + 1);
    assert.equal((await state()).state, 'built');

    // Removed while its build waited: the build does nothing.
    assert.equal((await call(token, 'POST', '/api/preview-projects/late/build', files)).status, 202);
    assert.equal((await call(token, 'DELETE', '/api/preview-projects/late')).body.removed, true);
    const [gone] = await conductor.drain();
    assert.equal(gone.built, false);
    assert.equal(builds(), before + 1);
    for (const slug of ['one', 'two', 'three']) assert.equal((await call(token, 'PUT', `/api/preview-projects/${slug}`, { appId: 1 })).status, 200);
  });

  await t.test('a step no conductor takes, or that fails, gives its claim back and answers try again', async () => {
    const state = async (slug) => (await pool.query('SELECT state, error, op_started_at FROM preview_projects WHERE slug = $1', [slug])).rows[0];
    const files = { files: [{ path: 'server.js', content: 'eA==' }] };
    for (const slug of ['one', 'two', 'three']) await call(token, 'DELETE', `/api/preview-projects/${slug}`);

    // Create: not taken. The claim is given back, so asking again makes it.
    conductor.refuseNext();
    let res = await call(token, 'PUT', '/api/preview-projects/again', { appId: 3 });
    assert.deepEqual([res.status, res.body.error], [503, 'temporarily_unavailable']);
    assert.equal((await state('again')).state, 'failed');
    res = await call(token, 'PUT', '/api/preview-projects/again', { appId: 3 });
    assert.deepEqual([res.status, res.body.project.state], [200, 'created']);

    // Build: not taken. The row goes back to what it was, its files go.
    conductor.refuseNext();
    res = await call(token, 'POST', '/api/preview-projects/again/build', files);
    assert.equal(res.status, 503);
    assert.equal((await state('again')).state, 'created');
    assert.equal((await state('again')).op_started_at, null);
    assert.equal((await pool.query('SELECT 1 FROM preview_project_inputs WHERE files IS NOT NULL')).rows.length, 0);
    assert.deepEqual(await conductor.drain(), [], 'nothing left to run');

    // What the conductor reads is checked again: an env the route would
    // have refused (here written behind its back) is not deployed.
    assert.equal((await call(token, 'POST', '/api/preview-projects/again/build', files)).status, 202);
    await conductor.drain();
    const { image_ref: imageRef } = (await pool.query("SELECT image_ref FROM preview_projects WHERE slug = 'again'")).rows[0];
    assert.equal((await call(token, 'POST', '/api/preview-projects/again/deploy', { imageRef, env: {} })).status, 202);
    await pool.query(`UPDATE preview_project_inputs SET env = '{"not a name": "x"}'::jsonb WHERE env IS NOT NULL`);
    const deploys = calls.filter((c) => c[0] === 'deploy').length;
    await conductor.drain();
    assert.equal(calls.filter((c) => c[0] === 'deploy').length, deploys, 'not deployed');
    assert.equal((await state('again')).state, 'failed');

    // A removal that fails every try answers try again, never the error's text.
    const remove = runtime.remove;
    runtime.remove = async () => { throw new Error('etcd leader changed (internal detail)'); };
    try {
      res = await call(token, 'DELETE', '/api/preview-projects/again');
      assert.deepEqual([res.status, res.body.error], [503, 'temporarily_unavailable']);
      assert.doesNotMatch(JSON.stringify(res.body), /etcd/);
    } finally { runtime.remove = remove; }
    assert.equal((await call(token, 'DELETE', '/api/preview-projects/again')).body.removed, true);

    // Restart and removal are the conductor's: one it does not take leaves the
    // runtime and the row as they were.
    assert.equal((await call(token, 'PUT', '/api/preview-projects/kept', { appId: 3 })).status, 200);
    const removed = calls.filter((c) => c[0] === 'remove').length;
    conductor.refuseNext();
    assert.equal((await call(token, 'DELETE', '/api/preview-projects/kept')).status, 503);
    assert.equal(calls.filter((c) => c[0] === 'remove').length, removed, 'nothing removed on the web side');
    assert.equal((await pool.query("SELECT 1 FROM preview_projects WHERE slug = 'kept'")).rows.length, 1);
    assert.equal((await call(token, 'DELETE', '/api/preview-projects/kept')).body.removed, true);

    // A preview whose author is gone: told so, and nothing left claimed.
    const orphaned = await projects.issueToken(pool, 504);
    res = await call(orphaned, 'PUT', '/api/preview-projects/lone', { appId: 3 });
    assert.deepEqual([res.status, res.body.error], [409, 'no_author']);
    assert.equal((await pool.query("SELECT state FROM preview_projects WHERE session_id = 504")).rows[0].state, 'failed');
    await pool.query('DELETE FROM preview_projects WHERE session_id = 504');
    for (const slug of ['one', 'two', 'three']) assert.equal((await call(token, 'PUT', `/api/preview-projects/${slug}`, { appId: 1 })).status, 200);
  });

  await t.test('retiring the preview removes its projects and credentials; the sweep takes those of a preview that is gone', async () => {
    const t501 = await projects.issueToken(pool, 501);
    await call(t501, 'PUT', '/api/preview-projects/orphan', { appId: 1 });
    const t503 = await projects.issueToken(pool, 503);
    await call(t503, 'PUT', '/api/preview-projects/held', { appId: 1 });
    await pool.query("UPDATE preview_projects SET created_at = NOW() - INTERVAL '1 hour'");

    const swept = await projects.sweep(CONFIG, pool);
    assert.equal(swept.removed, 1, 'only the project of a session with no preview, not held by the machine');
    const left = (await pool.query('SELECT session_id, slug FROM preview_projects ORDER BY id')).rows.map((r) => `${r.session_id}:${r.slug}`);
    assert.deepEqual(left, ['500:one', '500:two', '500:three', '503:held']);

    assert.deepEqual(await projects.retireForSession(CONFIG, pool, 500), { removed: 3 });
    assert.equal((await pool.query('SELECT 1 FROM preview_projects WHERE session_id = 500')).rows.length, 0);
    assert.equal((await pool.query('SELECT 1 FROM preview_project_tokens WHERE session_id = 500')).rows.length, 0);
    assert.equal((await call(token, 'GET', '/api/preview-projects/one')).status, 401, 'its credential is gone with it');
  });
});
