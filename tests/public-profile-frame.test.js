// Someone's public profile in the one frame (frontend/src/features/profile/
// public-profile-card.tsx, its kit branch), as the 2026-11-06 screen tour
// draws it (s51, o26): a page with the person's name as its title, their
// handle as its sentence, Message and the friend button as its actions, who
// they are in the column and their verified links beside it. The card
// itself keeps the owner's preview and the standard look.
//
// Run with: node --test tests/public-profile-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const CARD = 'frontend/src/features/profile/public-profile-card.tsx';
const FRAME = ['glass', 'brandkit', 'workbench', 'paper', 'pastel', 'mosaic', 'sunrise', 'today', 'playground'];
const stubs = (look) => ({
  '../../lib/skin': { useLiveSkin: () => look, isFrameSkin: (s) => FRAME.includes(s) },
  './message-button': { MessageButton: ({ username }) => createElement('button', { type: 'button', 'data-message-person': username }, 'Message') },
  '../friends/friend-button': { FriendButton: ({ initialState }) => createElement('button', { type: 'button', 'data-friend': initialState }, 'Friends') },
  '../dialogs/report': { openReport() {} },
});
const PROFILE = { username: 'evan', displayName: 'Evan', bio: 'Building Homeroom.', avatarUrl: '/avatars/0123456789abcdef0123456789abcdef', links: { github: 'evan' } };
const render = (over = {}, look = 'glass') => renderComponent(CARD, 'PublicProfileCard', { profile: PROFILE, allowReport: true, allowMessage: true, friendship: { userId: 8, state: 'friends' }, ...over }, { cache: false, stubs: stubs(look) });

test('the page: their name, their handle, Message and the friend button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-public-profile-frame="evan"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Evan<\/h1><p class="fr-purpose">@evan<\/p><\/div><div class="fr-acts"><button type="button" data-friend="friends">Friends<\/button><button type="button" data-message-person="evan">Message<\/button><\/div><\/div>/);
  assert.match(html, /<h2 class="fr-cap">About<\/h2><\/div><div class="fr-card"><div class="fr-row"><span class="fr-av"[^>]*><img src="\/avatars\/0123456789abcdef0123456789abcdef"[^>]*\/><\/span><span class="fr-tx"><span class="fr-t">Evan<\/span><span class="fr-s">@evan<\/span><\/span><\/div><div class="fr-pad fr-bio">Building Homeroom\.<\/div><\/div>/);
  assert.match(html, /<h2 class="fr-cap">Verified<\/h2>.*?<a class="fr-row" href="https:\/\/github\.com\/evan"[^>]*>.*?<span class="fr-t">GitHub<\/span><span class="fr-s">Verified GitHub · evan<\/span>/s, 'their links in the side column');
  assert.match(html, /<button type="button" class="fr-link fr-bad-link" id="public-profile-report">Report user<\/button>/, 'the report affordance stays, at the foot');
});

test('without a name the handle is the title; the owner\'s preview and a visitor\'s page leave out what they may not do', () => {
  const html = render({ profile: { ...PROFILE, displayName: null, bio: null }, allowReport: false, allowMessage: false, friendship: null });
  assert.match(html, /<h1 class="fr-title">@evan<\/h1>/);
  assert.doesNotMatch(html, /fr-acts|fr-bio|public-profile-report/);
});

test('under the standard look the card is as it was', () => {
  const html = render({}, 'standard');
  assert.match(html, /^<article id="public-profile-card"/);
  assert.doesNotMatch(html, /data-public-profile-frame/);
  const src = read(CARD);
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/, 'mounted when the page is: the device\'s look at once');
  assert.doesNotMatch(src, /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/);
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.btn.to.includes('[data-public-profile-frame] button:is(.bg-violet-600,.bg-zinc-100)'), 'Message and the friend button wear the look\'s button');
});
