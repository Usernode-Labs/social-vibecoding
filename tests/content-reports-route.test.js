'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const state = { apps: [], messages: [], appReports: [], messageReports: [], calls: [] };
const users = {
  reporter: { id: 10, username: 'reporter' },
  creator: { id: 20, username: 'creator' },
  viewer: { id: 30, username: 'viewer', isAdmin: true, canAdminWrite: false },
  admin: { id: 40, username: 'admin', isAdmin: true, canAdminWrite: true },
};

const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    state.calls.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    if (/FROM apps WHERE slug = \$1/.test(text)) {
      return { rows: state.apps.filter((app) => app.slug === params[0]) };
    }
    if (/INSERT INTO app_reports/.test(text)) {
      if (!state.appReports.some((r) => r.app_id === params[0]
          && r.reporter_user_id === params[1] && r.status === 'pending')) {
        state.appReports.push({ id: state.appReports.length + 1, app_id: params[0],
          reporter_user_id: params[1], app_slug_snapshot: params[2],
          app_name_snapshot: params[3], reason: params[4], detail: params[5],
          status: 'pending', created_at: new Date().toISOString() });
      }
      return { rows: [] };
    }
    if (/FROM chat_messages WHERE id = \$1 AND app_id = \$2/.test(text)) {
      return { rows: state.messages.filter((m) => m.id === params[0] && m.app_id === params[1]) };
    }
    if (/FROM chat_message_attachments WHERE message_id/.test(text)) {
      return { rows: [{ id: 'a'.repeat(32), kind: 'image', filename: 'evidence.png',
        content_type: 'image/png', size_bytes: 42 }] };
    }
    if (/INSERT INTO chat_message_reports/.test(text)) {
      if (!state.messageReports.some((r) => r.message_id === params[1]
          && r.reporter_user_id === params[2] && r.status === 'pending')) {
        state.messageReports.push({ id: state.messageReports.length + 1,
          app_id: params[0], message_id: params[1], reporter_user_id: params[2],
          reported_user_id: params[3], app_slug_snapshot: params[4],
          reason: params[5], detail: params[6], content_snapshot: params[7],
          evidence_snapshot: JSON.parse(params[8]), status: 'pending',
          created_at: new Date().toISOString() });
      }
      return { rows: [] };
    }
    if (/FROM app_reports r/.test(text)) {
      return { rows: state.appReports.filter((r) => r.status === params[0]) };
    }
    if (/FROM chat_message_reports r/.test(text)) {
      return { rows: state.messageReports.filter((r) => r.status === params[0]) };
    }
    if (/UPDATE (app_reports|chat_message_reports)\s+SET status/.test(text)) {
      const target = text.includes('UPDATE app_reports') ? state.appReports : state.messageReports;
      const row = target.find((r) => r.id === params[2] && r.status === 'pending');
      if (!row) return { rows: [] };
      row.status = params[0]; row.resolved_by = params[1];
      row.resolved_at = new Date().toISOString();
      return { rows: [{ id: row.id, status: row.status, resolved_at: row.resolved_at }] };
    }
    throw new Error(`Unexpected SQL: ${text.slice(0, 100)}`);
  },
  async connect() { return { query: (...args) => pool.query(...args), release() {} }; },
};

const poolModule = require('../src/db/pool');
poolModule.getPool = () => pool;
const limits = require('../src/middleware/rate-limits');
limits.contentReportLimiter = (_req, _res, next) => next();
const { contentReportRoutes } = require('../src/routes/content-reports');

async function withServer(fn) {
  state.apps = [{ id: 1, slug: 'sample', name: 'Sample', created_by: 20,
    view_visibility: 'public', self_hosted: false }];
  state.messages = [{ id: 9, app_id: 1, user_id: 20, content: 'Original post',
    msg_type: 'message', metadata: { quote: { refMsgId: 2 } },
    thread_type: 'issue', thread_ref: 2721, created_at: '2026-09-23T00:00:00Z',
    edited_at: null, posted_via: null }];
  state.appReports = []; state.messageReports = []; state.calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-test-user')]; next(); });
  app.use(contentReportRoutes({}));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  const request = async (path, user, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'x-test-user': user || '', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await fn(request); } finally { server.close(); }
}

test('a viewer can report a mini-app once; the creator cannot report their own', async () => {
  await withServer(async (request) => {
    const path = '/api/apps/sample/report';
    assert.equal((await request(path, 'reporter', { reason: 'spam', detail: 'Deceptive copy' })).status, 202);
    assert.equal((await request(path, 'reporter', { reason: 'other' })).status, 202);
    assert.equal(state.appReports.length, 1);
    assert.equal(state.appReports[0].app_name_snapshot, 'Sample');
    assert.equal((await request(path, 'creator', { reason: 'other' })).status, 400);
    assert.equal((await request(path, 'reporter', { reason: 'invalid' })).status, 400);
    assert.equal((await request('/api/apps/missing/report', 'reporter', { reason: 'spam' })).status, 404);
  });
});

test('a Workshop post report retains the original text, thread, and attachment metadata', async () => {
  await withServer(async (request) => {
    const path = '/api/apps/sample/messages/9/report';
    assert.equal((await request(path, 'reporter', { reason: 'harassment' })).status, 202);
    state.messages[0].content = 'Edited later';
    assert.equal((await request(path, 'reporter', { reason: 'spam' })).status, 202);
    assert.equal(state.messageReports.length, 1);
    assert.equal(state.messageReports[0].content_snapshot, 'Original post');
    assert.equal(state.messageReports[0].evidence_snapshot.threadRef, 2721);
    assert.equal(state.messageReports[0].evidence_snapshot.attachments[0].name, 'evidence.png');
    assert.equal((await request(path, 'creator', { reason: 'spam' })).status, 404);
    assert.equal((await request('/api/apps/sample/messages/10/report', 'reporter', { reason: 'spam' })).status, 404);
  });
});

test('only admins see report queues; only write admins may resolve or dismiss', async () => {
  await withServer(async (request) => {
    await request('/api/apps/sample/report', 'reporter', { reason: 'spam' });
    await request('/api/apps/sample/messages/9/report', 'reporter', { reason: 'hate' });
    assert.equal((await request('/api/admin/app-reports', 'reporter', null, 'GET')).status, 403);
    assert.equal((await request('/api/admin/app-reports', 'viewer', null, 'GET')).body.reports.length, 1);
    assert.equal((await request('/api/admin/app-message-reports', 'viewer', null, 'GET')).body.reports.length, 1);
    assert.equal((await request('/api/admin/app-reports/1/resolve', 'viewer')).status, 403);
    assert.equal((await request('/api/admin/app-reports/1/resolve', 'admin')).body.report.status, 'resolved');
    assert.equal((await request('/api/admin/app-message-reports/1/dismiss', 'admin')).body.report.status, 'dismissed');
    assert.equal((await request('/api/admin/app-reports', 'admin', null, 'GET')).body.reports.length, 0);
    assert.equal((await request('/api/admin/app-reports?status=resolved', 'admin', null, 'GET')).body.reports.length, 1);
  });
});
