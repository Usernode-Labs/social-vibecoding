// A project's Hub in the one frame (frontend/src/features/dev-board/
// workshop/frame/project-frame.tsx), as the 2026-11-06 screen tour draws it
// (s23, s24, s36): the project's places are the page's tabs; For you,
// Recently live and Topics are groups of the standard row; who is here, how
// a change goes live and the app sit in the context column; one primary
// button, Ask for a change. The page (../workshop.tsx) hands it what its own
// Hub reads, as plain words.
//
// Run with: node --test tests/project-hub-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/dev-board/workshop/frame/project-frame.tsx';

const tabs = [
  { key: 'status', label: 'Hub' }, { key: 'needs', label: 'Needs you', count: 1 }, { key: 'workshop', label: 'Workshop' },
  { key: 'discussion', label: '#general', count: 3 }, { key: 'topics', label: 'Topics' },
];
const base = {
  name: 'Homeroom', purpose: 'The community for the platform itself.', onAsk() {}, onInvite() {},
  tabs, tab: 'status', onTab() {},
  needs: { count: 1, title: 'Email templates: keep translations' }, quiet: null, onNeeds() {},
  work: { line: 'Next: Make proposals and voting more visual', words: 'In progress: 11', href: '#homeroom-bot?project=homeroom' }, onWorkshop() {},
  general: { handle: 'general', line: 'evan: Thank you @kempis!', ago: '18h', unread: 0 }, onGeneral() {},
  live: [
    { key: 'p1', title: 'Email templates, part 7', who: 'snait', ago: '48m', href: '#app/homeroom/dev/changes/6370' },
    { key: 'p2', title: 'Email templates, part 6', who: null, ago: '1h', href: '#app/homeroom/dev/changes/6369' },
  ], onAllLive() {},
  topics: [{ key: 'c:onboarding', name: 'Onboarding', about: 'Signing up and the first week', unread: 0 }, { key: 'c:bot', name: 'Homeroom bot', about: '', unread: 2 }], topicsTotal: 6, onTopic() {}, onAllTopics() {},
  people: { title: '26 active this week', line: 'snait, evan, Bruno and 23 more' },
  audience: { kind: 'open', title: 'Public community', line: '228 members' },
  rule: { title: 'evan or snait says yes', line: 'After the checks pass', onOpen() {} },
  app: null,
};
const render = (over) => renderComponent(FRAME, 'ProjectHubFrame', { ...base, ...over }, { cache: false });

test('the Hub is a page of the frame: the project\'s name, its sentence, two actions, its places as tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="status"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Homeroom<\/h1><p class="fr-purpose">The community for the platform itself\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Invite<\/button><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Ask for a change<\/button><\/div><\/div>/s);
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab[^"]*" aria-pressed="(true|false)">([^<]+)(?:<span class="fr-n">(\d+)<\/span>)?<\/button>/g)].map((m) => [m[2], m[1], m[3] || '']),
    [['Hub', 'true', ''], ['Needs you', 'false', '1'], ['Workshop', 'false', ''], ['#general', 'false', '3'], ['Topics', 'false', '']]);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('For you: the vote owed in blue, your work with the bot, the channel\'s last line and when', () => {
  const html = render();
  const at = html.indexOf('>For you<');
  const you = html.slice(at, html.indexOf('>Recently live<'));
  assert.ok(at > 0);
  assert.match(you, /<button type="button" class="fr-row"><span class="fr-lead fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Needs you<\/span><span class="fr-s">Email templates: keep translations<\/span><\/span><span class="fr-pill fr-act" data-kind="act">1 to vote<\/span><svg[^>]*fr-go[^>]*>.*?<\/svg><\/button>/s);
  assert.match(you, /<a class="fr-row" href="#homeroom-bot\?project=homeroom"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Your work<\/span><span class="fr-s">Next: Make proposals and voting more visual<\/span><\/span><span class="fr-meta">In progress: 11<\/span>/s);
  assert.match(you, /<span class="fr-t">#general<\/span><span class="fr-s">evan: Thank you @kempis!<\/span><\/span><span class="fr-meta">18h<\/span>/);
  assert.equal((you.match(/data-kind="act"/g) || []).length, 1);
});

test('with nothing to vote on the first row says so quietly, and something new in the channel is the blue pill', () => {
  const html = render({ needs: null, quiet: 'Nothing more to vote on.', general: { handle: 'general', line: 'lukas: so good', ago: '3d', unread: 4 } });
  assert.match(html, /<span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Needs you<\/span><span class="fr-s">Nothing more to vote on\.<\/span><\/span><svg/s);
  assert.match(html, /<span class="fr-t">#general<\/span><span class="fr-s">lukas: so good<\/span><\/span><span class="fr-pill fr-act" data-kind="act">4 new<\/span>/);
  assert.doesNotMatch(render({ needs: null, quiet: null }), />Needs you<\/span>/, 'a project with nobody else in it says nothing about votes');
  const out = render({ work: null });
  assert.match(out, /<span class="fr-t">Workshop<\/span><span class="fr-s">What happened, and every item<\/span>/, 'no work of yours: the Workshop\'s own row');
});

test('Recently live is rows with who built each and when; Topics, each with its line; both end in their link', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Recently live<\/h2><button type="button" class="fr-link">All in Workshop<\/button>/);
  assert.match(html, /<span class="fr-lead fr-ok" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Email templates, part 7<\/span><span class="fr-s">Built by snait<\/span><\/span><span class="fr-meta">48m<\/span>/s);
  assert.match(html, /<a class="fr-row fr-sm" href="#app\/homeroom\/dev\/changes\/6369"><span class="fr-lead fr-ok" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Email templates, part 6<\/span><\/span><span class="fr-meta">1h<\/span>/s, 'nobody named: one line');
  assert.match(html, /<h2 class="fr-cap">Topics<\/h2><button type="button" class="fr-link">All 6<\/button>/);
  assert.match(html, /<span class="fr-t">Onboarding<\/span><span class="fr-s">Signing up and the first week<\/span>/);
  assert.match(html, /<span class="fr-t">Homeroom bot<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/);
  const none = render({ live: [], topics: [], topicsTotal: 0 });
  assert.doesNotMatch(none, />Recently live<|>Topics<\/h2>/, 'an empty group is not drawn');
});

test('the context column: who is here, how a change goes live, and the app when it has one', () => {
  const html = render({ app: { name: 'Pourover Coffee', src: null, emoji: '☕', color: null, line: 'Live since 22 Oct', onOpen() {} } });
  const side = html.slice(html.lastIndexOf('<div class="fr-stack">'));
  assert.match(side, /<h2 class="fr-cap">People<\/h2>.*?<span class="fr-t">26 active this week<\/span><span class="fr-s">snait, evan, Bruno and 23 more<\/span>.*?<span class="fr-t">Public community<\/span><span class="fr-s">228 members<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">How a change goes live<\/h2>.*?<button type="button" class="fr-row fr-wrap">.*?<span class="fr-t">evan or snait says yes<\/span><span class="fr-s">After the checks pass<\/span>/s);
  assert.match(side, /<h2 class="fr-cap">The app<\/h2>.*?<span class="fr-tile"[^>]*>☕<\/span><span class="fr-tx"><span class="fr-t">Open Pourover Coffee<\/span><span class="fr-s">Live since 22 Oct<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm">Open<\/button>/s);
  assert.doesNotMatch(render(), />The app</, 'the platform\'s own community has no app of its own');
  assert.doesNotMatch(render({ people: null }), /active this week/);
});

test('a visitor gets no actions, and a place that is not the Hub keeps the head and tabs alone', () => {
  const html = render({ onAsk: null, onInvite: null });
  assert.doesNotMatch(html, /fr-acts/);
  const joins = render({ onAsk: null, onInvite: null, onJoin() {} });
  assert.match(joins, /<div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Join<\/button><\/div>/s, 'signed in and not a member yet: Join is the one button');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /offerJoin\(\{ code: 'join_required', app: \{ slug, name: projectName \} \}\)/);
  const head = renderComponent(FRAME, 'ProjectFrameHead', { title: 'Workshop', purpose: 'Everything asked for, being built and voted on in Homeroom.', tabs, tab: 'workshop', onTab() {}, onAsk() {} }, { cache: false });
  assert.match(head, /^<div class="fr" data-project-frame="workshop"><div class="fr-inner"><div class="fr-head">.*?<h1 class="fr-title">Workshop<\/h1>.*?<\/div><nav class="fr-tabs">.*?<\/nav><\/div><\/div>$/s);
  assert.match(head, /class="fr-tab fr-on" aria-pressed="true">Workshop</);
});

test('the page draws the kit\'s Hub under a look, from what its own Hub reads', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /App\?\.openFeedbackModal\?\.\(\{ fromDev: true, intent: 'issue' \}\)/, 'Ask for a change is the menu\'s Suggest an improvement');
  assert.match(src, /openInviteLinks\(\)/);
  assert.match(src, /<ProjectHubFrame\b/);
  assert.match(src, /<ProjectFrameHead\b/);
});

test('Topics is a page of rows: #general, then each topic with its open requests and what it is about', () => {
  const html = renderComponent(FRAME, 'ProjectTopicsFrame', {
    tabs, tab: 'topics', onTab() {}, onAsk() {},
    general: { handle: 'general', unread: 0 },
    topics: [
      { key: 'c:onboarding', name: 'Onboarding', about: 'Signing up and the first week', requests: 7, unread: 0 },
      { key: 'c:infra', name: 'Infra', about: '', requests: 1, unread: 2 },
      { key: 'c:misc', name: 'Misc', about: '', requests: 0, unread: 0 },
    ],
    onOpen() {}, onPropose() {},
  }, { cache: false });
  assert.match(html, /^<div class="fr" data-project-frame="topics"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Topics<\/h1><p class="fr-purpose">Each topic is a channel and a category of work\. A new topic is voted on like any change\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Propose a topic<\/button>/s);
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true">Topics</);
  assert.match(html, /<h2 class="fr-cap">Channels<\/h2>.*?<span class="fr-t">#general<\/span>/s);
  assert.match(html, /<span class="fr-t">Onboarding<\/span><span class="fr-s">7 open requests · Signing up and the first week<\/span>/);
  assert.match(html, /<span class="fr-t">Infra<\/span><span class="fr-s">1 open request<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/);
  assert.match(html, /<button type="button" class="fr-row fr-sm"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Misc<\/span><\/span>/s, 'zero says nothing');
  assert.match(html, /<h2 class="fr-cap">About topics<\/h2>.*?<span class="fr-t">Changed by a vote<\/span><span class="fr-s">New, renamed, merged or archived<\/span>/s);
});

test('under a look the project\'s page has the frame\'s page area, and the standard page stays mounted behind the kit\'s', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]\[data-project-frame\] #app-view \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/);
  assert.match(hand, /html\[data-skin\]\[data-project-frame\] #dev-workshop \{ max-width: none; margin: 0; \}/, 'not the standard look\'s 760px column');
  assert.match(hand, /html\[data-skin\] \.dev-ws > \[data-project-frame\] ~ \.dev-ws-placebar \{ display: none; \}/, 'the places are the kit\'s tabs');
  assert.match(hand, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\], \[data-project-frame="all-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'where the kit draws the whole place');
  // Under the kit's Hub the standard one goes part by part: what asks something of you once stays.
  const kept = hand.match(/html\[data-skin\] \.dev-ws > \[data-project-frame="status"\] ~ \.dev-ws-tabbody > :not\(:is\(([^)]*)\)\) \{ display: none; \}/);
  assert.ok(kept, 'the standard Hub is put away part by part');
  for (const card of ['[data-ws-first-version]', '[data-ws-update]', '[data-ws-share]', '[data-ws-start-here]', '[data-ws-hub-versions]', '[data-notify-ask="community"]']) {
    assert.ok(kept[1].includes(card), `${card} stays under the kit's Hub`);
  }
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(hub, /data-ws-first-version=\{line\}/);
  assert.match(hub, /data-ws-update=\{kind\}/);
  assert.match(read('frontend/src/features/dev-board/workshop/community-card.tsx'), /data-ws-share=""/);
  assert.match(hand, /html\[data-skin\] \.dev-ws:not\(\[data-ws-tab="needs"\]\) > \[data-project-frame\] ~ \.dev-ws-tabbody > \* \{ max-width: 720px; margin-inline: 0; \}/, 'an undrawn place sits in the kit\'s content column');
  assert.match(hand, /html\[data-skin\] #dev-workshop\.dev-ws-on-needs > \.dev-ws\[data-ws-tab="needs"\] > \[data-project-frame\] \{ max-width: none; margin-inline: 0; \}/, 'the kit\'s head is not held to the review stage\'s 760px');
  const frame = read(FRAME);
  assert.match(frame, /document\.documentElement\.setAttribute\('data-project-frame', ''\)/, 'the page says it is up, so no rule looks inside the board\'s hosts');
  assert.equal((frame.match(/^  useProjectFrameFlag\(\);$/gm) || []).length, 5, 'each of the kit\'s pages (the head, the Hub, Topics, the Workshop, All items)');
  // The page's own lines stay as written: the kit's page is drawn ahead of them.
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /\{frame && !frameTopics && tab === 'status' && !pending \? frameHub\(\) : null\}\s+\{frameWorkshopUp \? frameWorkshop\(\) : null\}\s+\{frameAllUp \? frameAll\(\) : null\}\s+\{frame && !frameTopics && tab !== 'status' && !frameWorkshopUp && !frameAllUp \? <ProjectFrameHead [^\n]+\n\s+\{band\}\n\s+\{tray\}/);
});

test('the project\'s ⋯ stands at the end of the kit\'s head: the one node the hero draws, with the hero put away around it', () => {
  // Leave, pin, members and approvals, rules: the menu is one node, in the
  // standard Hub's hero (tests/dev-workshop.test.js counts it), so the kit's
  // Hub cannot draw a second. The hero stays in the page with no size and
  // nothing of it seen, and its ⋯ alone is placed against the page.
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const hero = hand.match(/html\[data-skin\] \.dev-ws > \[data-project-frame="status"\] ~ \.dev-ws-tabbody > section\[data-ws-community\] \{([^}]*)\}/);
  assert.ok(hero);
  assert.match(hero[1], /visibility: hidden; position: static !important; overflow: visible;\s+height: 0;/, 'unpositioned even while its menu is open, which the standard look answers by positioning it');
  const plus = hand.match(/section\[data-ws-community\] \.dev-ws-plus \{([^}]*)\}/);
  assert.match(plus[1], /visibility: visible; position: absolute;/);
  assert.match(plus[1], /inset-inline-end: max\(32px, calc\(\(100% - 1136px\) \/ 2 \+ 32px\)\);/, 'at the kit column\'s end');
  assert.match(hand, /html\[data-skin\] \.dev-ws > \[data-project-frame="status"\] \.fr-head > \.fr-acts \{ margin-inline-end: 48px; \}/, 'the head\'s buttons make room for it');
  assert.match(hand, /html\[data-skin\] \.dev-ws > \[data-project-frame="status"\] ~ \.dev-ws-tabbody #dev-plus-menu \{ inset-inline-start: auto; inset-inline-end: 0; \}/, 'and its menu opens towards the start');
  assert.equal((read('frontend/src/features/dev-board/workshop/workshop.tsx').match(/<DevPlusMenu\b/g) || []).length, 1);
});

test('a topic\'s channel lights Topics but keeps the product\'s page under the head (its figures and its room)', () => {
  const head = renderComponent(FRAME, 'ProjectFrameHead', { title: '#onboarding', purpose: 'Where Homeroom talks.', tabs: [{ key: 'status', label: 'Hub' }, { key: 'topics', label: 'Topics' }], tab: 'topics', page: 'channel', onTab() {} }, { cache: false });
  assert.match(head, /^<div class="fr" data-project-frame="channel">/);
  assert.match(head, /<button type="button" class="fr-tab fr-on" aria-pressed="true">Topics<\/button>/);
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /page: tab\.startsWith\('c:'\) && !frameTopics \? 'channel' : undefined,/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\], \[data-project-frame="all-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'the body is put away for the kit\'s own pages only; a channel is not one');
  // In a phone browser a channel's tab is a fitted box (`--ws-fit`), the
  // chat's composer on its foot. Under a look the kit's head stands inside
  // that box, taller than the standard one, and the chat under it, holding
  // to its own 320px floor, ran under the kit's tab bar: it takes the room
  // the head leaves, its stream scrolling inside it either way.
  assert.match(css, /html\[data-skin\] \.dev-ws > \[data-project-frame\] ~ \.dev-ws-tabbody > \.dev-ws-discussion \{ min-height: 0; \}/);
});
