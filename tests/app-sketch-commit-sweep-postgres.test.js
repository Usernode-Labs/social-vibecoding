'use strict';

// The first session's card a restart kept out of a new repository
// (services/app-sketch.js sweepUncommitted), against the full schema. The late
// commit (commitWhenReady) runs in the process that made the repository and
// dies with it, and a creation resumed after a restart clones the repository
// it finds, so nothing else ever commits design/sketch.json. GitHub is a
// stand-in.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/app-sketch-commit-sweep-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const sketch = require('../src/services/app-sketch');
const CARD = { kind: 'card', emoji: '👟', tagline: 'The club\'s Sunday runs, together', points: ['Log a run in a tap', 'See the week\'s miles'] };

function fakeGithub({ committed = new Set() } = {}) {
  const pushes = [];
  return {
    pushes,
    isEnabled: () => true,
    parseGithubUrl: (u) => {
      const m = /github\.com\/([^/]+)\/([^/]+)/.exec(u || '');
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    async getFileContent(owner, repo, path) {
      if (path === 'design/sketch.json') return committed.has(repo) ? '{}' : null;
      return '{\n  "secrets": []\n}';
    },
    async pushFiles(owner, repo, files, opts) { pushes.push({ owner, repo, files, opts }); },
  };
}

test('cards a restart kept out of the repository, against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `sketch_sweep_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id`);

  let n = 0;
  // A project and its card, as a process left them. Ages in minutes.
  async function project({ status = 'running', readyAgo = 30, createdAgo = 31, committed = false, repo = true } = {}) {
    n += 1;
    const slug = `run-club-${n}`;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, slug`,
      [`Run Club ${n}`, slug, status, ada.id, repo ? `https://github.com/usernode-bot/${slug}` : null]);
    await pool.query(
      `INSERT INTO app_sketches (app_id, user_id, status, design, model, created_at, ready_at, committed_at)
       VALUES ($1, $2, 'ready', $3::jsonb, 'z-ai/glm-5.3-flash',
               NOW() - make_interval(mins => $4), NOW() - make_interval(mins => $5),
               CASE WHEN $6 THEN NOW() ELSE NULL END)`,
      [app.id, ada.id, JSON.stringify(CARD), createdAgo, readyAgo, committed]);
    return app;
  }
  const committedAt = async (id) => (await pool.query(
    'SELECT committed_at FROM app_sketches WHERE app_id = $1', [id])).rows[0].committed_at;

  await t.test('RESTART: a card whose late commit died with its process is committed by the leader', async () => {
    const app = await project();
    const github = fakeGithub();
    assert.equal(await sketch.sweepUncommitted(pool, { github }), 1);
    assert.equal(github.pushes.length, 1);
    assert.equal(github.pushes[0].repo, app.slug);
    assert.deepEqual(github.pushes[0].files.map((f) => f.path), ['design/sketch.json', 'dapp.json']);
    assert.deepEqual(JSON.parse(github.pushes[0].files[1].content).icon, { emoji: '👟' });
    assert.ok(await committedAt(app.id));
    assert.equal(await sketch.sweepUncommitted(pool, { github }), 0, 'once');
    assert.equal(github.pushes.length, 1);
  });

  await t.test('a card that reached the repository before its process could say so is only marked', async () => {
    const app = await project();
    const github = fakeGithub({ committed: new Set([app.slug]) });
    assert.equal(await sketch.sweepUncommitted(pool, { github }), 1);
    assert.equal(github.pushes.length, 0, 'never a second commit');
    assert.ok(await committedAt(app.id));
  });

  await t.test('left alone: a late commit still in time, an old card, a project not running', async () => {
    const recent = await project({ readyAgo: 1, createdAgo: 2 });
    const old = await project({ readyAgo: 60 * 30, createdAgo: 60 * 30 });
    const creating = await project({ status: 'creating' });
    const done = await project({ committed: true });
    const github = fakeGithub();
    assert.equal(await sketch.sweepUncommitted(pool, { github }), 0);
    assert.equal(github.pushes.length, 0);
    for (const app of [recent, old, creating]) assert.equal(await committedAt(app.id), null);
    assert.ok(await committedAt(done.id));
  });

  await t.test('GitHub off, or refusing: nothing marked, nothing thrown', async () => {
    const app = await project();
    assert.equal(await sketch.sweepUncommitted(pool, { github: { ...fakeGithub(), isEnabled: () => false } }), 0);
    const refusing = { ...fakeGithub(), async pushFiles() { throw new Error('Resource not accessible by integration'); } };
    assert.equal(await sketch.sweepUncommitted(pool, { github: refusing }), 0);
    assert.equal(await committedAt(app.id), null, 'tried again on a later pass');
  });
});
