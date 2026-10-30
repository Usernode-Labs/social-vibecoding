'use strict';

// "Share usage analytics" (#5097): off for every account until switched on in
// Settings > Privacy, kept on the server, and enforced there: an opted-out
// account's usage events are dropped whatever the browser sends.

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

// A users table of one column, as the service reads and writes it.
function usersPool(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([id, on]) => [Number(id), on]));
  const calls = [];
  return {
    rows,
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/SELECT usage_analytics FROM users WHERE id = \$1/.test(text)) {
        return { rows: rows.has(params[0]) ? [{ usage_analytics: rows.get(params[0]) }] : [] };
      }
      if (/UPDATE users SET usage_analytics = \$1 WHERE id = \$2/.test(text)) {
        if (!rows.has(params[1])) return { rows: [], rowCount: 0 };
        rows.set(params[1], params[0]);
        return { rows: [{ usage_analytics: params[0] }], rowCount: 1 };
      }
      // platform_settings (the Journey left-out list): nobody objected.
      return { rows: [], rowCount: 0 };
    },
    async connect() { throw new Error('nothing may be stored'); },
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

test('the column is off by default for existing and new accounts, added idempotently', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_analytics BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.equal((schema.match(/usage_analytics BOOLEAN/g) || []).length, 1, 'declared once');
});

test('the service answers yes only for an explicit TRUE, and no when unreadable', async () => {
  const pool = usersPool({ 1: true, 2: false });
  assert.equal(await usageAnalytics.sharesUsageAnalytics(pool, 1), true);
  assert.equal(await usageAnalytics.sharesUsageAnalytics(pool, 2), false);
  assert.equal(await usageAnalytics.sharesUsageAnalytics(pool, 3), false, 'no such account');
  assert.equal(await usageAnalytics.sharesUsageAnalytics(pool, null), false, 'signed out');
  assert.equal(await usageAnalytics.sharesUsageAnalytics({ async query() { throw new Error('down'); } }, 1), false,
    'a failed read never records anybody');
  assert.equal(await usageAnalytics.setUsageAnalytics(pool, 2, true), true);
  assert.equal(pool.rows.get(2), true);
  assert.equal(await usageAnalytics.setUsageAnalytics(pool, 9, true), null, 'no such account');
});

test('UI telemetry is recordable only for somebody who switched it on', async () => {
  const person = (id) => ({ id, username: `person-${id}` });
  const pool = usersPool({ 1: true, 2: false });
  assert.equal(await telemetry.isRecordable(pool, person(1)), true);
  assert.equal(await telemetry.isRecordable(pool, person(2)), false, 'off: not recorded');
  assert.equal(await telemetry.isRecordable(pool, null), false, 'signed out: not recorded');
  assert.equal(await telemetry.isRecordable(usersPool({ 3: true }), { id: 3, username: 'usernode-capture' }), false,
    'a service account stays out whatever its row says');

  // A server-side failure note is dropped too.
  const off = usersPool({ 2: false });
  await telemetry.recordServerFailure(off, { user: person(2), get() { return null; } },
    { screen: 'report_dialog', action: 'content_report_submit', status: 500, message: 'x' });
  assert.equal(off.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false);
});

test('the collector drops a batch from somebody who has it off, whatever was sent', async () => {
  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const pool = usersPool({ 2: false });
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

test('GET and PUT /api/me/usage-analytics: off by default, and the choice persists', async (t) => {
  const pool = usersPool({ 5: false });
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
    assert.deepEqual(await get(), { enabled: false, uiTelemetryEligible: false }, 'off by default');

    const on = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { ok: true, enabled: true, uiTelemetryEligible: true });
    assert.deepEqual(await get(), { enabled: true, uiTelemetryEligible: true }, 'kept on the server');

    const off = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await off.json(), { ok: true, enabled: false, uiTelemetryEligible: false });
    assert.equal(pool.rows.get(5), false);

    const bad = await fetch(`${base}/api/me/usage-analytics`, { method: 'PUT', headers, body: JSON.stringify({ enabled: 'yes' }) });
    assert.equal(bad.status, 400);
  });
  await serve(authRoutes({ jwtSecret: 'test-secret' }), null, async (base) => {
    assert.equal((await fetch(`${base}/api/me/usage-analytics`)).status, 401, 'signed out');
  });
});

test('Settings > Privacy carries the switch, off until the saved choice is read', () => {
  // #5097 + #5104: one Privacy page. The switch is its last block, under who
  // can reach you and who can find you.
  const html = renderComponent('frontend/src/features/settings/sections/privacy.tsx', 'PrivacySection', {});
  assert.match(html, /data-settings-section="contact-privacy"/);
  assert.match(html, /id="settings-contact-privacy-section"[\s\S]*id="settings-usage-analytics-section"/,
    'after the contact settings');
  assert.match(html, /<input[^>]*id="settings-usage-analytics"/);
  assert.doesNotMatch(html, /<input[^>]*id="settings-usage-analytics"[^>]*checked=""/, 'the first render is off');
  assert.match(html, /<input[^>]*id="settings-usage-analytics"[^>]*disabled=""|<input[^>]*disabled=""[^>]*id="settings-usage-analytics"/,
    'and waits for the server');
  assert.ok(html.includes(message('settings:privacy.usageAnalytics.label')));
  // #5926: the first line says what is true now (off, in the first
  // render); what is recorded and what never is follow, each a short
  // heading over a bulleted list (item 4), in the switch's description.
  const enc = (id) => message(`settings:privacy.usageAnalytics.${id}`).replace(/'/g, '&#x27;');
  assert.ok(html.includes(enc('stateOff')), 'with the off line');
  assert.ok(!html.includes(enc('stateOn')), 'not the on line while the switch is off');
  const description = html.slice(html.indexOf('id="settings-usage-analytics-description"'));
  const lists = [
    ['records.title', ['records.screens', 'records.apps', 'records.loadTimes', 'records.actions']],
    ['neverRecords.title', ['neverRecords.typing', 'neverRecords.screen']],
  ];
  let from = 0;
  for (const [title, items] of lists) {
    const list = `<p>${enc(title)}</p><ul class="mt-0.5 list-disc pl-5">${items.map((id) => `<li>${enc(id)}</li>`).join('')}</ul>`;
    const at = description.indexOf(list, from);
    assert.ok(at > 0, `${title}: a heading over one bullet per item, in order`);
    from = at + list.length;
  }
  // The same things the one paragraph said, and nothing more.
  assert.equal(message('settings:privacy.usageAnalytics.records.title'), "When it's on, we record:");
  assert.deepEqual(lists[0][1].map((id) => message(`settings:privacy.usageAnalytics.${id}`)), [
    'The screens you open, and in what order',
    'Which apps you open',
    'How long pages take to load',
    'Whether a few actions worked',
  ]);
  assert.equal(message('settings:privacy.usageAnalytics.neverRecords.title'), 'We never record:');
  assert.deepEqual(lists[1][1].map((id) => message(`settings:privacy.usageAnalytics.${id}`)), [
    'What you type',
    'What is on screen',
  ]);

  const pane = read('frontend/src/features/settings/sections/usage-analytics.tsx');
  assert.match(pane, /detail\?\.section === 'contact-privacy'\) void load\(\);/, 'read again when the page opens');
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
