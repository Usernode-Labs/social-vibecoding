'use strict';

// #7136: the build's own read of the files a request carries
// (GET /api/internal/sessions/:id/request-files/:id), against the real
// PostgreSQL schema. A build reads a file only when its own request carries
// it or somebody posted it in that request's discussion: knowing a file's id
// is not enough, and a refused id says nothing about whether it exists.
//
// Run with: node --test tests/internal-request-files-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'internal-request-files-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'internal-request-files-secret';

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function buildZip(entries) {
  const cdParts = [];
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(e.flags || 0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt32LE((e.compressed || 0) >>> 0, 20);
    h.writeUInt32LE((e.uncompressed || 0) >>> 0, 24);
    h.writeUInt16LE(nameBuf.length, 28);
    h.writeUInt32LE((e.extAttrs || 0) >>> 0, 38);
    cdParts.push(h, nameBuf);
  }
  const cd = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  return Buffer.concat([cd, eocd]);
}

const OK_ZIP = buildZip([{ name: 'index.html', compressed: 40, uncompressed: 90 }]);

test('a build saves only the files its own request carries', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `internal_req_files_${crypto.randomBytes(6).toString('hex')}`;
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
  require('../src/db/pool').getPool = () => pool;

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('filer', 'x', TRUE) RETURNING id`,
  );
  const mkApp = async (slug, repoUrl) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ($1, $2, 'running', $3, $4, 'private', 'private') RETURNING id`,
    [slug, slug, user.id, repoUrl],
  )).rows[0].id;
  const appId = await mkApp('plant-pal', 'https://github.com/usernode-bot/plant-pal');
  const otherAppId = await mkApp('other-project', 'https://github.com/usernode-bot/other-project');

  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues)
     VALUES ($1, $2, 'active', ARRAY[500]::integer[]) RETURNING id`,
    [appId, user.id],
  );
  // A request this session builds without the work order naming it: the run
  // that started the build records it.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id)
     VALUES ($1, 501, 'build', 'ready', $2)`,
    [appId, session.id],
  );
  const { rows: [otherSession] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues)
     VALUES ($1, $2, 'active', ARRAY[500]::integer[]) RETURNING id`,
    [otherAppId, user.id],
  );

  // A file carried onto request 500, one on request 502 (not this session's),
  // and one stamped with another app's repo on the same number.
  const mkIssueFile = async (filename, data, { owner = 'usernode-bot', repo = 'plant-pal', number = 500 } = {}) => {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO issue_files (id, user_id, filename, kind, content_type, size_bytes, data, issue_owner, issue_repo, issue_number)
       VALUES ($1, $2, $3, 'zip', 'application/zip', $4, $5, $6, $7, $8)`,
      [id, user.id, filename, data.length, data, owner, repo, number],
    );
    return id;
  };
  const carriedId = await mkIssueFile('site.zip', OK_ZIP);
  const otherNumberId = await mkIssueFile('elsewhere.zip', OK_ZIP, { number: 502 });
  const otherRepoId = await mkIssueFile('foreign.zip', OK_ZIP, { repo: 'other-project' });

  // A file posted in request 500's discussion, one in 502's, and one on a
  // message moderation hid.
  const mkChatFile = async (messageId, filer, filename, data, app = appId) => {
    const id = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO chat_message_attachments (id, app_id, message_id, user_id, kind, filename, content_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, 'binary', $5, 'application/zip', $6, $7)`,
      [id, app, messageId, filer, filename, data.length, data],
    );
    return id;
  };
  const mkMessage = async (app, number, { hidden = false } = {}) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, moderation_hidden_at)
     VALUES ($1, $2, 'here it is', 'issue', $3, $4) RETURNING id`,
    [app, user.id, number, hidden ? new Date() : null],
  )).rows[0].id;

  const discussionId = await mkChatFile(await mkMessage(appId, 500), user.id, 'notes.zip', OK_ZIP);
  const otherThreadId = await mkChatFile(await mkMessage(appId, 502), user.id, 'wrong-thread.zip', OK_ZIP);
  const hiddenId = await mkChatFile(await mkMessage(appId, 500, { hidden: true }), user.id, 'hidden.zip', OK_ZIP);
  const otherAppMessage = (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
     VALUES ($1, $2, 'elsewhere', 'issue', 500) RETURNING id`, [otherAppId, user.id],
  )).rows[0].id;
  const otherAppFileId = await mkChatFile(otherAppMessage, user.id, 'other-app.zip', OK_ZIP, otherAppId);
  // Over the chat's own zip limit, posted before that limit was checked here.
  const overLimitId = await mkChatFile(
    await mkMessage(appId, 500), user.id, 'huge.zip',
    buildZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, compressed: 1, uncompressed: 1 }))),
  );

  const { internalRoutes } = require('../src/routes/internal');
  const platformJwt = require('../src/services/platform-jwt');
  const server = express();
  server.use(express.json());
  server.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET }));
  const listening = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((r) => listening.close(r)));
  const base = `http://127.0.0.1:${listening.address().port}`;
  const token = platformJwt.signWorkerToken({ sessionId: session.id });

  const read = async (id, { withToken = token } = {}) => {
    const res = await fetch(`${base}/api/internal/sessions/${session.id}/request-files/${id}`, {
      headers: withToken ? { Authorization: `Bearer ${withToken}` } : {},
    });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  };

  await t.test('the file its request carries is served, with its name and type', async () => {
    const got = await read(carriedId);
    assert.equal(got.status, 200);
    assert.equal(got.body.toString('hex'), OK_ZIP.toString('hex'));
    assert.equal(got.headers.get('content-type'), 'application/zip');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(decodeURIComponent(got.headers.get('x-file-name')), 'site.zip');
  });

  await t.test('a file posted in the request\'s own discussion is served', async () => {
    const got = await read(discussionId);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/zip');
  });

  await t.test('a request the session builds through its run carries its files too', async () => {
    // 501 is in no work order: the run that built it named it.
    const id = await mkIssueFile('run.zip', OK_ZIP, { number: 501 });
    const got = await read(id);
    assert.equal(got.status, 200);
  });

  await t.test('another request\'s file, another app\'s file and a hidden message\'s file are not found', async () => {
    for (const [label, id] of [
      ['another request', otherNumberId],
      ['another repo on the same number', otherRepoId],
      ['another thread\'s discussion file', otherThreadId],
      ['a hidden message\'s file', hiddenId],
      ['another app\'s file on the same number', otherAppFileId],
      ['an id nobody carries', crypto.randomBytes(16).toString('hex')],
    ]) {
      const got = await read(id);
      assert.equal(got.status, 404, label);
      assert.deepEqual(JSON.parse(got.body.toString('utf8')), {
        ok: false, code: 'not_found', message: 'This request carries no such file.',
      }, label);
    }
  });

  await t.test('a token that is not a build\'s own is refused', async () => {
    const got = await read(carriedId, { withToken: null });
    assert.ok(got.status === 401 || got.status === 403, `refused, got ${got.status}`);
  });

  await t.test('a discussion file over the chat\'s limits is refused as too large', async () => {
    const got = await read(overLimitId);
    assert.equal(got.status, 413);
    const body = JSON.parse(got.body.toString('utf8'));
    assert.equal(body.code, 'too_large');
    assert.match(body.message, /too many files/);
  });

  await t.test('usernode-issues <number> lists the request\'s files with their ids', async () => {
    const github = require('../src/services/github');
    const wasIssue = github.fetchPublicIssue;
    const wasComments = github.fetchIssueComments;
    github.fetchPublicIssue = async () => ({ issue: { number: 500, title: 'Build it', body: 'b' } });
    github.fetchIssueComments = async () => ({ comments: [], truncated: false });
    t.after(() => { github.fetchPublicIssue = wasIssue; github.fetchIssueComments = wasComments; });
    const res = await fetch(`${base}/api/internal/sessions/${session.id}/issues/500`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = new Map(body.files.map((f) => [f.id, f]));
    assert.deepEqual(byId.get(carriedId), {
      id: carriedId, name: 'site.zip', size: OK_ZIP.length, contentType: 'application/zip', from: 'request',
    });
    assert.equal(byId.get(discussionId)?.from, 'discussion');
    assert.equal(byId.has(otherNumberId), false, 'only this request\'s files');
    assert.equal(byId.has(hiddenId), false, 'a hidden message\'s file is nobody\'s');
  });

  await t.test('a request with no files says nothing about them', async () => {
    const res = await fetch(`${base}/api/internal/sessions/${session.id}/issues/601`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    assert.equal('files' in body, false);
  });
});
