'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const state = { appReports: [], messageReports: [] };
const users = {
  reporter: { id: 10, username: 'reporter' },
  viewer: { id: 30, username: 'viewer', isAdmin: true, canAdminWrite: false },
};

const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    if (/FROM app_reports r/.test(text)) {
      return { rows: state.appReports.filter((r) => r.status === params[0]) };
    }
    if (/FROM chat_message_reports r/.test(text)) {
      return { rows: state.messageReports.filter((r) => r.status === params[0]) };
    }
    throw new Error(`Unexpected SQL: ${text.slice(0, 100)}`);
  },
};

const poolModule = require('../src/db/pool');
poolModule.getPool = () => pool;
const { contentReportRoutes } = require('../src/routes/content-reports');

async function withServer(fn) {
  state.appReports = [{ id: 1, app_id: 1, status: 'pending' }, { id: 2, app_id: 1, status: 'resolved' }];
  state.messageReports = [{ id: 1, app_id: 1, message_id: 9, status: 'pending' }];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-test-user')]; next(); });
  app.use(contentReportRoutes({}));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  const request = async (path, user, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'x-test-user': user || '' },
    });
    return { status: response.status };
  };
  const json = async (path, user) => (await fetch(
    `http://127.0.0.1:${server.address().port}${path}`, { headers: { 'x-test-user': user } }
  )).json();
  try { await fn(request, json); } finally { server.close(); }
}

test('only admins see the legacy report queues, filtered by status', async () => {
  await withServer(async (request, json) => {
    assert.equal((await request('/api/admin/app-reports', 'reporter')).status, 403);
    assert.equal((await json('/api/admin/app-reports', 'viewer')).reports.length, 1);
    assert.equal((await json('/api/admin/app-reports?status=resolved', 'viewer')).reports[0].id, 2);
    assert.equal((await json('/api/admin/app-message-reports', 'viewer')).reports.length, 1);
  });
});

// Reporting and deciding on reports belong to routes/moderation.js; this
// router must not register a second handler that would sit behind it.
test('the legacy router no longer handles report submissions or decisions', async () => {
  await withServer(async (request) => {
    for (const path of ['/api/apps/sample/report', '/api/apps/sample/messages/9/report',
      '/api/admin/app-reports/1/resolve', '/api/admin/app-message-reports/1/dismiss']) {
      assert.equal((await request(path, 'viewer', 'POST')).status, 404, path);
    }
  });
});
