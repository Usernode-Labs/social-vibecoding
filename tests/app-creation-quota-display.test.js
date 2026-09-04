// Issue #1611: the create flow shows the viewer's current app-slot quota.
//
// The quota is capacity, not a timed allowance: apps with status `error` do
// not consume a slot and deleting an app frees one. The UI therefore reports
// "used of limit" and deliberately does not invent reset copy.
//
// Run with: node --test tests/app-creation-quota-display.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const poolMod = require('../src/db/pool');
let appQuotaUsed = 0;
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM users u/.test(sql)) {
      return { rows: [{ app_quota_used: appQuotaUsed }] };
    }
    return { rows: [] };
  },
});

const { authRoutes } = require('../src/routes/auth');

let server;
let base;
let user;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});

test.beforeEach(() => {
  calls = [];
  appQuotaUsed = 1;
  user = {
    id: 42,
    username: 'quota-user',
    isAdmin: false,
    canAdminWrite: false,
    adminReadonly: false,
    appQuota: 2,
  };
});

async function me() {
  const response = await fetch(`${base}/api/auth/me`);
  assert.equal(response.status, 200);
  return (await response.json()).user;
}

test('/api/auth/me reports used, limit, and remaining app slots', async () => {
  const result = await me();
  assert.deepEqual(result.appCreationQuota, { used: 1, limit: 2, remaining: 1 });
  assert.equal(result.canCreateApps, true);

  const query = calls.find((call) => /AS app_quota_used/.test(call.sql));
  assert.ok(query, 'the auth response must count the viewer\'s apps');
  assert.match(query.sql, /owned_app\.created_by = u\.id/);
  assert.match(query.sql, /owned_app\.status <> 'error'/,
    'usage must match the create/fork gate: errored apps do not consume a slot');
});

test('an exhausted quota reports zero remaining and locks creation', async () => {
  appQuotaUsed = 2;
  const result = await me();
  assert.deepEqual(result.appCreationQuota, { used: 2, limit: 2, remaining: 0 });
  assert.equal(result.canCreateApps, false);
});

test('a zero quota is explicit rather than disappearing behind a boolean', async () => {
  user.appQuota = 0;
  appQuotaUsed = 0;
  const result = await me();
  assert.deepEqual(result.appCreationQuota, { used: 0, limit: 0, remaining: 0 });
  assert.equal(result.canCreateApps, false);
});

test('full admins report usage with no limit, while view-only admins keep their quota', async () => {
  user.isAdmin = true;
  user.canAdminWrite = true;
  user.appQuota = 0;
  appQuotaUsed = 7;
  let result = await me();
  assert.deepEqual(result.appCreationQuota, { used: 7, limit: null, remaining: null });
  assert.equal(result.canCreateApps, true);

  user.canAdminWrite = false;
  user.adminReadonly = true;
  user.appQuota = 2;
  appQuotaUsed = 2;
  result = await me();
  assert.deepEqual(result.appCreationQuota, { used: 2, limit: 2, remaining: 0 });
  assert.equal(result.canCreateApps, false,
    'view-only admins do not bypass the write-route quota');
});

test('the create dialog loads and renders the quota without reset copy', () => {
  const source = read('frontend/src/features/dialogs/create-app.tsx');
  assert.match(source, /fetch\('\/api\/auth\/me'/,
    'opening the dialog refreshes usage instead of relying on a stale boot value');
  assert.match(source, /id="create-app-quota"/);
  assert.match(source, /`\$\{quota\.used\} of \$\{quota\.limit\} app/);
  assert.match(source, /disabled=\{quotaBlocksCreation\}/,
    'the visible at-limit dialog must not offer a submit the server will refuse');
  assert.match(source, /disabledStyle="block"/,
    'the disabled submit must look unavailable, not only reject clicks');

  const quotaCopy = source.slice(
    source.indexOf('function quotaHeadline'),
    source.indexOf('export function CreateAppDialog'),
  );
  assert.doesNotMatch(quotaCopy, /reset/i,
    'app slots have no timed reset, so the quota copy must not claim one');
});

test('locked create entries still open the dialog so the quota is reachable', () => {
  const panel = read('frontend/src/features/home/panels/create.tsx');
  const click = panel.slice(panel.indexOf('onClick={(e) =>'));
  assert.match(click, /App\?\.showCreateModal\?\.\(\)/);
  assert.doesNotMatch(click, /PlatformUI\?\.toast/,
    'a generic toast would hide the exact quota at the moment it matters');

  const switcher = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const start = switcher.indexOf('id="apps-switcher-create"');
  const end = switcher.indexOf('id="apps-switcher-close"', start);
  const createEntry = switcher.slice(start, end);
  assert.match(createEntry, /App\?\.showCreateModal\?\.\(\)/);
  assert.doesNotMatch(createEntry, /Home\?\.canCreate/);
});

test('the finite quota state has a deterministic visual-review path', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((entry) => entry.name.includes('quota and usage (#1611)'));
  assert.ok(check);
  assert.equal(check.path, '/?shot=create-quota#create');
  assert.equal(check.expectText, '1 of 2 app slots used');
});
