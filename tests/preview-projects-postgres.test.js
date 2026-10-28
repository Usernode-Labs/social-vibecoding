'use strict';

// Projects made inside a platform preview (services/preview-projects.js)
// against a real PostgreSQL: the credential, the caps, a project through
// create, build, deploy and removal, the retirement and the sweep, and the
// door (routes/preview-projects.js) with the shared rate limiter.
//
// The preview-projects block of src/db/schema.sql is lifted out and run as
// written (twice, since schema.sql runs on every boot), in a scratch schema
// beside the few tables it reads. Only the outside world is stubbed: the
// project database's creation, the git host, the build and the runtime.
//
// Set TEST_DATABASE_URL to run it; without a reachable server it skips (the
// unit-suite container has none).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

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
    CREATE TABLE chat_sessions (id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), staging_url VARCHAR(512));
    CREATE TABLE wf_instances (machine TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL);
  `);
  await pool.query(previewProjectsBlock());
  await pool.query(previewProjectsBlock());
  await pool.query(rateLimitTable());
  await pool.query(`
    INSERT INTO apps (id, slug) VALUES (2, '${SELF}'), (7, 'recipe-box');
    INSERT INTO chat_sessions (id, app_id, staging_url) VALUES
      (500, 2, 'https://usernode-2d5619--s500.example.test'),
      (501, 2, NULL),
      (502, 7, 'https://recipe-box--s502.example.test'),
      (503, 2, NULL);
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
  const savedEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';

  const projects = require('../src/services/preview-projects');
  const dbManager = require('../src/services/db-manager');
  const gitHost = require('../src/services/git-host');
  const runtime = require('../src/services/application-runtime');
  const retention = require('../src/services/build-retention-guard');
  const { previewProjectsRoutes } = require('../src/routes/preview-projects');

  const calls = [];
  const saved = {
    create: dbManager.createPreviewProjectDatabase, drop: dbManager.dropDatabase, url: dbManager.connectionUrl,
    isConfigured: gitHost.isConfigured, createRepo: gitHost.createRepo, push: gitHost.pushInitialFiles,
    repoUrl: gitHost.repoUrl, deleteRef: gitHost.deleteRef, setPrivate: gitHost.setPrivate,
    build: runtime.build, deploy: runtime.deploy, remove: runtime.remove, withBuildUse: retention.withBuildUse,
  };
  dbManager.createPreviewProjectDatabase = async (name) => { calls.push(['db', name]); return { password: `pw-${name}`, server: 'preview', url: 'postgres://x' }; };
  dbManager.dropDatabase = async (name) => { calls.push(['drop', name]); };
  dbManager.connectionUrl = (name, password, { server }) => `postgres://${name}_owner:${password}@${server}.db.test/${name}`;
  gitHost.isConfigured = () => true;
  gitHost.createRepo = async (name, opts) => { calls.push(['repo', name, opts.private]); return { name }; };
  gitHost.pushInitialFiles = async (repo, files, { branch }) => { calls.push(['push', repo, branch, files.length]); return 'A'.repeat(40); };
  gitHost.repoUrl = (name) => `https://git.example.test/apps/${name}`;
  gitHost.setPrivate = async (repo, isPrivate) => { calls.push(['visibility', repo, isPrivate]); };
  gitHost.deleteRef = async (repo, ref) => { calls.push(['branch', repo, ref]); };
  retention.withBuildUse = async (_c, fn) => fn();
  runtime.build = async (_c, args) => { calls.push(['build', args.app.slug, args.app.id, args.revision, args.environment]); return { imageRef: 'reg/preview-project@sha256:1', buildRef: 'b1' }; };
  runtime.deploy = async (_c, args) => {
    calls.push(['deploy', args.app.slug, args.environment, args.sessionId, args.runtimeName, args.env.USERNODE_ENV, args.env.DATABASE_URL.includes('pw-')]);
    return { runtimeName: args.runtimeName, hostname: `${args.app.slug}--s${args.sessionId}.example.test` };
  };
  runtime.remove = async (_c, ref) => { calls.push(['remove', ref.runtimeName]); };

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
    Object.assign(gitHost, {
      isConfigured: saved.isConfigured, createRepo: saved.createRepo, pushInitialFiles: saved.push,
      repoUrl: saved.repoUrl, deleteRef: saved.deleteRef, setPrivate: saved.setPrivate,
    });
    Object.assign(runtime, { build: saved.build, deploy: saved.deploy, remove: saved.remove });
    retention.withBuildUse = saved.withBuildUse;
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
    assert.ok([202, 409].includes(busy.status));
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
    assert.equal(build[3], 'a'.repeat(40));
    assert.ok(calls.some((c) => c[0] === 'repo' && c[2] === false), 'the source repository is public: builds fetch it with no credential');
    assert.ok(calls.some((c) => c[0] === 'visibility' && c[2] === false), 'and one made private before is turned public');

    assert.equal((await call(token, 'POST', '/api/preview-projects/tier/deploy', { imageRef: 'reg/other@sha256:9', env: {} })).status, 409);
    res = await call(token, 'POST', '/api/preview-projects/tier/deploy', { imageRef: built.imageRef, env: { USERNODE_APP_ID: '41', USERNODE_ENV: 'production' } });
    assert.equal(res.status, 202);
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
  });

  await t.test('a preview can make up to its cap', async () => {
    for (const slug of ['one', 'two', 'three']) assert.equal((await call(token, 'PUT', `/api/preview-projects/${slug}`, { appId: 1 })).status, 200);
    const fourth = await call(token, 'PUT', '/api/preview-projects/four', { appId: 1 });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.error, 'limit_reached');
    assert.equal((await call(token, 'PUT', `/api/preview-projects/${SELF}`, { appId: 1 })).body.error, 'invalid_slug');
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
