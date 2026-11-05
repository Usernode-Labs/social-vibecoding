'use strict';

// #6305: File on all files one request per ticked row, against the full
// PostgreSQL schema. Each row's request is its own; an unticked row files
// nothing; a retry of the same tap finds the request its fileKey already
// made and files no second one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const created = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
    pushConversationEvent() { return 1; },
    pushToUser() { return 1; },
  },
};
const githubId = require.resolve('../src/services/github');
const githubStub = {
  isEnabled: () => true,
  async createIssue(owner, repo, { title }) {
    created.push({ owner, repo, title });
    return { number: 100 + created.length };
  },
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const fileManySvc = require('../src/services/homeroom-bot-file-many');

const ROWS = [
  { named: 'Alpha', match: 'exact', slug: 'alpha', name: 'Alpha', choices: [], done: null, disabled: null, ticked: true },
  { named: 'Beta', match: 'guess', slug: null, name: 'Beta', choices: [{ slug: 'beta', name: 'Beta' }], done: null, disabled: null, ticked: false },
  { named: 'Gamma', match: 'exact', slug: 'gamma', name: 'Gamma', choices: [], done: null, disabled: null, ticked: false },
];
const TITLE = 'Work for people who are not signed in';
const DETAILS = 'Visitors without an account can open the app and use it.';

test('#6305: File on all files one request per ticked row', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_file_many_${crypto.randomBytes(6).toString('hex')}`;
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

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id, username`,
  );
  async function project(slug) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, 'public', 'public') RETURNING id`,
      [slug.replace(/^./, (c) => c.toUpperCase()), slug, user.id, `https://github.com/usernode-bot/${slug}`],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [app.community_id, user.id],
    );
    return app;
  }
  await project('alpha');
  await project('beta');
  await project('gamma');

  const config = { dataEncryptionKey: 'synthetic-key' };
  const out = await fileManySvc.fileMany(pool, config, {
    user, rows: ROWS, picks: ['0:alpha', '1:beta'], title: TITLE, details: DETAILS,
    extras: null, messageId: 77, settings: { mode: 'off' },
  });
  assert.equal(out.ok, true);
  assert.equal(created.length, 2, 'two ticked rows make two requests');
  assert.deepEqual(created.map((c) => c.repo), ['alpha', 'beta']);
  // The unticked row filed nothing.
  assert.equal(out.rows[2].issueNumber, undefined);
  assert.equal(out.rows[0].error, null);
  assert.deepEqual(out.rows.slice(0, 2).map((r) => r.issueNumber), [101, 102]);
  // One record per filed request, each done with its number.
  const actions = await pool.query(
    `SELECT app_id, status, issue_number FROM bot_cards WHERE user_id = $1 ORDER BY id`, [user.id],
  );
  assert.equal(actions.rows.length, 2);
  for (const row of actions.rows) {
    assert.equal(row.status, 'done');
    assert.ok(Number(row.issue_number) > 0);
  }
  const issues = await pool.query(
    `SELECT app_id, github_issue_number, payload->>'fileKey' AS key FROM issues ORDER BY id`,
  );
  assert.equal(issues.rows.length, 2);
  assert.deepEqual(issues.rows.map((r) => r.key), ['file-many:77:1', 'file-many:77:2']);

  // The same tap again (a retry) files no second request.
  const again = await fileManySvc.fileMany(pool, config, {
    user, rows: ROWS, picks: ['0:alpha', '1:beta'], title: TITLE, details: DETAILS,
    extras: null, messageId: 77, settings: { mode: 'off' },
  });
  assert.equal(again.ok, true);
  assert.equal(created.length, 2, 'a retry makes no second request');
  assert.deepEqual(again.rows.slice(0, 2).map((r) => r.issueNumber), [101, 102]);
  const stillTwo = await pool.query('SELECT COUNT(*)::int AS n FROM issues');
  assert.equal(stillTwo.rows[0].n, 2);

  // A pick that names a project its row does not offer files nothing.
  const bad = await fileManySvc.fileMany(pool, config, {
    user, rows: ROWS, picks: ['0:gamma'], title: TITLE, details: DETAILS, messageId: 77, settings: { mode: 'off' },
  });
  assert.equal(bad.ok, false);
  assert.equal(created.length, 2);
});
