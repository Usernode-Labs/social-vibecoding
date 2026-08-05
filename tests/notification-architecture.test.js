'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_KINDS, MAX_TTL_MS } = require('../src/services/mobile-push-policy');
const { retryDelayMs } = require('../src/services/mobile-push-worker');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ADR = read('NOTIFICATIONS-ARCHITECTURE.md');
const README = read('README.md');
const SCHEMA = read('src/db/schema.sql');
const SERVICE = read('src/services/notifications.js');
const ROUTE = read('src/routes/notifications.js');
const WS = read('src/services/ws.js');
const APP = read('public/js/app.js');
const CLIENT = read('public/js/notifications.js');
const ALERTS = read('public/js/dev-alerts.js');
const WORKER = read('src/services/mobile-push-worker.js');

const KINDS = [
  'mention',
  'reply',
  'reaction',
  'kudos',
  'stale_pr',
  'check_failed',
  'pr_proposed',
  'session_done',
  'auto_solve_done',
  'spec_shared',
  'collab_invite',
  'collab_invite_accepted',
  'approver_invite',
  'approver_invite_accepted',
];

test('the ADR inventories every current persisted kind and client renderer', () => {
  assert.match(README, /NOTIFICATIONS-ARCHITECTURE\.md/);
  assert.match(
    ADR,
    new RegExp('notification-kinds: ' + KINDS.join(',')),
    'machine-checked kind marker remains the reviewed inventory'
  );
  for (const kind of KINDS) {
    assert.match(
      SERVICE + SCHEMA,
      new RegExp("'" + kind + "'"),
      'backend documents or produces ' + kind
    );
    assert.match(
      CLIENT,
      new RegExp("'" + kind + "'"),
      'client has rendering/routing coverage for ' + kind
    );
  }
});

test('PostgreSQL is canonical and the HTTP feed is user-scoped keyset reconciliation', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS notifications\s*\(/);
  assert.match(SCHEMA, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(SCHEMA, /read_at\s+TIMESTAMPTZ/);
  assert.match(SERVICE, /WHERE n\.user_id = \$1[\s\S]*ORDER BY n\.created_at DESC, n\.id DESC/);
  assert.match(SERVICE, /\(n\.created_at, n\.id\) < \(\$2, \$3\)/);
  assert.match(ROUTE, /router\.get\('\/api\/notifications'[\s\S]*if \(!req\.user\).*401/);
  assert.match(ROUTE, /Math\.min\(Math\.max\(Math\.trunc\(rawLimit\), 1\), 100\)/);
  assert.match(CLIENT, /if \(window\.App && App\.user\) Notifications\.refresh\(\)/);
  assert.match(APP, /if \(isReconnect\) App\.resyncCurrentView\(\)/);
  assert.match(APP, /resyncCurrentView\(\)[\s\S]*Notifications\.refresh\?\.\(\)/);
});

test('WebSocket notification delivery remains a per-process acceleration layer', () => {
  assert.match(WS, /const globalClients = new Set\(\)/);
  assert.match(
    WS,
    /function pushNotificationToUser\(userId, payload\)[\s\S]*for \(const client of globalClients\)/
  );
  assert.match(APP, /case 'notification_new':[\s\S]*Notifications\.handleIncoming/);
  assert.match(APP, /case 'notifications_changed':[\s\S]*Notifications\.refresh/);
  assert.match(
    ADR,
    /There is no acknowledgement,\s*retry, persisted WebSocket cursor, or cross-process broker/
  );
  assert.match(ADR, /single Social application\s+process/);
});

test('browser completion alerts are local presentation, not web push', () => {
  assert.match(ALERTS, /There is intentionally no service worker \/ web-push/);
  assert.match(ALERTS, /document\.visibilityState === 'hidden'/);
  assert.match(ALERTS, /new Notification\(title, \{ body, tag \}\)/);
  assert.match(ADR, /A closed browser cannot/i);
});

test('native mobile is the only durable channel outbox and has a two-kind allowlist', () => {
  assert.deepEqual([...ALLOWED_KINDS].sort(), ['auto_solve_done', 'session_done']);
  assert.equal(MAX_TTL_MS, 24 * 60 * 60 * 1000);
  assert.match(
    SCHEMA,
    /CREATE TRIGGER notifications_enqueue_mobile_push_deliveries[\s\S]*AFTER INSERT ON notifications/
  );
  assert.match(SCHEMA, /NEW\.kind NOT IN \('session_done', 'auto_solve_done'\)/);
  assert.match(SCHEMA, /UNIQUE \(notification_id, environment, installation_id\)/);
  assert.match(SCHEMA, /INTERVAL '24 hours'/);
  assert.match(WORKER, /batchSize: 20/);
  assert.match(WORKER, /pollMs: 5000/);
  assert.match(WORKER, /retentionDays: 30/);
  assert.equal(retryDelayMs(1, 5000, 60 * 60 * 1000), 5000);
  assert.equal(retryDelayMs(50, 5000, 60 * 60 * 1000), 60 * 60 * 1000);
});

test('the contract exposes single-worker recovery and canonical-retention limits', () => {
  assert.match(
    WORKER,
    /Passes do not overlap[\s\S]*failed prior pass/
  );
  assert.match(
    WORKER,
    /WHERE status = 'sending'\s+OR \(status = 'pending' AND expires_at <= NOW\(\)\)/
  );
  assert.match(
    ADR,
    /a second active worker could reset work the first is\s+currently sending/
  );
  assert.match(ADR, /Canonical rows have no age-based retention job/);
  assert.match(ADR, /There is no general archive or user-delete-notification API/);
});

test('the contract does not overclaim reliability and records #498 as a dependency', () => {
  for (const required of [
    /does not\s+guarantee that every successful domain event creates a row/,
    /Provider delivery is not exactly once/,
    /No latency, throughput, availability, or queue-depth SLO/,
    /issue #498/,
    /session 3034/,
    /ready, unpromoted/,
    /#497 does not duplicate\s+those edits/,
  ]) {
    assert.match(ADR, required);
  }
  assert.match(ADR, /preferences, quiet hours, digests/);
  assert.match(ADR, /server-side browser push, email, SMS, or\s+webhook delivery/);
});
