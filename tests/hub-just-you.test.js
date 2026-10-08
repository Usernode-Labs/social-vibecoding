'use strict';

// The hub of a project nobody else is in yet
// (frontend/src/features/dev-board/workshop/).
//
// Evan, testing on his phone on 5 Oct 2026, of a brand-new "Just you"
// project whose first version Homeroom bot was still building: "The initial
// hub if no one has joined is really sad. It should come with a short
// description, made the build stage, etc." It read only "Just you", Open app
// and the ⋯, "Nothing more to vote on.", the Share it card, and "Your work ·
// No work in progress."
//
// Now:
//
//   - the hero has a description even when dapp.json has none yet: the first
//     sentence of the description it was made from (server half pinned in
//     tests/hub-just-you-postgres.test.js);
//   - a First version card under the hero says where Homeroom bot's build
//     stands, in the build line the made screen and the App tab draw
//     ("Building it", #4053: never "Step 4 of 7: Build it", which read as an
//     instruction), and opens the bot's chat when the bot waits on its maker;
//   - "Nothing more to vote on." is a zero nobody else could change, so a
//     project nobody else is in leaves it out;
//   - an empty Your work says how to change something there, or leaves the
//     hub while the first version or the start-here banner already says
//     what is next;
//   - a project with people in it is drawn as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');

const hub = loadTsx(HUB);

const community = (over = {}) => ({
  slug: 'geneva-hikes',
  name: 'Geneva hike planner',
  description: 'Plan hikes around Geneva with friends',
  member_count: 1,
  is_member: true,
  is_creator: true,
  audience: 'solo',
  audience_label: 'Just you',
  members: [{ id: 7, username: 'evan' }],
  channel: null,
  activity: null,
  can_manage: true,
  audience_change: null,
  approval: { policy: 'anyone', approvals_required: null, electorate: 1, required: 1 },
  first_version: null,
  ...over,
});

const building = (over = {}) => ({
  step: 4, of: 7, line: 'building', ready: false, mine: true, creator: 'evan',
  waits_on: null, conversation_id: 41, session_id: null, ...over,
});

const card = (fv) => renderToHtml(createElement(hub.FirstVersionCard, {
  slug: 'geneva-hikes', data: community({ first_version: fv }),
}));

test('a just-you project being built: the build line, and no step count or build time', () => {
  const html = card(building());
  assert.match(html, /^<section class="dev-ws-strip dev-ws-hub-first" data-ws-first-version="building">/);
  assert.match(html, /<span class="dev-ws-head-title">First version<\/span>/);
  assert.match(html, /<span role="status" data-build-line="building"[^>]*>.*>Building it<\/span><\/span>/,
    'the made screen\'s and the App tab\'s words, with a spinner');
  assert.match(html, /animate-spin/);
  // #4053: no "Step 4 of 7" and no ring counting it: step numbers stay in
  // Homeroom bot's chat. Evan, 5 Oct 2026: no average build time either.
  assert.doesNotMatch(html, /Step \d of|<svg[^>]*width="38"|4\/7|minute|usually/);
  assert.doesNotMatch(html, /data-ws-first-version-chat|data-ws-first-version-change/,
    'nothing to press while nothing waits on its maker');
  assert.equal(hub.firstVersionLine(building({ step: 1, line: 'planning' })), 'planning');
  assert.equal(hub.firstVersionLine(building({ line: null })), 'planning', 'a record without its line');
  assert.equal(hub.firstVersionLine(building({ line: null, ready: true })), 'ready');
  assert.equal(hub.firstVersionStep, undefined);
  assert.equal(hub.firstVersionNote, undefined, 'one line, said once');
  const src = read(HUB);
  assert.doesNotMatch(src.slice(src.indexOf('export const FIRST_VERSION_POLL_MS'), src.indexOf('export function ReelThumb(')),
    /typical_minutes|\$\{minutes\}|usually in about|ProgressRing/, 'and nothing reads one');
});

test('a plan or a question waiting on its maker: the blue line, and a button to the chat', () => {
  const plan = card(building({ step: 3, line: 'plan', waits_on: 'plan' }));
  assert.match(plan, /data-ws-first-version="plan"/);
  assert.match(plan, /data-build-line="plan"[^>]*>.*Your plan is ready to review/);
  // The canvas's FVCard: "Review the plan", with the chat glyph, opens Homeroom bot's chat.
  assert.match(plan, /<button[^>]*data-ws-first-version-chat=""[^>]*><svg[^>]*aria-hidden="true">.*<\/svg>Review the plan<\/button>/);
  assert.match(plan, /data-ws-first-version-chat="" class="inline-flex items-center gap-2 rounded-full bg-violet-600[^"]*self-start"/,
    'the accent: it is the one thing on the hub that waits on them');
  assert.doesNotMatch(plan, /Go to chat/);
  const question = card(building({ step: 2, line: 'question', waits_on: 'question' }));
  assert.match(question, /data-ws-first-version="question"/);
  assert.match(question, /Homeroom bot has a question for you/);
  assert.match(question, /data-ws-first-version-chat="" class="rounded-full bg-violet-600[^"]*self-start"[^>]*>Go to chat<\/button>/);
  // The chat is theirs: their DM when the record names it, else the bot's door.
  const src = read(HUB);
  assert.match(src, /if \(fv\.conversation_id\) openConversation\(fv\.conversation_id\);\s*else void openBot\(\);/);
  assert.match(src, /import \{ open as openConversation, openBot \} from '\.\.\/\.\.\/messages\/store';/);
});

test('ready to try: Ready to try, and See the change opens it', () => {
  const html = card(building({ step: 6, line: 'ready', ready: true, session_id: 990003 }));
  assert.match(html, /data-ws-first-version="ready"/);
  assert.match(html, /data-build-line="ready"[^>]*>.*Ready to try/);
  assert.match(html, /<a href="#app\/geneva-hikes\/dev\/proposals\/990003" class="dev-ws-hub-open un-touch-target self-start" data-ws-first-version-change="">See the change/);
  assert.doesNotMatch(html, /data-ws-first-version-chat/);
  assert.doesNotMatch(card(building({ ready: true, session_id: null })), /data-ws-first-version-change/,
    'no change to open when the read of it failed');
});

test('somebody else reading it while its plan waits: Planning it, and nobody\'s chat', () => {
  const html = card(building({ mine: false, creator: 'ada', conversation_id: null, step: 3, line: 'plan-member' }));
  assert.match(html, /data-build-line="plan-member"[^>]*>.*Planning it/);
  assert.doesNotMatch(html, /data-ws-first-version-chat|--accent/);
});

test('the line is the server\'s for this viewer, and its words are the build line\'s, never written on the hub', () => {
  const src = read(HUB);
  const body = src.slice(src.indexOf('export const FIRST_VERSION_POLL_MS'), src.indexOf('export function ReelThumb('));
  assert.match(body, /return buildLineOf\(fv\.line\) \|\| \(fv\.ready \? 'ready' : 'planning'\);/);
  assert.match(body, /<BuildLine state=\{firstVersionLine\(fv\)\} \/>/);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['Homeroom bot is planning it', 'Your plan is ready to review', 'Planning it', 'Building it', 'Testing it', 'Ready to try', 'Step ']) {
    for (const quote of ["'", '"', '`', '>']) {
      assert.ok(!code.includes(`${quote}${name}`), `no line written in the hub's code: ${quote}${name}`);
    }
  }
  const route = read('src/routes/apps.js');
  assert.match(route, /line: state\.line \|\| null,/);
  assert.match(route, /const state = await botDm\.firstVersionState\(pool, app\.id, \{ viewerId: req\.user\?\.id \?\? null \}\);\s*firstVersion = hubFirstVersion\(state, req\.user\?\.id \?\? null\);/,
    'read for this viewer, as GET /api/apps/:slug reads it for the App tab');
});

test('nothing being built, or no record yet: no card', () => {
  assert.equal(card(null), '');
  assert.equal(renderToHtml(createElement(hub.FirstVersionCard, { slug: 'geneva-hikes', data: null })), '');
  // While it is on screen it reads the record again, as the App tab and the
  // made screen read theirs: no event marks each step.
  const src = read(HUB);
  const body = src.slice(src.indexOf('export function FirstVersionCard('), src.indexOf('export function ReelThumb('));
  assert.match(body, /window\.setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'visible'\) return;\s*if \(!ref\.current \|\| !ref\.current\.getClientRects\(\)\.length\) return;\s*void reloadCommunity\(slug\);\s*\}, FIRST_VERSION_POLL_MS\);/);
  assert.match(body, /return \(\) => window\.clearInterval\(timer\);/);
  assert.equal(hub.FIRST_VERSION_POLL_MS, 15000);
});

test('"Nothing more to vote on." is a zero on a project nobody else is in', () => {
  const { NothingToVote, hubAlone } = hub;
  assert.equal(renderToHtml(createElement(NothingToVote, { queue: [], onOpen: () => {}, alone: true })), '');
  const claims = [{ t: 'card', key: 'r1', kind: 'claim', card: { title: { text: 'Trail maps' } } }];
  const one = renderToHtml(createElement(NothingToVote, { queue: claims, onOpen: () => {}, alone: true }));
  assert.match(one, /^<p class="dev-ws-week-note" data-ws-hub-needs-none=""><button[^>]*data-ws-hub-needs-requests="">1 request nobody has picked up<\/button><\/p>$/,
    'a request still waiting is still the way into Needs you');
  // A project with people in it: as it was (#3408).
  assert.equal(renderToHtml(createElement(NothingToVote, { queue: [], onOpen: () => {} })),
    '<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on.</p>');
  assert.equal(hubAlone(community()), true, 'Just you');
  assert.equal(hubAlone(community({ audience: 'open', audience_label: 'Public community', member_count: 1 })), true,
    'a public community nobody has joined yet');
  assert.equal(hubAlone(community({ audience: 'invited', audience_label: 'Private community', member_count: 2 })), false);
  assert.equal(hubAlone(community({ audience: 'open', member_count: 12 })), false);
  assert.equal(hubAlone(null), false, 'nothing is taken off the hub before the read answers');
});

test('Your work on a project nobody else is in: how to change something, or nothing', () => {
  const { YourWorkCard, hubWorkEmpty } = hub;
  const props = { slug: 'geneva-hikes', canPost: true, openKey: null, onToggleRow: () => {}, all: false, onAll: () => {}, rows: [] };
  const is = (over) => hubWorkEmpty({ alone: true, building: false, startHere: false, readOnly: false, bot: false, ...over });
  assert.equal(is({ alone: false, building: true, startHere: true }), 'plain', 'a project with people in it keeps #3489');
  assert.equal(is({ building: true }), null, 'its first version being built already says what is next');
  assert.equal(is({ startHere: true }), null, 'so does the start-here banner');
  assert.equal(is({ readOnly: true }), null, 'and a read-only viewer has nothing to start');
  assert.equal(is({ bot: true }), 'bot');
  assert.equal(is({}), 'menu');

  assert.equal(renderToHtml(createElement(YourWorkCard, { ...props, empty: null })), '');
  const bot = renderToHtml(createElement(YourWorkCard, { ...props, empty: 'bot' }));
  assert.match(bot, /^<section class="dev-ws-strip dev-ws-hub-work" data-ws-mine-card="">/);
  assert.match(bot, /data-ws-mine-empty="bot">Nothing in progress\. To change something, tell Homeroom bot\.<\/p>/);
  assert.match(bot, /<button[^>]*data-ws-mine-bot=""[^>]*>Go to chat<\/button>/);
  assert.match(bot, /data-ws-mine-bot="" class="rounded-full bg-zinc-100 /, 'a neutral pill: nothing waits on them');
  const menu = renderToHtml(createElement(YourWorkCard, { ...props, empty: 'menu' }));
  assert.match(menu, /data-ws-mine-empty="menu">Nothing in progress\. Press <span class="font-medium text-violet-700 dark:text-violet-400">⋯<\/span> to suggest an improvement\.<\/p>/);
  // A project with people in it: as it was, for the declared check that
  // reads "No work in progress." on Homeroom's own hub.
  const plain = renderToHtml(createElement(YourWorkCard, { ...props }));
  assert.match(plain, /<p class="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">No work in progress\.<\/p>/);
  const declared = JSON.parse(read('dapp.json')).tests
    .find((t) => t.name === 'Hub: Your work stays when nothing is in progress, and says so (#3489)');
  assert.equal(declared.expectText, 'No work in progress.');
  assert.match(declared.path, /#app\/usernode-2d5619\/workshop$/, 'on Homeroom\'s own hub, which has people in it');
});

test('the Share it card says what an invite is for while it is being built', () => {
  const { shareItLine } = loadTsx(CARD);
  assert.equal(shareItLine(true), 'Invite people to follow along while it’s being built, or make it public so anyone can join.');
  assert.equal(shareItLine(false), 'Invite people to make it a private community, or make it public so anyone can join.');
  assert.match(read(CARD), /<p className="dev-ws-strip-text">\{shareItLine\(!!data\.first_version && !data\.first_version\.ready\)\}<\/p>/);
});

test('the hub puts the first version under the hero, and stands the start-here prompt down while the bot builds', () => {
  const hubTab = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("), LANDER.indexOf("{tab === 'discussion' ? ("));
  const at = (x) => hubTab.indexOf(x);
  assert.ok(at('<CommunityCard') >= 0 && at('<CommunityCard') < at('<FirstVersionCard')
    && at('<FirstVersionCard') < at('{startHere ? <StartHereBanner />') && at('<FirstVersionCard') < at('<SinceSummaryCard'),
    'right under the hero, ahead of everything else on the hub');
  assert.match(hubTab, /\{slug \? <FirstVersionCard slug=\{slug\} data=\{community\} \/> : null\}/);
  // Before its description is filed the board is empty too, and "The first
  // change is yours to start" told its maker to start the bot's change.
  assert.match(LANDER, /const building = !!\(community && community\.first_version\);\s*const startHere = !!\(v\.dashboard && v\.dashboard\.open === 0 && !v\.dashboard\.everShipped\) && !building;/);
  assert.match(hubTab, /\{v\.emptyNote && !building \? \(/, 'nor the no-items note');
  assert.match(LANDER, /const alone = hubAlone\(community\);\s*const workEmpty = hubWorkEmpty\(\{\s*alone, building, startHere, readOnly: !!actions\.readOnly, bot: !!\(v\.mine && v\.mine\.bot\),\s*\}\);/);
  assert.match(hubTab, /<NothingToVote queue=\{v\.queue\} onOpen=\{\(\) => openTab\('needs'\)\} alone=\{alone\} \/>/);
  assert.match(hubTab, /\{v\.mine && \(v\.mine\.rows\.length \|\| \(v\.mine\.viewer && workEmpty\)\) \? \(\s*<YourWorkCard[\s\S]{0,400}empty=\{workEmpty\}/);
  // The ring and its row are app.css's, beside the hub's doors.
  assert.match(read('public/css/app.css'), /\.dev-ws-hub-first-row \{ display: flex; align-items: center; gap: 12px; min-width: 0; \}/);
});

test('the server cuts the bot\'s state to what the hub says, and hands the maker\'s chat to the maker alone', () => {
  const { hubFirstVersion } = require('../src/routes/apps');
  const state = {
    userId: 7, creator: 'evan', conversationId: 41, step: 3, of: 7, line: 'plan',
    question: false, ready: false, plan: { bullets: ['A trail list'], actionId: 5 },
  };
  assert.deepEqual(hubFirstVersion(state, 7), {
    step: 3, of: 7, line: 'plan', ready: false, mine: true, creator: 'evan',
    waits_on: 'plan', conversation_id: 41, session_id: null,
  }, 'the line as the state says it for this viewer, and no build time');
  assert.deepEqual(hubFirstVersion({ ...state, line: 'plan-member' }, 9), {
    step: 3, of: 7, line: 'plan-member', ready: false, mine: false, creator: 'evan',
    waits_on: null, conversation_id: null, session_id: null,
  }, 'nobody else is told what it waits on from its maker, or handed their chat');
  assert.doesNotMatch(read('src/routes/apps.js').slice(read('src/routes/apps.js').indexOf('function hubFirstVersion('),
    read('src/routes/apps.js').indexOf('function isPlatformRepo(')), /typical/i, 'no build time in the hub\'s cut');
  assert.equal(hubFirstVersion({ ...state, plan: undefined, question: true }, 7).waits_on, 'question');
  const ready = hubFirstVersion({ ...state, plan: undefined, ready: true, step: 6, line: 'ready', approval: { sessionId: 31 } }, 9);
  assert.deepEqual([ready.ready, ready.session_id, ready.waits_on], [true, 31, null]);
  assert.equal(hubFirstVersion(null, 7), null);
});
