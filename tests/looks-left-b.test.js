// What the lanes and the fix pass left on Messages, a project's pages, a
// request's and a change's page, You, Challenges and Standings (looks v2,
// the leftovers of group B, 11 Nov 2026). Each test pins one item: what a
// look now draws, from which of the product's own parts, and that the
// standard look is where it was.
//
// Run with: node --test tests/looks-left-b.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const wear = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
const wearers = (root) => [wear[root].to, ...(wear[root].also || []).map((w) => w.to)];
/** A hand block of app.css, from its heading to the next one named. */
const block = (from, to) => {
  const a = css.indexOf(from);
  const b = css.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `the block "${from}" is in app.css`);
  return css.slice(a, b);
};
const rules = (text) => text.split('\n').filter((line) => line.startsWith('html'));
const LOOK = 'html[data-skin]:where(:not([data-skin="brand"]))';

test('the ⋯ of a request and a change wears the look: the popover on a desktop, the action sheet on a phone', () => {
  const hand = block('/* WHAT THE LANES LEFT, GROUP B (11 Nov 2026)', '/* YOU\'S DIALOGS');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu {`), 'the popover is dressed');
  assert.match(hand, /\.dev-card-menu \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);[^}]*box-shadow: var\(--fr-sh\), inset 0 0 0 1px var\(--fr-line\);/, 'the kit sheet\'s ground, shadow and edge');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu-item:hover:not(:disabled) { background: var(--fr-sunk); color: var(--fr-ink); }`), 'a row lights in the sunk tone, not the accent');
  assert.ok(hand.includes(`${LOOK} .dev-card-menu-item-danger:hover:not(:disabled) { background: var(--fr-bad-t); color: var(--fr-bad); }`));
  assert.match(hand, /\.un-action-card \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);/, 'the phone\'s sheet has the look\'s ground');
  assert.ok(hand.includes(`${LOOK} .un-action-btn.un-has-icon { justify-content: flex-start; gap: 14px; text-align: start; }`), 'a row with a glyph reads from the start, as the kit\'s row');
  assert.ok(hand.includes(`${LOOK} .un-action-btn.un-action-cancel { justify-content: center; color: var(--fr-mut); font-weight: 650; text-align: center; }`));
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'kit tokens only');
  // The menu is still the product's: nothing in its code knows a look.
  const view = read('public/js/app-view.js');
  assert.match(view, /menu\.className = 'dev-card-menu';/);
  assert.match(view, /PlatformUI\.actionSheet\(\{\n\s+actions: items\.filter/);
});

test('App slots, Share your week and Your feedback are the product\'s dialogs in the kit\'s sheet', () => {
  const hand = block('/* YOU\'S DIALOGS', '/* YOU BEFORE ITS DATA');
  const ids = '#profile-app-slots-sheet, #profile-week-share-sheet, #profile-feedback-sheet';
  assert.match(hand, new RegExp(`\\.un-modal:has\\(> :is\\(${ids}\\)\\) \\{\\n\\s+--un-modal-radius: 24px; --un-modal-padding: 24px;\\n\\s+background: var\\(--fr-solid, var\\(--fr-ground\\)\\);`), 'the modal is the kit\'s sheet');
  assert.ok(wearers('title').includes(':is(#profile-app-slots-sheet,#profile-week-share-sheet,#profile-feedback-sheet) h2'), 'the title wears the look\'s');
  const btn = wear.btn.also.find((w) => w.to === ':is(#profile-week-share-send,#profile-week-share-copy)');
  assert.deepEqual(btn && btn.parts, { quiet: '#profile-week-share-copy' }, 'Share is the look\'s button, Copy its quiet one');
  assert.match(hand, /#profile-app-quota \{\n\s+margin-bottom: 0; padding: 14px 16px; border: 0; border-radius: 16px;\n\s+background: var\(--fr-surface\); box-shadow: inset 0 0 0 1px var\(--fr-line\);/, 'the allowance box is the kit\'s card');
  assert.match(hand, /#profile-week-share-sheet \.rounded-2xl \{[^}]*background: var\(--fr-sunk\);/, 'the preview is the sunk box');
  assert.match(hand, /#profile-feedback-list \{ border-radius: 20px; background: var\(--fr-surface\); box-shadow: inset 0 0 0 1px var\(--fr-line\); \}/);
  for (const line of rules(hand)) {
    assert.match(line, /^html\[data-skin(="workbench")?\]/);
    assert.match(line, /#profile-(app-slots|week-share|feedback)-/, 'only these three dialogs');
    assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  }
  for (const file of ['app-slots-sheet.tsx', 'week-share-sheet.tsx', 'feedback-sheet.tsx']) {
    assert.doesNotMatch(read('frontend/src/features/profile', file), /isFrameSkin|useLiveSkin|components\/ui\/kit/, `${file} does not branch on the look`);
  }
});

test('You before its data is the kit\'s page at its own shape; the standard look keeps its outline', () => {
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(view, /if \(view\.kind === 'loading'\) return frame \? <YouLoading \/> : <ProfileSkeleton \/>;/);
  const html = renderComponent('frontend/src/features/profile/frame/you-frame.tsx', 'YouLoading', {}, { cache: false });
  assert.match(html, /^<div class="fr" data-you-frame="" data-you-loading="" role="status" aria-label="Loading your profile">/, 'one status, with the standard outline\'s words');
  assert.match(html, /<div class="fr-inner animate-pulse" aria-hidden="true">/);
  assert.equal((html.match(/class="fr-row"/g) || []).length, 6, 'a card of four rows and one of two');
  assert.ok(html.includes('<div class="fr-cols">'), 'two columns, as the page');
  const hand = block('/* YOU BEFORE ITS DATA', '/* STANDINGS, WHAT THE BOARD SAYS');
  assert.ok(hand.includes('html[data-skin] [data-you-loading] [data-sk] { display: block; border-radius: 6px; background: color-mix(in srgb, var(--fr-ink) 9%, transparent); }'));
});

test('Standings: the first read, a failed read and a board with no table are the kit\'s; a row\'s details too', () => {
  const hand = block('/* STANDINGS, WHAT THE BOARD SAYS', '/* THE BOARD IS THE STRIP');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-body > .bg-red-50 { padding: 12px 16px; border: 0; border-radius: 16px; background: var(--fr-bad-t); color: var(--fr-bad); font-size: 15px; font-weight: 500; }`), 'a failed read is the kit\'s bad note');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-body > p:not(#tc-lb-disclaimer) { padding: 64px 16px; color: var(--fr-mut); font-size: 15px; text-align: center; }`), 'private, empty and nobody left are the lone line');
  assert.match(hand, /#tc-lb-body \.animate-pulse > div > div \{ height: 10px; border-radius: 5px; background: var\(--fr-sunk\); \}/, 'the outline\'s blocks are the sunk tone');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-drill h3 { color: var(--fr-ink); font-size: 17px; font-weight: 650; line-height: 1.3; letter-spacing: -.01em; }`), 'the details\' name is the 17px heading');
  assert.ok(hand.includes(`${LOOK} [data-standings-cols] #tc-lb-drill .font-mono { color: var(--fr-ink); font-family: inherit; font-variant-numeric: tabular-nums; font-weight: 600; }`), 'figures line up by digit in the look\'s own type');
  assert.ok(hand.includes('html[data-skin="workbench"]:is([data-challenges-frame], [data-standings-frame]) #leaderboard-event-bar { max-width: 1240px; padding-inline: 28px; }'), 'the picker starts where Workbench\'s page does');
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  // The pane's states are still its own markup: one Body, no second drawing.
  const pane = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(pane, /if \(!view \|\| view\.state === 'loading'\) return <StandingsSkeleton \/>;/);
  assert.match(pane, /<div id="tc-lb-drill">/);
});
