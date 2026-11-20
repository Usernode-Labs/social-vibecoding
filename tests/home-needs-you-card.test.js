'use strict';

// Home's card in `#home-aside` (frontend/src/features/home/needs-you-card.tsx):
// it was the Needs you card and, since #6816, lists the project's recent
// threads, the same list the notifications sheet's Recent threads tab shows.
// The file, the component and the id keep the names they had, because the
// look's CSS knows the section by `#home-needs-card`.
//
//   1. It is drawn where there is a thread to list, as a section: its label
//      line on the page, then one card.
//   2. A row is two lines beside the project's 40px tile: its title, then
//      the project and how long ago (19 Nov 2026). No pill: a row here is not
//      something asked of the viewer.
//   3. Beside Pinned apps the column lists as many as fit; everywhere else
//      it lists NEEDS_ROWS. The heading opens the rest: no count, no "more"
//      row.
//
// Run with: node --test tests/home-needs-you-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/needs-you-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const thread = (threadId, extra = {}) => ({
  threadId,
  kind: 'change',
  number: threadId + 100,
  title: `Thread ${threadId}`,
  appSlug: 'plant-pal',
  appName: 'Plant Pal',
  lastAt: '2026-11-18T09:00:00.000Z',
  href: `#app/plant-pal/dev/changes/${threadId + 100}`,
  ...extra,
});

test('the island mounts it under Standard (WIP) and the brand look, in a row of its own before Challenges', () => {
  const island = read('frontend/src/features/home/index.tsx');
  // Standard (WIP) mounts it as soon as the look and the viewer are known, so its
  // place is held from the first paint; the brand look mounts it with the grid.
  assert.match(island, /const aside = wip \? viewer : brand && grid\.ready && !!grid\.create;/);
  assert.match(island, /\{wip \|\| brand \? \(\s*<div id="home-row" className="home-row">\s*\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NeedsYouCard \/>\s*<\/aside>\s*\) : null\}\s*<ChallengesSection \/>\s*<\/div>\s*\) : null\}/);
  assert.match(island, /\{wip \|\| brand \? null : <ChallengesSection \/>\}/, 'every other look keeps Challenges in its own place');
  // A row of its own, as wide as the column, placed right under Pinned projects.
  const css = read('public/css/app.css');
  assert.match(css, /html:not\(\[data-skin\]\) \.home-row > \.home-aside > \* \{ flex: 1 1 auto; min-width: 0; \}/);
  assert.match(css, /html:not\(\[data-skin\]\) #home-screen \.home-main > \.home-row \{ display: contents; \}/);
  assert.match(css, /html:not\(\[data-skin\]\) #home-screen \.home-row > \.home-aside \{ order: 1; \}/);
});

test('it is a section as Pinned apps is: its label line on the page, then one card of recent threads', () => {
  const src = read(CARD);
  assert.match(src, /const count = feed \? \(serverTotal \?\? feed\.length\) : hint;/);
  assert.match(src, /const drawn = feed \? feed\.length > 0 : hint > 0;/);
  assert.match(src, /if \(!drawn\) return null;/);
  assert.match(src, /<section ref=\{sectionRef\} id="home-needs-card" aria-label=\{t\('home:needsCard\.eyebrow'\)\} data-threads=\{String\(count\)\}>/);
  // The label and a chevron are one thing to press, opening the sheet's own
  // list; it is a button, because the list is a sheet not a page.
  assert.match(src, /<SectionHeading>\s*<WipHeadMore\s+id="home-needs-card-btn"\s+direction="right"\s+onClick=\{openThreadsList\}/);
  assert.match(src, /<span id="home-needs-card-title" className="wip-head-words">\{t\('home:needsCard\.eyebrow'\)\}<\/span>\s*<\/WipHeadMore>/);
  assert.match(src, /label=\{t\('home:needsCard\.seeAll'\)\}/, 'it has no words of its own on screen, so its name says what it opens');
  assert.equal(message('home:needsCard.eyebrow'), 'Recent threads');
  assert.equal(message('home:needsCard.seeAll'), 'See all');
  // 19 Nov 2026: no count. How many threads the viewer ever took part in
  // (3524 for an admin) is not news on a card of recent ones.
  assert.doesNotMatch(src, /wip-count|home:needsCard\.(total|seeAllCount)/);
  // The card holds the list alone.
  assert.match(src, /<WipCard className="wip-panel" data-tone="ask">\s*<ul ref=\{listRef\} className="wip-rows wip-rows-cols"/);
});

test('the list is the sheet\'s own recent threads, read once where the card is drawn', () => {
  const src = read(CARD);
  const { THREADS_LIMIT } = loadTsx(CARD);
  assert.equal(THREADS_LIMIT, 50, 'the page\'s own maximum: more than any column lists');
  assert.doesNotMatch(src, /matchMedia/, 'the card is drawn at every width, so nothing waits on one');
  assert.doesNotMatch(src, /needs-feed/, 'what waits for a vote is not this card any more');
  assert.match(src, /sharedJson<\{ threads\?: RecentThreadItem\[\]; total\?: number \}>\(/);
  assert.match(src, /`\/api\/me\/recent-threads\?limit=\$\{THREADS_LIMIT\}\$\{demoQuery\(\)\}`/);
  assert.match(src, /setServerTotal\(Number\.isFinite\(Number\(body\.total\)\) \? Number\(body\.total\) : body\.threads\.length\)/, 'the count is the whole list\'s, not one page\'s');
});

test('while the list is on its way the card holds its place, from what the last visit saw', () => {
  const src = read(CARD);
  const { NEEDS_HINT_KEY } = loadTsx(CARD);
  assert.equal(NEEDS_HINT_KEY, 'homeroom:recent-threads');
  // The count of the last visit stands in until this load's list arrives, and is kept once it does.
  assert.match(src, /const \[hint\] = useState\(readNeedsHint\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(feed\) writeNeedsHint\(count\); \}, \[feed, count\]\);/);
  // Zero is removed, so somebody with no threads gets no placeholder to flash and go.
  assert.match(src, /if \(count > 0\) window\.localStorage\.setItem\(NEEDS_HINT_KEY, String\(count\)\);\s*else window\.localStorage\.removeItem\(NEEDS_HINT_KEY\);/);
  // As many placeholder rows as the last visit saw, in the list's own columns, said once in words.
  assert.match(src, /\{!feed \? \(/);
  assert.match(src, /<WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label=\{t\('home:grid\.loading'\)\}>/);
  assert.match(src, /Array\.from\(\{ length: Math\.min\(hint, NEEDS_ROWS\) \}, \(_, i\) => <li key=\{i\}><WipSkelRow \/><\/li>\)/);
});

test('beside Pinned apps it lists as many as fit, and the heading opens the rest', () => {
  const { needsLayout, NEEDS_ROWS } = loadTsx(CARD);
  const feed = Array.from({ length: 16 }, (_, i) => thread(i + 1));
  assert.equal(NEEDS_ROWS, 8, 'where the column cannot be measured it lists two lines of four');
  assert.deepEqual(needsLayout(feed, null), { rows: feed.slice(0, NEEDS_ROWS), more: 8 }, 'no measurement: as it always listed');
  // 19 Nov 2026: every row of the space is a thread; no row goes to "N more".
  const { rows, more } = needsLayout(feed, 7);
  assert.equal(rows.length, 7, 'as many threads as fit');
  assert.equal(more, 9, 'and how many it could not list, which the card does not draw');
  const two = feed.slice(0, 2);
  assert.deepEqual(needsLayout(two, 7), { rows: two, more: 0 }, 'a short list lists all of itself and ends there');
  assert.deepEqual(needsLayout(feed, 16), { rows: feed, more: 0 }, 'everything fits');
  assert.deepEqual(needsLayout(feed, 2).rows, feed.slice(0, 2), 'room for two is two threads');
  // A list longer than the page the card asked for counts what it could not have asked for either.
  const long = needsLayout(feed, 7, 40);
  assert.deepEqual([long.rows.length, long.more], [7, 33]);
  const src = read(CARD);
  // It measures the column beside Pinned apps only: the page's grid puts the aside in column 2.
  assert.match(src, /getComputedStyle\(aside\)\.gridColumnStart !== '2'/);
  assert.match(src, /new ResizeObserver\(measure\);/);
  assert.match(src, /aside\.clientHeight - \(heading\?\.offsetHeight \|\| 0\) - padding/);
  // No "3517 more" row: the heading is the way to the rest.
  assert.doesNotMatch(src, /wip-row-more|data-threads-more|home:needsCard\.more/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /#home-needs-card \.wip-rows > li:nth-child\(n \+ 6\)/, 'nothing is hidden after the fifth');
  assert.doesNotMatch(css, /#home-needs-card \.wip-row-more/);
});

test('the heading opens the sheet on its Recent threads list', () => {
  const src = read(CARD);
  assert.match(src, /import \{ notificationsSheetStore \} from '\.\.\/notifications\/notifications-sheet-store\.js';/);
  assert.match(src, /try \{ notificationsSheetStore\.set\(\{ tab: 'threads' \}\); \}/);
  assert.match(src, /if \(typeof win\.App\?\.openNotificationsSheet === 'function'\) \{ win\.App\.openNotificationsSheet\(\); return; \}/);
  assert.match(src, /win\.NotificationsSheet\?\.open\?\.\(\);/);
  // The sheet picks the tab up as it opens, and clears the request.
  const sheet = read('frontend/src/features/notifications/notifications-sheet.tsx');
  assert.match(sheet, /if \(!open \|\| !wantedTab\) return;\s*setTab\(wantedTab\);\s*notificationsSheetStore\.set\(\{ tab: null \}\);/);
});

test('a row is the project\'s tile, the thread\'s title, then the project and how long ago', () => {
  const src = read(CARD);
  const { kindId } = loadTsx(CARD);
  assert.equal(kindId({ kind: 'change', number: 6800 }), 'home:needsCard.kind.change');
  assert.equal(kindId({ kind: 'change', number: null }), 'home:needsCard.kind.changeBare');
  assert.equal(kindId({ kind: 'decision', number: null }), 'home:needsCard.kind.decision');
  assert.equal(kindId({ kind: 'request', number: 6790 }), 'home:needsCard.kind.request');
  assert.equal(kindId({ kind: 'request', number: null }), 'home:needsCard.kind.requestBare');
  assert.equal(message('home:needsCard.kind.change'), 'Change #{{number}}');
  assert.equal(message('home:needsCard.kind.request'), 'Request #{{number}}');
  assert.equal(message('home:needsCard.kind.decision'), 'Decision');
  assert.equal(message('home:needsCard.meta'), '{{project}} · <0>{{when}}</0>');
  // The same app tile the notifications sheet draws, from the same two pieces, 40px beside two lines.
  assert.match(src, /from '\.\.\/apps\/app-card-view'/);
  assert.match(src, /data-icon=\{appIconKind\(app\)\}\s*className="app-icon-tile w-10 h-10 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"\s*>\s*<AppIconContent app=\{app\} \/>/);
  // Two lines, 15 over 13: the title, then the project and when. Not what
  // kind of thread it is nor its number (asked 19 Nov 2026), except as the
  // title of a thread with none of its own, never the project's name.
  assert.doesNotMatch(src, /wip-item-kind/);
  assert.match(src, /<b className="wip-item-title block text-\[15px\] font-\[650\] truncate">\s*\{thread\.title \|\| t\(kindId\(thread\), \{ number: thread\.number == null \? '' : String\(thread\.number\) \}\)\}\s*<\/b>/);
  assert.match(src, /<RichMessage\s+id="home:needsCard\.meta"\s+values=\{\{ project: app\.name, when \}\}\s+components=\{\[<time title=\{whenTitle\} \/>\]\}\s*\/>/);
  // No waiting time: the project's name alone.
  assert.match(src, /\) : \(\s*<span className="wip-item-meta block text-\[13px\][^"]*">\{app\.name\}<\/span>/);
  // No pill: these are not things asked of the viewer.
  assert.doesNotMatch(src, /wip-pill/, 'conversation is not a vote');
  assert.doesNotMatch(src, /home:needsCard\.(vote|advisoryPill)/);
});

test('a row is the thread\'s own page, and the card lists what is in the look\'s columns', () => {
  const src = read(CARD);
  assert.match(src, /<a className="wip-row" href=\{thread\.href\} data-recent-thread=\{thread\.threadId\}>/, 'a row is a link a new tab can open');
  assert.match(src, /<ul ref=\{listRef\} className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">/);
  // As many columns as the look has room for, the number Challenges' cards read too.
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-rows-cols \{ grid-template-columns: repeat\(var\(--wip-cols, 1\), minmax\(0, 1fr\)\);/);
  // Four from 1024px, where Pinned projects' own four columns become rows: the lists share their lines.
  for (const [at, n] of [['640px', 2], ['1024px', 4]]) {
    assert.match(css, new RegExp(`@media \\(min-width: ${at}\\) \\{ html:not\\(\\[data-skin\\]\\) \\{ --wip-cols: ${n}; \\} \\}`));
  }
  // A challenge is a card of its own, one of the same columns wide and a card gap from the next.
  assert.match(css, /\.wip-poster \{\s*display: flex;\s*flex: 0 0 calc\(\(100% - \(var\(--wip-cols, 1\) - 1\) \* var\(--wip-card-gap\)\) \/ var\(--wip-cols, 1\)\);/, 'a challenge is one of the same columns');
});

test('a challenge is its picture, then its words beside it, in a row that pages with an arrow at each end', () => {
  const src = read('frontend/src/features/home/panels/challenges.tsx');
  assert.match(src, /className=\{`\$\{WIP_CARD\} wip-poster`\}[\s\S]{0,400}<WipChallengeArt[\s\S]{0,200}<span className="wip-item-text">/, 'the picture first, the words in their own column');
  // An arrow is drawn only while there is more that way, and names where it goes.
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-back" aria-label=\{t\('home:challenges\.scrollBack'\)\} onClick=\{\(\) => page\(-1\)\}/);
  assert.match(src, /className="wip-rail-arrow wip-rail-arrow-on" aria-label=\{t\('home:challenges\.scrollOn'\)\} onClick=\{\(\) => page\(1\)\}/);
  assert.equal(message('home:challenges.scrollBack'), 'Earlier challenges');
  assert.equal(message('home:challenges.scrollOn'), 'More challenges');
  const css = read('public/css/app.css');
  assert.match(css, /\.wip-poster-art \{[^}]*width: var\(--wip-poster-art\);[^}]*height: var\(--wip-poster-art\);/);
  // A row keeps a project tile's own padding, so the two lists' icons start on the same lines.
  assert.match(css, /\.wip-row \{[^}]*padding: 0\.5rem var\(--wip-cell-pad\);/);
  // A poster is a card of its own (20 Nov 2026), so it has a card's padding,
  // and 4px more at its end, which keeps what it is worth clear of the arrow
  // drawn over that edge.
  assert.match(css, /\.wip-poster \{[^}]*padding: var\(--wip-card-pad\);\s*padding-inline-end: calc\(var\(--wip-card-pad\) \+ 0\.25rem\);/);
  // 19 Nov 2026: the brand look sets no --wip-cell-pad, so that padding fell
  // away and a recent thread's lines sat on the hairlines. Its rows are
  // padded top and bottom from 768px (a phone's rows are cards of their own).
  assert.match(css, /@media \(min-width: 768px\) \{\s*html\[data-skin="brand"\][^{]*#home-needs-card \.wip-row \{\s*padding: 0\.5rem 0;\s*\}\s*\}/);
});

test('each challenge is a card of its own, and the row around them draws none', () => {
  // 20 Nov 2026 (asked by the product owner): the posters were things in one
  // wide card; now each is the kit's card, and the row is no card at all.
  const row = (over) => ({
    eventId: 3, icon: null, illustration: null, illustrationTone: null, done: false,
    reward: '500 pts', state: 'new', stateLabel: 'Not started', fill: null, counted: false, earned: null, ...over,
  });
  const view = {
    key: 'challenges', title: 'Challenges', mode: 'next', heading: 'Next challenges', seeAll: true, note: null,
    rows: [
      row({ id: '11', goal: 'Use apps for 10 minutes', reward: '1,000 pts', state: 'progress', stateLabel: '1/10 Minutes this week', fill: 0.1, counted: true }),
      row({ id: '12', goal: 'Invite someone to Homeroom' }),
    ],
  };
  // The prerender's look is the standard one, which draws the kit's posters.
  const html = renderComponent('frontend/src/features/home/panels/challenges.tsx', 'ChallengesPanel', { view });
  assert.match(html, /<article class="home-panel" data-panel="challenges"[^>]*><div class="wip-posters-box" data-wip-challenges=""><div class="wip-posters">/,
    'the row is held by a box that is no card: no wip-card, no tone');
  const cards = [...html.matchAll(/<button type="button" class="([^"]*)" data-tone="([^"]*)" data-challenge-id="(\d+)"/g)];
  assert.deepEqual(cards.map((m) => [m[1], m[2], m[3]]), [['wip-card wip-poster', 'goal', '11'], ['wip-card wip-poster', 'goal', '12']],
    'each challenge is the kit\'s card, in the goal colours');
  assert.equal((html.match(/wip-card/g) || []).length, 2, 'the cards are the only cards');
  // Inside a card nothing changed: the picture, the goal, where the viewer
  // stands, what it is worth and the meter. Not an arrow of its own, nor
  // progress in a pill (an older design had both; asked to leave them out).
  for (const card of html.split('<button type="button" class="wip-card wip-poster"').slice(1)) {
    const body = card.slice(0, card.indexOf('</button>'));
    assert.match(body, /^[^>]*><span class="wip-poster-art" aria-hidden="true">[^<]*<\/span><span class="wip-item-text"><b class="wip-item-title">[^<]+<\/b><span class="wip-poster-facts"><span class="wip-item-meta">[^<]+<\/span><span class="wip-poster-worth">[^<]+<\/span><\/span><span class="wip-meter" aria-hidden="true"><span style="width:\d+%"><\/span><\/span><\/span>$/);
    assert.doesNotMatch(body, /<svg|wip-pill|wip-rail-arrow/);
  }

  const css = read('public/css/app.css');
  // The kit's card is the one recipe: its ground, its hairline, its corners.
  assert.match(css, /\n\.wip-card \{\s*border-radius: var\(--wip-card-radius\);\s*background-color: var\(--wip-card-bg\);\s*box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-card-shadow\);\s*\}/);
  // The box paints nothing; it holds the row's margins, so an arrow's 50% is the cards' middle.
  assert.match(css, /\n\.wip-posters-box \{ position: relative; display: flow-root; \}/);
  assert.doesNotMatch(css, /\.wip-posters-card/, 'the old card round the row is gone');
  // A card gap between two cards, and room inside the scroller for what a
  // card draws outside its box (its shadow, its focus ring), given back by
  // the margins so the cards stay on the column's lines.
  assert.match(css, /\n\.wip-posters \{\s*display: flex;\s*gap: var\(--wip-card-gap\);\s*margin-block: -0\.25rem -1rem;\s*margin-inline: calc\(var\(--wip-card-gap\) \/ -2\);\s*padding-block: 0\.25rem 1rem;\s*padding-inline: calc\(var\(--wip-card-gap\) \/ 2\);\s*overflow-x: auto;\s*scroll-snap-type: x mandatory;\s*scroll-padding-inline: calc\(var\(--wip-card-gap\) \/ 2\);/);
  // Under the pointer the Workshop board's card edge and shadow; the keyboard's card also wears a focus ring.
  assert.match(css, /\n\.wip-poster:is\(:hover, :focus-visible\) \{ box-shadow: inset 0 0 0 1px var\(--wip-card-line-hover\), 0 8px 22px -14px var\(--wip-card-line-hover\); \}/);
  assert.match(css, /#dev-kanban \.dev-ws-wrow:hover \{ box-shadow: inset 0 0 0 1px var\(--wip-card-line-hover\), 0 8px 22px -14px var\(--wip-card-line-hover\); \}/, 'the board\'s own, which the poster copies');
  assert.match(css, /\n\.wip-poster:focus-visible \{ outline: 2px solid var\(--wip-ink-action\); outline-offset: 2px; \}/);
  // The arrows sit centred on the edge of the card at their end; a phone's 12px gutter keeps them a little further in.
  assert.match(css, /\n\.wip-rail-arrow-back \{ inset-inline-start: -1rem; \}\n\.wip-rail-arrow-on \{ inset-inline-end: -1rem; \}\n@media \(max-width: 639\.98px\) \{\n  \.wip-rail-arrow-back \{ inset-inline-start: -0\.625rem; \}\n  \.wip-rail-arrow-on \{ inset-inline-end: -0\.625rem; \}\n\}/);
  // While it loads, the placeholder holds the same shape: card-shaped blocks a card gap apart, nothing round them.
  const pending = 'html:not\\(\\[data-skin\\]\\) #home-challenges-section\\.home-section-pending > \\.home-panel-body';
  assert.match(css, new RegExp(`${pending} \\{ padding: 0; \\}`));
  assert.match(css, new RegExp(`${pending} > div \\{\\s*flex-direction: row;\\s*gap: var\\(--wip-card-gap\\);`));
  assert.match(css, new RegExp(`${pending} > div > div \\{\\s*flex: 0 0 calc\\(\\(100% - \\(var\\(--wip-cols\\) - 1\\) \\* var\\(--wip-card-gap\\)\\) \\/ var\\(--wip-cols\\)\\);\\s*height: calc\\(var\\(--wip-poster-art\\) \\+ 2 \\* var\\(--wip-card-pad\\)\\);\\s*border-radius: var\\(--wip-card-radius\\);\\s*background-color: var\\(--wip-skeleton\\);\\s*\\}`));
});

test('a title\'s plain words have their own span, and a project\'s name is one size', () => {
  const css = read('public/css/app.css');
  // The brand kit's second drawing (V2), whose tokens this test also held, was removed on 20 Nov 2026.
  assert.ok(!css.includes('[data-wip-tokens="brand2"]'));
  // The stroke is on a title's words alone: the kit gives plain words their own span.
  assert.match(read('frontend/src/features/home/wip-kit.tsx'), /typeof children === 'string' \? <span className="wip-head-words">\{children\}<\/span> : children/);
  // A plain pill in a card that asks reads the card's own ink (Advisory was pale on yellow in the dark).
  assert.match(css, /--wip-ink-soft: var\(--wip-ask-ink\);/);
  // One size at every width, outside any media query.
  assert.match(css, /\nhtml:not\(\[data-skin\]\) #app-list \.app-card-title \{\s*font-size: var\(--wip-title-size\);/, 'at the start of a line: not inside a media query');
  // On a phone alone it is a size down: four across leaves a name about 85px.
  assert.match(css, /@media \(max-width: 639\.98px\) \{[^@]*html:not\(\[data-skin\]\) #app-list \.app-card-title \{ font-size: var\(--wip-title-size-phone\);/);
});

test('Standard (WIP): a project\'s hub folds Invite and Make it public into its hero, and keeps Needs you in For you\'s row', () => {
  const card = read('frontend/src/features/dev-board/workshop/community-card.tsx');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  // No Invite card and no Share it card under the look: both actions are the hero's.
  assert.match(ws, /const wipLook = isKitHome\(useLiveSkin\(\)\);/);
  assert.match(ws, /inviteCard=\{!kitHub\}/);
  assert.match(card, /if \(wipLook\) return null;/, 'Share it is not drawn under the look');
  assert.match(card, /\{wipLook \? <WipHeroPublic slug=\{slug\} name=\{displayName\} data=\{data\} \/> : null\}/);
  assert.match(card, /function WipHeroPublic\([^)]*\): ReactNode \{\s*if \(data\.audience !== 'solo' \|\| !data\.can_manage \|\| data\.audience_change\) return null;\s*return <MakePublic /, 'Make it public is offered to exactly whom Share it offers it');
  // Invite ends the line about who is here, for a member, and opens the same pane.
  assert.match(card, /\{member \? \(\s*<button type="button" className="wip-hub-meta-invite" data-ws-community-invite="" title=\{t\('project:communityCard\.invite\.title'\)\} onClick=\{openInviteLinks\}>/);
  assert.match(card, /\{wipLook \? null : \(\s*<>\s*\{member && !\(inviteCard && showsInviteHero\(data\) && !inviteClosed\) \? \(/, 'one Invite on the page');
  // The hero's scenery is for show.
  assert.match(card, /<span className="wip-hero-wash" data-scene=\{platform \? 'home' : String\(communityScene\(slug\)\)\} aria-hidden="true" \/>\s*<span className="wip-hero-art" aria-hidden="true">/);
  // The standard look's hub too (20 Nov 2026), and a project's preview beside the hero where there is one.
  assert.match(card, /const wipLook = isKitHome\(useLiveSkin\(\)\);/);
  assert.match(card, /const previewBeside = wipLook && !platform && !!data\.cover\?\.illustration_url;/);
  // Pointing at that picture plays the project's loop over it, as a featured card on Home does.
  assert.match(card, /\{data\.cover\?\.preview_url \? <CardPreview src=\{data\.cover\.preview_url\} \/> : null\}/);
  // Needs you stays in the row with nothing waiting, shaped as its neighbours.
  assert.match(hub, /if \(alone && !claims && !wipLook\) return null;/);
  assert.match(hub, /className="dev-ws-week-note wip-hub-door" data-ws-hub-needs-none=""/);
  const css = read('public/css/app.css');
  assert.match(css, /html:not\(\[data-skin\]\) #dev-workshop \[data-ws-hub-topics\] \{ display: none; \}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, 'For you is three across from 768px');
});

test('Standard (WIP): a project\'s empty Needs you says so as good news, with the ways on under it', () => {
  // The run knows no look: the two pieces beside it read it (project-needs.tsx).
  const flow = read('frontend/src/features/review-flow/review-flow.tsx');
  const beside = read('frontend/src/features/review-flow/project-needs.tsx');
  assert.match(flow, /<ProjectNeedsEmpty slug=\{slug\} project=\{project\} anchorRef=\{anchorRef\}>\s*<p ref=\{anchorRef as never\}[^>]*data-needs-empty="" data-review-flow="">/, 'the plain line is every other look\'s');
  assert.match(flow, /<ProjectWaysIn slug=\{slug\} project=\{project\} \/>/, 'under what waits, too');
  assert.match(beside, /return isKitHome\(useLiveSkin\(\)\) && !!slug && !!project;/);
  assert.match(beside, /if \(!drawn\) return children;\s*return \(\s*<div ref=\{anchorRef\} className="wip-needs" data-needs-empty="" data-review-flow="">/, 'the same hooks the plain line carries');
  assert.match(beside, /door\('1', 'workshop'[\s\S]{0,400}door\('3', 'discussion'[\s\S]{0,400}door\('2', 'status'/);
  assert.equal(message('communities:reel.caughtUp.title'), 'You\'re all caught up');
  assert.equal(message('communities:reel.caughtUp.next'), 'While you\'re here');
});

test('Standard (WIP): a board card\'s line says who and when first, then the item\'s number as a code', () => {
  const src = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(src, /<span className="dev-ws-wrow-sub">\{rowWords\(b, \{ whoFirst: wipLook \}\)\}<\/span>/);
  assert.match(src, /if \(opts\.whoFirst\) \{\s*if \(b\.by && opts\.by !== false\) parts\.push\(b\.by\);\s*if \(b\.ago && opts\.ago !== false\) parts\.push\(b\.ago\);\s*parts\.push\(codeWords\(b\)\);/);
  assert.equal(message('project:workRow.code.request', { number: 6465 }), 'R#6465');
  assert.equal(message('project:workRow.code.change', { number: 5990 }), 'PR#5990');
});

test('Standard (WIP): the board ties a request to the changes made for it, and opens on the board', () => {
  const { tiesOf } = loadTsx('frontend/src/features/dev-board/workshop/board-links.ts');
  const row = (noun, num, links) => ({
    getAttribute: (name) => ({ 'data-ws-noun': noun, 'data-ws-num': String(num), 'data-ws-for': links || null })[name] ?? null,
  });
  const request = row('request', 6464);
  const other = row('request', 6420);
  const change = row('change', 6460, '6464');
  const both = row('change', 6500, '6420,6464');
  const vote = row('vote', 2462);
  const rows = [request, other, change, both, vote];
  // From the request: each change made for it, request → change.
  assert.deepEqual(tiesOf(request, rows), [{ from: request, to: change }, { from: request, to: both }]);
  // From a change: the requests it is for that are on the board, still request → change.
  assert.deepEqual(tiesOf(both, rows), [{ from: request, to: both }, { from: other, to: both }]);
  assert.deepEqual(tiesOf(vote, rows), [], 'a vote is tied to nothing');
  // Nothing is written to the board: the drawing is a layer of its own on <body>.
  const src = read('frontend/src/features/dev-board/workshop/board-links.ts');
  assert.match(src, /document\.body\.appendChild\(svg\);/);
  assert.doesNotMatch(src, /classList|setAttribute\('class'|\.style\./, 'no class or style is written to a row');
  const row2 = read('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.match(row2, /\{\.\.\.\(board && wipLook && b\.n \? \{\s*'data-ws-noun': b\.noun,\s*'data-ws-num': String\(b\.n\),/);
  // The Workshop's door opens the board, and the board is by stage alone.
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /if \(!wipLook \|\| tab !== 'workshop'\) return;\s*if \(was === 'all' \|\| was === 'bot'\) return;\s*if \(traversed\.current\) \{ traversed\.current = false; return; \}\s*cameFrom\.current = 'all';\s*setTab\('all'\);/);
  assert.doesNotMatch(ws, /_setWorkshopGroup|GroupStrip/, 'in every look since request 6708: there is no switch to put on By stage');
  assert.match(ws, /useEffect\(\(\) => \(wipLook && tab === 'all' \? watchBoardLinks\(\) : undefined\), \[wipLook, tab\]\);/);
  // Advanced mode is on <html> for the look's one detail kept for it.
  assert.match(read('frontend/src/head.html'), /root\.setAttribute\('data-interface-mode', basic \? 'basic' : 'advanced'\);/);
  assert.match(read('public/css/app.css'), /html:not\(\[data-skin\]\)\[data-interface-mode="basic"\] #dev-kanban \[data-attr-field="category"\] \{ display: none; \}/);
});

test('Standard (WIP): the menu is the token set\'s own panel, and a pinned project says who is in it', () => {
  const css = read('public/css/app.css');
  // The sidebar and the phone's bar are one panel, drawn from the menu's tokens at every width.
  assert.match(css, /html:not\(\[data-skin\]\) #platform-tabs \{[^}]*background: var\(--wip-nav-bg\);[^}]*font-family: var\(--wip-nav-font\);/);
  assert.match(css, /html:not\(\[data-skin\]\) \{[^}]*--wip-nav-bg: #3c7bd8;/, 'the menu wears the brand\'s own sky, under the standard look too');
  assert.match(css, /\[aria-current="page"\] \{\s*background: var\(--wip-nav-on-bg\);\s*box-shadow: none;\s*color: var\(--wip-nav-on-ink\);/);
  // The brand is the logotype at the panel's top, and the top bar starts beside the panel.
  assert.match(css, /html:not\(\[data-skin\]\) #platform-tabs::before \{[^}]*mask: var\(--wip-nav-brand-logo\) left center \/ contain no-repeat;/);
  assert.match(css, /#platform-header \{ padding-inline-start: calc\(var\(--wip-nav-w\) \+ 1rem\); \}/);
  // A folded sidebar opens from its arrow alone.
  assert.match(read('frontend/src/features/nav/rail-peek.ts'),
    /export function enterPeek\(\): void \{\s*clearPeekTimer\(\);[^}]*!document\.documentElement\?\.hasAttribute\('data-skin'\)\) return;/);
  // A pinned project: members, then contributors, each on its line; no sentence; the same air on four sides.
  const grid = read('frontend/src/features/home/app-grid.tsx');
  assert.match(grid, /t\('home:grid\.tile\.members', \{ count: app\.members, formatted: app\.members\.toLocaleString\(\) \}\)/);
  assert.equal(message('home:grid.tile.members_other', { formatted: '1,284', count: 1284 }), '1,284 members');
  assert.match(read('frontend/src/features/home/home.js'), /members: Math\.max\(0, Number\(app\.member_count\) \|\| 0\),/);
  assert.match(css, /html:not\(\[data-skin\]\) #app-list \.app-card-desc \{ display: none; \}/);
  assert.match(css, /html:not\(\[data-skin\]\) #app-list \{ padding: var\(--wip-cell-pad\); \}/);
  // A recent thread is its title, its project and when, in every look now: there is no kind line to hide.
  assert.doesNotMatch(css, /#home-needs-card \.wip-item-kind/);
});

test('Standard (WIP): one token set draws it, the brand kit, and the others are gone', () => {
  const css = read('public/css/app.css');
  // The sets drawn and removed: eight on 19 Nov 2026, then the brand kit's second drawing and Highlighter on 20 Nov 2026.
  for (const gone of ['window', 'denim', 'afterdark', 'hands', 'shipped', 'frontpage', 'logosheet', 'greenhill', 'brand2', 'highlighter']) {
    assert.ok(!css.includes(`[data-wip-tokens="${gone}"]`), `${gone} has no rule`);
    assert.ok(!read('frontend/locales/en/settings.json').includes(`"experimental.wipTokens.${gone}"`), `${gone} has no name`);
  }
  // Every named set left in the stylesheet is the one the head draws the look with.
  assert.deepEqual([...new Set([...css.matchAll(/\[data-wip-tokens="([a-z0-9]+)"\]/g)].map((m) => m[1]))], ['brand']);
  const head = read('frontend/src/head.html');
  assert.match(head, /const WIP_TOKENS = 'brand';/);
  assert.match(head, /if \(skin === 'wip'\) root\.setAttribute\('data-wip-tokens', WIP_TOKENS\);\s*else root\.removeAttribute\('data-wip-tokens'\);/,
    'on whenever the look is, so a rule that asks for a token set always applies under it');
  assert.doesNotMatch(head, /TOKEN_SETS|homeroom:wip-tokens'\)|getTokens|setTokens/, 'nothing is stored or pinned for it');
  // It has a light rule and a dark rule.
  assert.match(css, /html:not\(\[data-skin\]\) \{[^}]*--wip-font: 'Geist',/);
  assert.match(css, /html\[data-skin-wip\]\[data-wip-tokens="brand"\]\.dark \{[^}]*--lit-ink: #fffeea;/);
  // The menus name the look by it: one entry, no 'wip:<set>' entries, no second menu.
  const picker = read('frontend/src/features/frame/look-picker.tsx');
  assert.ok(picker.includes("wip: 'settings:experimental.wipTokens.brand',"));
  assert.equal(message('settings:experimental.wipTokens.brand'), 'Homeroom brand kit (WIP)');
  assert.doesNotMatch(picker, /data-look-tokens/, 'no second menu for token sets');
  const skinMod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.deepEqual([...skinMod.LOOK_CHOICES], ['standard', 'wip', 'brand']);
  assert.equal(skinMod.WIP_TOKEN_SETS, undefined);
  assert.equal(skinMod.parseLookChoice, undefined);
  // The sidebar's logotype is drawn in the menu's own ink, over nothing of the bar's glass.
  assert.match(css, /html:not\(\[data-skin\]\) #platform-tabs::before \{[^}]*background: var\(--wip-nav-ink-strong\);/);
});
