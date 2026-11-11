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

// ── Messages' list (what lane M left) ──────────────────────────────────
const LIST = 'frontend/src/features/messages/frame-list.tsx';
const inboxRow = (key, title, over) => ({
  key, lead: null, title, line: 'Homeroom · Ready', time: null, timeTitle: null, fresh: null, status: null, active: false,
  href: `#messages/${key}`, onClick() {}, ...over,
});
const inbox = (over) => renderComponent(LIST, 'MessagesFrameList', {
  people: [inboxRow('4', 'evan', { time: '4d ago' })],
  agents: [
    inboxRow('s1', 'Simplify the admin console', { status: { text: 'Ready', kind: 'ok' }, unseen: { said: 'Unread', session: 5616 } }),
    inboxRow('s2', 'Sign-in: one way in', { status: { text: 'Ready', kind: 'ok' } }),
  ],
  tab: 'agents', onTab() {}, query: '', onQuery() {}, onNew() {},
  state: { loading: false, error: null, onRetry() {}, offline: false, empty: false, onStart() {}, searched: null },
  ...over,
}, { cache: false });

test('Messages: a change in flight with news not seen yet ends in the dot the standard row ends in', () => {
  const html = inbox();
  assert.match(html, /<span class="fr-pill fr-ok" data-kind="ok">Ready<\/span><span role="img" aria-label="Unread" data-inbox-unseen="" data-session-unread="5616"><\/span>/, 'after its state, said in words, with the notifications store\'s own hook');
  assert.equal((html.match(/data-inbox-unseen/g) || []).length, 1, 'only the row that has news');
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /const \{ sessionUnreadIds \} = useStoreState\(notificationsStore\) as \{ sessionUnreadIds: number\[\] \};/, 'read from the store the standard row reads');
  assert.match(pane, /unseen: sessionUnreadIds\.includes\(sn\.id\) \? \{ said: translate\('agent:menu\.row\.unread'\), session: sn\.id \} : null,/, 'in the standard row\'s words');
  assert.ok(css.includes('html[data-skin] [data-messages-frame-list] [data-inbox-unseen] { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fr-acc); }'));
});

test('Messages: the Agents tab says how many are working, as the standard heading does; none working says nothing', () => {
  assert.match(inbox({ working: '2 working' }), /<button type="button" class="fr-tab fr-on" aria-pressed="true">Agents<span class="fr-pill fr-mini" data-kind="none">2 working<\/span><\/button>/, 'a small grey word, not a count that asks for you');
  assert.match(inbox(), /<button type="button" class="fr-tab fr-on" aria-pressed="true">Agents<\/button>/);
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /working=\{asides\.agents\.text\}/, 'the standard heading\'s own aside');
});

test('Messages: under a look the pane keeps its place across a live re-sort and offers Oldest chats', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /const FRAME_ROW = '\[data-messages-frame-list\] a\.fr-row\[href\]';/, 'a kit row is told apart by its address');
  assert.match(pane, /const nodes = frame \? el\.querySelectorAll<HTMLElement>\(FRAME_ROW\) : el\.querySelectorAll<HTMLElement>\('\[data-inbox-row\]'\);\n\s+for \(const node of Array\.from\(nodes\)\) \{\n\s+const key = frame \? node\.getAttribute\('href'\) : node\.dataset\.inboxRow;/, 'one reader for both lists');
  assert.match(pane, /row = frame\n\s+\? Array\.from\(el\.querySelectorAll\(FRAME_ROW\)\)\.find\(\(node\) => node\.getAttribute\('href'\) === saved\.key\) \|\| null\n\s+: el\.querySelector\(keyedRow\(saved\.key\)\);/, 'and one correction');
  assert.match(pane, /\\u0000\$\{frame \? frameTab : ''\}`;/, 'the other tab is the reader moving the list: the held place is dropped');
  const branch = pane.slice(pane.indexOf('  if (frame) {\n    const me = Number'), pane.indexOf("aria-label={t('messages:inbox.listName')}"));
  assert.match(branch, /ref=\{scrollRef as RefObject<HTMLElement \| null>\}\n\s+onScroll=\{readAnchor\}/, 'the pane is the scroller under a look');
  assert.match(branch, /<InboxToEnd scroller=\{scrollRef\} \/>\n\s+<\/section>/, 'Oldest chats is the product\'s own button');
  assert.equal((pane.match(/<InboxToEnd scroller=\{scrollRef\} \/>/g) || []).length, 2, 'once in each list');
  const hand = block('/* MESSAGES\' LIST, WHAT LANE M LEFT', '/* NEW MESSAGE\'S DIALOG');
  assert.ok(hand.includes('html[data-skin] .messages-list-pane[data-frame-list] { overflow-anchor: none; }'), 'the browser\'s own anchoring is off, as on the standard scroller');
  assert.ok(hand.includes('html[data-skin] .messages-list-pane[data-frame-list] > [data-inbox-to-end] { position: sticky; bottom: 0; height: 0; }'), 'the button stays at the pane\'s foot');
  assert.match(hand, /\[data-inbox-to-end\] > div \{ bottom: calc\(var\(--fr-shell-bottom, 0px\) \+ 12px\) !important; \}/, 'over the look\'s own tab bar on a phone');
});

// ── All items (what lane P left) ───────────────────────────────────────
test('All items: a category\'s figures read on one line, its counts are the kit\'s pills, and By stage keeps its chips as the kit\'s', () => {
  const hand = block('/* What lane P left of a category\'s card', '/* WHO DECIDES (project-frame.tsx');
  const AT = 'html[data-skin] .dev-ws > [data-project-frame="all-items"] ~ .dev-ws-tabbody';
  assert.ok(hand.includes(`${AT} .dev-ws-stat { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }`), 'the figure, then its word (the mockup\'s "7 people | 7 items")');
  assert.ok(hand.includes(`${AT} .dev-ws-theme-people b { display: inline; }`));
  assert.ok(hand.includes(`${AT} .dev-ws-cnt > .dev-ws-dot { display: none; }`), 'a pill says its tone itself');
  assert.ok(hand.includes(`${AT} .dev-ws-cnt-review { background: var(--fr-wait-t); color: var(--fr-wait); }`));
  assert.ok(hand.includes(`${AT} .dev-ws-cnt-shipped { background: var(--fr-ok-t); color: var(--fr-ok); }`));
  assert.match(hand, /\[data-all-group="stage"\] ~ \.dev-ws-tabbody \.dev-ws-allbar :is\(#dev-kanban-filters-btn, \[data-quick-filter\]\) \{\n\s+height: 32px; padding: 0 14px; border: 0; border-radius: 999px;\n\s+background: var\(--fr-sunk\); color: var\(--fr-ink\);/, 'the chips over the board are the kit\'s small quiet buttons');
  assert.match(hand, /:is\(#dev-kanban-filters-btn, \[data-quick-filter\]\)\[aria-pressed="true"\] \{ background: var\(--fr-lit\);/, 'the pressed one is lit');
  for (const line of rules(hand)) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(/i, 'kit tokens only');
  // By stage has no side column because today's page has none: the three chips are all it has over the board.
  const frame = read('frontend/src/features/dev-board/workshop/frame/project-frame.tsx');
  assert.match(frame, /data-all-group=/);
  // "re-drafting categories…" is said in the label over the categories, which wears the kit's label.
  assert.ok(wearers('cap').some((to) => to.includes('.dev-ws-sort > .dev-ws-eyebrow')), 'the eyebrow that says it wears the kit\'s label');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /v\.meta\.source === 'ai' \? t\('project:allItems\.grouping\.redrafting'\) : t\('project:allItems\.grouping\.drafting'\)/);
});
