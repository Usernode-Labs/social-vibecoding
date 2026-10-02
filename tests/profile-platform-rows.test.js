'use strict';

// The Me tab's two lists of rows (UI overhaul): "Your work" (Your changes,
// Your requests, Your votes) and "More" (Challenges & standings, Kudos,
// Friends, Settings), each row with a line under it that says what is behind
// it (`scrMe` in the prototype).
//
// #2718 made Challenges, Settings and the Admin console rows of the Profile
// screen, with the native node / wallet / staking readouts and Log out under
// them. The prototype's Me keeps three rows and puts the rest inside
// Settings (the spec's "Me, with Admin and Validator inside Settings"), so
// this pins the new shape and the four things that can go wrong on the way:
//
//   1. a destination reachable from nowhere, because a row left Me before its
//      new home existed (Admin and the native rows: tests/admin-console-entry-
//      row.test.js and tests/app-menu-wallet-validator.test.js pin Settings);
//   2. a button where an anchor belongs, which silently costs cmd-click,
//      middle-click, the context menu and drag-to-bookmark;
//   3. a row whose line claims something the data did not say;
//   4. Settings' line naming the admin console to an account without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const PANEL = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/profile/account-panel.tsx'), 'utf8');
// The code alone: the header explains where each moved row went, by name.
const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** One `<ListRow … />` element's source, from its opening tag to the next. */
function rowSource(src, id) {
  const at = src.indexOf(`id="${id}"`);
  const start = src.lastIndexOf('<ListRow', at);
  const next = src.indexOf('<ListRow', at);
  const end = next === -1 ? src.indexOf('</GroupedList>', at) : next;
  return src.slice(start, end);
}

const ROWS = [
  // Your work: the three views of the Your work screen, at addresses no
  // username can have (a username has no hyphen).
  ['profile-row-proposals', '#profile/your-changes'],
  ['profile-row-feedback', '#profile/your-requests'],
  ['profile-row-votes', '#profile/your-votes'],
  // More. App slots opens the create dialog, whose allowance card offers
  // "Request more" (#3250); `#create` is the same dialog's deep link.
  ['profile-row-app-slots', '#create'],
  ['profile-row-challenges', '#leaderboard/challenges'],
  ['profile-row-kudos', '#leaderboard/kudos'],
  // The Friends card over Me, by the address Profile.open() honours.
  ['profile-row-friends', '#profile?friends'],
  ['profile-row-settings', '#settings'],
];

test('the rows are anchors to their destinations', () => {
  for (const [id, href] of ROWS) {
    assert.ok(CODE.indexOf(`id="${id}"`) > 0, `#${id} must be a row of Me's "More" list`);
    const row = rowSource(CODE, id);
    assert.match(row, /as="a"/,
      `#${id} must be an anchor — cmd-click, middle-click, the context menu `
      + 'and drag-to-bookmark are the browser\'s to give, and only an anchor '
      + 'with an href gets them');
    assert.ok(row.includes(`href="${href}"`), `#${id} points at ${href}`);
    assert.match(row, /subtitle=/, `#${id} carries the line that says what is behind it`);
  }
});

test('in order: Your changes, requests, votes; then App slots, Challenges & standings, Kudos, Friends, Settings', () => {
  const order = ROWS.map(([id]) => CODE.indexOf(`id="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(CODE.indexOf('id="profile-work"') < CODE.indexOf('id="profile-more"'));
  // Friends opens its card in place on a plain click; the browser keeps the rest.
  assert.match(rowSource(CODE, 'profile-row-friends'), /if \(!plainClick\(event\)\) return;\s*event\.preventDefault\(\);\s*Profile\.showFriends\(\);/);
  const { validateUsername } = require('../src/services/usernames');
  for (const [, href] of ROWS.filter(([id]) => /proposals|feedback|votes/.test(id))) {
    const tail = href.split('/')[1];
    assert.equal(validateUsername(tail).ok, false, `${tail} can never be somebody's username`);
  }
});

test('App slots says the allowance in words, and opens the create dialog in place', () => {
  assert.match(rowSource(CODE, 'profile-row-app-slots'),
    /if \(!plainClick\(event\)\) return;\s*event\.preventDefault\(\);\s*\(window[^;]*\.App\?\.showCreateModal\?\.\(\);/);
  const { appSlotsLine } = loadTsx('frontend/src/features/dialogs/app-allowance.tsx');
  assert.equal(appSlotsLine(null, null), null, 'no allowance yet, no invented count');
  assert.equal(appSlotsLine({ used: 1, limit: 2, remaining: 1 }, null), '1 of 2 app slots used');
  assert.equal(appSlotsLine({ used: 2, limit: 2, remaining: 0 }, '2026-09-07T12:00:00Z'),
    '2 of 2 app slots used · more requested');
  assert.equal(appSlotsLine({ used: 3, limit: null, remaining: null }, null), '3 apps · no limit',
    'an admin without a slot limit is told so, not shown a fraction');

  const store = loadTsx('frontend/src/features/dialogs/app-allowance-store.js');
  store.seedAppAllowance({ appCreationQuota: { used: 1, limit: 2, remaining: 1 } });
  const allowance = loadTsx('frontend/src/features/dialogs/app-allowance.tsx', {
    stubs: { './app-allowance-store.js': store },
  });
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx', {
    stubs: { '../dialogs/app-allowance': allowance },
  });
  const html = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null } }));
  assert.match(html, /id="profile-row-app-slots"[\s\S]*?App slots[\s\S]*?1 of 2 app slots used/);
  assert.ok(html.indexOf('id="profile-row-app-slots"') < html.indexOf('id="profile-row-challenges"'));
});

test('the rows that moved to Settings are not on Me any more', () => {
  for (const gone of ['profile-row-admin', '<NodePillRow', '<WalletRow', '<StakingRow', 'Log out']) {
    assert.ok(!CODE.includes(gone), `${gone} lives in Settings now`);
  }
});

test('it renders the data\'s lines, and quiet fallbacks without them', () => {
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.MorePanel, {
    rows: { challenges: 'Season 3 · rank #3 · 2 of 7 done', kudos: '3 received', friends: '1 request waiting' },
  }));
  assert.match(html, /id="profile-more"/);
  assert.match(html, /Challenges &amp; standings/);
  assert.match(html, /Season 3 · rank #3 · 2 of 7 done/);
  assert.match(html, /Kudos on your changes/, 'the number is the stat card\'s; the row says what is behind it');
  assert.match(html, /1 request waiting/);
  const bare = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null } }));
  assert.match(bare, /This season’s challenges and standings/, 'no data, no invented rank');
  assert.match(bare, /Only you can see your friends/, 'and no count of friends, ever');
  assert.match(bare, /How many apps you can create/, 'no allowance yet, no invented count');

  const work = renderToHtml(createElement(mod.WorkPanel, {
    rows: { changes: '9 merged · 2 in progress', requests: '2 open · 1 done', votes: 'Latest: Timer sounds' },
  }));
  assert.match(work, /id="profile-work"/);
  assert.match(work, /Your work<\/h2>/);
  for (const line of ['Your changes', '9 merged · 2 in progress', 'Your requests', '2 open · 1 done', 'Your votes', 'Latest: Timer sounds']) {
    assert.ok(work.includes(line), line);
  }
  const quiet = renderToHtml(createElement(mod.WorkPanel, { rows: {} }));
  for (const line of ['Everything you have started', 'What you asked for, and where it stands', 'The changes and decisions you voted on']) {
    assert.ok(quiet.includes(line), line);
  }
});

test('Settings\' line names the console only for the capability', () => {
  // Read from the same published flag App.renderAdminButton writes — the
  // Admin row itself is in Settings now, and this line only describes it.
  assert.match(PANEL, /useVisibility\('switcher-row-admin', false\)/);
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const html = renderToHtml(createElement(mod.MorePanel, { rows: { challenges: null, kudos: null } }));
  assert.match(html, /Account, alerts, keys</, 'nothing published: no admin, no wallet');
  assert.doesNotMatch(html, /alerts, keys, (wallet, )?admin/);
});
