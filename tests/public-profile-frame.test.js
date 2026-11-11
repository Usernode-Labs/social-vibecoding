// Someone's public profile in the one frame, version 2 (frontend/src/features/
// profile/public-profile-card.tsx, its kit branch; the tour's s51, s52): the
// person's picture and name as the head with their handle under it, the
// friend button and Message as its actions, their bio in the column with
// Report user under it, and their verified accounts beside it. The card
// itself keeps the owner's preview inside Edit profile and the standard look.
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
const PROFILE = { username: 'evan', displayName: 'Evan', bio: 'Building Homeroom.', avatarUrl: '/avatars/0123456789abcdef0123456789abcdef', links: { github: 'evan', x: 'evanx' } };
const render = (over = {}, look = 'glass') => renderComponent(CARD, 'PublicProfileCard', { profile: PROFILE, allowReport: true, allowMessage: true, friendship: { userId: 8, state: 'friends' }, ...over }, { cache: false, stubs: stubs(look) });

test('the page: their picture, name and handle in the head, the friend button and Message', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-public-profile-frame="evan"><div class="fr-inner"><div class="fr-head"><span class="fr-av" style="--fr-as:56px" aria-hidden="true"><img src="\/avatars\/0123456789abcdef0123456789abcdef"[^>]*\/><\/span><div class="fr-tx"><h1 class="fr-title">Evan<\/h1><p class="fr-purpose">@evan<\/p><\/div><div class="fr-acts"><button type="button" data-friend="friends">Friends<\/button><button type="button" data-message-person="evan">Message<\/button><\/div><\/div>/);
  assert.match(html, /<h2 class="fr-cap">About<\/h2><\/div><div class="fr-card fr-pad"><p class="fr-sub15">Building Homeroom\.<\/p><\/div><\/section>/, 'About is the bio and nothing else');
  assert.doesNotMatch(html, /fr-bio|fr-bad-link/, 'no class the kit does not define');
  assert.match(html, /<h2 class="fr-cap">Verified<\/h2>.*?<a class="fr-row" href="https:\/\/github\.com\/evan"[^>]*>.*?<span class="fr-t">GitHub<\/span><span class="fr-s">evan<\/span>.*?<a class="fr-row" href="https:\/\/x\.com\/evanx"[^>]*>.*?<span class="fr-t">X<\/span><span class="fr-s">@evanx<\/span>/s, 'their accounts in the side column, each by its handle');
  assert.match(html, /<div id="public-profile-report"><button type="button" class="fr-link fr-bad">Report user<\/button><\/div>/, 'Report user stays, under About');
  for (const gone of ['Recently live', 'Communities', 'Visibility', 'Copy link', 'Edit profile']) assert.doesNotMatch(html, new RegExp(gone));
});

test('without a display name the username is the title; no bio, no About; your own page has no buttons and no report', () => {
  const html = render({ profile: { ...PROFILE, displayName: null, bio: null }, allowReport: false, allowMessage: false, friendship: null });
  assert.match(html, /<h1 class="fr-title">evan<\/h1><p class="fr-purpose">@evan<\/p>/, 'as the standard card says it: the name, then the handle');
  assert.doesNotMatch(html, /fr-acts|>About<|public-profile-report/);
});

test('under the standard look, and in Edit profile\'s preview under any look, the card is as it was', () => {
  const html = render({}, 'standard');
  assert.match(html, /^<article id="public-profile-card"/);
  assert.doesNotMatch(html, /data-public-profile-frame/);
  const preview = render({ preview: true, allowReport: false, allowMessage: false, friendship: null }, 'glass');
  assert.match(preview, /^<article id="public-profile-card"/, 'a card in a dialog, not a page');
  assert.doesNotMatch(preview, /class="fr[ "-]/);
  assert.match(read('frontend/src/features/profile/profile-edit-sheet.tsx'), /<PublicProfileCard profile=\{controls\.profile\} allowReport=\{false\} preview \/>/);
  const src = read(CARD);
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\) && !preview;/, 'mounted when the page is: the device\'s look at once');
  assert.doesNotMatch(src, /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/);
  assert.equal((src.match(/import \{ useMessages \} from/g) || []).length, 1, 'one import of the catalog hook');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.btn.to.includes('[data-public-profile-frame] button:is(.bg-violet-600,.bg-zinc-100)'), 'Message and the friend button wear the look\'s button');
});
