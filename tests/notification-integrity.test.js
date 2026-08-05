// Notification platform integrity regressions (#498).
//
// These tests pin the three boundaries fixed by the issue:
//   * every read/live hydration path uses the same current-access predicate;
//   * database uniqueness, not a racy pre-read alone, enforces deduplication;
//   * duplicate WS delivery is side-effect idempotent in the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifications = require('../src/services/notifications');

const ROOT = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const SERVICE = fs.readFileSync(path.join(ROOT, 'src/services/notifications.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public/js/notifications.js'), 'utf8');
const MOBILE_WORKER = fs.readFileSync(path.join(ROOT, 'src/services/mobile-push-worker.js'), 'utf8');

function compactSql(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

test('list, exact lookup, unread count, and live hydration share current app access', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(compactSql(sql));
      if (/COUNT\(\*\)::int AS c/.test(sql)) return { rows: [{ c: 0 }] };
      return { rows: [] };
    },
  };

  await notifications.listForUser(pool, 7, { limit: 25 });
  await notifications.getForUser(pool, 7, 99);
  await notifications.countUnread(pool, 7);
  await notifications.hydrateAndPush(pool, { id: 99, user_id: 7 });

  assert.equal(calls.length, 4);
  const predicate = compactSql(notifications.NOTIFICATION_ACCESS_SQL);
  for (const sql of calls) {
    assert.match(sql, new RegExp(predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(predicate, /notification_app\.collab_visibility = 'public'/);
  assert.match(predicate, /notification_viewer\.is_admin = TRUE/);
  assert.match(predicate, /notification_member\.status = 'member'/);
  assert.match(predicate, /'collab_invite', 'approver_invite', 'spec_shared'/,
    'invites and explicit spec shares remain intentional disclosures');
});

test('every backend notification_new fanout goes through authorized hydration', () => {
  const files = [
    'src/services/ws.js',
    'src/services/rename-pr.js',
    'src/services/fleet-maintenance.js',
    'src/routes/votes.js',
    'src/routes/kudos.js',
    'src/routes/collaborators.js',
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /type:\s*'notification_new'/,
      `${relative} must not bypass notifications.hydrateAndPush`);
    assert.match(source, /notifications\.hydrateAndPush/,
      `${relative} routes fresh delivery through the access-checked hydrator`);
  }
  assert.match(SERVICE, /type:\s*'notification_new'/,
    'the centralized notification service remains the sole fanout owner');
});

test('mobile opaque-id delivery cancels when current private-app access was revoked', () => {
  assert.match(MOBILE_WORKER, /NOTIFICATION_ACCESS_SQL/);
  assert.match(MOBILE_WORKER, /notification_accessible/);
  assert.match(MOBILE_WORKER, /return 'app_access_revoked'/);
});

test('schema cleans legacy duplicates before enforcing both dedup contracts', () => {
  assert.match(SCHEMA, /ranked_unread_session_notifications/);
  assert.match(SCHEMA, /ranked_pr_proposed_notifications/);
  assert.match(SCHEMA,
    /CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_unread_session_kind[\s\S]*?user_id, session_id, kind[\s\S]*?read_at IS NULL[\s\S]*?session_done[\s\S]*?auto_solve_done[\s\S]*?check_failed/);
  assert.match(SCHEMA,
    /CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_pr_proposed_once[\s\S]*?user_id, session_id[\s\S]*?kind = 'pr_proposed'/);
});

test('all race-sensitive notification inserts tolerate a concurrent unique-index loser', () => {
  const producers = {
    check_failed: 'createCheckFailedNotification',
    session_done: 'createSessionDoneNotification',
    auto_solve_done: 'createAutoSolveDoneNotification',
    pr_proposed: 'createPrProposedNotifications',
  };
  for (const [kind, functionName] of Object.entries(producers)) {
    const start = SERVICE.indexOf(`async function ${functionName}`);
    assert.notEqual(start, -1, `${kind} producer exists`);
    const next = SERVICE.indexOf('\nasync function ', start + 1);
    const block = SERVICE.slice(start, next < 0 ? SERVICE.length : next);
    assert.match(block, /INSERT INTO notifications/, `${kind} insert block found`);
    assert.match(block, /ON CONFLICT DO NOTHING/,
      `${kind} handles the database-enforced dedup race`);
  }
});

function handleIncomingBody() {
  const match = CLIENT.match(/handleIncoming\(notif\) \{([\s\S]*?)\n  \},\n\n  toggle\(\)/);
  assert.ok(match, 'shipped handleIncoming body found');
  return match[1];
}

function runIncoming(store, notif, effects) {
  const DevChat = {
    _userIsAway: () => true,
    setCompletionTitle: () => { effects.titles += 1; },
  };
  const DevAlerts = {
    onCompletion: () => { effects.alerts += 1; },
  };
  const window = { DevChat, DevAlerts };
  const fn = new Function(
    'Notifications', 'window', 'DevChat', 'DevAlerts', 'completionAlertInfo', 'notif',
    handleIncomingBody()
  );
  fn(store, window, DevChat, DevAlerts, (n) => n, notif);
}

test('duplicate browser delivery refreshes the row without unread or alert side effects', () => {
  const effects = { titles: 0, alerts: 0, badges: 0, lists: 0 };
  const store = {
    items: [{ id: 10, kind: 'session_done', readAt: null, detail: null }],
    unread: 1,
    open: true,
    _renderBadge: () => { effects.badges += 1; },
    _renderList: () => { effects.lists += 1; },
    refresh() {},
  };

  runIncoming(store, { id: 10, kind: 'session_done', readAt: null, detail: null }, effects);

  assert.equal(store.items.length, 1);
  assert.equal(store.unread, 1);
  assert.equal(effects.titles, 0);
  assert.equal(effects.alerts, 0);
  assert.equal(effects.badges, 1, 'the refreshed row still repaints');
  assert.equal(effects.lists, 1);
});

test('a genuinely new unread completion keeps the existing badge and alert flow', () => {
  const effects = { titles: 0, alerts: 0, badges: 0, lists: 0 };
  const store = {
    items: [], unread: 0, open: true,
    _renderBadge: () => { effects.badges += 1; },
    _renderList: () => { effects.lists += 1; },
    refresh() {},
  };

  runIncoming(store, { id: 11, kind: 'session_done', readAt: null, detail: null }, effects);

  assert.equal(store.items.length, 1);
  assert.equal(store.unread, 1);
  assert.equal(effects.titles, 1);
  assert.equal(effects.alerts, 1);
});
