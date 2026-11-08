// The "Share your week" card (#6464): which figures it offers, the words it
// sends, and that sharing is a local, read-only action. The card's own
// figures are pinned in tests/profile-activity.test.js; the server's half in
// tests/me-summary.test.js and tests/profile-activity-postgres.test.js.
//
// Run with: node --test tests/profile-week-share.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';
const VIEW = 'frontend/src/features/profile/profile-view.tsx';
const SHEET = 'frontend/src/features/profile/week-share-sheet.tsx';
const store = loadTsx(STORE);

const DATES = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
const SUMMARY = {
  activity: {
    days: DATES.map((date, i) => ({ date, seconds: [1500, 0, 2880, 4200, 720, 2100, 1800][i] })),
    appsOpened: 6,
    totalSeconds: 13200,
  },
  week: {
    merged: 2,
    apps: [{ slug: 'usernode-2d5619', name: 'Homeroom' }, { slug: 'notes', name: 'Notes' }],
    challengesDone: 1,
  },
};
const PUBLISHED = {
  published: true,
  moderationDisabled: false,
  profile: { username: 'evan', url: '/#profile/evan' },
};
const ORIGIN = 'https://homeroom.example';

test('the card offers every non-zero figure, in the card\'s own order', () => {
  const view = store.shareWeekView(SUMMARY, null, ORIGIN);
  assert.deepEqual(view.items.map((item) => item.key), ['time', 'apps', 'merged', 'built', 'challenges']);
  assert.equal(view.items[0].label, '3h 40m time in apps');
  assert.equal(view.items[1].label, '6 apps opened');
  assert.equal(view.items[2].label, '2 changes live');
  assert.equal(view.items[3].label, 'Built in: Homeroom, Notes');
  assert.equal(view.items[4].label, '1 challenge done');
});

test('a zero figure is not offered at all', () => {
  const view = store.shareWeekView({
    activity: { days: DATES.map((date) => ({ date, seconds: 0 })), appsOpened: 1, totalSeconds: 0 },
    week: { merged: 0, apps: [], challengesDone: 0 },
  }, null, ORIGIN);
  assert.deepEqual(view.items.map((item) => item.key), ['apps']);
});

test('the public profile link is added only when it is published and not hidden', () => {
  assert.equal(store.shareWeekView(SUMMARY, PUBLISHED, ORIGIN).link, 'https://homeroom.example/#profile/evan');
  assert.equal(store.shareWeekView(SUMMARY, { ...PUBLISHED, published: false }, ORIGIN).link, null,
    'an unpublished profile has no link to add');
  assert.equal(store.shareWeekView(SUMMARY, { ...PUBLISHED, moderationDisabled: true }, ORIGIN).link, null,
    'a hidden profile is not linked');
  assert.equal(store.shareWeekView(SUMMARY, null, ORIGIN).link, null, 'not asked: words alone');
});

test('the words are the selected figures, joined the card\'s own way', () => {
  const { items, link } = store.shareWeekView(SUMMARY, PUBLISHED, ORIGIN);
  const all = store.shareText(items, items.map((item) => item.key), link);
  assert.equal(all, 'My week on Homeroom: 3h 40m time in apps · 6 apps opened · 2 changes live · '
    + 'Built in: Homeroom, Notes · 1 challenge done\nhttps://homeroom.example/#profile/evan');
  const some = store.shareText(items, ['time', 'merged']);
  assert.equal(some, 'My week on Homeroom: 3h 40m time in apps · 2 changes live');
  assert.equal(store.shareText(items, new Set(['apps'])), 'My week on Homeroom: 6 apps opened');
  assert.equal(store.shareText(items, []), '', 'nothing selected says nothing');
});

test('the sheet draws a switch for every figure and the words that will leave', () => {
  const state = {
    open: true,
    user: { username: 'evan', links: {} },
    data: { ranking: {}, summary: SUMMARY, ownerPublicProfile: PUBLISHED },
    sheetOpen: false, publicStatus: '', publishing: false, previewOpen: false,
    weekShareOpen: true,
  };
  const mod = loadTsx(VIEW, {
    stubs: { './profile-store.js': { ...store, profileStore: { get: () => state, subscribe: () => () => {} } } },
  });
  const html = renderToHtml(createElement(mod.ProfileRoot, {}));
  assert.ok(html.includes('id="profile-week-share-sheet"'));
  assert.ok(html.includes(message('profile:weekShare.title')));
  assert.ok(html.includes(message('profile:weekShare.note')));
  assert.equal((html.match(/id="profile-week-share-(time|apps|merged|built|challenges)"/g) || []).length, 5);
  assert.ok(html.includes('id="profile-week-share-copy"'), 'Copy is always offered');
  assert.ok(html.includes(message('profile:weekShare.preview')));
  assert.ok(html.includes('My week on Homeroom: 3h 40m time in apps'));
});

test('sharing is local: the card sends nothing and records nothing', () => {
  const sheet = read(SHEET);
  assert.ok(!/fetch\(|XMLHttpRequest|\.send\(|api\/me\//.test(sheet), 'no request of any kind');
  assert.match(sheet, /navigator\.share/, 'the device\'s own share menu');
  assert.match(sheet, /navigator\.clipboard\.writeText/, 'and a clipboard copy');
  // The store adds no write either.
  assert.ok(!/POST|PATCH|DELETE/.test(read(STORE).slice(read(STORE).indexOf('export function shareWeekView'))));
});
