// A project's Hub in the one frame (frontend/src/features/dev-board/
// workshop/frame/project-frame.tsx), version 2 of the screen tour's s23, s24
// and s36: the first tour's layout (the places as the page's tabs, two
// columns) holding today's Hub. The head is the hero's (tile, name,
// description, Open app, Invite, Join); For you is its three doors, Recently
// live its three pictures; who is around and who it is for sit in the side
// column; a phone lists the topics too. What the first tour added and
// today's Hub does not have is gone: Ask for a change, the Your work row,
// Recently live as rows, How a change goes live, The app. The page
// (../workshop.tsx) hands it what its own Hub reads.
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
  name: 'Homeroom', purpose: 'The community for the platform itself.', onInvite() {},
  tile: { src: null, emoji: '☕' }, onOpenApp: null,
  tabs, tab: 'status', onTab() {},
  needs: { count: 1, line: 'Email templates: keep translations', join: false }, quiet: null, onNeeds() {},
  onWorkshop() {},
  general: { handle: 'general', last: true, said: 'Thank you @kempis!', by: 'evan', ago: '18h ago', unread: 0 }, onGeneral() {},
  live: [
    { key: 'p1', title: 'Email templates, part 7', line: 'snait · 48m ago', src: '/visuals/abc', href: '#app/homeroom/dev/changes/6370' },
    { key: 'p2', title: 'Email templates, part 6', line: null, src: null, href: '#app/homeroom/dev/changes/6369' },
  ], ownLive: null, onAllLive() {},
  topics: [{ key: 'c:onboarding', name: 'Onboarding', handle: 'onboarding', icon: '🚪', about: 'Signing up and the first week', unread: 0 }, { key: 'c:bot', name: 'Homeroom bot', handle: 'homeroom-bot', icon: '', about: '', unread: 2 }], onTopic() {},
  people: { title: '26 active this week', line: 'snait, evan, Bruno and 23 more', faces: [{ name: 'snait', color: '#5b7f5a' }, { name: 'evan' }], more: 24 },
  audience: { kind: 'open', title: 'Public community', line: '228 members' },
};
const render = (over) => renderComponent(FRAME, 'ProjectHubFrame', { ...base, ...over }, { cache: false });

test('the Hub is a page of the frame: the project\'s tile and name, its sentence, the hero\'s actions, its places as tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="status"><div class="fr-inner"><div class="fr-head"><span class="fr-tile"[^>]*>☕<\/span><div class="fr-tx"><h1 class="fr-title">Homeroom<\/h1><p class="fr-purpose">The community for the platform itself\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Invite<\/button><\/div><\/div>/s);
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab[^"]*" aria-pressed="(true|false)">([^<]+)(?:<span class="fr-n">(\d+)<\/span>)?<\/button>/g)].map((m) => [m[2], m[1], m[3] || '']),
    [['Hub', 'true', ''], ['Needs you', 'false', '1'], ['Workshop', 'false', ''], ['#general', 'false', '3'], ['Topics', 'false', '']]);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
  assert.doesNotMatch(html, /Ask for a change/, 'today\'s Hub has no such button');
  // A project with an app: Open app is the primary, before Invite.
  const app = render({ onOpenApp() {} });
  assert.match(app, /<div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Open app<\/button><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Invite<\/button><\/div>/s);
});

test('For you: the vote owed in blue, the Workshop\'s door, and Discussion #general with its last line and when', () => {
  const html = render();
  const at = html.indexOf('>For you<');
  const you = html.slice(at, html.indexOf('<h2 class="fr-cap">Topics<'));
  assert.ok(at > 0);
  assert.match(you, /<button type="button" class="fr-row"><span class="fr-lead fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Needs you<\/span><span class="fr-s">Email templates: keep translations<\/span><\/span><span class="fr-pill fr-act" data-kind="act">1 to vote<\/span><svg[^>]*fr-go[^>]*>.*?<\/svg><\/button>/s);
  assert.match(you, /<span class="fr-t">Workshop<\/span><span class="fr-s">What happened, and every item<\/span>/);
  assert.doesNotMatch(you, /Your work/, 'your work is the Workshop tab\'s card, not the Hub\'s');
  assert.match(you, /<span class="fr-t">Discussion <span class="fr-mut">#general<\/span><\/span><span class="fr-s"><span class="fr-cut">@evan: Thank you @kempis!<\/span><span class="fr-aft"> · 18h ago<\/span><\/span>/, 'the product\'s own words; the message is cut short, never the time');
  assert.equal((you.match(/data-kind="act"/g) || []).length, 1);
  assert.match(render({ needs: { count: 0, line: '2 skipped', join: false } }), /<span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Needs you<\/span><span class="fr-s">2 skipped<\/span><\/span><svg/s, 'votes all seen: the row stays, without its pill');
  assert.match(render({ needs: { count: 2, line: 'x', join: true } }), /<p class="fr-cardnote">Join to vote on these\.<\/p>/);
  assert.doesNotMatch(render({ onWorkshop: null }), /<span class="fr-t">Workshop<\/span>/, 'a visitor has no Workshop row');
});

test('with nothing to vote on the first line says so quietly, naming the requests nobody has picked up', () => {
  const html = render({ needs: null, quiet: { claims: 0, alone: false }, general: { handle: 'general', last: true, said: 'so good', by: 'lukas', ago: '3d ago', unread: 4 } });
  assert.match(html, /<div class="fr-card"><p class="fr-cardnote">Nothing more to vote on\.<\/p><button type="button" class="fr-row">/, 'a line, not a row');
  assert.doesNotMatch(html, /<span class="fr-t">Needs you<\/span>/);
  assert.match(html, /<span class="fr-aft"> · 3d ago<\/span><\/span><\/span><span class="fr-pill fr-act" data-kind="act">4 new<\/span>/);
  const claims = render({ needs: null, quiet: { claims: 2, alone: false } });
  assert.match(claims, /<p class="fr-cardnote">Nothing more to vote on · <button type="button" class="fr-link">2 requests nobody has picked up<\/button><\/p>/, 'the phrase is the way to the Workshop');
  assert.match(render({ needs: null, quiet: { claims: 1, alone: true } }), /<p class="fr-cardnote"><button type="button" class="fr-link">1 request nobody has picked up<\/button><\/p>/);
  assert.doesNotMatch(render({ needs: null, quiet: null }), /fr-cardnote/, 'a project with nobody else in it says nothing about votes');
  assert.match(render({ general: { handle: 'general', last: false, said: '', by: null, ago: '', unread: 0 } }), /<span class="fr-s">No messages yet\.<\/span>/);
});

test('Recently live is three picture cards (who and when under each name), ending in its link; before anything went live, the app itself', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Recently live<\/h2><button type="button" class="fr-link">All in Workshop<\/button><\/div><div class="fr-card"><div class="fr-shots fr-s3 fr-cards">/);
  assert.match(html, /<a class="fr-shot fr-shotc" href="#app\/homeroom\/dev\/changes\/6370"><span class="fr-pic fr-img" aria-hidden="true"><img src="\/visuals\/abc"[^>]*\/><\/span><span class="fr-cap2"><b>Email templates, part 7<\/b><\/span><span class="fr-cap2">snait · 48m ago<\/span><\/a>/);
  assert.match(html, /<a class="fr-shot fr-shotc" href="#app\/homeroom\/dev\/changes\/6369"><span class="fr-pic fr-img" aria-hidden="true"><span class="fr-tile"[^>]*>☕<\/span><\/span><span class="fr-cap2"><b>Email templates, part 6<\/b><\/span><\/a>/, 'no picture: the project\'s tile; nobody named: no second line');
  assert.doesNotMatch(html, /Built by/, 'not the first tour\'s rows');
  const own = render({ live: [], ownLive: { name: 'Pourover Coffee', line: 'Live since today', onOpen() {} } });
  assert.match(own, /<h2 class="fr-cap">Recently live<\/h2><\/div><div class="fr-card"><div class="fr-shots fr-s3 fr-cards"><button type="button" class="fr-shot fr-shotc">.*?<b>Pourover Coffee<\/b><\/span><span class="fr-cap2">Live since today<\/span><\/button>/s, 'no door to the Workshop while nothing has landed');
  assert.doesNotMatch(render({ live: [] }), />Recently live</, 'an empty group is not drawn');
});

test('the topics are listed on a phone only, each as the Hub\'s own row, the rest behind Show N more', () => {
  const html = render();
  assert.match(html, /<section class="fr-sec fr-p"><div class="fr-sechead"><h2 class="fr-cap">Topics<\/h2><\/div>/, 'the kit\'s phone-only mark: a wide window has the Topics tab');
  assert.match(html, /<span class="fr-lead">🚪<\/span><span class="fr-tx"><span class="fr-t">Onboarding <span class="fr-mut">#onboarding<\/span><\/span><span class="fr-s">Signing up and the first week<\/span>/);
  assert.match(html, /<span class="fr-t">Homeroom bot <span class="fr-mut">#homeroom-bot<\/span><\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/);
  const many = render({ topics: Array.from({ length: 8 }, (_, i) => ({ key: `c:t${i}`, name: `T${i}`, handle: `t${i}`, icon: '', about: '', unread: 0 })) });
  assert.equal((many.match(/<span class="fr-mut">#t\d<\/span>/g) || []).length, 6);
  assert.match(many, /<button type="button" class="fr-row fr-sm fr-showall"><span class="fr-tx"><span class="fr-t">Show 2 more<\/span>/);
  assert.doesNotMatch(render({ topics: [] }), />Topics<\/h2>/);
  assert.match(read('frontend/looks/kit.css'), /\.hr:not\(\.phone\) \.p\{display:none!important\}/);
});

test('the side column is People alone: this week\'s faces and names, then who it is for', () => {
  const html = render({ onOpenApp() {} });
  const side = html.slice(html.lastIndexOf('<div class="fr-stack fr-first">'));
  assert.match(side, /^<div class="fr-stack fr-first"><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">People<\/h2><\/div><div class="fr-card"><div class="fr-row fr-wrap fr-all"><span class="fr-avs"><span class="fr-av"[^>]*>s<\/span><span class="fr-av"[^>]*>e<\/span><span class="fr-av fr-more"[^>]*>\+24<\/span><\/span><span class="fr-tx"><span class="fr-t">26 active this week<\/span><span class="fr-s">snait, evan, Bruno and 23 more<\/span>.*?<span class="fr-t">Public community<\/span><span class="fr-s">228 members<\/span>/s, 'first on a phone, as the hero\'s people are');
  assert.doesNotMatch(side, /How a change goes live|The app|fr-cap">Who decides/, 'today\'s Hub has neither');
  assert.doesNotMatch(render({ people: null }), /active this week/);
});

test('a visitor gets no actions, and a place that is not the Hub keeps the head and tabs alone', () => {
  const html = render({ onInvite: null });
  assert.doesNotMatch(html, /fr-acts/);
  const joins = render({ onInvite: null, onJoin() {}, onOpenApp() {} });
  assert.match(joins, /<div class="fr-acts"><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Open app<\/button><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>Join<\/button><\/div>/s, 'signed in and not a member yet: Join is the one primary button');
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /offerJoin\(\{ code: 'join_required', app: \{ slug, name: projectName \} \}\)/);
  const head = renderComponent(FRAME, 'ProjectFrameHead', { title: 'Homeroom bot', purpose: 'Everything asked for, being built and voted on in Homeroom.', tabs, tab: 'workshop', onTab() {} }, { cache: false });
  assert.match(head, /^<div class="fr" data-project-frame="workshop"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Homeroom bot<\/h1>.*?<\/div><\/div><nav class="fr-tabs">.*?<\/nav><\/div><\/div>$/s, 'no buttons');
  assert.match(head, /class="fr-tab fr-on" aria-pressed="true">Workshop</);
});

test('the page draws the kit\'s Hub under a look, from what its own Hub reads', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /openInviteLinks\(\)/);
  assert.match(src, /<ProjectHubFrame\b/);
  assert.match(src, /<ProjectFrameHead\b/);
  const hub = src.slice(src.indexOf('const frameHub = (): ReactNode => {'), src.indexOf('const framePurpose ='));
  assert.match(hub, /onOpenApp=\{!actions\.selfHosted \? \(\) => \{ \(window as any\)\.App\?\.openAppTab\?\.\(slug, 'app'\); \} : null\}/, 'the hero\'s Open app, not on the platform\'s own page');
  assert.match(hub, /needs=\{owedRows\.length \? \{/, 'the row while any vote is owed, seen or not (ForYouCard)');
  assert.match(hub, /quiet=\{owedRows\.length \|\| \(alone && !claims\) \? null : \{ claims, alone \}\}/);
  assert.match(hub, /onWorkshop=\{v\.mine\?\.viewer \? \(\) => openTab\('workshop'\) : null\}/);
  assert.match(hub, /src: row\.picture \|\| null,/, 'the after shot the standard card shows');
  assert.match(hub, /t\('project:hub\.recent\.byGoing', \{ who: row\.who \}\)/);
  assert.match(hub, /faces: active\.map\(\(person\) => \(\{ name: person\.username, color: swatchFor\(person\.username\) \}\)\)/);
  assert.doesNotMatch(hub, /frameRule|frameWork|project:frame\.hub\.(builtBy|saidBy|members|openApp)/);
  // No place's head but the Hub's has buttons: Needs you's lost Invite and Ask for a change with the rest (lane K).
  assert.match(src, /<ProjectFrameHead \{\.\.\.frameHead\} title=\{pageTitle\(tab\)\} purpose=\{framePurpose\} \/>/);
  assert.doesNotMatch(src, /askChange|onAsk=/);
});

test('Topics is the places list\'s own rows: the topics, and the channels beside them, each by its name', () => {
  const html = renderComponent(FRAME, 'ProjectTopicsFrame', {
    tabs, tab: 'topics', onTab() {},
    general: { key: 'discussion', label: 'general', count: 0 },
    topics: [
      { key: 'c:onboarding', label: 'onboarding', count: 0 },
      { key: 'c:infra', label: 'infra', count: 2 },
    ],
    onOpen() {},
  }, { cache: false });
  assert.match(html, /^<div class="fr" data-project-frame="topics"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Topics<\/h1><p class="fr-purpose">Each topic is a channel and a category of work\.<\/p><\/div><\/div>/, 'one sentence, no button');
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true">Topics</);
  const main = html.slice(html.indexOf('<div class="fr-cols">'), html.indexOf('<div class="fr-stack fr-first">'));
  assert.match(main, /<h2 class="fr-cap">Topics<\/h2>.*?<button type="button" class="fr-row fr-sm"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">onboarding<\/span><\/span><svg/s, 'the name alone, as the list says it');
  assert.match(main, /<span class="fr-t">infra<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 unread<\/span>/);
  assert.match(html.slice(html.indexOf('<div class="fr-stack fr-first">')), /<h2 class="fr-cap">Channels<\/h2>.*?<span class="fr-t">general<\/span>/s, 'the channels beside them, first on a phone');
  assert.doesNotMatch(html, /Propose a topic|About topics|Changed by a vote|open request/, 'what the first tour added to the list');
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /topics=\{placeRows\(community\?\.places, owed\)\.topics\}/, 'the places list\'s own rows (project-places.tsx placeRows)');
});

test('under a look the project\'s page has the frame\'s page area, and the standard page stays mounted behind the kit\'s', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]\[data-project-frame\] #app-view \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/);
  assert.match(hand, /html\[data-skin\]\[data-project-frame\] #dev-workshop \{ max-width: none; margin: 0; \}/, 'not the standard look\'s 760px column');
  assert.match(hand, /html\[data-skin\] \.dev-ws > \[data-project-frame\] ~ \.dev-ws-placebar \{ display: none; \}/, 'the places are the kit\'s tabs');
  assert.match(hand, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'where the kit draws the whole place');
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
  assert.match(css, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'the body is put away for the kit\'s own pages only; a channel is not one');
  // In a phone browser a channel's tab is a fitted box (`--ws-fit`), the
  // chat's composer on its foot. Under a look the kit's head stands inside
  // that box, taller than the standard one, and the chat under it, holding
  // to its own 320px floor, ran under the kit's tab bar: it takes the room
  // the head leaves, its stream scrolling inside it either way.
  assert.match(css, /html\[data-skin\] \.dev-ws > \[data-project-frame\] ~ \.dev-ws-tabbody > \.dev-ws-discussion \{ min-height: 0; \}/);
});

test('#general under a look: what it is for under the title, the room in the content column, This channel beside it', () => {
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /: tab === 'discussion' \? t\('project:frame\.place\.general', \{ project: projectName \}\)\s+: t\('project:frame\.place\.channel', \{ project: projectName \}\);/, 'a topic\'s channel keeps its own sentence');
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  assert.equal(catalog['frame.place.general'].text, `${catalog['places.generalHead.about'].text}.`, 'the standard line\'s own words, as a sentence');
  // The line over the room is the kit's group under a look, from the one
  // owner of the mute state (no second copy is mounted).
  const head = read('frontend/src/features/dev-board/workshop/channel-head.tsx');
  assert.match(head, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  const kit = head.slice(head.indexOf('if (frame) {'), head.indexOf('  return (\n    <div className="dev-ws-channel-head" data-ws-channel-head="general">'));
  assert.match(kit, /<div className="fr dev-ws-channel-head" data-ws-channel-head="general" data-frame-side="">\s+<Sec label=\{t\('project:frame\.channel\.this'\)\}>/);
  assert.match(kit, /title=\{members > 0 \? t\('project:places\.generalHead\.members', \{ count: members \}\) : about\}/);
  assert.match(kit, /<Btn\s+small\s+kind="line"\s+icon="bell"\s+data-ws-channel-mute=\{muted \? 'on' : 'off'\}\s+aria-pressed=\{muted\}\s+disabled=\{busy\}/);
  assert.match(kit, /onClick=\{\(\) => \{ void toggle\(\); \}\}/, 'the same write');
  assert.equal((head.match(/useState<boolean \| null>\(known\)/g) || []).length, 1);
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const grid = 'html[data-skin] .dev-ws > [data-project-frame="discussion"] ~ .dev-ws-tabbody > .dev-ws-general-channel:not(.dev-ws-discussion-threaded, :has(.messages-reply-pane))';
  assert.ok(hand.includes(`${grid} {\n    display: grid; grid-template-columns: minmax(0, 720px) 320px; grid-template-rows: minmax(0, 1fr); column-gap: 32px; max-width: none;`), 'the kit\'s two columns; a reply thread beside the room takes the width back');
  assert.ok(hand.includes(`${grid} > .dev-ws-channel-head { grid-column: 2; grid-row: 1; align-self: start; margin: 0; }`));
  assert.ok(hand.includes(`${grid} > :not(.dev-ws-channel-head) { grid-column: 1; grid-row: 1; min-width: 0; min-height: 0; }`));
  assert.ok(hand.indexOf(`${grid} {`) > hand.indexOf('@media (min-width: 768px) {\n  html[data-skin] .dev-ws > [data-project-frame="discussion"]') - 1, 'on a phone the group stays over the room');
  assert.match(hand, /html\[data-skin\] \.fr-post \.gc-quoted \{[^}]*border-inline-start: 3px solid var\(--fr-acc\); border-radius: 0; background: none; \}/, 'a quoted reply wears the kit\'s quote');
});
