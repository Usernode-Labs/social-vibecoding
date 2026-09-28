'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const express = require('express');
process.env.USERNODE_ENV = 'staging';
const stagingMessages = require('../src/services/staging-messages');
const stagingApps = require('../src/services/staging-apps');
const { seedStagingGeneralChannel } = require('../src/db/migrate');
const { conversationRoutes } = require('../src/routes/conversations');
const { moderationRoutes } = require('../src/routes/moderation');
const { moderationGuard } = require('../src/middleware/moderation');
const { appRoutes } = require('../src/routes/apps');

test('fixture reconciliation is inert outside staging', async () => {
  process.env.USERNODE_ENV = 'production';
  const pool = { connect() { assert.fail('production must never seed fixtures'); } };
  try {
    await stagingMessages.ensureFixtures(pool, { id: 1 });
    await stagingApps.seedCatalog(pool);
    assert.equal(stagingApps.isSample({ slug: 'staging-demo-emoji-icon', created_by: 900001, status: 'running' }), false);
  } finally { process.env.USERNODE_ENV = 'staging'; }
});

test('older stored sample apps also avoid nonexistent runtimes, while real deployments are unchanged', () => {
  const sample = { slug: 'staging-demo-fork', created_by: 900001, status: 'running' };
  assert.equal(stagingApps.isSample(sample), true);
  for (const change of [{ created_by: 1 }, { slug: 'real-app' }, { self_hosted: true },
    { repo_url: 'https://github.com/example/app' }, { container_id: 'live-app' },
    { runtime_name: 'live-app' }, { status: 'error' }]) {
    assert.equal(stagingApps.isSample({ ...sample, ...change }), false);
  }
});

test('Preview lists and actions share persisted identities, with private viewer isolation (PostgreSQL)', async t => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await admin.connect(); }
  catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`Local test database unavailable: ${err.code}`);
  }
  const name = `reconcile_${crypto.randomBytes(6).toString('hex')}`;
  let pool, server;
  const closed = [];
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('connect', client => closed.push(new Promise(resolve => client.once('end', resolve))));
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    const viewers = (await pool.query(
      "INSERT INTO users (username, password) VALUES ('viewer-one', 'unused'), ('viewer-two', 'unused') RETURNING id, username")).rows;
    await pool.query("INSERT INTO users (id, username, password) VALUES (900001, 'staging-demo-user', 'staging-demo-not-a-login')");
    const launcherSlugs = ['staging-demo-pixel-racer', 'staging-demo-puzzle-chain', 'staging-demo-word-garden'];
    for (const slug of launcherSlugs) await pool.query(
      "INSERT INTO apps (name, slug, status, view_visibility, created_by) VALUES ($1, $1, 'running', 'public', 900001)", [slug]);
    await seedStagingGeneralChannel(pool);
    await stagingApps.seedCatalog(pool, { adminUsername: viewers[0].username });
    // Concurrent first loads must create one set, not duplicate private rooms.
    const [first, same, second] = await Promise.all([
      stagingMessages.ensureFixtures(pool, viewers[0]), stagingMessages.ensureFixtures(pool, viewers[0]),
      stagingMessages.ensureFixtures(pool, viewers[1]),
    ]);
    assert.deepEqual(first, same);
    assert.notEqual(first.get(910002), second.get(910002));
    assert.equal(first.get(910004), second.get(910004), '#general really is shared');
    const web = express(); web.use(express.json());
    web.use((req, _res, next) => { req.user = viewers[req.get('x-test-viewer') === '2' ? 1 : 0]; next(); });
    web.use(moderationGuard({}, { pool }));
    web.use(conversationRoutes({}, { pool }));
    web.use(moderationRoutes({}, { pool }));
    web.use(appRoutes({ selfAppPublicVoting: true }, { pool }));
    server = await new Promise(resolve => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, method = 'GET', data, viewer = 1) => {
      const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', 'x-test-viewer': String(viewer) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
      const body = await response.text();
      return { status: response.status, body: body.startsWith('{') ? JSON.parse(body) : body, headers: response.headers };
    };
    const list = await api('/api/conversations?demo=1');
    assert.equal(list.status, 200);
    for (const conversation of list.body.conversations) {
      assert.equal((await pool.query('SELECT id FROM conversations WHERE id = $1', [conversation.id])).rowCount, 1);
    }
    const group = first.get(910002);
    const legacy = await api('/api/conversations/910002?demo=1');
    assert.equal(legacy.body.conversation.id, group);
    assert.equal(legacy.body.conversation.title, 'Launch crew');
    const transcript = await api(`/api/conversations/${group}/messages?demo=1`);
    assert.equal(transcript.status, 200);
    const message = transcript.body.messages[0];
    assert.equal(message.content, 'I attached the launch checklist.');
    assert.equal(message.attachments.length, 2);
    for (const attachment of message.attachments) {
      const download = await api(attachment.url);
      assert.equal(download.status, 200);
      if (attachment.kind === 'image') assert.match(download.headers.get('content-disposition'), /%E2%80%AFPM/);
      assert.equal((await api(attachment.url, 'GET', null, 2)).status, 404, 'another demo viewer cannot read private attachments');
    }
    assert.equal((await api(`/api/conversations/${group}/messages`, 'GET', null, 2)).status, 404);
    assert.equal((await api('/api/reports', 'POST', { targetType: 'conversation_message', target: message.id, reason: 'spam' }, 2)).status, 404);
    const report = await api('/api/reports', 'POST', {
      targetType: 'conversation_message', target: message.id, reason: 'spam', detail: 'First line\n\nSecond line.',
    });
    assert.equal(report.status, 202, JSON.stringify(report.body));
    assert.equal(report.body.blockUserId, message.sender.id);
    const savedReport = (await pool.query('SELECT detail, evidence FROM moderation_reports WHERE id = $1', [report.body.id])).rows[0];
    assert.equal(savedReport.evidence.content, message.content);
    assert.equal(savedReport.detail, 'First line\n\nSecond line.');
    assert.equal((await pool.query('SELECT * FROM moderation_report_files WHERE report_id = $1', [report.body.id])).rowCount, 2);
    const sent = await api(`/api/conversations/${group}/messages?demo=1`, 'POST', { content: 'A real newly sent message' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.message.content, 'A real newly sent message');
    assert.equal(sent.body.message.sender.id, viewers[0].id);
    assert.notEqual(sent.body.message.id, message.id);
    assert.equal((await api(`/api/conversations/${group}/messages/${sent.body.message.id}?demo=1`, 'PATCH', { content: 'Edited and persisted' })).status, 200);
    assert.equal((await api(`/api/conversations/${group}/messages/${message.id}/bookmark?demo=1`, 'PUT')).status, 200);
    assert.equal((await api(`/api/conversations/${group}/messages/${message.id}/reactions?demo=1`, 'POST', { emoji: '👍' })).status, 200);
    assert.equal((await api(`/api/conversations/${group}/read?demo=1`, 'POST', { message_id: sent.body.message.id })).status, 200);
    const refreshed = await api(`/api/conversations/${group}/messages`);
    assert.equal(refreshed.body.messages.at(-1).content, 'Edited and persisted');
    assert.equal(refreshed.body.messages[0].saved, true);
    assert.equal(refreshed.body.messages[0].reactions[0].reacted, true);
    const invite = first.get(910003);
    assert.equal((await api(`/api/conversations/${invite}/messages`)).status, 404, 'invites do not grant history access');
    assert.equal((await api(`/api/conversations/${invite}/respond`, 'POST', { action: 'accept' })).status, 200);
    assert.equal((await api(`/api/conversations/${group}/leave`, 'POST')).status, 200);
    await stagingMessages.ensureFixtures(pool, viewers[0]);
    assert.equal((await api(`/api/conversations/${group}`)).status, 404, 'loading fixtures does not undo leaving');

    const catalog = await api('/api/apps?demo=1&curation=1');
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.apps.length, stagingApps.catalogFixtures(true).length + launcherSlugs.length);
    for (const app of catalog.body.apps) {
      const detail = await api(`/api/apps/${app.slug}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.app.id, app.id, 'list and detail must identify the same app');
      assert.equal(app.demo, undefined, 'persisted apps use normal UI actions');
      assert.equal(app.url, detail.body.app.url);
      assert.equal(app.url, null, 'a sample never points at a nonexistent runtime');
      assert.equal(detail.body.app.staging_sample, true);

    }
    const launcherApps = [...launcherSlugs, 'staging-demo-long-name'];
    for (const slug of launcherApps) {
      assert.equal(catalog.body.apps.find(app => app.slug === slug).is_favorited, true,
        'launcher samples are backed by actual favorites');
      assert.equal((await api(`/api/apps/${slug}/favorite`, 'POST', { favorited: false })).status, 200);
    }
    assert.ok(catalog.body.apps.some(app => app.featured && !app.is_favorited), 'Discover retains featured samples');
    assert.ok(catalog.body.apps.some(app => Number(app.active_users) > 0 && !app.featured && !app.is_favorited),
      'Discover retains popular samples');
    const sample = catalog.body.apps.find(app => app.slug === 'staging-demo-emoji-icon');
    const appReport = await api('/api/reports', 'POST', { targetType: 'app', target: sample.slug, reason: 'spam' });
    assert.equal(appReport.status, 202, JSON.stringify(appReport.body));
    assert.equal(appReport.body.blockAppSlug, sample.slug);
    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [viewers[0].id, sample.id]);
    await stagingApps.seedCatalog(pool, { adminUsername: viewers[0].username });
    const afterRestart = (await api('/api/apps?demo=1')).body.apps;
    for (const slug of launcherApps) assert.equal(afterRestart.find(app => app.slug === slug).is_favorited, false,
      'restarting Preview must not undo removing an app');
    const blocked = await api(`/api/apps/${sample.slug}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'app_blocked');
    assert.ok(!(await api('/api/apps?demo=1')).body.apps.some(app => app.id === sample.id), 'fixture injection cannot resurrect a blocked app');
    assert.equal((await api('/api/apps/staging-demo-unknown')).status, 404);
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (pool) { await pool.end(); await Promise.all(closed); }
    await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
  }
});
