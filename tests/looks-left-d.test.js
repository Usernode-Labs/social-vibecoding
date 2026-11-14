// What groups A and B of the left-overs pass reported as left or as needing
// the shared kit and frame (looks v2, the leftovers of group D, 11 Nov
// 2026). Each test pins one item: what a look now draws, from which of the
// product's own parts, and that the standard look is where it was.
//
// Run with: node --test tests/looks-left-d.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement: h } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const kitCss = read('frontend/looks/kit.css');
const wear = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
const wearers = (root) => [wear[root].to, ...(wear[root].also || []).map((w) => w.to)];
const K = loadTsx('frontend/@/components/ui/kit.tsx');
const html = (el) => renderToHtml(el);
const LOOK = 'html[data-skin]:where(:not([data-skin="brand"]))';

// ── The kit ──────────────────────────────────────────────────────────────

test('Bars: where the days say themselves the chart is a list of them, as the standard chart is', () => {
  const days = [
    { id: '2026-11-09', label: 'Mon', value: 1, text: '37m', spoken: 'Monday: 37m' },
    { id: '2026-11-10', label: 'Tue', value: 0, spoken: 'Tuesday: no time', now: true },
  ];
  const out = html(h(K.Bars, { days, label: 'Time in apps each day' }));
  assert.match(out, /^<div class="fr-bars" style="--fr-bn:2" role="list" aria-label="Time in apps each day">/);
  assert.match(out, /<div class="fr-bcol" role="listitem" title="Monday: 37m" data-activity-day="2026-11-09"><span class="fr-sro">Monday: 37m<\/span><span class="fr-bv" aria-hidden="true">37m<\/span><i aria-hidden="true" style="height:100%"><\/i><span class="fr-bl" aria-hidden="true">Mon<\/span><\/div>/);
  assert.match(out, /<div class="fr-bcol fr-now fr-none" role="listitem" title="Tuesday: no time"[^>]*><span class="fr-sro">Tuesday: no time<\/span><span class="fr-bv" aria-hidden="true"><\/span><i aria-hidden="true"><\/i>/, 'an empty day keeps the grey baseline and is still said');
  assert.match(kitCss, /\n\.sro\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0,0,0,0\);white-space:nowrap\}/);
  // With no words for the days it is the picture it was.
  assert.match(html(h(K.Bars, { days: days.map(({ spoken, ...d }) => d), label: 'l' })), /role="img" aria-label="l"><div class="fr-bcol" aria-hidden="true">/);
  const you = read('frontend/src/features/profile/frame/you-frame.tsx');
  assert.match(you, /days=\{days\.map\(\(day\) => \(\{ id: day\.key, label: day\.label, value: day\.zero \? 0 : day\.heightPct \/ 100, text: day\.peakLabel, now: day\.today, spoken: day\.spoken \}\)\)\}/, 'You feeds it the standard chart\'s own sentence for each day');
});

test('Row: another site is a real link in a new tab, and data attributes pass through; Pill too', () => {
  assert.equal(html(h(K.Row, { title: 'GitHub', href: 'https://github.com/x', target: '_blank', 'data-k': 'v' })),
    '<a class="fr-row fr-sm" href="https://github.com/x" target="_blank" rel="noopener noreferrer" data-k="v"><span class="fr-tx"><span class="fr-t">GitHub</span></span></a>');
  assert.equal(html(h(K.Row, { title: 'Here', href: '#x' })), '<a class="fr-row fr-sm" href="#x"><span class="fr-tx"><span class="fr-t">Here</span></span></a>', 'a door inside the product is as it was');
  assert.match(html(h(K.Row, { title: 'B', onClick() {}, 'data-inbox-row': '12' })), /^<button type="button" class="fr-row fr-sm" data-inbox-row="12">/);
  assert.match(html(h(K.Row, { title: 'P', 'data-a': '1' })), /^<div class="fr-row fr-sm" data-a="1">/);
  assert.equal(html(h(K.Pill, { href: 'https://x.com/a', target: '_blank' }, 'Verified X')), '<a class="fr-pill" data-kind="none" href="https://x.com/a" target="_blank" rel="noopener noreferrer">Verified X</a>');
  const card = read('frontend/src/features/profile/public-profile-card.tsx');
  assert.doesNotMatch(card.slice(card.indexOf('if (frame) {'), card.indexOf('<PageBody')), /window\.open/, 'a Verified row no longer opens its site by script');
  assert.match(card, /href=\{link\.href\}\n\s+\/\/ [^\n]+\n\s+target="_blank"/);
  assert.match(read('frontend/src/features/profile/frame/you-frame.tsx'), /<Pill key=\{chip\.key\} href=\{chip\.href\} target=\{chip\.external \? '_blank' : undefined\}>/);
});

test('Av: a face says the initials it is given, as the standard Messages list says two for a name of two words', () => {
  assert.match(html(h(K.Av, { name: 'Deleted User', initials: 'DU' })), />DU<\/span>$/);
  assert.match(html(h(K.Av, { name: '@snait' })), />s<\/span>$/, 'with none given, the first letter as before');
  assert.match(read('frontend/src/features/messages/format.tsx'), /<KitAv size=\{px\} name=\{label\} initials=\{initials\(label\)\} /);
  assert.match(read('frontend/src/features/messages/index.tsx'), /lead: <KitAv size=\{40\} name=\{face\?\.username \|\| name \|\| '\?'\} initials=\{initials\(face\?\.username \|\| name \|\| '\?'\)\} /);
});

test('PicCard: with a control of its own the card is a group, its door over a foot', () => {
  const out = html(h(K.PicCard, { href: '/app/a', title: 'A', line: 'About', meta: '20 members', end: h('button', { type: 'button' }, 'Join'), 'data-home-join-card': 'a' }));
  assert.match(out, /^<div class="fr-card fr-fcard" data-home-join-card="a"><a class="fr-fdoor" href="\/app\/a">/);
  assert.match(out, /<\/a><div class="fr-fm"><span class="fr-fmt">20 members<\/span><button type="button">Join<\/button><\/div><\/div>$/, 'the button is beside the link, never inside it');
  assert.match(html(h(K.PicCard, { href: '/app/a', title: 'A' })), /^<a class="fr-card fr-fcard" href="\/app\/a">/, 'without one it is the link it was');
  const home = read('frontend/src/features/home/frame/home-frame.tsx');
  // Home's own directory no longer hands a card a control (#6609: no Join on a card), so there it is the link.
  assert.match(home, /picture=\{\(app\) => \(\{\n\s+flag: isNew\(app\) \? ta\('auth:guest\.card\.new'\) : undefined,\n\s+badge: [^\n]+\n\s+\}\)\}/, 'a member\'s directory is picture cards, each the door to its page');
});

// ── The frame ────────────────────────────────────────────────────────────

test('every native-kit modal, sheet, alert and menu wears the look by one rule', () => {
  const a = css.indexOf('/* EVERY MODAL, SHEET, ALERT AND MENU OF THE NATIVE KIT');
  const b = css.indexOf('/* YOU\'S DIALOGS', a);
  assert.ok(a > 0 && b > a);
  const hand = css.slice(a, b);
  assert.match(hand, new RegExp(`${LOOK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} :is\\(\\.un-modal, \\.un-sheet, \\.un-alert, \\.un-popover\\) \\{[^}]*--un-sheet-bg: var\\(--fr-solid, var\\(--fr-ground\\)\\);[^}]*background-color: var\\(--fr-solid, var\\(--fr-ground\\)\\);[^}]*color: var\\(--fr-ink\\); font-family: var\\(--fr-f\\);`));
  assert.ok(hand.includes(`${LOOK} .un-modal { --un-modal-radius: 24px; box-shadow: var(--fr-sh), inset 0 0 0 1px var(--fr-line); }`));
  assert.ok(hand.includes(`${LOOK} .un-modal:has(#feedback-form),\n${LOOK} .un-modal .feedback-actions { background-color: var(--fr-solid, var(--fr-ground)); }`), 'the feedback form and its sticky foot');
  assert.doesNotMatch(hand, /--dc-/, 'the shell\'s plane tokens are declared once per theme, never here');
  assert.ok(hand.includes(`${LOOK} .un-alert-btn.un-destructive { color: var(--fr-bad); }`));
  assert.ok(hand.includes(`${LOOK} .un-popover-item:is(:hover, :focus-visible):not(:disabled) { background: var(--fr-sunk); }`));
  assert.doesNotMatch(hand, /--un-modal-padding|\bwidth:/, 'padding and width stay each dialog\'s own');
  // The three You dialogs keep their closer fit, after the general rule.
  assert.ok(css.indexOf(`${LOOK} .un-modal:has(> :is(#profile-app-slots-sheet, #profile-week-share-sheet, #profile-feedback-sheet)) {`) > b);
});

test('the bar on a phone: a page may keep its parent\'s name, and no line stands under the bar (it was Main Chat\'s)', () => {
  const frame = read('frontend/src/features/frame/frame-app.tsx');
  // 14 Nov 2026: the line under the title was Main Chat's alone; it and the
  // row it moved to when it did not fit went with Main Chat.
  assert.doesNotMatch(frame, /lineUnder|crumbLine|data-frame-crumb-line/);
  assert.match(frame, /<\/header>\n\s+<main className=\{k\('pagearea'\)\}/);
  assert.match(frame, /const kept = page\.crumb && page\.phoneUp && crumbs\.length > 1 \? crumbs\.length - 2 : crumbs\.length - 1;/);
  assert.match(frame, /k\('ci', i === crumbs\.length - 1 && 'here', i === kept && 'keep'\)/);
  assert.doesNotMatch(kitCss, /\.barline|\.crumb \.cs\.off/);
  assert.match(kitCss, /\n\.phone \.crumb>\.keep\{color:var\(--ink\)\}/);
  assert.doesNotMatch(css, /\.fr-barline/);
  assert.match(read('frontend/src/features/leaderboard/frame/challenges-frame.tsx'), /framePageStore\.set\(\{ crumb, onBack: shellBack, phoneUp: true \}\);/, 'Challenges and Standings: the bar says You, the title says Challenges');
});

// ── The pages ────────────────────────────────────────────────────────────

test('a page under the Workshop says its name in the kit\'s head and its place in the bar; its own bar is put away', () => {
  const back = read('frontend/src/features/dev-board/workshop/page-back.tsx');
  assert.match(back, /const crumb = useMemo\(\(\) => \(frame \? \[label, title\] : null\), \[frame, label, title\]\);\n\s+useFramePage\(crumb, frame \? goBack : null, true\);/);
  assert.match(back, /<div className="dev-ws-pagehead" data-ws-pagehead="">/, 'the standard markup is what it was');
  assert.ok(css.includes('html[data-skin] .dev-ws > [data-project-frame] ~ .dev-ws-tabbody .dev-ws-pagehead { display: none; }'));
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /title=\{tab === 'workshop' && weekUp \? weekName\(weekUp\) : pageTitle\(tab\)\}/);
  assert.match(read('frontend/src/features/frame/frame-page-store.ts'), /framePageStore\.set\(phoneUp \? \{ crumb, onBack, phoneUp \} : \{ crumb, onBack \}\);/);
});

test('a week\'s page, the bot\'s slots, a topic\'s channel, a challenge\'s page and the made screen wear the look', () => {
  for (const to of ['[data-ws-bot-slots-body] > h2', ':is(.dev-ws-figs-head > h2,[data-topic-signals] > h2)', '#tc-se-detail-panel .ui-sechead']) assert.ok(wearers('cap').includes(to), `label: ${to}`);
  for (const to of [':is([data-ws-bot-slots-body] .ui-glist,.dev-ws-weekpage > .dev-ws-strip)', ':is(.dev-ws-figs-card,[data-topic-signals] > .ui-glist)', '#tc-se-detail-panel .ui-glist']) assert.ok(wearers('card').includes(to), `card: ${to}`);
  assert.ok(wearers('title').includes('#tc-se-detail-title'));
  assert.ok(wearers('btn').includes('#tc-se-detail-panel :is(a,button):is(.bg-violet-600,.bg-zinc-100)'));
  assert.ok(wearers('btn').includes('[data-first-session-made].platform-under-header button:is(.bg-violet-600,.bg-white)'));
  for (const head of ['/* HOMEROOM BOT\'S SLOTS under a look', '/* A WEEK\'S PAGE under a look', '/* A TOPIC\'S CHANNEL under a look', '/* A CHALLENGE\'S OWN PAGE under a look', '/* THE MADE SCREEN, from Create', '/* ON AN ITEM\'S PAGE, THE THREE SURFACES LANE T LEFT']) assert.ok(css.includes(head), head);
  // The made screen stands in the frame's page area, as Make does.
  assert.ok(css.includes('html[data-skin][data-frame-chrome] :is(.platform-kb-surface, [data-first-session-made]).platform-under-header {'));
  // A topic's line is the kit's group beside the room under a look, and the line it was without one.
  const head = read('frontend/src/features/dev-board/workshop/topic-head.tsx');
  assert.match(head, /<div className="fr dev-ws-topic-head" data-ws-topic-head=\{topic\.handle\} data-frame-side="">\n\s+<Sec label=\{t\('project:frame\.channel\.this'\)\}>/);
  assert.match(head, /<p className="dev-ws-topic-head" data-ws-topic-head=\{topic\.handle\}>/);
  assert.match(css, /\.dev-ws-topic-channel:not\(\.dev-ws-discussion-threaded, :has\(\.messages-reply-pane\)\) \{\n\s+display: grid; grid-template-columns: minmax\(0, 720px\) 320px;/);
});

test('smaller pieces: Edit profile\'s cards and preview, the New message dialog\'s foot, Messages\' rows by their key', () => {
  assert.ok(css.includes('html[data-skin]:not([data-skin="brand"]) #profile-edit-sheet section > .un-group { box-shadow: inset 0 0 0 1px var(--fr-line); }'));
  assert.ok(css.includes('html[data-skin]:not([data-skin="brand"]) #profile-edit-sheet #public-profile-card { border-radius: 20px; background: var(--fr-surface); box-shadow: inset 0 0 0 1px var(--fr-line); color: var(--fr-ink); }'));
  assert.ok(css.includes('html[data-skin]:not([data-skin="brand"]) [data-new-message] .border-t { flex-wrap: wrap; row-gap: 12px; }'));
  assert.ok(css.includes('html[data-skin]:not([data-skin="brand"]) [data-new-message] .border-t > button { flex: none; white-space: nowrap; }'));
  assert.match(read('frontend/src/features/messages/frame-list.tsx'), /data-inbox-row=\{row\.key\}/);
  assert.doesNotMatch(read('frontend/src/features/messages/index.tsx'), /FRAME_ROW/);
});
