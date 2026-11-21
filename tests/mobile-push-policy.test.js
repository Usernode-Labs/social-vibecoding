'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildMessage, buildNotificationCopy, isPushParked, recipientBinding, RECIPIENT_CONTEXT, isPushEnvironment,
} = require('../src/services/mobile-push-policy');
const {
  classifyError, parseServiceAccount,
} = require('../src/services/mobile-push-provider');
const { validateConfiguration } = require('../src/services/mobile-push');

const INPUT = {
  token: 'opaque-fcm-token',
  notificationId: 42,
  kind: 'session_done',
  environment: 'production',
  installationId: '123e4567-e89b-12d3-a456-426614174000',
  userId: 7,
  expiresAt: new Date(Date.now() + 60_000),
};

test('recipient binding exactly matches the Flutter context encoding', () => {
  const expected = crypto.createHash('sha256').update([
    RECIPIENT_CONTEXT, INPUT.installationId, '7', 'production',
  ].join('\n')).digest('hex');
  assert.equal(recipientBinding(INPUT), expected);
});

test('push environments match the mobile build contract', () => {
  assert.equal(isPushEnvironment('production'), true);
  assert.equal(isPushEnvironment('staging_2'), true);
  assert.equal(isPushEnvironment('2production'), false);
  assert.equal(isPushEnvironment('Production'), false);
  assert.equal(isPushEnvironment(''), false);
});

test('FCM data payload keeps the opaque, environment-bound contract', () => {
  const message = buildMessage(INPUT);
  assert.deepEqual(Object.keys(message.data).sort(), [
    'environment', 'notification_id', 'recipient_binding', 'schema', 'source',
  ]);
  assert.equal(message.data.source, 'usernode_social');
  assert.equal(message.data.schema, '1');
  assert.equal(message.data.notification_id, '42');
  assert.equal(message.android.notification.channelId, 'social_activity');
  assert.ok(message.android.ttl > 0 && message.android.ttl <= 24 * 60 * 60 * 1000);
  assert.doesNotMatch(JSON.stringify(message.data), /session_done|user_id|token/);
});

test('a notification collapses to one alert per id on both platforms', () => {
  // #1078 UX contract: re-sends of the same notification replace the visible
  // alert (collapse id per notification), and all social pushes group into
  // one thread/channel rather than scattering across the lock screen.
  const now = new Date('2026-08-13T12:00:00Z');
  const message = buildMessage({ ...INPUT, now, expiresAt: new Date(now.getTime() + 60_000) });
  assert.equal(message.android.collapseKey, 'usernode-social-42');
  assert.equal(message.android.notification.tag, 'usernode-social-42');
  assert.equal(message.apns.headers['apns-collapse-id'], 'usernode-social-42');
  assert.equal(message.apns.headers['apns-push-type'], 'alert');
  assert.equal(message.apns.headers['apns-priority'], '10');
  assert.deepEqual(message.apns.payload.aps, {
    category: 'USERNODE_SOCIAL', threadId: 'usernode-social',
  });
  // The APNs expiration mirrors the delivery TTL exactly (unix seconds).
  assert.equal(message.android.ttl, 60_000);
  assert.equal(message.apns.headers['apns-expiration'],
    String(Math.floor((now.getTime() + 60_000) / 1000)));
});

// #5249: kudos is parked. Its copy is kept for when it comes back, but no
// push is built for it, and the worker settles its deliveries unsent.
test('a parked kind keeps its copy but builds no push', () => {
  assert.equal(isPushParked('kudos'), true);
  assert.equal(isPushParked('reaction'), false);
  assert.deepEqual(buildNotificationCopy('kudos', {
    sourceUsername: 'alice', appName: 'MyPage', sessionTitle: 'Fix login redirect loop',
  }), {
    title: '@alice gave you kudos for "Fix login redirect loop" · MyPage',
    body: 'Your work is getting noticed',
  });
  assert.throws(() => buildMessage({ ...INPUT, kind: 'kudos' }), /kind_not_allowed/);
});

test('reviewed interaction kinds build and unknown kinds stay closed', () => {
  assert.equal(buildMessage({ ...INPUT, kind: 'mention' }).data.notification_id, '42');
  assert.throws(() => buildMessage({ ...INPUT, kind: 'future_kind' }), /kind_not_allowed/);
  assert.throws(() => buildMessage({ ...INPUT, notificationId: 2147483648 }), /id_invalid/);
});

test('the unread total rides as the icon badge on both platforms', () => {
  // #1445: iOS only badges the homescreen icon when a push carries
  // `aps.badge`; Android launchers read `notificationCount`.
  const message = buildMessage({ ...INPUT, unreadCount: 5 });
  assert.deepEqual(message.apns.payload.aps, {
    category: 'USERNODE_SOCIAL', threadId: 'usernode-social', badge: 5,
  });
  assert.equal(message.android.notification.notificationCount, 5);

  // Zero is a valid count (it clears the badge), even though the worker
  // clamps to 1 in practice because the delivered notification is unread.
  const cleared = buildMessage({ ...INPUT, unreadCount: 0 });
  assert.equal(cleared.apns.payload.aps.badge, 0);
  assert.equal(cleared.android.notification.notificationCount, 0);
});

test('a missing or invalid unread count degrades to the pre-badge payload', () => {
  // The badge is display-only: a count problem must never fail a delivery,
  // so anything but a non-negative safe integer omits both fields.
  for (const unreadCount of [undefined, null, -1, 1.5, NaN, '5', Infinity]) {
    const message = buildMessage({ ...INPUT, unreadCount });
    assert.equal('badge' in message.apns.payload.aps, false,
      `aps.badge omitted for ${String(unreadCount)}`);
    assert.equal('notificationCount' in message.android.notification, false,
      `notificationCount omitted for ${String(unreadCount)}`);
  }
});

const CONTEXT = {
  appName: 'MyPage',
  conversationTitle: 'Design crew',
  sourceUsername: 'alice',
  messageContent: 'hey can you look at the header',
  sessionTitle: 'Fix login redirect loop',
  prTitle: null,
  branchName: null,
  detail: null,
};

test('each kind renders its own title and body from send-time context', () => {
  const cases = [
    ['conversation_invite', CONTEXT,
      '@alice invited you to a conversation · Design crew',
      'Open Messages to accept or decline'],
    ['conversation_message', CONTEXT,
      '@alice sent you a message · Design crew',
      'hey can you look at the header'],
    ['conversation_mention', CONTEXT,
      '@alice mentioned you · Design crew',
      'hey can you look at the header'],
    ['conversation_reply', CONTEXT,
      '@alice replied to you · Design crew',
      'hey can you look at the header'],
    ['conversation_reaction', { ...CONTEXT, detail: '👍' },
      '@alice reacted 👍 to your message · Design crew',
      'You said: hey can you look at the header'],
    ['mention', CONTEXT,
      '@alice mentioned you in "Fix login redirect loop" · MyPage',
      'hey can you look at the header'],
    ['reply', CONTEXT,
      '@alice replied in "Fix login redirect loop" · MyPage',
      'hey can you look at the header'],
    // #2387: a reply in an app-chat reply thread you are in.
    ['thread_reply', CONTEXT,
      '@alice replied in a thread · MyPage',
      'hey can you look at the header'],
    // #4535: a message in a request's discussion you filed or posted in.
    // The title names the request from `detail`; the reply is the body.
    ['issue_thread_reply', { ...CONTEXT, detail: '4417' },
      '@alice replied on request #4417 · MyPage',
      'hey can you look at the header'],
    ['issue_thread_reply', CONTEXT,
      '@alice replied on a request · MyPage',
      'hey can you look at the header'],
    ['reaction', { ...CONTEXT, detail: '👍' },
      '@alice reacted 👍 to your message · MyPage',
      'You said: hey can you look at the header'],
    ['collab_invite', CONTEXT,
      '@alice wants to build MyPage with you',
      'Join them to build it. Accept or decline in the app'],
    ['collab_invite_accepted', CONTEXT,
      '@alice is in! · MyPage',
      'Your invite was accepted. You can start building together'],
    ['approver_invite', CONTEXT,
      '@alice asked you to help approve changes · MyPage',
      "You'd try changes and vote on them. Accept in the app"],
    ['approver_invite_accepted', CONTEXT,
      '@alice can approve changes now · MyPage',
      'They can try changes and vote on them from now on'],
    ['pr_proposed', { ...CONTEXT, prTitle: 'Fix login redirect loop', sessionTitle: null },
      '@alice proposed "Fix login redirect loop" · MyPage',
      '@alice would love your eyes on this'],
    ['proposal_vote', CONTEXT,
      '@alice voted yes on "Fix login redirect loop" · MyPage',
      'Open the change to see their vote'],
    ['pr_merged', CONTEXT,
      '"Fix login redirect loop" is live · MyPage',
      'The vote carried. Your change is live'],
    ['issue_opened', { ...CONTEXT, detail: '2273' },
      '@alice filed request #2273 · MyPage',
      'Open the request to see what needs attention'],
    // #3952: named with @ in a request somebody filed.
    ['issue_mention', { ...CONTEXT, detail: '3952' },
      '@alice mentioned you in request #3952 · MyPage',
      'Open the request to see what they wrote'],
    ['vote_digest', { ...CONTEXT, detail: '3' },
      '3 changes are waiting for your approval',
      'See them under Needs you in Communities'],
    ['vote_digest', { ...CONTEXT, detail: '1' },
      '1 change is waiting for your approval',
      'Open it to try it and approve it'],
    ['check_failed', CONTEXT,
      'Testing found a problem with "Fix login redirect loop" · MyPage',
      'It needs a fix before it can go live'],
    ['stale_pr', CONTEXT,
      '"Fix login redirect loop" is waiting for approval · MyPage',
      'Share the preview or ask a friend to try it'],
    // Its votes are met and its merge stands still (a conflict, red checks).
    ['stale_pr', { ...CONTEXT, detail: 'blocked' },
      '"Fix login redirect loop" is approved but can\'t go live · MyPage',
      'It needs a fix before it can go live, or it will be set aside'],
  ];
  for (const [kind, context, title, body] of cases) {
    const message = buildMessage({ ...INPUT, kind, context });
    assert.deepEqual(message.notification, { title, body }, kind);
  }
});

test('a stale proposal names how long it has been waiting when the promotion time is known', () => {
  const day = 24 * 60 * 60 * 1000;
  const bodyAfter = (ms) => buildMessage({
    ...INPUT, kind: 'stale_pr',
    context: { ...CONTEXT, promotedAt: new Date(Date.now() - ms) },
  }).notification.body;
  assert.equal(
    bodyAfter(3 * day + 60_000),
    'Nobody has weighed in for 3 days. Share the preview or ask a friend to try it'
  );
  assert.equal(
    bodyAfter(day + 60_000),
    'Nobody has weighed in for 1 day. Share the preview or ask a friend to try it'
  );
  // Under a day, or promoted_at missing entirely: the nudge stands alone.
  assert.equal(bodyAfter(60_000), 'Share the preview or ask a friend to try it');
});

test('machine-generated branch names never appear as a label', () => {
  const context = {
    ...CONTEXT, sessionTitle: null, prTitle: null, branchName: 'dev/evan-1786562509265',
  };
  assert.equal(
    buildMessage({ ...INPUT, kind: 'pr_proposed', context }).notification.title,
    '@alice proposed a change · MyPage'
  );
  // A human-named branch still earns the label slot.
  assert.equal(
    buildMessage({
      ...INPUT, kind: 'pr_proposed', context: { ...context, branchName: 'fix-header-contrast' },
    }).notification.title,
    '@alice proposed "fix-header-contrast" · MyPage'
  );
});

test('a mention with no message text still locates the conversation', () => {
  // The label already anchors the title, so the body is simply omitted.
  assert.deepEqual(
    buildMessage({
      ...INPUT, kind: 'mention', context: { ...CONTEXT, messageContent: null },
    }).notification,
    { title: '@alice mentioned you in "Fix login redirect loop" · MyPage' }
  );
  // No label either: the copy falls back to the plain form.
  assert.deepEqual(
    buildMessage({
      ...INPUT, kind: 'mention',
      context: { ...CONTEXT, messageContent: null, sessionTitle: null },
    }).notification,
    { title: '@alice mentioned you · MyPage' }
  );
});

test('titles and bodies are sanitized, collapsed, and truncated', () => {
  const message = buildMessage({
    ...INPUT,
    kind: 'mention',
    context: {
      ...CONTEXT,
      appName: 'A'.repeat(200),
      messageContent: `line one\n\n  ${'x'.repeat(300)}`,
    },
  });
  assert.equal(message.notification.title.length, 80);
  assert.ok(message.notification.title.endsWith('…'));
  assert.equal(message.notification.body.length, 140);
  assert.ok(message.notification.body.startsWith('line one x'));
  assert.ok(message.notification.body.endsWith('…'));
  assert.doesNotMatch(message.notification.body, /\n/);

  const embedded = buildMessage({
    ...INPUT,
    kind: 'pr_proposed',
    context: { ...CONTEXT, sessionTitle: null, prTitle: 'p'.repeat(200) },
  });
  assert.ok(embedded.notification.title.includes('…'));
  assert.ok(embedded.notification.title.length <= 80);
  // Title-embedded labels are capped, so the app suffix survives instead of
  // being eaten by the 80-char truncation.
  assert.ok(embedded.notification.title.endsWith(' · MyPage'));
});

test('missing context degrades to the generic notification, never a throw', () => {
  for (const context of [undefined, {}, { appName: 42, sourceUsername: {} }]) {
    const message = buildMessage({ ...INPUT, kind: 'mention', context });
    assert.deepEqual(message.notification, {
      title: 'Homeroom', body: 'You have new activity',
    });
  }
  // System-owned kinds keep their kind-specific copy: they can identify the
  // event without an actor, app or proposal label, so they never regress to
  // generic activity.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'pr_merged', context: {} }).notification,
    { title: 'Your change is live', body: 'The vote carried. Your change is live' }
  );
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'vote_digest', context: {} }).notification,
    { title: 'Changes are waiting for your approval', body: 'See them under Needs you in Communities' }
  );
});

test('context never leaks into the data payload', () => {
  const message = buildMessage({ ...INPUT, kind: 'mention', context: CONTEXT });
  assert.doesNotMatch(JSON.stringify(message.data), /alice|MyPage|header/);
});

test('provider errors distinguish dead tokens from retryable transport failures', () => {
  assert.equal(
    classifyError({ code: 'messaging/registration-token-not-registered' }).action,
    'drop_registration'
  );
  assert.equal(
    classifyError({ code: 'messaging/mismatched-credential' }).action,
    'drop_registration'
  );
  assert.equal(classifyError({ code: 'messaging/server-unavailable' }).action, 'retry');
  assert.deepEqual(classifyError({ code: 'messaging/invalid-payload' }), {
    action: 'dead', code: 'invalid_application_payload',
  });
});

test('enabled delivery requires a matching Firebase project and explicit environment', () => {
  const account = {
    project_id: 'social-prod', client_email: 'firebase@example.test', private_key: 'pem',
  };
  const encoded = Buffer.from(JSON.stringify(account)).toString('base64');
  assert.equal(parseServiceAccount(encoded, 'social-prod').project_id, 'social-prod');
  assert.throws(() => parseServiceAccount(encoded, 'other'), /another project/);
  assert.throws(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: '',
  }), /PUSH_ENV/);
  assert.doesNotThrow(() => validateConfiguration({
    mobilePushEnabled: true,
    mobilePushEnvironment: 'production',
    firebaseProjectId: 'social-prod',
    firebaseServiceAccountJsonB64: encoded,
  }));
});

test('test alert uses explicit copy with the normal opaque push envelope', () => {
  const message = buildMessage({ ...INPUT, kind: 'test_alert' });
  assert.deepEqual(message.notification, {
    title: 'Homeroom test alert',
    body: 'Your phone can receive push notifications from Homeroom.',
  });
  assert.equal(message.data.notification_id, '42');
  assert.equal(message.android.notification.channelId, 'social_activity');
});

test('app health alerts say what happened and what to do (#2253, #2273)', () => {
  // The storage cap and deploy-failure tokens all produce contextual copy.
  // Unknown future tokens still identify the app and direct the recipient to
  // the durable detail instead of degrading to generic activity.
  const warn = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_warn' },
  });
  assert.deepEqual(warn.notification, {
    title: 'Storage is nearly full · MyPage',
    body: 'MyPage has used most of its storage. Clean up old data or ask an admin to raise the limit',
  });
  const full = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_full' },
  });
  assert.deepEqual(full.notification, {
    title: 'Out of storage · MyPage',
    body: 'New data cannot be saved until an admin raises the limit or allows time to clean up',
  });
  const deploy = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'deploy_failed' },
  });
  assert.deepEqual(deploy.notification, {
    title: 'Deploy failed · MyPage',
    body: 'The latest change did not go live. Open the app to see what failed',
  });
  const other = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'future_token' },
  });
  assert.deepEqual(other.notification, {
    title: 'App needs attention · MyPage',
    body: 'Open the app to see what needs attention',
  });
});

test('storage notices carry the figures, early and nearly full (#6494)', () => {
  const early = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_early:1638:3072' },
  });
  assert.deepEqual(early.notification, {
    title: 'Storage is over half full · MyPage',
    body: 'MyPage has used 1.6 GB of 3 GB. Clean up old data or ask an admin to raise the limit before it fills',
  });
  const warn = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, detail: 'storage_warn:2560:3072' },
  });
  assert.deepEqual(warn.notification, {
    title: 'Storage is nearly full · MyPage',
    body: 'MyPage has used 2.5 GB of 3 GB. Clean up old data or ask an admin to raise the limit',
  });
  // No app name, and a size under 1 GB reads in MB.
  const plain = buildMessage({
    ...INPUT, kind: 'app_health', context: { ...CONTEXT, appName: null, detail: 'storage_early:614:3072' },
  });
  assert.deepEqual(plain.notification, {
    title: 'Storage is over half full',
    body: 'Your app has used 614 MB of 3 GB. Clean up old data or ask an admin to raise the limit before it fills',
  });
});

test('unexpected events alerts say how many of what, with no app (#4296)', () => {
  const copy = (detail) => buildMessage({
    ...INPUT, kind: 'platform_incident', context: { detail },
  }).notification;
  assert.deepEqual(copy('hour:build_interrupted:6'), {
    title: 'Unexpected events piling up',
    body: '6 build interrupted in the last hour. Admin \u2192 Unexpected events has each one',
  });
  assert.deepEqual(copy('digest:9:build_interrupted=7'), {
    title: '9 unexpected events yesterday',
    body: 'build interrupted 7, other 2',
  });
  assert.deepEqual(copy('digest:1:build_interrupted=1').title, '1 unexpected event yesterday');
  assert.equal(copy('garbage').title, 'Unexpected events');
  // A private request (a security finding): the lock screen says only where it is.
  assert.deepEqual(copy('private:42'), {
    title: 'A private platform request needs a person',
    body: 'Homeroom filed it privately: open Private requests in its Workshop',
  });
});

test('platform limit alerts name the cap, how full it is, and the lever', () => {
  // Full admins only, and no app: the title carries no " · App" suffix.
  const copy = (detail) => buildMessage({
    ...INPUT, kind: 'platform_limit', context: { detail },
  }).notification;
  assert.deepEqual(copy('apps_warn:40:50'), {
    title: 'Nearing the app limit',
    body: '40 of 50 apps are in use. Raise the limit in Admin \u2192 Limits before new apps are refused',
  });
  assert.deepEqual(copy('apps_full:50:50'), {
    title: 'App limit reached',
    body: '50 of 50 apps are in use. New apps are refused until the limit is raised in Admin \u2192 Limits',
  });
  assert.deepEqual(copy('sessions_warn:60:75'), {
    title: 'Nearing the session limit',
    body: '60 of 75 coding sessions are running. At the limit, idle sessions are paused to make room',
  });
  assert.equal(copy('sessions_full:75:75').title, 'Session limit reached');
  assert.match(copy('sessions_full:75:75').body, /raised in Admin → Limits/);
  // The shared database's connections (platform-limit-alerts.js).
  assert.deepEqual(copy('connections_warn:80:97'), {
    title: 'Database connections running low',
    body: "80 of 97 database connections are open. At 97, apps can't open new ones",
  });
  assert.equal(copy('connections_full:97:97').title, 'Database connections used up');
  // The cluster's own (services/platform-capacity.js).
  assert.deepEqual(copy('db_disk_warn:41000:51200'), {
    title: 'Database disk filling up',
    body: "40 of 50 GiB of the database's disk is used. When it fills, Postgres stops writing",
  });
  assert.equal(copy('db_disk_full:51200:51200').title, 'Database disk full');
  assert.deepEqual(copy('quota_workers_warn:917:1000'), {
    title: 'Cluster quota running low (workers)',
    body: "91% of the workers namespace's quota is used. When it fills, new coding sessions and checks wait",
  });
  assert.equal(copy('quota_apps_full:1000:1000').title, 'Cluster quota used up (apps)');
  assert.match(copy('quota_builds_full:1000:1000').body, /new image builds fail/);
  assert.equal(copy('node_pool_full:10000:10000').title, 'Node volume pool full');
  // Homeroom bot's weekly budget, in cents (services/openrouter-credit.js
  // budget). The day is the next week boundary, which is always a Monday.
  assert.deepEqual(copy('bot_budget_warn:64800:80000'), {
    title: "Homeroom bot's weekly budget is 81% used",
    body: "$648 of $800 used. At $800 the bot stops building, and screenshots, sync with main and apps' AI features stop with it, until Monday",
  });
  assert.deepEqual(copy('bot_budget_full:80000:80000'), {
    title: "Homeroom bot's weekly budget is used up",
    body: "Building, screenshots, sync with main and apps' AI features have stopped. They start again on Monday, or once the budget is raised",
  });
  assert.match(copy('node_pool_warn:9000:10000').body, /^8\.8 of 9\.8 GiB of a node's volume pool is used/);
  // GitHub's hourly budget (services/github-budget.js).
  assert.deepEqual(copy('github_warn:4000:5000'), {
    title: 'GitHub requests running low',
    body: "4000 of 5000 GitHub requests used this hour. Background work waits so people's work keeps the rest",
  });
  assert.deepEqual(copy('github_full:5000:5000'), {
    title: 'GitHub requests used up',
    body: "All 5000 of this hour's GitHub requests are used. Proposals and shots that need GitHub fail until the hour resets",
  });
  assert.equal(copy('github_app_warn:10000:12500').title, 'GitHub App requests running low');
  assert.equal(copy('github_app_full:12500:12500').title, 'GitHub App requests used up');
  for (const d of ['github_warn:4000:5000', 'github_full:5000:5000', 'github_app_full:12500:12500']) {
    assert.ok(!/\u2014/.test(JSON.stringify(copy(d))), d);
  }
  // An unreadable token still says what kind of alert it is.
  assert.equal(copy('disk_warn:1:2').title, 'Platform limit');
  assert.equal(copy(undefined).title, 'Platform limit');
});

test('#6901: a refusal at the app limit says so, with a count for later notices', () => {
  const copy = (detail) => buildMessage({
    ...INPUT, kind: 'platform_limit', context: { detail },
  }).notification;
  assert.deepEqual(copy('apps_away:1:210:0'), {
    title: 'Someone was turned away',
    body: 'The server is at its app limit (210 apps). Raise it in Admin → Limits or remove an app',
  });
  assert.deepEqual(copy('apps_away:1:210:61'), {
    title: 'People turned away at the app limit',
    body: '1 person was turned away in the last 2 hours',
  });
  assert.deepEqual(copy('apps_away:3:210:180'), {
    title: 'People turned away at the app limit',
    body: '3 people were turned away in the last 3 hours',
  });
  // Under the hour says "in the last hour"; 60 minutes is the last hour too.
  assert.equal(copy('apps_away:2:210:60').body, '2 people were turned away in the last hour');
  for (const detail of ['apps_away:1:210:0', 'apps_away:3:210:180']) {
    assert.ok(!/—/.test(JSON.stringify(copy(detail))), detail);
  }
});

test('#2386: a friend request and its acceptance name the person and what to do', () => {
  const request = buildMessage({ ...INPUT, kind: 'friend_request', context: { sourceUsername: 'lin' } });
  assert.deepEqual(request.notification, {
    title: '@lin sent you a friend request',
    body: 'Accept or decline in Notifications',
  });
  const accepted = buildMessage({ ...INPUT, kind: 'friend_accept', context: { sourceUsername: 'ada' } });
  assert.equal(accepted.notification.title, '@ada accepted your friend request');
  assert.match(accepted.notification.body, /friends now/);
  // No app and no conversation ride along, so nothing is appended.
  assert.doesNotMatch(request.notification.title, / · /);
  // Without the person there is nothing true to say: the generic copy.
  assert.deepEqual(
    buildMessage({ ...INPUT, kind: 'friend_request', context: {} }).notification,
    { title: 'Homeroom', body: 'You have new activity' },
  );
  // The opaque data payload is unchanged by the kind.
  assert.equal(request.data.notification_id, '42');
  assert.equal(Object.keys(request.data).includes('source_username'), false);
});

test('the credit warnings are the account\'s credit, with days only when there is a rate', () => {
  const copy = (detail) => buildMessage({
    ...INPUT, kind: 'platform_incident', context: { detail },
  }).notification;
  assert.deepEqual(copy('credit:low:500:480:6'), {
    title: 'OpenRouter credit is below $500',
    body: '$480 left, about 6 days at the recent rate. Add credit before Homeroom bot stops building',
  });
  assert.equal(copy('credit:urgent:200:184:1').body, '$184 left, about 1 day at the recent rate. Add credit before Homeroom bot stops building');
  assert.equal(copy('credit:low:500:480:0').body, '$480 left. Add credit before Homeroom bot stops building');
  assert.equal(copy('credit:out').title, 'OpenRouter credit ran out');
});
