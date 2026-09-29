'use strict';

// #2904: the iOS app-icon badge must equal the in-app unread count, and must
// come down when notifications are read anywhere — not only on the phone.
//
// Covers the badge-only payload (buildBadgeMessage), the per-user sync that
// recounts with countUnread and sends it to each live iOS registration
// (MobilePushBadgeSync), and the two hooks that schedule a sync: every
// `notifications_changed` fan-out through ws.pushToUser, and a conversation
// read.
//
// Run with: node --test tests/mobile-push-badge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encrypt } = require('../src/services/secrets');
const { buildBadgeMessage, BADGE_TTL_MS } = require('../src/services/mobile-push-policy');
const { MobilePushBadgeSync } = require('../src/services/mobile-push-badge');
const mobilePush = require('../src/services/mobile-push');

const DATA_KEY = 'mobile-push-badge-test-key';
const CONFIG = {
  mobilePushEnabled: true,
  mobilePushEnvironment: 'production',
  firebaseProjectId: 'social-prod',
  dataEncryptionKey: DATA_KEY,
};

// ── payload ────────────────────────────────────────────────────────────

test('the badge payload carries only the count, with no banner or data', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const message = buildBadgeMessage({ token: 'tok', unreadCount: 0, now });
  assert.deepEqual(message, {
    token: 'tok',
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor((now.getTime() + BADGE_TTL_MS) / 1000)),
      },
      payload: { aps: { badge: 0 } },
    },
  });
  assert.equal('notification' in message, false, 'no visible alert');
  assert.equal('data' in message, false, 'nothing for the shell to route');
  assert.equal('android' in message, false);
});

test('zero is a real badge value — it is what clears the icon', () => {
  assert.equal(buildBadgeMessage({ token: 't', unreadCount: 0 }).apns.payload.aps.badge, 0);
  assert.equal(buildBadgeMessage({ token: 't', unreadCount: 12 }).apns.payload.aps.badge, 12);
});

test('an unusable count or token throws instead of badging garbage', () => {
  assert.throws(() => buildBadgeMessage({ token: 't', unreadCount: -1 }), /badge_count_invalid/);
  assert.throws(() => buildBadgeMessage({ token: 't', unreadCount: 1.5 }), /badge_count_invalid/);
  assert.throws(() => buildBadgeMessage({ token: 't', unreadCount: null }), /badge_count_invalid/);
  assert.throws(() => buildBadgeMessage({ token: '', unreadCount: 1 }), /registration_missing/);
});

// ── count + sync ───────────────────────────────────────────────────────

function harness({
  unread = 0,
  registrations = [{ id: 1, registration_enc: encrypt('ios-token-1', DATA_KEY) }],
  send = async () => 'provider-id',
  provider,
  options = { debounceMs: 5 },
} = {}) {
  const calls = { sent: [], counted: [], registrationQueries: [] };
  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM notifications AS n')) {
        calls.counted.push(params[0]);
        return { rows: [{ c: unread }] };
      }
      if (sql.includes('FROM mobile_push_registrations r')) {
        calls.registrationQueries.push({ sql, params });
        return { rows: registrations };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
  };
  const sync = new MobilePushBadgeSync({
    pool,
    config: CONFIG,
    provider: provider === undefined
      ? { send: async (message) => { calls.sent.push(message); return send(message); } }
      : provider,
    options,
  });
  return { sync, calls };
}

test('the synced badge is the same countUnread total the bell shows', async () => {
  const { sync, calls } = harness({ unread: 0 });
  assert.equal(await sync.syncUser(7), 1);
  assert.deepEqual(calls.counted, [7], 'counted with the in-app unread predicate');
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].token, 'ios-token-1');
  assert.equal(calls.sent[0].apns.payload.aps.badge, 0,
    'zero unread in-app clears the icon — no clamp to 1 like an alert push');
});

test('every live iOS registration gets the fresh count', async () => {
  const { sync, calls } = harness({
    unread: 2,
    registrations: [
      { id: 1, registration_enc: encrypt('phone', DATA_KEY) },
      { id: 2, registration_enc: encrypt('ipad', DATA_KEY) },
    ],
  });
  assert.equal(await sync.syncUser(7), 2);
  assert.deepEqual(calls.sent.map((m) => [m.token, m.apns.payload.aps.badge]),
    [['phone', 2], ['ipad', 2]]);
});

test('registrations are gated like the alert worker: iOS, live, this deployment', async () => {
  const { sync, calls } = harness();
  await sync.syncUser(7);
  const [{ sql, params }] = calls.registrationQueries;
  assert.deepEqual(params, [7, 'production', 'social-prod']);
  assert.match(sql, /r\.platform = 'ios'/);
  assert.match(sql, /r\.session_expires_at > NOW\(\)/);
  assert.match(sql, /permission_status IN \('authorized', 'provisional'\)/);
  assert.match(sql, /state\.send_enabled/);
});

test('no iOS registration means no count query and no send', async () => {
  const { sync, calls } = harness({ registrations: [] });
  assert.equal(await sync.syncUser(7), 0);
  assert.deepEqual(calls.counted, []);
  assert.deepEqual(calls.sent, []);
});

test('an undecryptable registration is skipped and a provider error does not stop the rest', async () => {
  let n = 0;
  const { sync, calls } = harness({
    unread: 1,
    registrations: [
      { id: 1, registration_enc: 'not-ciphertext' },
      { id: 2, registration_enc: encrypt('a', DATA_KEY) },
      { id: 3, registration_enc: encrypt('b', DATA_KEY) },
    ],
    send: async () => {
      n += 1;
      if (n === 1) {
        const err = new Error('gone');
        err.code = 'messaging/registration-token-not-registered';
        throw err;
      }
      return 'ok';
    },
  });
  assert.equal(await sync.syncUser(7), 1);
  assert.deepEqual(calls.sent.map((m) => m.token), ['a', 'b']);
});

test('a burst of changes coalesces into one push with the settled count', async () => {
  const { sync, calls } = harness({ unread: 0 });
  sync.schedule(7);
  sync.schedule(7);
  sync.schedule('7');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.sent.length, 1);
  sync.stop();
});

test('schedule ignores an unusable user id', () => {
  const { sync } = harness();
  assert.equal(sync.schedule(null), false);
  assert.equal(sync.schedule(0), false);
  assert.equal(sync.schedule('abc'), false);
  sync.stop();
});

test('scheduleBadgeSync is a quiet no-op until push is initialized', () => {
  mobilePush.resetForTests();
  assert.equal(mobilePush.scheduleBadgeSync(7), false);
});

// ── hooks ──────────────────────────────────────────────────────────────

test('every notifications_changed fan-out schedules a badge sync', async () => {
  const scheduled = [];
  const original = mobilePush.scheduleBadgeSync;
  mobilePush.scheduleBadgeSync = (userId) => { scheduled.push(userId); return true; };
  try {
    const ws = require('../src/services/ws');
    ws.pushToUser(7, { type: 'notifications_changed' });
    ws.pushToUser(7, { type: 'user_blocks_changed' });
    assert.deepEqual(scheduled, [7], 'only the read/clear signal re-badges');
  } finally {
    mobilePush.scheduleBadgeSync = original;
  }
});

test('a conversation read schedules a badge sync for the reader', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'conversations.js'), 'utf8'
  );
  const read = src.slice(src.indexOf("type: 'conversation_read'"));
  const end = read.indexOf('return res.json({ ok: true });');
  assert.ok(end > 0);
  assert.match(read.slice(0, end), /scheduleBadgeSync\(req\.user\.id\)/);
});

// ── #3050: clears that never announced themselves ──────────────────────
//
// The iPhone app shell does not implement the WebView's setSocialBadgeCount
// seam, so the icon moves only when a push carries `aps.badge`. Any path that
// lowers countUnread without a `notifications_changed` left the icon on a
// number the bell no longer showed, and nothing in the app could correct it.

function routeSource(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', name), 'utf8');
}

function handlerBody(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `handler ${marker} exists`);
  const next = src.indexOf('router.', start + marker.length);
  return src.slice(start, next > 0 ? next : undefined);
}

test('loading the bell re-badges the iPhone to the total it just counted', () => {
  const body = handlerBody(routeSource('notifications.js'), "router.get('/api/notifications',");
  const firstPage = body.slice(body.indexOf('if (!before) {'));
  const count = firstPage.indexOf('payload.unread = await notifications.countUnread(pool, req.user.id);');
  const sync = firstPage.indexOf("require('../services/mobile-push').scheduleBadgeSync(req.user.id)");
  assert.ok(count >= 0, 'first page counts unread');
  assert.ok(sync > count, 'the first page schedules a badge sync after counting');
  // Only the first page: a cursor follow-up carries no total and must not
  // re-badge on every scroll.
  assert.ok(body.indexOf('scheduleBadgeSync') > body.indexOf('if (!before) {'));
});

test('retracting kudos refreshes the recipient bell and badge', () => {
  const body = handlerBody(routeSource('kudos.js'), "router.delete('/api/sessions/:id/kudos'");
  assert.match(body, /DELETE FROM notifications[\s\S]*?RETURNING user_id/);
  assert.match(body, /pushNotificationToUser\(userId, \{ type: 'notifications_changed' \}\)/);
});

test('conversation membership changes and un-reacting announce notifications_changed', () => {
  const src = routeSource('conversations.js');
  assert.match(src, /function pushNotificationsChanged\(userIds\)[\s\S]*?pushToUser\(userId, \{ type: 'notifications_changed' \}\)/);
  const cases = [
    ["router.post('/api/conversations/:id/respond'", /pushNotificationsChanged\(\[req\.user\.id, \.\.\.\(result\.memberIds \|\| \[\]\)\]\)/],
    ["router.delete('/api/conversations/:id/members/:userId'", /pushNotificationsChanged\(targetId === req\.user\.id \? result\.memberIds : \[targetId\]\)/],
    ["router.post('/api/conversations/:id/leave'", /pushNotificationsChanged\(result\.memberIds\)/],
    ["router.post('/api/conversations/:id/messages/:messageId/reactions'", /pushNotificationsChanged\(result\.clearedUserIds\)/],
  ];
  for (const [marker, pattern] of cases) {
    assert.match(handlerBody(src, marker), pattern, marker);
  }
});

test('un-reacting reports whose reaction notification it deleted', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'conversations.js'), 'utf8'
  );
  const fn = src.slice(src.indexOf('async function toggleReaction('),
    src.indexOf('async function markRead('));
  assert.match(fn, /kind = 'conversation_reaction' AND detail = \$5\s*RETURNING user_id/);
  assert.match(fn, /return \{ notifications, clearedUserIds, memberIds:/);
});
