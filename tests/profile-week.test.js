'use strict';

// Me's "This week" list (#5964): the apps the viewer was in since Monday
// 00:00 UTC and the minutes in each, under Rewards on their own profile.
//
// The server half — the SQL, the week boundary, the cap and the ?demo=1
// overlay — is pinned in tests/me-summary.test.js, where the SQL also runs
// against a real database. This file pins what the CLIENT says: the shaping
// in profile-store.js (`weekView`), the catalog ids it asks for, and where
// the panel sits.
//
// Run with: node --test tests/profile-week.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';

const sum = (apps, totalSeconds) => ({ weekStart: '2026-10-26T00:00:00.000Z', totalSeconds, apps });

test('the week says each app\'s minutes, rounded down, with the total in the heading', () => {
  const { weekView } = loadTsx(STORE);
  const view = weekView({
    week: sum([
      { slug: 'pixel-board', name: 'Pixel Board', iconEmoji: '🎨', iconUrl: null, seconds: 840 },
      { slug: 'book-swap', name: 'Book Swap', iconEmoji: null, iconUrl: '/app-icons/abc', seconds: 59 },
      { slug: 'word-grid', name: 'Word Grid', iconEmoji: '🧩', iconUrl: null, seconds: 245 },
    ], 840 + 59 + 245),
  });
  assert.equal(view.totalMinutes, 19, 'the heading is floored once, over every second');
  assert.equal(view.heading, message('profile:week.heading', { count: 19, number: '19' }));
  assert.deepEqual(view.apps.map((a) => [a.slug, a.minutes, a.label]), [
    ['pixel-board', 14, message('profile:week.minutes', { count: 14, number: '14' })],
    ['book-swap', 0, message('profile:week.underMinute')],
    ['word-grid', 4, message('profile:week.minutes', { count: 4, number: '4' })],
  ]);
  assert.equal(view.note, message('profile:week.note'));
  assert.equal(view.apps[1].iconUrl, '/app-icons/abc');
});

test('the heading and the row both read "minute" for one', () => {
  const { weekView } = loadTsx(STORE);
  assert.equal(weekView({ week: sum([{ slug: 'a', name: 'A', seconds: 60 }], 60) }).heading,
    'This week · 1 minute');
  assert.equal(weekView({ week: sum([{ slug: 'a', name: 'A', seconds: 60 }], 60) }).apps[0].label, '1 minute');
  assert.equal(weekView({ week: sum([], 600) }).heading, 'This week · 10 minutes',
    'a total with no app rows still has a heading');
});

test('no week, or an empty one, draws nothing at all', () => {
  const { weekView } = loadTsx(STORE);
  assert.equal(weekView(null), null, 'a failed or unfinished read is not a section');
  assert.equal(weekView({}), null);
  assert.equal(weekView({ week: null }), null);
  assert.equal(weekView({ week: sum([], 0) }), null, 'a week with no counted time shows nothing');
});

test('the total comes from every app, not from adding the rounded rows up', () => {
  const { weekView } = loadTsx(STORE);
  // Two apps under a minute each: no row can say "0 minutes", but their
  // seconds are still the week's.
  const view = weekView({ week: sum([
    { slug: 'a', name: 'A', seconds: 40 },
    { slug: 'b', name: 'B', seconds: 40 },
  ], 80) });
  assert.equal(view.totalMinutes, 1);
  assert.deepEqual(view.apps.map((a) => a.label), [message('profile:week.underMinute'), message('profile:week.underMinute')]);
});

test('every id the list asks for exists in the profile catalog', () => {
  const catalog = JSON.parse(read('frontend/locales/en/profile.json'));
  for (const id of ['week.heading_one', 'week.heading_other', 'week.minutes_one', 'week.minutes_other', 'week.underMinute', 'week.note']) {
    assert.ok(catalog[id], `${id} is in frontend/locales/en/profile.json`);
    assert.ok(catalog[id].description, `${id} says where it appears`);
  }
  const store = read(STORE);
  for (const id of ['profile:week.heading', 'profile:week.minutes', 'profile:week.underMinute', 'profile:week.note']) {
    assert.ok(store.includes(`'${id}'`), `profile-store.js asks for ${id}`);
  }
});

test('the panel sits right after Rewards, and is built from the shell\'s own primitives', () => {
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(view, /<RewardsPanel rows=\{view\.rows\} \/>\s*<WeekPanel week=\{view\.week\} \/>/,
    'This week is the list directly under Rewards');
  const panel = read('frontend/src/features/profile/account-panel.tsx');
  assert.match(panel, /<section id="profile-week" className="mt-2">/);
  assert.match(panel, /<SectionHeader>\{week\.heading\}<\/SectionHeader>/);
  assert.match(panel, /<GroupedList className="mx-0" tone="plane">/);
  assert.match(panel, /data-week-app=\{app\.slug\}/);
  assert.match(panel, /chevron=\{false\}/, 'a row that only reports has no arrow');
});
