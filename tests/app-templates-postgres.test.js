'use strict';

// Each starter's own API against a throwaway PostgreSQL database: the tables
// it creates, its staging seed (idempotent), and the flows the screen drives.
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set,
// like the platform's other *-postgres suites.
//
// The generated api.js is loaded from a temporary file: that is the file a
// new project receives, not a copy kept in src/.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const express = require('express');
const templates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

/** The starter's api.js, loaded the way a generated repository would have it. */
function loadStarterApi(id) {
  // Inside the repository, so `require('express')` resolves from its
  // node_modules exactly as it will in the generated repository.
  const dir = fs.mkdtempSync(path.join(__dirname, '..', `.tmp-starter-${id}-`));
  const file = path.join(dir, 'api.js');
  fs.writeFileSync(file, getTemplateFiles('Test app', 'test-app-abc123', 'postgres://x', null, { template: id })
    .find((f) => f.path === 'api.js').content);
  const api = require(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return api;
}

/** An HTTP surface with the platform's sign-in already applied. */
async function serve(api, pool) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const name = String(req.headers['x-test-user'] || 'ada');
    req.user = { id: 900000 + name.charCodeAt(0), username: name };
    next();
  });
  api.mount(app, pool);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, user = 'ada') => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-user': user },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { server, call };
}

test('every starter creates its tables, seeds once in staging, and works', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }

  for (const starter of templates.TEMPLATES) {
    const name = `starter_${starter.id.replace(/-/g, '_')}_` + crypto.randomBytes(4).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    const api = loadStarterApi(starter.id);
    const { server, call } = await serve(api, pool);
    try {
      await api.migrate(pool);
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const owns = tables.rows.map((r) => r.table_name);
      assert.ok(owns.length > 0, `${starter.id}: migrate creates its tables`);

      // A real project begins empty: nothing is written until seed() runs.
      const before = await call('GET', starter.id === 'social-productivity' ? '/api/state'
        : starter.id === 'multimedia-social' ? '/api/posts' : '/api/scores');
      assert.equal(before.status, 200, `${starter.id}: a signed-in visitor gets the screen's data`);
      const empty = before.data.lists || before.data.posts || before.data.scores;
      assert.equal(empty.length, 0, `${starter.id}: production starts empty`);

      // Staging seed: obviously fake, and a second boot does not duplicate it.
      await api.seed(pool);
      await api.seed(pool);
      const seeded = await call('GET', starter.id === 'social-productivity' ? '/api/state'
        : starter.id === 'multimedia-social' ? '/api/posts' : '/api/scores');
      const rows = seeded.data.lists || seeded.data.posts || seeded.data.scores;
      assert.ok(rows.length > 0, `${starter.id}: staging has a few rows`);
      assert.ok(rows.length <= 4, `${starter.id}: seed is idempotent`);

      if (starter.id === 'social-productivity') {
        const added = await call('POST', '/api/lists', { title: 'Trip packing' });
        assert.equal(added.status, 201);
        const list = added.data.lists.find((l) => l.title === 'Trip packing');
        const task = await call('POST', `/api/lists/${list.id}/tasks`, { title: 'Pack a raincoat' });
        assert.equal(task.status, 201);
        const t1 = task.data.lists.find((l) => l.id === list.id).tasks[0];
        const claim = await call('POST', `/api/tasks/${t1.id}/claim`, {}, 'grace');
        assert.equal(claim.status, 200);
        assert.equal(claim.data.lists.find((l) => l.id === list.id).tasks[0].claimedByUsername, 'grace');
        const done = await call('POST', `/api/tasks/${t1.id}/done`, { done: true }, 'grace');
        assert.equal(done.status, 200);
        assert.equal(done.data.lists.find((l) => l.id === list.id).tasks[0].done, true);
        const removed = await call('DELETE', `/api/tasks/${t1.id}`, null, 'ada');
        assert.equal(removed.status, 200, 'the list’s starter may remove a task');
      }

      if (starter.id === 'multimedia-social') {
        const posted = await call('POST', '/api/posts', { caption: 'A quiet corner of the garden' });
        assert.equal(posted.status, 201);
        const post = posted.data.posts.find((p) => p.caption === 'A quiet corner of the garden');
        assert.equal(post.author, 'ada');
        const liked = await call('POST', `/api/posts/${post.id}/like`, {}, 'grace');
        assert.ok(liked.data.posts.find((p) => p.id === post.id).likes >= 1);
        // Three different people report it; it stops being shown.
        for (const person of ['grace', 'lin', 'sam']) {
          await call('POST', `/api/posts/${post.id}/report`, {}, person);
        }
        const hidden = await call('GET', '/api/posts');
        assert.equal(hidden.data.posts.some((p) => p.id === post.id), false,
          'a post reported by three different people is hidden');
      }

      if (starter.id === 'game-2d' || starter.id === 'game-3d') {
        const saved = await call('POST', '/api/scores', { score: 7 }, 'grace');
        assert.equal(saved.status, 201);
        assert.ok(saved.data.scores.length > 0);
        const board = await call('GET', '/api/scores', null, 'grace');
        assert.ok(board.data.yourBest >= 7, 'the viewer’s best comes back');
        assert.equal((await call('POST', '/api/scores', { score: -1 })).status, 400);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  }
  await admin.end();
});
