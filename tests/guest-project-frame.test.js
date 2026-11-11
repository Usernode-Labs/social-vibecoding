// A public community's page for a visitor, in the one frame (frontend/src/
// features/guest/frame/project-frame.tsx): version 2 of the screen tour's
// o20, o21, w12 and w13. The first tour's layout (a head with one primary
// button, tabs, two columns) holding today's read-only page: the icon, the
// name, "Public community", the facts line; each change up for a vote as a
// card with its before and after; the picture, What's happening, People
// and From the chat beside them. The product's own page (../guest-project
// .tsx) reads the data and keeps the state; under a look it hands both to
// this view.
//
// Run with: node --test tests/guest-project-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const VIEW = 'frontend/src/features/guest/frame/project-frame.tsx';

const APP = { slug: 'game-corner', name: 'Game Corner', description: 'Twelve small games.', url: 'https://gc.example', icon_emoji: '🎮', icon_url: null, icon_color: '#3b2d8f', requires_login: false, active_users: 41, merged_week: 2, last_merged_at: '2026-11-08T10:00:00Z' };
const OVERVIEW = {
  app: { ...APP, builders: 25, open_votes: 2 },
  votes: [
    { id: 7, pr_number: 70, title: 'Snake: wrap-around walls', summary: 'An option in the menu.', yes: 2, no: 0, pictures: { before: '/b.png', after: '/a.png' } },
    { id: 8, pr_number: 71, title: null, summary: null, yes: 0, no: 1, pictures: null },
  ],
  merged: [{ id: 3, title: 'Dark mode', summary: 'Follows the device.', merged_at: '2026-11-08T10:00:00Z' }],
  requests: { total: 3, more: false, items: [{ number: 12, title: 'A leaderboard' }, { number: 13, title: 'Sounds' }] },
};
const base = {
  color: '#123456',
  app: APP, overview: OVERVIEW, loaded: true, tab: 'hub', onTab() {}, signedIn: false, pinned: false, onPin() {}, canTry: true,
  onIntent() {}, onOpenInside() {}, onShare() {}, now: Date.parse('2026-11-09T10:00:00Z'),
};
const render = (over) => renderComponent(VIEW, 'GuestProjectFrame', { ...base, ...over }, { cache: false });
const titles = (html) => [...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]);
const caps = (html) => [...html.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1].replace(/&#x27;/g, '\''));

test('the head: the icon, the name, what it is, how many built and use it, and one primary button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-guest-project-frame="game-corner" data-guest-project-tab="hub"><div class="fr-inner"><div class="fr-head"><span class="fr-tile" style="--fr-ts:56px;--fr-tc:#3b2d8f" aria-hidden="true">🎮<\/span><div class="fr-tx"><h1 class="fr-title">Game Corner<\/h1><div class="fr-sub13">Public community<\/div><p class="fr-purpose">Twelve small games\.<span class="fr-sub13" data-guest-project-facts="">Built by 25 people · 41 people used it lately<\/span><\/p><\/div>/);
  const acts = html.slice(html.indexOf('fr-acts'), html.indexOf('</div>', html.indexOf('fr-acts')));
  assert.match(acts, /^fr-acts"><a class="fr-btn" href="https:\/\/gc\.example" data-guest-try="game-corner"><svg[^>]*>.*?<\/svg>Try it<\/a><button type="button" class="fr-btn fr-line" data-guest-join-project="">Join<\/button><button type="button" class="fr-btn fr-line" data-guest-pin-project="" aria-pressed="false">Pin<\/button><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Share<\/button>$/s,
    'Try it first, then Join, Pin and Share with its word');
  assert.match(render({ pinned: true }), /aria-pressed="true">Pinned<\/button>/);
  assert.match(render({ canTry: false }), /<div class="fr-acts"><button type="button" class="fr-btn" data-guest-use="">Sign in to use it<\/button>/, 'an app with no view for visitors says what it takes');
  // The facts follow the standard band's own minimums.
  const small = render({ app: { ...APP, active_users: 3 }, overview: { ...OVERVIEW, app: { ...OVERVIEW.app, builders: 2 } } });
  assert.match(small, /<span class="fr-sub13" data-guest-project-facts="">2 changes voted in this week<\/span>/, 'under them, what changed this week');
  assert.match(small, /<span class="fr-t">Built by 2 people<\/span>/, 'People still says who built it');
  assert.match(render({ app: { ...APP, description: '' } }), /<p class="fr-purpose"><span class="fr-sub13" data-guest-project-facts="">Built by 25 people/);
  assert.doesNotMatch(html, /reading as a guest|fr-note/, 'no banner: today\'s page has none');
});

test('the places are the page\'s tabs', () => {
  const html = render({ tab: 'workshop' });
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab(?: fr-on)?" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]),
    [['Hub', 'false'], ['Workshop', 'true'], ['Discussion', 'false']]);
});

test('the Hub: each change up for a vote is a card with its before and after; the picture, what is happening and who is here beside them', () => {
  const html = render();
  assert.deepEqual(caps(html), ['Up for a vote', 'Recently voted in', 'People', 'From the chat', 'What\'s happening', 'People', 'From the chat']);
  // The work column, then the side column, which leads on a phone.
  const side = html.slice(html.indexOf('<div class="fr-stack fr-first">'));
  const main = html.slice(html.indexOf('<div class="fr-cols">'), html.indexOf('<div class="fr-stack fr-first">'));
  assert.match(main, /<div class="fr-card"><div class="fr-shots"><figure><img src="\/b\.png" alt="" loading="lazy"\/><figcaption>Before<\/figcaption><\/figure><figure><img src="\/a\.png" alt="" loading="lazy"\/><figcaption>After<\/figcaption><\/figure><\/div><div class="fr-ballot fr-visit" data-guest-vote="7"><div><h3 class="fr-sub17">Snake: wrap-around walls<\/h3><p class="fr-sum">An option in the menu\.<\/p><\/div><div class="fr-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i style="width:100%"><\/i><\/div><div class="fr-line1"><span>2 for · 0 against<\/span><button type="button" class="fr-btn fr-quiet fr-sm" data-guest-vote-btn="">Vote<\/button><\/div><\/div><\/div>/,
    'the standard card: pictures, name, sentence, the share of yeses, the tally and Vote');
  assert.match(main, /<div class="fr-card"><div class="fr-ballot fr-visit" data-guest-vote="8"><div><h3 class="fr-sub17">A change<\/h3><\/div>/, 'a change with no pictures and no name');
  assert.match(main, /<h2 class="fr-cap">Recently voted in<\/h2><\/div><div class="fr-card"><div class="fr-row fr-wrap fr-all"><span class="fr-tx"><span class="fr-t">Dark mode<\/span><span class="fr-s">Follows the device\.<\/span><\/span><span class="fr-meta">1d ago<\/span><\/div>/);
  assert.match(main, /<div class="fr-p fr-stack"><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">People<\/h2>/, 'on a phone People and the chat come last, as on the standard page');
  assert.match(side, /^<div class="fr-stack fr-first"><div class="fr-cover" style="--fr-tc:#123456" aria-hidden="true" data-guest-hero=""><span class="fr-tile" style="--fr-ts:72px;--fr-tc:#3b2d8f" aria-hidden="true">🎮<\/span><\/div><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">What&#x27;s happening<\/h2>/, 'no picture of its own: its icon on the community\'s colour');
  assert.deepEqual(titles(side.slice(0, side.indexOf('fr-d fr-stack'))), ['2 changes up for a vote', '3 requests open', 'Updated 1d ago']);
  assert.match(side, /<div class="fr-d fr-stack"><section class="fr-sec">.*?<span class="fr-t">Built by 25 people<\/span><span class="fr-s">41 people used it lately<\/span>.*?<button type="button" class="fr-row fr-wrap fr-all">.*?<span class="fr-t">The chat is for members<\/span><span class="fr-s">Join Game Corner to read along and say hi\.<\/span><\/span><span class="fr-btn fr-quiet fr-sm">Join<\/span><\/button>/s);
  assert.doesNotMatch(html, /fr-t">Public community</, 'said once, under the name');
  const pictured = render({ app: { ...APP, illustration_url: '/art.png', illustration_dark_url: '/art-dark.png' } });
  assert.match(pictured, /<div class="fr-cover" aria-hidden="true" data-guest-hero=""><img src="\/art\.png" alt="" class="fr-sun"\/><img src="\/art-dark\.png" alt="" class="fr-moon"\/><\/div>/, 'the picture its group chose, and its dark twin');
  assert.equal((render({ overview: { ...OVERVIEW, votes: [1, 2, 3, 4].map((id) => ({ ...OVERVIEW.votes[1], id })) } }).match(/data-guest-vote="/g) || []).length, 3, 'the first three; the Workshop has them all');
});

test('the Workshop: every change up for a vote, and the requests beside them', () => {
  const html = render({ tab: 'workshop' });
  assert.deepEqual(caps(html), ['Up for a vote', 'Requests'], 'People is the Hub\'s, as on the standard page');
  assert.match(html, /<div class="fr-shots"><figure><img src="\/b\.png" alt="" loading="lazy"\/><figcaption>Before<\/figcaption><\/figure>/);
  // The picture is the kit's own (Shot and Shots); a shot that cannot be
  // read is dropped where it fails to load.
  const src = read('frontend/@/components/ui/kit.tsx');
  assert.match(read(VIEW), /import \{[^}]*\bShot, Shots\b[^}]*\} from '@\/components\/ui\/kit';/);
  assert.doesNotMatch(read(VIEW), /function Shot\(|className="fr-shots"/, 'no second copy of it here');
  assert.match(src, /\{bad \? null : <img src=\{src\} alt="" loading="lazy" onError=\{\(\) => setBad\(true\)\} \/>\}<figcaption>\{label\}<\/figcaption>/);
  const side = html.slice(html.lastIndexOf('<div class="fr-stack">'));
  assert.match(side, /^<div class="fr-stack"><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">Requests<\/h2><button type="button" class="fr-link">Ask for something<\/button><\/div><div class="fr-card">/);
  assert.deepEqual(titles(side), ['A leaderboard', 'Sounds']);
  assert.match(side, /<p class="fr-cardnote fr-last">and 1 more<\/p><\/div>/);
  assert.doesNotMatch(html, /fr-cover|What&#x27;s happening|From the chat/);
  assert.match(render({ tab: 'workshop', overview: null, loaded: false }), /<div class="fr-card fr-pad">Loading…<\/div>/);
  assert.match(render({ tab: 'workshop', overview: { ...OVERVIEW, votes: [], requests: null } }), /Nothing is up for a vote right now\..*The requests can&#x27;t be shown right now\./s);
});

test('the Discussion says the chat is for members, with the way in', () => {
  const html = render({ tab: 'discussion' });
  assert.match(html, /<div class="fr-cols fr-one"><div class="fr-stack"><div class="fr-card fr-pad"><div class="fr-sub17">The chat is for members<\/div><p class="fr-purpose">Join Game Corner to read along and say hi\.<\/p><div class="fr-btnrow"><button type="button" class="fr-btn" data-guest-chat-join="">Join<\/button><\/div><\/div>/);
});

test('an account still in line reads the same page: Try it and Share, and "once you\'re in" where a visitor has a button', () => {
  // The tour's w12 and w13, in today's chrome (the guest's bar).
  const hub = render({ signedIn: true });
  const acts = hub.slice(hub.indexOf('fr-acts'), hub.indexOf('</div>', hub.indexOf('fr-acts')));
  assert.match(acts, /Try it<\/a><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Share<\/button>$/s);
  assert.doesNotMatch(hub, /data-guest-join-project|data-guest-pin-project|data-guest-vote-btn|>Join</);
  assert.match(hub, /<div class="fr-line1"><span>2 for · 0 against<\/span><span class="fr-later" data-guest-vote-later="">You can vote once you&#x27;re in<\/span><\/div>/);
  assert.match(hub, /<div class="fr-row fr-wrap fr-all">.*?<span class="fr-t">The chat is for members<\/span><span class="fr-s">You can join once you&#x27;re in<\/span>/s);
  const workshop = render({ signedIn: true, tab: 'workshop' });
  assert.doesNotMatch(workshop, /Ask for something/);
  const waiting = render({ tab: 'discussion', signedIn: true });
  assert.match(waiting, /You can join once you&#x27;re in/);
  assert.doesNotMatch(waiting, /data-guest-chat-join/, 'not offered a button that cannot work yet');
});

test('the frame\'s bar names the tab after the project when it is not the Hub', () => {
  const page = read('frontend/src/features/guest/guest-project.tsx');
  assert.match(page, /useEffect\(\(\) => \{ onPlace\?\.\(tab\); \}, \[tab, onPlace\]\);/);
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /onPlace=\{setProjectTab\}/);
  assert.match(landing, /\{frame && guestPages && guestProject && projectTab !== 'hub' \? \(\s*<span hidden data-guest-place="trail">\{projectTab === 'workshop' \? t\('auth:guest\.project\.tab\.workshop'\) : t\('auth:guest\.project\.tab\.discussion'\)\}<\/span>/);
  assert.equal(JSON.parse(read('frontend/locales/en/auth.json'))['frame.project.guest'], undefined, 'the banner\'s words went with it');
});

test('every class is the kit\'s', () => {
  for (const tab of ['hub', 'workshop', 'discussion']) {
    const classes = [...render({ tab }).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    for (const c of classes) assert.match(c, /^fr(-|$)/, `${tab}: ${c} is not a kit class`);
  }
});

test('the product\'s page hands its data and state to the view under a look', () => {
  const src = read('frontend/src/features/guest/guest-project.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/, 'mounted after the first paint: the device\'s own look at once');
  assert.match(src, /if \(frame\) \{\s*return \(\s*<GuestProjectFrame/);
  assert.match(src, /overview=\{overview\}\s*loaded=\{loaded\}\s*tab=\{tab\}\s*onTab=\{setTab\}/, 'one read of the overview, one state, whichever look draws it');
  assert.doesNotMatch(src, /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/);
});
