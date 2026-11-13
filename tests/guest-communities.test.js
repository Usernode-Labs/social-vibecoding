// The signed-out page about private communities
// (frontend/src/features/guest/guest-communities.tsx), at `/communities`.
//
// The landing's own pitch is the public library, apps anyone can edit. A
// private community is a different promise (its maker says who gets in and
// who approves a change), for somebody who runs a group, so it has a page
// of its own behind a door on the landing (features/auth/story.tsx). This
// holds:
//   - what the page says, top to bottom, and that its approval rules and
//     audiences are the product's own messages, not a second wording;
//   - its one way in, which says "Join the waitlist" while new accounts wait
//     and notes itself as where a sign-up came from;
//   - its address: the landing draws it at that pathname in the guest
//     Discover's place, and a visitor with no account may open it.
//
// Run with: node --test tests/guest-communities.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PAGE = 'frontend/src/features/guest/guest-communities.tsx';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const STORY = 'frontend/src/features/auth/story.tsx';

const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));
const render = (over = {}) => renderComponent(PAGE, 'GuestCommunities', { waitlist: true, onStart() {}, ...over }, {
  cache: false,
  stubs: { '../auth/sign-up-from': { noteSignUpFrom() {} } },
});

test('the page, top to bottom: who it is for, how it works, who decides, private until you say otherwise, and one way in', () => {
  const html = render();
  assert.deepEqual(text(html), [
    'Public apps',
    'An app for your group, made by your group.',
    message('auth:guest.groups.lead'),
    'Join the waitlist',
    'Want it open to everyone instead?', 'Make a public app', '.',
    'Made for groups like yours',
    'Friend groups', message('auth:guest.groups.for.friends.body'),
    'School clubs and classes', message('auth:guest.groups.for.school.body'),
    'Local clubs', message('auth:guest.groups.for.clubs.body'),
    'Studios and collectives', message('auth:guest.groups.for.studios.body'),
    'Neighborhoods', message('auth:guest.groups.for.neighbors.body'),
    'Towns and cities', message('auth:guest.groups.for.towns.body'),
    'How it works',
    message('auth:guest.groups.how.sub'),
    '1', 'Say what you need', message('auth:guest.groups.how.say.body'),
    '2', 'Invite your people', message('auth:guest.groups.how.invite.body'),
    '3', 'Change it together', message('auth:guest.groups.how.change.body'),
    'You choose who decides',
    message('auth:guest.groups.decides.lead'),
    'Anyone can suggest changes', 'Describe it. A coding agent builds it.',
    'You see it before you decide', 'Each change shows a before and after.',
    'You can configure who approves changes', 'Pick a rule and switch it any time.',
    message('dialogs:whoDecides.preset.you_or_the_group.name'), 'Where every group starts', message('dialogs:whoDecides.preset.you_or_the_group.line'),
    message('dialogs:whoDecides.preset.two_yeses.name'), message('dialogs:whoDecides.preset.two_yeses.line'),
    message('dialogs:whoDecides.preset.open_floor.name'), message('dialogs:whoDecides.preset.open_floor.line'),
    message('dialogs:whoDecides.preset.group_vote.name'), message('dialogs:whoDecides.preset.group_vote.line'),
    'Private until you say otherwise',
    message('auth:guest.groups.private.sub'),
    message('communities:sections.solo.noun'), message('auth:guest.groups.private.solo'),
    message('communities:sections.invited.noun'), message('auth:guest.groups.private.invited'),
    message('communities:sections.open.noun'), 'If the group ever votes to open it, it joins the', 'public apps', 'anyone can use.',
    'Bring your group.',
    message('auth:guest.groups.closing.body'),
    'Join the waitlist',
  ]);
  // One headline for the page; a heading for each of its five sections.
  assert.equal([...html.matchAll(/<h1 /g)].length, 1);
  assert.equal([...html.matchAll(/<h2 /g)].length, 5);
  // Six kinds of group, three steps, three points, four rules, three audiences.
  assert.equal([...html.matchAll(/<h3 /g)].length, 6 + 3 + 3 + 4 + 3);
});

test('the approval rules and the audiences are the product\'s own, in its order', () => {
  const html = render();
  // The four presets a community picks from, as the Who decides dialog lists
  // them; a new one starts on the first, and only that one says so.
  const { PRESET_KEYS, DEFAULT_PRESET } = require('../src/services/governance-rules');
  assert.deepEqual([...html.matchAll(/data-guest-groups-rule="([a-z_]+)"/g)].map((m) => m[1]), [...PRESET_KEYS]);
  assert.equal(DEFAULT_PRESET, PRESET_KEYS[0], 'the pill sits on the rule a new community has');
  assert.equal([...html.matchAll(/Where every group starts/g)].length, 1);
  assert.ok(html.indexOf('Where every group starts') < html.indexOf(message('dialogs:whoDecides.preset.two_yeses.name')));
  const src = read(PAGE);
  for (const key of PRESET_KEYS) {
    assert.match(src, new RegExp(`td\\('dialogs:whoDecides\\.preset\\.${key}\\.name'\\), line: td\\('dialogs:whoDecides\\.preset\\.${key}\\.line'\\)`));
  }
  // The three audiences are the Communities screen's nouns.
  for (const key of ['solo', 'invited', 'open']) assert.match(src, new RegExp(`tc\\('communities:sections\\.${key}\\.noun'\\)`));
  assert.equal(message('communities:sections.solo.noun'), 'Just you');
  assert.equal(message('communities:sections.invited.noun'), 'Private community');
  assert.equal(message('communities:sections.open.noun'), 'Public community');
});

test('one way in, which says what it does and notes where the sign-up came from', () => {
  const waiting = render({ waitlist: true });
  const open = render({ waitlist: false });
  // The same button at the top and in the closing band.
  assert.equal([...waiting.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Join the waitlist<\/button>/g)].length, 2);
  assert.equal([...open.matchAll(/<button [^>]*data-guest-groups-start=""[^>]*>Start a community<\/button>/g)].length, 2);
  assert.doesNotMatch(open, /Join the waitlist/);
  // Nothing else to press but the ways back to the public apps, plain links
  // to the guest Discover: this page and that one are two addresses of one
  // document.
  assert.equal([...waiting.matchAll(/<button /g)].length, 2);
  assert.deepEqual([...waiting.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/', '/', '/']);
  assert.match(waiting, /<a href="\/" data-guest-groups-back="" class="[^"]*">/);
  assert.match(waiting, /<a href="\/" data-guest-groups-public="" class="[^"]*">Make a public app<\/a>/);
  const src = read(PAGE);
  assert.match(src, /const start = \(\) => \{ noteSignUpFrom\('groups'\); onStart\(\); \};/);
  assert.match(src, /const startLabel = waitlist \? t\('auth:guest\.hero\.joinWaitlist'\) : t\('auth:guest\.groups\.start'\);/);
  // The server records that name and no other (tests/sign-up-from.test.js).
  assert.ok(require('../src/services/sign-up-from').SIGN_UP_FROM.includes('groups'));
  // No id of its own (tests/shell-id-inventory.test.js) and no drawing of its
  // own (tests/shell-icon-set.test.js): its glyphs are the shell's set.
  assert.doesNotMatch(waiting, / id="/);
  assert.doesNotMatch(src, /<svg|\sd="M/);
});

test('its address: the landing draws it at /communities in Discover\'s place, and anybody may open that document', () => {
  assert.equal(loadTsx(STORY).COMMUNITIES_PATH, '/communities');
  const landing = read(LANDING);
  // Read in the first render, as the invite path is; the prerender has no location.
  assert.match(landing, /useState\(\s+\(\) => typeof location !== 'undefined' && location\.pathname === COMMUNITIES_PATH,\s+\);/);
  assert.match(landing, /useEffect\(\(\) => \{ setOnGroupsPath\(location\.pathname === COMMUNITIES_PATH\); \}, \[\]\);/);
  // A project's page or a members' link's sheet named by the hash still comes first.
  assert.match(landing, /const groupsPage = guestPages && onGroupsPath && !guestProject && !linkPending && !gate;/);
  // In the guest Discover's place, under either drawing of it.
  assert.match(landing, /\{groupsPage \? \(\s+<GuestCommunities waitlist=\{accountsWait\} onStart=\{\(\) => setSheet\('start'\)\} \/>\s+\) : \(\s+<>/);
  const at = landing.indexOf('<GuestCommunities');
  assert.ok(at > 0 && at < landing.indexOf('<LandingFrame') && at < landing.indexOf('<GuestDiscover'));

  // A visitor with no account is who it is for: the anonymous redirect and
  // the waiting-room gate both leave that one pathname alone.
  const auth = read('src/middleware/auth.js');
  const source = auth.match(/function isSpaDocumentPath\(pathname\) \{[\s\S]*?\n\}/);
  assert.ok(source, 'isSpaDocumentPath is one function');
  const isSpaDocumentPath = new Function(`${source[0]}; return isSpaDocumentPath;`)();
  assert.equal(isSpaDocumentPath('/communities'), true);
  assert.equal(isSpaDocumentPath('/'), true);
  assert.equal(isSpaDocumentPath('/app/notes-9206f8'), true);
  // Narrow: nothing under it and nothing beside it.
  assert.equal(isSpaDocumentPath('/communities/'), false);
  assert.equal(isSpaDocumentPath('/communities/anything'), false);
  assert.equal(isSpaDocumentPath('/community'), false);
  assert.equal(isSpaDocumentPath('/dashboard'), false);
});
