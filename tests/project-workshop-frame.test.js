// A project's Workshop in the one frame (frontend/src/features/dev-board/
// workshop/frame/project-frame.tsx ProjectWorkshopFrame), as the 2026-11-06
// screen tour draws it (s27, s28, s37): where things are as figures said in
// words, the vote that waits for you as the ballot card, your work, what
// went live, and beside them Homeroom bot's slots, who decides and the
// requests nobody is on. The page (../workshop.tsx) hands it what its own
// Workshop reads.
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
const base = {
  tabs, tab: 'workshop', onTab() {}, onAsk() {}, onInvite() {},
  purpose: 'Everything asked for, being built and voted on in Homeroom.', onAll() {},
  facts: [{ value: 13, label: 'open items' }, { value: 4, label: 'nobody on them' }, { value: 7, label: 'waiting on votes', tone: 'acc' }, { value: 298, label: 'live this week', tone: 'ok' }],
  vote: { id: '#6370', title: 'Email templates: keep translations', line: 'By snait', yes: 1, no: 0, of: 4, need: 2, note: null, onVote() {} },
  work: { line: 'Next: Make proposals more visual', words: 'In progress: 11', href: '#homeroom-bot?project=homeroom' },
  live: [{ key: 'p1', title: 'Email templates, part 7', ago: '55m', href: '#app/homeroom/dev/changes/6369' }],
  weeks: [{ key: 'w1', title: 'Last week', line: '2 Nov – 8 Nov', right: '7 live', onOpen() {} }],
  slots: { title: 'Building 1 of 5', line: '4 waiting for votes', onOpen() {} },
  rule: { title: '2 of 4 approve', line: 'After the checks pass', onOpen: null },
  unclaimed: [{ key: 'i1', title: 'Mobile app does not respect the safe area', id: '#6204', onOpen() {} }], unclaimedTotal: 4, onAllUnclaimed() {},
};
const render = (over) => renderComponent(FRAME, 'ProjectWorkshopFrame', { ...base, ...over }, { cache: false });

test('the Workshop is a page of the frame: its sentence, All items beside Ask for a change, the places as tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="workshop-kit"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Workshop<\/h1><p class="fr-purpose">Everything asked for, being built and voted on in Homeroom\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>All items<\/button><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Ask for a change<\/button><\/div><\/div>/s);
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true">Workshop</);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('where things are: up to five figures said in words, the one that waits in blue, what is live in green', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Where things are<\/h2><\/div><div class="fr-card"><div class="fr-facts fr-f4"><div class="fr-fact"><div class="fr-v">13<\/div><div class="fr-l">open items<\/div><\/div>/);
  assert.match(html, /<div class="fr-v fr-acc">7<\/div><div class="fr-l">waiting on votes<\/div>/);
  assert.match(html, /<div class="fr-v fr-ok">298<\/div><div class="fr-l">live this week<\/div>/);
});

test('the vote that waits for you is the ballot card: its tally as a bar with the line to pass, and one way to cast it', () => {
  const html = render();
  const at = html.indexOf('>Needs your vote<');
  const card = html.slice(at, html.indexOf('>Your work<'));
  assert.ok(at > 0);
  assert.match(card, /<div class="fr-card"><div class="fr-ballot"><div><div class="fr-btnrow"><span class="fr-pill fr-act" data-kind="act">Your vote<\/span><span class="fr-mono">#6370<\/span><\/div><div class="fr-sub17" style="margin-top:8px">Email templates: keep translations<\/div><div class="fr-s" style="font-size:13px;color:var\(--fr-mut\);margin-top:4px">By snait<\/div><\/div>/);
  assert.match(card, /<div class="fr-bar2" role="img" aria-label="1 yes · 0 no · 1 more to pass"><i class="fr-y" style="width:25%"><\/i><i class="fr-no" style="width:0%"><\/i><span class="fr-need" data-l="2 yes needed" style="inset-inline-start:50%"><\/span><\/div>/);
  assert.match(card, /<div class="fr-line1"><b>1 yes<\/b><span>0 no · 1 more to pass<\/span><span style="flex:1"><\/span><\/div>/);
  assert.match(card, /<div class="fr-btnrow"><button type="button" class="fr-btn fr-ok"><svg[^>]*>.*?<\/svg>Review and vote<\/button><\/div>/s,
    'a No needs its reason, so the vote is cast on Needs you, which this opens');
  assert.match(render({ vote: { ...base.vote, yes: 2 } }), /<span>0 no · passed<\/span>/);
  assert.doesNotMatch(render({ vote: null }), /Needs your vote/);
});

test('your work, what went live, and the weeks before as rows', () => {
  const html = render();
  // The group's heading says Your work; the row says what is next and the
  // counts, not the heading again (a row does not repeat its heading).
  assert.match(html, /<h2 class="fr-cap">Your work<\/h2>.*?<a class="fr-row" href="#homeroom-bot\?project=homeroom">.*?<span class="fr-t">Next: Make proposals more visual<\/span><span class="fr-s">In progress: 11<\/span><\/span><svg/s);
  assert.match(render({ work: { line: null, words: 'In progress: 11', href: '#homeroom-bot?project=homeroom' } }), /<span class="fr-t">In progress: 11<\/span><\/span><svg/, 'with nothing next, the counts are the row');
  assert.match(html, /<h2 class="fr-cap">Recently live<\/h2>.*?<a class="fr-row fr-sm" href="#app\/homeroom\/dev\/changes\/6369"><span class="fr-lead fr-ok" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Email templates, part 7<\/span><\/span><span class="fr-meta">55m<\/span>/s);
  assert.match(html, /<h2 class="fr-cap">Week by week<\/h2>.*?<button type="button" class="fr-row"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Last week<\/span><span class="fr-s">2 Nov – 8 Nov<\/span><\/span><span class="fr-meta">7 live<\/span>/s);
  const quiet = render({ work: null, live: [], weeks: [] });
  assert.doesNotMatch(quiet, />Your work<|>Recently live<|>Week by week</, 'an empty group is not drawn');
});

test('beside them: Homeroom bot\'s slots, who decides, and the requests nobody is on', () => {
  const html = render();
  const side = html.slice(html.lastIndexOf('<div class="fr-stack">'));
  assert.match(side, /<h2 class="fr-cap">Homeroom bot<\/h2>.*?<span class="fr-t">Building 1 of 5<\/span><span class="fr-s">4 waiting for votes<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">Who decides<\/h2>.*?<span class="fr-t">2 of 4 approve<\/span><span class="fr-s">After the checks pass<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">Nobody is on these<\/h2><button type="button" class="fr-link">All 4<\/button>.*?<button type="button" class="fr-row"><span class="fr-tx"><span class="fr-t">Mobile app does not respect the safe area<\/span><span class="fr-s">#6204<\/span><\/span><svg/s);
  assert.doesNotMatch(render({ slots: null, unclaimed: [], unclaimedTotal: 0 }), />Homeroom bot<\/h2>|>Nobody is on these</);
});

test('the page draws the kit\'s Workshop under a look, and keeps its own for a week\'s page', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /<ProjectWorkshopFrame\b/);
  assert.match(src, /const frameWorkshopUp = frame && !frameTopics && tab === 'workshop' && !weekUp;/, 'a week\'s page is still the page\'s own, under the kit\'s head');
  assert.match(src, /useBotSlots\(frame \? v\.slug : null\)/, 'the slots are read only under a look');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\], \[data-project-frame="all-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/);
});
