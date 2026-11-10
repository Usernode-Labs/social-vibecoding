// The You tab in the one frame (frontend/src/features/profile/frame/you-
// frame.tsx), as the 2026-11-06 screen tour draws it (s44, s45): your handle
// as the title, one line about you, Edit profile; four numbers in one strip
// in place of the stat boxes and the bar chart; Your work as rows; usage
// said in rows of words; the season, friends, projects and Settings in the
// context column. It is the profile's own view (profile-store.js
// buildProfileView) with another face.
//
// Run with: node --test tests/you-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/profile/frame/you-frame.tsx';

const base = {
  identity: { name: '@snait', sub: 'Building since April 2026 · Changes live in 78 apps', avatarUrl: null, initial: 'S', bio: null, chips: [{ key: 'gh', label: 'Verified GitHub · lingash25' }] },
  stats: [{ key: 'live', value: '974', label: 'live' }, { key: 'challenges', value: '8', label: 'challenges' }, { key: 'kudos', value: '0', label: 'kudos', zero: true }],
  activity: { empty: false, time: '25m', apps: '21', appsLabel: 'apps opened', days: [] },
  rows: { changes: '974 live · 13 in progress', requests: '51 open · 714 done', requestsPending: false, feedback: '150 sent · 24 counted', votes: 'Latest: Ask for your location', challenges: 'Season 2 · rank #16 · 8 of 11 done', kudos: null, friends: 'Only you can see your friends' },
  slots: '11 apps made · no limit', admin: false,
  onEdit() {}, onFriends() {}, onSlots() {}, onFeedback() {},
};
const render = (over) => renderComponent(FRAME, 'YouFrame', { ...base, ...over }, { cache: false });

test('You is a page of the frame: your handle, one line about you, and Edit profile', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-you-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">@snait<\/h1><p class="fr-purpose">Building since April 2026 · Changes live in 78 apps · Verified GitHub · lingash25<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Edit profile<\/button><\/div><\/div>/s);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the numbers are one strip, and a zero says nothing', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">In numbers<\/h2><\/div><div class="fr-card"><div class="fr-facts fr-f2"><div class="fr-fact"><div class="fr-v">974<\/div><div class="fr-l">live<\/div><\/div><div class="fr-fact"><div class="fr-v">8<\/div><div class="fr-l">challenges<\/div><\/div><\/div><\/div>/);
  assert.doesNotMatch(html, />kudos</);
  assert.doesNotMatch(render({ stats: [{ key: 'live', value: '0', label: 'live', zero: true }] }), /In numbers/);
});

test('Your work is rows that open where the standard page\'s rows do', () => {
  const html = render();
  const rows = [...html.matchAll(/<a class="fr-row" href="([^"]+)"[^>]*><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">([^<]+)<\/span><span class="fr-s">([^<]+)<\/span>/gs)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(rows.slice(0, 4), [
    ['#homeroom-bot/history?kind=change', 'Your changes', '974 live · 13 in progress'],
    ['#homeroom-bot/history?kind=request', 'Your requests', '51 open · 714 done'],
    ['#profile?feedback', 'Your feedback', '150 sent · 24 counted'],
    ['#homeroom-bot/history?kind=vote', 'Your votes', 'Latest: Ask for your location'],
  ]);
});

test('this week is said in two rows of words, with no chart', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">This week<\/h2>.*?<span class="fr-t">25m in apps<\/span>.*?<span class="fr-t">21 apps opened<\/span>/s);
  assert.doesNotMatch(render({ activity: { empty: true } }), /This week/);
});

test('the context column: the season, then friends, projects and Settings; Admin for an admin', () => {
  const html = render();
  const side = html.slice(html.lastIndexOf('<div class="fr-stack">'));
  assert.match(side, /<h2 class="fr-cap">Rewards<\/h2>.*?<a class="fr-row" href="#leaderboard\/challenges">.*?<span class="fr-t">Challenges &amp; standings<\/span><span class="fr-s">Season 2 · rank #16 · 8 of 11 done<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">Account<\/h2>.*?<span class="fr-t">Friends<\/span><span class="fr-s">Only you can see your friends<\/span>.*?<span class="fr-t">App slots<\/span><span class="fr-s">11 apps made · no limit<\/span>.*?<a class="fr-row fr-sm" href="#settings">.*?<span class="fr-t">Settings<\/span>/s);
  assert.doesNotMatch(side, /href="#admin"/);
  assert.match(render({ admin: true }), /<a class="fr-row fr-sm" href="#admin">/);
});

test('the profile draws the kit\'s page under a look, from its own view, with its sheets', () => {
  const src = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /\{frame \? <YouInFrame view=\{view\} publicStatus=\{state\.publicStatus \|\| ''\} \/> : \(/);
  assert.match(src, /<YouFrame\s+identity=\{view\.identity\}/);
  assert.match(src, /onEdit=\{\(\) => Profile\.showEditSheet\(\)\}/);
  assert.match(src, /useFramePage\(\[tc\('core:tabs\.me'\)\], null\);/, 'the bar says You, as the tab does');
  assert.match(src, /<div className="lg:grid lg:grid-cols-\[minmax\(0,22rem\)_minmax\(0,1fr\)\]/, 'the standard page stays as written');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-you-frame\] #profile-screen \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/, 'the page has the frame\'s page area');
});

test('Public page is the head\'s second button while the page is live, and a group of the context column', () => {
  const live = render({ publicPage: { href: '#profile/snait', published: true, line: 'On: anyone with the link can view it, no account needed', status: '', onCopy() {} } });
  assert.match(live, /<div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Edit profile<\/button><a class="fr-btn fr-quiet" href="#profile\/snait"><svg[^>]*>.*?<\/svg>Open public page<\/a><\/div>/s);
  assert.match(live, /<h2 class="fr-cap">Public page<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-wrap"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Public profile<\/span><span class="fr-s">On: anyone with the link can view it, no account needed<\/span><\/span><svg class="fr-ic fr-go"[^>]*>.*?<\/svg><\/button><div class="fr-row fr-sm"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Copy public link<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm">Copy<\/button><\/div><\/div>/s,
    'the switch is in Edit profile, where it asks before publishing: the row opens it');
  assert.match(render({ publicPage: { href: '#profile/snait', published: true, line: 'On', status: 'Public link copied.', onCopy() {} } }), /<span class="fr-t">Copy public link<\/span><span class="fr-s">Public link copied\.<\/span>/, 'the copy says it did');
  const off = render({ publicPage: { href: '#profile/snait', published: false, line: 'Off: your profile has no public link', status: '', onCopy() {} } });
  assert.doesNotMatch(off, /Open public page|Copy public link/, 'nothing to open or copy while it is off');
  assert.match(off, /<span class="fr-t">Public profile<\/span><span class="fr-s">Off: your profile has no public link<\/span>/);
  assert.doesNotMatch(render(), /Public page|Public profile/, 'before the page knows: nothing');
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(view, /publicPage=\{view\.publicControls && !view\.publicControls\.moderationDisabled \? \{ href: view\.publicControls\.openHref, published: view\.publicControls\.published, line: view\.publicControls\.visibility, status: publicStatus, onCopy: \(\) => \{ void Profile\.copyPublicLink\(view\.publicControls\.openHref\); \} \} : null\}/);
});
