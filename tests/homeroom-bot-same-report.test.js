'use strict';

// #6869: the same report on another project. Against the real schema: only
// public projects' open requests from the last seven days, never this
// project and never a private one, matched by the title's words or by the
// other read having put it on Homeroom itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const { sameReports, sameReportNote } = require('../src/services/homeroom-bot-same-report');

test('#6869: matching reports on other public projects', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_same_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const { rows: [owner] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('owner_1', 'x', TRUE) RETURNING id",
  );
  const project = async (slug, visibility) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id, slug, name`,
      [slug.replace(/-/g, ' '), slug, owner.id, `https://github.com/usernode-bot/${slug}`, visibility,
        visibility === 'public' ? 'public' : 'private'],
    );
    return row;
  };
  const issue = async (app, number, title, { daysAgo = 1, status = 'open' } = {}) => {
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, status, created_at)
       VALUES ($1, $2, $3, '', 'general', $4, NOW() - ($5 || ' days')::interval)`,
      [app.id, number, title, status, String(daysAgo)],
    );
  };
  const read = async (app, number, { aboutPlatform = false, reason = null } = {}) => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, about_platform, reason)
       VALUES ($1, $2, 'live', 'person', $3, $4)`,
      [app.id, number, aboutPlatform, reason],
    );
  };

  const mine = await project('rilo', 'public');
  const family = await project('family-tree', 'public');
  const privateApp = await project('secret-place', 'private');
  const unrelated = await project('other-place', 'public');

  await issue(mine, 29, 'the app isnt loading for me');
  // The same words, on another public project, yesterday.
  await issue(family, 19, 'app isnt loading, the page shows garbled text');
  // A different title, but the other read put it on Homeroom itself.
  await issue(unrelated, 4, 'the buttons are the wrong shade of blue');
  await read(unrelated, 4, { aboutPlatform: true, reason: 'this is Homeroom\'s header, not the app\'s' });
  // A private project's matching report is never named.
  await issue(privateApp, 7, 'app isnt loading for me either');
  // Outside the seven days.
  await issue(family, 12, 'app isnt loading for me', { daysAgo: 30 });
  // Closed.
  await issue(unrelated, 5, 'app isnt loading for me', { status: 'closed' });

  const found = await sameReports(pool, { app: mine, issueNumber: 29, title: 'the app isnt loading for me' });
  assert.equal(found.length, 2, JSON.stringify(found));
  const byNumber = new Map(found.map((r) => [r.number, r]));
  assert.ok(byNumber.has(19), 'the same report on Family Tree');
  assert.equal(byNumber.get(19).project, 'family tree');
  assert.equal(byNumber.get(19).aboutPlatform, false);
  assert.ok(byNumber.has(4), 'the report its own read put on Homeroom');
  assert.equal(byNumber.get(4).aboutPlatform, true);
  assert.ok(found.every((r) => r.number !== 7), 'a private project is never named');
  assert.ok(found.every((r) => r.number !== 12), 'only the last seven days');
  assert.ok(found.every((r) => r.number !== 5), 'only open requests');
  assert.ok(found.every((r) => r.number !== 29), 'never this request');

  const note = sameReportNote(found);
  assert.match(note, /family tree reported request #19/);
  assert.match(note, /yesterday/);
  assert.match(note, /on Homeroom itself/);
  assert.equal(sameReportNote([]), null);
});
