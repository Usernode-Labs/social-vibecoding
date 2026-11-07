'use strict';

// Usage analytics and Leave me out (Settings > Privacy). Screen usage data is
// recorded for every account unless the person leaves themselves out, which
// also erases what was recorded. It is kept on the server and enforced there:
// a left-out account's usage events are dropped whatever the browser sends.
// Before, #5593 made the same set opt-in ("Share usage analytics").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const usageAnalytics = require('../src/services/usage-analytics');
const telemetry = require('../src/services/ui-telemetry');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const html = (text) => text.replace(/'/g, '&#x27;');

// A users table of one column (id → usage_left_out_at, null for recorded),
// and the events the service erases, as the service reads and writes them.
function usersPool(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([id, at]) => [Number(id), at]));
  const erased = [];
  const calls = [];
  async function query(sql, params = []) {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT usage_left_out_at FROM users WHERE id = \$1/.test(text)) {
      return { rows: rows.has(params[0]) ? [{ usage_left_out_at: rows.get(params[0]) }] : [] };
    }
    if (/SELECT id FROM users WHERE usage_left_out_at IS NOT NULL/.test(text)) {
      return { rows: [...rows].filter(([, at]) => at != null).map(([id]) => ({ id })) };
    }
    if (/UPDATE users\s+SET usage_left_out_at = CASE/.test(text)) {
      const [id, leave] = params;
      if (!rows.has(id)) return { rows: [], rowCount: 0 };
      const next = leave ? (rows.get(id) || new Date('2026-11-07T15:00:00Z')) : null;
      rows.set(id, next);
      return { rows: [{ usage_left_out_at: next }], rowCount: 1 };
    }
    if (/DELETE FROM events WHERE user_id = \$1 AND event_type = ANY/.test(text)) {
      erased.push({ userId: params[0], types: params[1] });
      return { rows: [], rowCount: 3 };
    }
    // BEGIN / COMMIT / ROLLBACK, and platform_settings (the Journey left-out
    // list): nobody objected.
    return { rows: [], rowCount: 0 };
  }
  return {
    rows,
    erased,
    calls,
    query,
    async connect() { return { query, release() {} }; },
  };
}

async function serve(router, user, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the column is recorded by default for existing and new accounts, added idempotently', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_left_out_at TIMESTAMPTZ;/);
  assert.equal((schema.match(/usage_left_out_at TIMESTAMPTZ/g) || []).length, 1, 'declared once, with no default');
  assert.match(read('src/services/usage-analytics.js'), /SELECT usage_left_out_at FROM users WHERE id = \$1/);
  assert.doesNotMatch(read('src/services/usage-analytics.js'), /SELECT usage_analytics FROM users/,
    "#5593's opt-in column is no longer read");
});

test('the service records everyone but who left themselves out, and nobody when unreadable', async () => {
  const pool = usersPool({ 1: null, 2: new Date('2026-11-01T00:00:00Z') });
  assert.equal(await usageAnalytics.recordsUsage(pool, 1), true, 'recorded by default');
  assert.equal(await usageAnalytics.recordsUsage(pool, 2), false, 'left out');
  assert.equal(await usageAnalytics.recordsUsage(pool, 3), false, 'no such account');
  assert.equal(await usageAnalytics.recordsUsage(pool, null), false, 'signed out');
  assert.equal(await usageAnalytics.recordsUsage({ async query() { throw new Error('down'); } }, 1), false,
    'a failed read never records somebody who may have left themselves out');
  assert.deepEqual(await usageAnalytics.leftOutIds(pool), [2]);
});

test('Leave me out erases the screen usage data already recorded, and including again brings none back', async () => {
  const pool = usersPool({ 1: null });
  const out = await usageAnalytics.setLeftOut(pool, 1, true);
  assert.equal(out.leftOut, true);
  assert.equal(out.leftOutAt, '2026-11-07T15:00:00.000Z');
  assert.deepEqual(pool.erased, [{ userId: 1, types: [...usageAnalytics.SCREEN_USAGE_EVENT_TYPES] }]);
  assert.deepEqual(usageAnalytics.SCREEN_USAGE_EVENT_TYPES, [
    'ui_experience', 'ui_telemetry_delivery', 'first_session_moment',
    'dapp_opened', 'live_build_opened', 'live_build_watched',
  ]);
  const again = await usageAnalytics.setLeftOut(pool, 1, true);
  assert.equal(again.leftOutAt, out.leftOutAt, 'leaving out again keeps the first time');

  const back = await usageAnalytics.setLeftOut(pool, 1, false);
  assert.deepEqual(back, { leftOut: false, leftOutAt: null });
  assert.equal(pool.erased.length, 2, 'including again erases nothing more and restores nothing');
  assert.equal(await usageAnalytics.setLeftOut(pool, 9, true), null, 'no such account');
});

test('UI telemetry is recordable for everyone but who left themselves out', async () => {
  const person = (id) => ({ id, username: `person-${id}` });
  const pool = usersPool({ 1: null, 2: new Date() });
  assert.equal(await telemetry.isRecordable(pool, person(1)), true, 'recorded by default');
  assert.equal(await telemetry.isRecordable(pool, person(2)), false, 'left out: not recorded');
  assert.equal(await telemetry.isRecordable(pool, null), false, 'signed out: not recorded');
  assert.equal(await telemetry.isRecordable(usersPool({ 3: null }), { id: 3, username: 'usernode-capture' }), false,
    'a service account stays out whatever its row says');

  // Google Analytics stops counting a left-out account too.
  assert.equal(await telemetry.countsInGoogleAnalytics(pool, person(1)), true);
  assert.equal(await telemetry.countsInGoogleAnalytics(pool, person(2)), false, 'left out: not counted');

  // A server-side failure note is dropped too.
  const off = usersPool({ 2: new Date() });
  await telemetry.recordServerFailure(off, { user: person(2), get() { return null; } },
    { screen: 'report_dialog', action: 'content_report_submit', status: 500, message: 'x' });
  assert.equal(off.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false);
});

test('the collector drops a batch from somebody who left themselves out, whatever was sent', async () => {
  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const pool = usersPool({ 2: new Date() });
  const now = new Date().toISOString();
  const body = {
    schemaVersion: 2,
    batchId: 'batch-0000000000000001',
    delivery: { failedBatches: 0, droppedEvents: 0 },
    events: [{
      id: 'event-00000000000000001', visitId: 'visit-00000000000000001', kind: 'screen_visit',
      screen: 'home', via: 'own', occurredAt: now, sequence: 1,
    }],
  };
  await serve(uiTelemetryRoutes({}, { pool }), { id: 2, username: 'person-2' }, async (base) => {
    const res = await fetch(`${base}/api/ui-telemetry/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    const answer = await res.json();
    assert.equal(answer.discarded, true);
    assert.equal(answer.accepted, 0);
  });
  assert.equal(pool.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false, 'nothing stored');
});

test('GET and PUT /api/me/usage-analytics: recorded by default, and Leave me out persists', async (t) => {
  const pool = usersPool({ 5: null });
  const dbPool = require('../src/db/pool');
  const realGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;
  t.after(() => { dbPool.getPool = realGetPool; });
  const { authRoutes } = require('../src/routes/auth');
  const router = authRoutes({ jwtSecret: 'test-secret' });
  const user = { id: 5, username: 'person-5' };
  await serve(router, user, async (base) => {
    const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    const get = async () => (await fetch(`${base}/api/me/usage-analytics`)).json();
    assert.deepEqual(await get(), { leftOut: false, leftOutAt: null, uiTelemetryEligible: true, analyticsCounted: true },
      'recorded by default');

    const out = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ leftOut: true }) });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), {
      ok: true, leftOut: true, leftOutAt: '2026-11-07T15:00:00.000Z', uiTelemetryEligible: false, analyticsCounted: false,
    });
    assert.deepEqual(await get(), {
      leftOut: true, leftOutAt: '2026-11-07T15:00:00.000Z', uiTelemetryEligible: false, analyticsCounted: false,
    }, 'kept on the server');
    assert.equal(pool.erased.length, 1, 'what was recorded is erased');

    const back = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ leftOut: false }) });
    assert.deepEqual(await back.json(), { ok: true, leftOut: false, leftOutAt: null, uiTelemetryEligible: true, analyticsCounted: true });
    assert.equal(pool.rows.get(5), null);

    const old = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(old.status, 400, "#5593's enabled is not a Leave me out answer");
  });
  await serve(authRoutes({ jwtSecret: 'test-secret' }), null, async (base) => {
    assert.equal((await fetch(`${base}/api/me/usage-analytics`)).status, 401, 'signed out');
  });
});

test('Settings > Privacy says what is kept and carries Leave me out, off until the saved choice is read', () => {
  // #5097 + #5104: one Privacy page. Usage analytics is its last block, under
  // who can reach you and who can find you.
  const page = renderComponent('frontend/src/features/settings/sections/privacy.tsx', 'PrivacySection', {});
  assert.match(page, /data-settings-section="contact-privacy"/);
  assert.match(page, /id="settings-contact-privacy-section"[\s\S]*id="settings-usage-analytics-section"/,
    'after the contact settings');
  assert.match(page, /<input[^>]*id="settings-usage-analytics"/);
  assert.doesNotMatch(page, /<input[^>]*id="settings-usage-analytics"[^>]*checked=""/, 'the first render is not left out');
  assert.match(page, /<input[^>]*id="settings-usage-analytics"[^>]*disabled=""|<input[^>]*disabled=""[^>]*id="settings-usage-analytics"/,
    'and waits for the server');
  assert.ok(page.includes(message('settings:privacy.usageAnalytics.leaveOut.label')));
  // What is always kept, what is also recorded, what never is, and what
  // Leave me out does and leaves in place.
  for (const id of [
    'intro', 'alwaysKept.title', 'alwaysKept.apps', 'alwaysKept.acts', 'alwaysKept.challenges',
    'alsoRecorded.title', 'alsoRecorded.screens', 'alsoRecorded.speed', 'neverRecorded', 'googleAnalytics',
    'leaveOut.offWhat', 'leaveOut.offStill',
  ]) {
    assert.ok(page.includes(html(message(`settings:privacy.usageAnalytics.${id}`))), `with the ${id} line`);
  }
  assert.ok(!page.includes(html(message('settings:privacy.usageAnalytics.alsoRecorded.titleLeftOut'))),
    'not the left-out heading while not left out');
  assert.match(message('settings:privacy.usageAnalytics.neverRecorded'), /^Never recorded: what you type, or what's on your screen\.$/);
  assert.match(message('settings:privacy.usageAnalytics.googleAnalytics'), /without names or account numbers\.$/);
  assert.doesNotMatch(message('settings:privacy.usageAnalytics.intro'), /unless you turn this on/,
    'nothing claims no record is kept');

  const pane = read('frontend/src/features/settings/sections/usage-analytics.tsx');
  assert.match(pane, /detail\?\.section === 'contact-privacy'\) void load\(\);/, 'read again when the page opens');
  assert.match(pane, /body: JSON\.stringify\(\{ leftOut: next \}\)/);
  const settings = read('frontend/src/features/settings/settings.js');
  assert.doesNotMatch(settings, /key: 'privacy'/, 'no second Privacy row');
  assert.match(settings, /\{ key: 'contact-privacy', label: 'settings:nav\.part\.contactPrivacy'/);
});

test('the client sends usage analytics only on the server\'s explicit yes', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { sharesUsageAnalytics } = loadTsx('frontend/src/lib/usage-analytics.ts');
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1, uiTelemetryEligible: true } } }), true);
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1, uiTelemetryEligible: false } } }), false);
  assert.equal(sharesUsageAnalytics({ App: { user: { id: 1 } } }), false, 'before the server answered');
  assert.equal(sharesUsageAnalytics({ App: { user: null } }), false, 'signed out');
  assert.equal(sharesUsageAnalytics({}), false);
  assert.match(read('frontend/src/features/app-frame/live-band.tsx'), /if \(!sharesUsageAnalytics\(\)\) return;/,
    'watching Live is not sent either');
});
