'use strict';

// #5404: the Monday row of the changes you voted on
// (src/services/voted-digest.js): when it runs, what it writes, and that the
// row, the phone and the tap say what they should. The real SQL runs in
// tests/voted-digest-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const digest = require('../src/services/voted-digest');
const prefs = require('../src/workflow/rules/notification-preferences.ts');
const pushPrefs = require('../src/services/mobile-push-preferences');
const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('it runs on Monday from 13:00 UTC and on no other hour', () => {
  assert.equal(digest.isPostingTime(new Date('2026-11-09T12:59:00Z')), false, 'Monday, before');
  assert.equal(digest.isPostingTime(new Date('2026-11-09T13:00:00Z')), true, 'Monday, on the hour');
  assert.equal(digest.isPostingTime(new Date('2026-11-09T23:30:00Z')), true, 'Monday, later');
  assert.equal(digest.isPostingTime(new Date('2026-11-10T13:00:00Z')), false, 'Tuesday');
});

test('the week is a fixed mark, whichever hour of the Monday asks', () => {
  const mark = '2026-11-09T13:00:00.000Z';
  assert.equal(digest.weekStart(new Date('2026-11-09T13:00:00Z')).toISOString(), mark);
  assert.equal(digest.weekStart(new Date('2026-11-09T22:15:00Z')).toISOString(), mark);
  assert.equal(digest.weekStart(new Date('2026-11-15T23:00:00Z')).toISOString(), mark, 'the Sunday after');
  assert.equal(digest.weekStart(new Date('2026-11-09T12:00:00Z')).toISOString(), '2026-11-02T13:00:00.000Z', 'before the hour');
  assert.equal(digest.weekStart(new Date('2026-12-01T14:00:00Z')).toISOString(), '2026-11-30T13:00:00.000Z', 'across a month');
});

test('outside the posting time it does not touch the database', async () => {
  const pool = { query: async () => { throw new Error('no query outside the posting time'); } };
  assert.deepEqual(await digest.sweep(pool, new Date('2026-11-10T13:00:00Z')), { skipped: true });
});

test('nothing decided: one query and nothing sent', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  const result = await digest.sweep(pool, new Date('2026-11-09T14:00:00Z'));
  assert.deepEqual(result, { candidates: 0, sent: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['2026-11-02T13:00:00.000Z', '2026-11-09T13:00:00.000Z'], 'one Monday to the next');
});

test('the query starts from the week\'s decided changes, never a walk of the votes', async () => {
  let sql = '';
  await digest.sweep({ query: async (text) => { sql = text.replace(/\s+/g, ' '); return { rows: [] }; } },
    new Date('2026-11-09T14:00:00Z'));
  assert.match(sql, /WITH decided AS \( SELECT cs\.id, cs\.app_id FROM chat_sessions cs WHERE cs\.merged_at >= \$1/);
  assert.match(sql, /FROM decided d JOIN pr_votes v ON v\.session_id = d\.id/, 'votes read by change');
  assert.doesNotMatch(sql, /\bevents\b/, 'the events log has no index on session_id');
  assert.match(sql, /a\.view_visibility = 'public' OR EXISTS/, 'a private project counts only for a member');
});

test('the preference is an account switch, on by default, and the phone counts it a Change alert', () => {
  assert.equal(prefs.KIND_TO_CATEGORY.get('voted_digest'), 'voted_digest');
  const category = prefs.ACCOUNT_CATEGORY_DEFINITIONS.find((row) => row.key === 'voted_digest');
  assert.equal(category.defaultEnabled, true);
  assert.equal(pushPrefs.KIND_TO_CATEGORY.get('voted_digest'), 'proposal_alerts');
  const kinds = read('src', 'services', 'activity-mail.js').match(/const KINDS = Object\.freeze\((\[[^\]]*\])/)[1];
  assert.doesNotMatch(kinds, /voted_digest/, 'bell and phone only: digests are not emailed (#5794)');
});

test('the push counts and names nothing', () => {
  assert.deepEqual(buildNotificationCopy('voted_digest', { detail: '3' }), {
    title: message('push:votedDigest.title_other', { count: 3 }),
    body: message('push:votedDigest.body'),
  });
  assert.equal(buildNotificationCopy('voted_digest', { detail: '1' }).title, message('push:votedDigest.title_one', { count: 1 }));
  assert.equal(buildNotificationCopy('voted_digest', { detail: '' }).title, message('push:votedDigest.title.plain'));
});

test('the row opens Your votes, and the clock runs the sweep', () => {
  const src = read('frontend', 'src', 'features', 'notifications', 'notifications.js');
  const branch = src.slice(src.indexOf("if (item.kind === 'voted_digest') {"), src.indexOf('if (item.appSlug) {\n      // Every path below navigates'));
  assert.match(branch, /App\.navigateToProfileProposals\('votes'\)/);
  assert.match(branch, /#profile\/your-votes/);
  assert.match(read('frontend', 'src', 'features', 'notifications', 'notifications-kinds.js'), /'voted_digest'/,
    'under the Votes filter');
  assert.match(read('src', 'workflow', 'clock', 'services.ts'), /name: 'voted-digest', everyMs: HOUR/);
});

test('the bell row says a count under its label, and carries no project', () => {
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.PlatformI18n = englishPlatformI18n();
  loadTsx('frontend/src/features/notifications/notifications.js');
  const view = globalThis.window.Notifications._rowView({
    id: 1, createdAt: new Date().toISOString(), readAt: null, kind: 'voted_digest', detail: '3',
    appId: null, appSlug: null, appName: null, sourceUsername: null,
  });
  assert.equal(view.label, message('notifications:row.votedDigest.label'));
  assert.equal(view.segments.map((s) => s.v).join(' '), message('notifications:row.votedDigest.count_other', { count: 3 }));
  assert.equal(view.needsYou, false, 'it asks for nothing');
});
