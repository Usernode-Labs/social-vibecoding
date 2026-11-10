// A public community's page for a visitor, in the one frame (frontend/src/
// features/guest/frame/project-frame.tsx), as the 2026-11-06 screen tour
// draws it (o22 to o25): the member's page, readable, with nothing pressed
// that needs membership without saying so. The product's own page
// (../guest-project.tsx) reads the data and keeps the state; under a look it
// hands both to this view.
//
// Run with: node --test tests/guest-project-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const VIEW = 'frontend/src/features/guest/frame/project-frame.tsx';

const APP = { slug: 'game-corner', name: 'Game Corner', description: 'Twelve small games.', url: 'https://gc.example', icon_emoji: '🎮', icon_url: null, icon_color: '#3b2d8f', requires_login: false, active_users: 41, merged_week: 2, last_merged_at: '2026-11-08T10:00:00Z' };
const OVERVIEW = {
  app: { ...APP, builders: 25, open_votes: 2 },
  votes: [
    { id: 7, pr_number: 70, title: 'Snake: wrap-around walls', summary: 'An option in the menu.', yes: 2, no: 0, pictures: { before: '/b.png', after: '/a.png' } },
    { id: 8, pr_number: 71, title: null, summary: null, yes: 0, no: 1, pictures: null },
  ],
  merged: [{ id: 3, title: 'Dark mode', summary: 'Follows the device.', merged_at: '2026-11-08T10:00:00Z' }],
  requests: { total: 3, more: false, items: [{ number: 12, title: 'A leaderboard' }, { number: 13, title: 'Sounds' }] },
};
const base = {
  app: APP, overview: OVERVIEW, loaded: true, tab: 'hub', onTab() {}, signedIn: false, pinned: false, onPin() {}, canTry: true,
  onIntent() {}, onOpenInside() {}, onShare() {}, now: Date.parse('2026-11-09T10:00:00Z'),
};
const render = (over) => renderComponent(VIEW, 'GuestProjectFrame', { ...base, ...over }, { cache: false });
const titles = (html) => [...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]);
const caps = (html) => [...html.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1].replace(/&#x27;/g, '\''));

test('the head: the community, what it is, and one primary button that needs no account', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-guest-project-frame="game-corner"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Game Corner<\/h1><p class="fr-purpose">Twelve small games\.<\/p><\/div>/);
  const acts = html.slice(html.indexOf('fr-acts'), html.indexOf('</div>', html.indexOf('fr-acts')));
  assert.match(acts, /<button type="button" class="fr-btn fr-line" aria-label="Share"><svg/);
  assert.match(acts, /<button type="button" class="fr-btn fr-line" aria-pressed="false">Pin<\/button><button type="button" class="fr-btn fr-line">Join<\/button><a class="fr-btn" href="https:\/\/gc\.example" data-guest-try="game-corner"><svg[^>]*>.*?<\/svg>Try it<\/a>/s);
  assert.match(render({ pinned: true }), /aria-pressed="true">Pinned<\/button>/);
  assert.match(render({ canTry: false }), /<button type="button" class="fr-btn" data-guest-use="">Sign in to use it<\/button>/, 'an app with no view for visitors says what it takes');
  assert.match(html, /<div class="fr-note"[^>]*><svg[^>]*>.*?<\/svg><div>You&#x27;re reading as a guest\. Sign in to vote, reply or ask for a change\.<\/div><\/div>/s);
});

test('the places are the page\'s tabs', () => {
  const html = render({ tab: 'workshop' });
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab(?: fr-on)?" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]),
    [['Hub', 'false'], ['Workshop', 'true'], ['Discussion', 'false']]);
});

test('the Hub: what is happening, what is up for a vote, what was voted in; who is here beside them', () => {
  const html = render();
  assert.deepEqual(caps(html), ['What\'s happening', 'Up for a vote', 'Recently voted in', 'People', 'From the chat']);
  assert.deepEqual(titles(html), ['2 changes up for a vote', '3 requests open', 'Updated 1d ago', 'Snake: wrap-around walls', 'A change', 'Dark mode', 'Built by 25 people', 'Public community', 'The chat is for members']);
  assert.match(html, /<button type="button" class="fr-row"[^>]*>.*?<span class="fr-t">Snake: wrap-around walls<\/span><span class="fr-s">2 for · 0 against<\/span><\/span><span class="fr-btn fr-quiet fr-sm">Vote<\/span><\/button>/s,
    'a vote is a row whose word says what a press starts');
  assert.match(html, /<span class="fr-t">Built by 25 people<\/span><span class="fr-s">41 people used it lately<\/span>/);
  assert.doesNotMatch(html, /<img[^>]*src="\/a\.png"/, 'the pictures are the Workshop\'s');
});

test('the Workshop: every vote with its before and after, then the requests', () => {
  const html = render({ tab: 'workshop' });
  assert.deepEqual(caps(html), ['Up for a vote', 'Requests', 'People'], 'who made it and who uses it stand beside every tab');
  assert.match(html, /<div class="fr-shots"><figure><img src="\/b\.png" alt="" loading="lazy"\/><figcaption>Before<\/figcaption><\/figure><figure><img src="\/a\.png" alt="" loading="lazy"\/><figcaption>After<\/figcaption><\/figure><\/div>/);
  assert.deepEqual(titles(html), ['Snake: wrap-around walls', 'A change', 'A leaderboard', 'Sounds', 'and 1 more', 'Built by 25 people', 'Public community']);
  assert.match(html, /<h2 class="fr-cap">Requests<\/h2><button type="button" class="fr-link">Ask for something<\/button>/);
  assert.match(render({ tab: 'workshop', overview: null, loaded: false }), /<div class="fr-card fr-pad">Loading…<\/div>/);
  assert.match(render({ tab: 'workshop', overview: { ...OVERVIEW, votes: [], requests: null } }), /Nothing is up for a vote right now\..*The requests can&#x27;t be shown right now\./s);
});

test('the Discussion says the chat is for members, with the way in', () => {
  const html = render({ tab: 'discussion' });
  assert.match(html, /<div class="fr-card fr-pad"><div class="fr-sub17">The chat is for members<\/div><p class="fr-purpose">Join Game Corner to read along and say hi\.<\/p><div class="fr-btnrow"><button type="button" class="fr-btn" data-guest-chat-join="">Join<\/button><\/div><\/div>/);
  const waiting = render({ tab: 'discussion', signedIn: true });
  assert.match(waiting, /You can join once you&#x27;re in/);
  assert.doesNotMatch(waiting, /data-guest-chat-join/, 'an account still in line is not offered a button that cannot work yet');
  assert.doesNotMatch(render({ signedIn: true }), /reading as a guest|>Join<|>Pin</);
});

test('every class is the kit\'s', () => {
  for (const tab of ['hub', 'workshop', 'discussion']) {
    const classes = [...render({ tab }).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    for (const c of classes) assert.match(c, /^fr(-|$)/, `${tab}: ${c} is not a kit class`);
  }
});

test('the product\'s page hands its data and state to the view under a look', () => {
  const src = read('frontend/src/features/guest/guest-project.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/, 'mounted after the first paint: the device\'s own look at once');
  assert.match(src, /if \(frame\) \{\s*return \(\s*<GuestProjectFrame/);
  assert.match(src, /overview=\{overview\}\s*loaded=\{loaded\}\s*tab=\{tab\}\s*onTab=\{setTab\}/, 'one read of the overview, one state, whichever look draws it');
  assert.doesNotMatch(src, /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/);
});
