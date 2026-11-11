// A project's Workshop in the one frame (frontend/src/features/dev-board/
// workshop/frame/project-frame.tsx ProjectWorkshopFrame), version 2 of the
// screen tour's s27, s28 and s37: the first tour's two columns holding
// today's Workshop. Overview is All items with its four figures and the
// Your work card; What happened is this week row by row, then the weeks
// before; Homeroom bot's slots and the approval rule (the Overview card's
// last two lines today) stand beside them. What the first tour added is
// gone: the head's buttons, the ballot, Recently live, Week by week as four
// rows, Nobody is on these. The page (../workshop.tsx) hands it what its
// own Workshop reads.
//
// Run with: node --test tests/project-workshop-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/dev-board/workshop/frame/project-frame.tsx';

const tabs = [{ key: 'status', label: 'Hub' }, { key: 'needs', label: 'Needs you', count: 1 }, { key: 'workshop', label: 'Workshop' }];
const item = (over) => ({ key: 'k', title: 'High scores per game', href: '#app/homeroom/dev/issues/7', glyph: 'chat', fresh: false, you: false, going: false, stuck: null, ago: '2d ago', on: false, onOpen() {}, act: null, ...over });
const base = {
  tabs, tab: 'workshop', onTab() {}, onInvite() {},
  purpose: 'Everything asked for, being built and voted on in Homeroom.',
  overview: {
    onAll() {}, filtered: false,
    facts: [
      { value: 13, label: 'open items', onClick() {} }, { value: 0, label: 'nobody on them', onClick: null },
      { value: 7, label: 'waiting on votes', tone: 'wait', sub: '3 on you', onClick() {} },
      { value: '298+', label: 'live this week', tone: 'ok', sub: 'from 168 by this time last week', onClick() {} },
    ],
  },
  first: null,
  work: { line: 'Next: Make proposals more visual', words: { id: 'project:workshop.desk.both', values: { needs: 8, progress: 5 } }, href: '#homeroom-bot?project=homeroom', hint: 'Opens Homeroom bot, showing your work in Homeroom' },
  happened: {
    onClear() {}, clearOff: false, none: false,
    thisWeek: {
      key: 'w0', name: 'This week', range: '9 Nov → now', fresh: 2, live: { count: 116, partial: false }, onOpen: null, onAll() {},
      items: [
        item({ key: 'a', title: 'Snake: wrap-around walls', fresh: true, act: { label: 'Build it', title: 'Ask Homeroom bot to build this', onPress() {} } }),
        item({ key: 'b', title: 'User guide', glyph: 'refresh', you: true, going: true, ago: '5m ago', on: true }),
        item({ key: 'c', title: 'Stuck merge', glyph: 'rocket', stuck: 'Merge blocked', href: null }),
      ],
    },
    weeks: [
      { key: 'w1', name: 'Last week', range: '2 Nov – 8 Nov', fresh: 0, live: { count: 390, partial: true }, onOpen() {} },
      { key: 'w2', name: '26 Oct – 1 Nov', range: null, fresh: 0, live: null, onOpen() {} },
    ],
    onEarlier() {}, started: null,
  },
  slots: { title: 'Building 1 of 5', line: '4 waiting for votes', onOpen() {} },
  rule: { id: 'project:communityCard.lineShort.anyOf', values: { names: 'evan or snait' }, wait: null, onRules: null },
};
const render = (over) => renderComponent(FRAME, 'ProjectWorkshopFrame', { ...base, ...over }, { cache: false });

test('the Workshop is a page of the frame: its sentence, no buttons, the places as tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="workshop-kit"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Workshop<\/h1><p class="fr-purpose">Everything asked for, being built and voted on in Homeroom\.<\/p><\/div><\/div><nav class="fr-tabs">/);
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true">Workshop</);
  assert.doesNotMatch(html, /Ask for a change|fr-acts/, 'today\'s Workshop has no button over it: All items is the Overview card\'s door');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('Overview: All items with See all, then the four figures with their lines, each opening what it counts', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Overview<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-sm fr-headrow"><span class="fr-tx"><span class="fr-t">All items<\/span><\/span><span class="fr-link">See all<\/span><svg[^>]*fr-go[^>]*>.*?<\/svg><\/button><div class="fr-facts fr-f4"><button type="button" class="fr-fact"><span class="fr-v">13<\/span><span class="fr-l">open items<\/span><\/button>/s);
  assert.match(html, /<div class="fr-fact"><div class="fr-v">0<\/div><div class="fr-l">nobody on them<\/div><\/div>/, 'a zero opens nothing');
  assert.match(html, /<button type="button" class="fr-fact"><span class="fr-v fr-wait">7<\/span><span class="fr-l">waiting on votes<\/span><span class="fr-l fr-sub">3 on you<\/span><\/button>/);
  assert.match(html, /<span class="fr-v fr-ok">298\+<\/span><span class="fr-l">live this week<\/span><span class="fr-l fr-sub">from 168 by this time last week<\/span>/);
  const filtered = render({ overview: { ...base.overview, filtered: true } });
  assert.match(filtered, /<span class="fr-link">See all<span class="fr-fdot" aria-hidden="true"><\/span><span class="fr-sro"> \(filtered\)<\/span><\/span>/, 'a search or filter waiting on All items shows from here (#2915)');
  assert.doesNotMatch(render({ overview: null }), />All items</);
  assert.doesNotMatch(html, /Where things are/);
});

test('Your work is a card of its own in Overview: the bot\'s mark, what is next, the counts with the accent number', () => {
  const html = render();
  const over = html.slice(html.indexOf('>Overview<'), html.indexOf('>What happened<'));
  assert.match(over, /<\/div><\/div><div class="fr-card"><a class="fr-row" href="#homeroom-bot\?project=homeroom" aria-label="Opens Homeroom bot, showing your work in Homeroom"><span class="fr-tile"[^>]*><img src="\/brand\/homeroom-mark\.png"[^>]*\/><\/span><span class="fr-tx"><span class="fr-t">Your work<\/span><span class="fr-s">Next: Make proposals more visual<\/span><\/span><span class="fr-meta fr-d">Needs you: <b class="fr-acc">8<\/b> · In progress: 5<\/span><svg/);
  assert.doesNotMatch(render({ work: null }), />Your work</, 'not for a visitor');
  // A newcomer: the product's own card stands in its place.
  const first = renderComponent(FRAME, 'ProjectWorkshopFrame', { ...base, first: 'FIRST-CHANGE-CARD' }, { cache: false });
  assert.match(first, /FIRST-CHANGE-CARD/);
  assert.doesNotMatch(first, />Your work</);
});

test('What happened: Mark all seen, this week\'s rows (new, You, Going live, Build it), All of this week, then the weeks before', () => {
  const html = render();
  const card = html.slice(html.indexOf('>What happened<'), html.indexOf('<div class="fr-stack fr-first">'));
  assert.match(card, /^>What happened<\/h2><button type="button" class="fr-link">Mark all seen<\/button><\/div><div class="fr-card"><div class="fr-row fr-sm fr-week"><span class="fr-tx"><span class="fr-t">This week <span class="fr-mut">9 Nov → now<\/span><\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span><span class="fr-meta fr-ok"><span>116<\/span> live<\/span><\/div>/);
  // A new request nobody is on: the title is the link, and Build it is the row's own button.
  assert.match(card, /<div class="fr-row fr-sm fr-item"><span class="fr-ei fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t"><a class="fr-tlink" href="#app\/homeroom\/dev\/issues\/7"><span class="fr-sro">New <\/span>Snake: wrap-around walls<\/a><\/span><\/span><span class="fr-meta">2d ago<\/span><button type="button" class="fr-btn fr-line fr-sm" title="Ask Homeroom bot to build this">Build it<\/button><\/div>/s);
  assert.match(card, /<a class="fr-row fr-sm fr-on fr-item" href="#app\/homeroom\/dev\/issues\/7" aria-current="page"><span class="fr-ei" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">User guide<\/span><\/span><span class="fr-pill" data-kind="none">You<\/span><span class="fr-pill fr-ok" data-kind="ok">Going live<\/span><span class="fr-meta">5m ago<\/span><\/a>/s, 'the row whose page is open beside the list is lit');
  assert.match(card, /<div class="fr-row fr-sm fr-item">.*?<span class="fr-t">Stuck merge<\/span><\/span><span class="fr-pill fr-bad" data-kind="bad">Merge blocked<\/span>/s);
  assert.match(card, /<button type="button" class="fr-row fr-sm fr-showall"><span class="fr-tx"><span class="fr-t">All of this week<\/span><\/span><svg[^>]*fr-go/);
  assert.match(card, /<button type="button" class="fr-row fr-sm fr-week"><span class="fr-tx"><span class="fr-t">Last week <span class="fr-mut">2 Nov – 8 Nov<\/span><\/span><\/span><span class="fr-meta fr-ok"><span>390\+<\/span> live<\/span><svg/);
  assert.match(card, /<span class="fr-t">26 Oct – 1 Nov<\/span><\/span><svg/, 'a week named by its dates says them once; nothing live says nothing');
  assert.match(card, /<button type="button" class="fr-row fr-sm fr-showall"><span class="fr-tx"><span class="fr-t">Earlier weeks<\/span><\/span><\/button><\/div><\/section>/);
  const quiet = render({ happened: { ...base.happened, none: true, clearOff: true, onEarlier: null, started: 'This project started the week of 12 Oct.' } });
  assert.match(quiet, /<button type="button" class="fr-link fr-off" disabled="">Mark all seen<\/button><\/div><div class="fr-card"><p class="fr-cardnote">Nothing new since you were last here\.<\/p>/);
  assert.match(quiet, /<p class="fr-cardnote">This project started the week of 12 Oct\.<\/p><\/div><\/section>/);
  assert.doesNotMatch(render({ happened: { ...base.happened, onClear: null } }), /Mark all seen/, 'a first visit has no line to move');
  assert.doesNotMatch(render({ happened: null }), />What happened</);
  assert.doesNotMatch(html, /Recently live|Week by week|Needs your vote|Review and vote|fr-ballot/, 'what the first tour drew here');
});

test('beside them: Homeroom bot\'s slots, and who decides in the product\'s own sentence, with Rules for whoever may change it', () => {
  const html = render();
  const side = html.slice(html.lastIndexOf('<div class="fr-stack fr-first">'));
  assert.match(side, /<h2 class="fr-cap">Homeroom bot<\/h2>.*?<span class="fr-tile"[^>]*><img src="\/brand\/homeroom-mark\.png"[^>]*\/><\/span><span class="fr-tx"><span class="fr-t">Building 1 of 5<\/span><span class="fr-s">4 waiting for votes<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">Who decides<\/h2><\/div><div class="fr-card"><div class="fr-row fr-wrap fr-all">.*?<span class="fr-t">Goes live when its checks pass and <span><\/span><b>evan or snait<\/b> says yes\.<\/span><\/span><\/div>/s);
  const group = render({ rule: { id: 'project:communityCard.lineShort.members.some', values: { count: 11, total: 41 }, wait: 'Or after a wait, if one approves and nobody objects', onRules() {} } });
  assert.match(group, /<h2 class="fr-cap">Who decides<\/h2><button type="button" class="fr-link">Rules<\/button>.*?<span class="fr-t">Goes live when its checks pass and 11 of the 41 active members approve it\.<\/span><span class="fr-s">Or after a wait, if one approves and nobody objects<\/span>/s);
  assert.doesNotMatch(side, /Nobody is on these/);
  assert.doesNotMatch(render({ slots: null }), />Homeroom bot<\/h2>/);
});

test('the page draws the kit\'s Workshop under a look from what its own Workshop reads, and keeps its own for a week\'s page', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /<ProjectWorkshopFrame\b/);
  assert.match(src, /const frameWorkshopUp = frame && !frameTopics && tab === 'workshop' && !weekUp;/, 'a week\'s page is still the page\'s own, under the kit\'s head');
  assert.match(src, /useBotSlots\(frame \? v\.slug : null\)/, 'the slots are read only under a look');
  assert.match(src, /const frameFirst = useFirstChange\(frame \? v\.slug \|\| '' : '', desk\);/, 'a hook, with the page\'s others at its top');
  assert.ok(src.indexOf('const frameFirst = useFirstChange(') < src.indexOf('const hostRef = useRef<HTMLDivElement>(null);'));
  const ws = src.slice(src.indexOf('const frameWorkshop = (): ReactNode => {'), src.indexOf('const frameHub = (): ReactNode => {'));
  assert.match(ws, /callAppView\('openWorkshopStage', key\); openTab\('all'\);/, 'a figure opens All items narrowed to what it counts (#5369)');
  assert.match(ws, /if \(refs\.length === 1\) callAppView\('openTopic', refs\[0\]\.kind, refs\[0\]\.id\);/, 'one change waiting: its page (#4745)');
  assert.match(ws, /onClear: v\.since \? clearSince : null,/);
  assert.match(ws, /\.slice\(0, THIS_WEEK_NEW_MAX\)\.map\(\(row\) => itemOf\(row, true\)\)/);
  assert.match(ws, /\.slice\(0, THIS_WEEK_SEEN\)\.map\(\(row\) => itemOf\(row, false\)\)/);
  assert.match(ws, /weeks: pastWeeks\.slice\(0, weeksShown\)\.map/);
  assert.match(ws, /onOpen: ref \? \(event: ReactMouseEvent<HTMLAnchorElement>\) => openItem\(event, ref\) : undefined,/, 'an item opens beside the list, as the page\'s own rows do');
  assert.match(ws, /below=\{slug \? <PrivateRequests slug=\{slug\} \/> : null\}/, 'an admin\'s private requests stay on the tab');
  const rule = src.slice(src.indexOf('const frameRule = () => {'), src.indexOf('const frameWorkshopUp ='));
  assert.match(rule, /const line = ruleSentence\(approval, community, approvers\);/, 'the Overview line\'s own sentence (community-card.tsx)');
  assert.match(rule, /id: line\.short,/);
  assert.doesNotMatch(src, /project:frame\.rule\.|project:frame\.workshop\.(where|needsVote|yourVote|yes|noMore|noPassed|needed|review|weeks|unclaimed|all|liveCount)/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\], \[data-project-frame="all-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/);
});
