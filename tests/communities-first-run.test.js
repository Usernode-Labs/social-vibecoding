'use strict';

// A new account's first run on the client (communities, stages 4 and 5):
// the join screen that follows the username and terms steps, the Getting
// started card on Home, and the small mark on a Home tile that says where a
// project lives. The server half (what the screen lists, what answering
// does, what ticks the card's steps) is tests/onboarding-postgres.test.js;
// the tour that runs between them is tests/home-tour.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GATE = read('frontend/src/features/auth/communities-first-run.js');
const MAIN = read('frontend/src/main.tsx');
const AUTH = read('src/routes/auth.js');
const SIGNUP = read('src/services/email-signup.js');
const SCHEMA = read('src/db/schema.sql');
const CARD_SRC = read('frontend/src/features/home/getting-started.tsx');
const HOME_SRC = read('frontend/src/features/home/index.tsx');
const HOME_JS = read('frontend/src/features/home/home.js');
const GRID_SRC = read('frontend/src/features/home/app-grid.tsx');
const DAPP = JSON.parse(read('dapp.json'));

// ── who is asked ───────────────────────────────────────────────────────

test('only a new account is asked: a flag set at sign-up, false for everyone before it', () => {
  assert.match(SCHEMA,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS communities_onboarded_at TIMESTAMPTZ;/);
  assert.match(SCHEMA, /ALTER TABLE users ADD COLUMN IF NOT EXISTS getting_started_closed_at TIMESTAMPTZ;/);
  // No backfill: the default IS the answer for existing accounts, and for
  // the accounts the boot seeds (capture identities), which a NULL-means-new
  // rule would have put behind a blocking step.
  assert.doesNotMatch(SCHEMA, /UPDATE users\s+SET needs_communities_choice/);
  assert.match(SIGNUP, /needs_username_choice, needs_communities_choice\)\s*\n\s*VALUES \(\$1, \$2, \$3, TRUE, NOW\(\), FALSE, FALSE, TRUE, TRUE\)/);
  // /api/auth/me carries both flags, failing toward no step and no card.
  assert.match(AUTH, /let needsCommunitiesChoice = false;\s*\n\s*let showGettingStarted = false;/);
  assert.match(AUTH, /\(u\.communities_onboarded_at IS NOT NULL\s*\n\s*AND u\.getting_started_closed_at IS NULL\) AS show_getting_started/);
  assert.match(AUTH, /\n\s*needsCommunitiesChoice,\n/);
  assert.match(AUTH, /\n\s*showGettingStarted,\n/);
});

// ── the join screen ────────────────────────────────────────────────────

test('the join screen comes after the username and terms steps, and before the tour', () => {
  assert.ok(MAIN.indexOf("import './features/auth/username-first-run.js';")
    < MAIN.indexOf("import './features/auth/communities-first-run.js';"));
  assert.match(GATE, /window\.App\.user\.needsCommunitiesChoice !== true/);
  // It waits on terms, which waits on the username step.
  assert.match(GATE, /const terms = window\.TermsFirstRun;[\s\S]{0,120}await terms\.settled\(\);/);
  assert.ok(GATE.indexOf('await CommunitiesFirstRun._afterEarlierSteps();')
    < GATE.indexOf("fetch('/api/me/join-suggestions'"), 'terms first, then the list');
  // It publishes the settled() the tour waits on.
  assert.match(GATE, /window\.CommunitiesFirstRun = CommunitiesFirstRun;/);
  assert.match(read('frontend/src/features/home/tour/index.tsx'), /host\.CommunitiesFirstRun/);
});

test('it never lands on a capture route, and has one screenshot state of its own', () => {
  assert.match(GATE, /const SHOT = 'join-communities';/);
  assert.match(GATE, /params\.get\('shot'\) \|\| params\.get\('demo'\) \|\| params\.get\('token'\)/);
  assert.ok(GATE.indexOf("params.get('shot') === SHOT") < GATE.indexOf("params.get('token')"),
    'the one opt-in is read before the skip');
  // The fixture writes nothing.
  assert.match(GATE, /if \(opts && opts\.demo\) \{ status\.textContent = ''; return; \}/);
});

test('one exit, the answer, and the button says what it will do', () => {
  assert.match(GATE, /PlatformUI\.modal\(\{ contentEl: panel, dismissible: false \}\)/);
  assert.match(GATE, /n === 0 \? 'Pick at least one'/);
  assert.match(GATE, /`Join \$\{n\} \$\{n === 1 \? 'community' : 'communities'\}`/);
  assert.match(GATE, /'What communities do you want to join\?'/);
  assert.match(GATE, /'You can join or leave any time from Discover\.'/);
  // In the screen's order, so the first one ticked is the card's.
  assert.match(GATE, /join: list\.map\(\(c\) => c\.slug\)\.filter\(\(s\) => picked\.has\(s\)\)/);
  // Home re-reads its pins and the card appears.
  assert.match(GATE, /new CustomEvent\('sv:communities-joined'/);
  assert.match(GATE, /window\.App\.user\.showGettingStarted = true;/);
  const code = GATE.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /console\.error/, 'a console error on any route fails proposal checks');
  assert.doesNotMatch(code, /—/, 'no em dash in the copy');
});

// ── the Getting started card ───────────────────────────────────────────

test('the card ships as an empty hidden section, and draws nothing until the server says so', () => {
  const html = renderComponent('frontend/src/features/home/getting-started.tsx', 'GettingStarted');
  assert.equal(html,
    '<section id="home-getting-started" class="hidden px-3 pb-2 pt-3" aria-label="Getting started"></section>');
  assert.match(CARD_SRC, /useHiddenClass\(rootRef, !model\);/);
  assert.match(CARD_SRC, /showGettingStarted === true/);
  assert.match(CARD_SRC, /fetch\('\/api\/me\/getting-started'/);
  // It sits on top of Home, above the widget strip and Your apps.
  assert.ok(HOME_SRC.indexOf('<GettingStarted />') < HOME_SRC.indexOf('<WidgetStrip />'));
  assert.ok(HOME_SRC.indexOf('<GettingStarted />') < HOME_SRC.indexOf('<section id="home-apps-section"'));
});

test('the card counts, records the two visits it asks for, and closes for good', () => {
  const card = loadTsx('frontend/src/features/home/getting-started.tsx');
  assert.equal(card.counterText({ done: 1, total: 3 }), '1 of 3');
  assert.equal(card.counterText({ done: 3, total: 3 }), 'All done');
  assert.equal(card.seenKeyFor({ href: '#workshop' }), 'workshop');
  assert.equal(card.seenKeyFor({ href: '#apps' }), 'discover');
  assert.equal(card.seenKeyFor({ href: '#messages/app/x' }), null, 'a message leaves its own row');
  assert.match(CARD_SRC, /void post\('\/api\/me\/getting-started\/close'\)/);
  assert.match(CARD_SRC, /void post\('\/api\/me\/getting-started\/seen', \{ step: seen \}\)/);
  // The fixture is three steps, one done, the shape the declared check reads.
  assert.deepEqual(card.SHOT_MODEL.steps.map((s) => [s.id, s.done]),
    [['say-hi', true], ['vote', false], ['explore', false]]);
  assert.doesNotMatch(CARD_SRC.replace(/\/\*[\s\S]*?\*\//g, ''), /—/);
});

// ── the tile mark (stage 4) ────────────────────────────────────────────

test('a Home tile says where it lives: people for a group, a lock for just you, nothing for a community', () => {
  assert.match(HOME_JS,
    /audience: app\.audience === 'invited' \|\| app\.audience === 'solo' \? app\.audience : 'open',/);
  assert.match(GRID_SRC, /\{app\.audience !== 'open' \? \(/);
  assert.match(GRID_SRC, /data-stage=\{app\.audience\}/);
  assert.match(GRID_SRC, /\? <UserGroupIcon className="w-3 h-3" aria-hidden="true" \/>\s*\n\s*: <LockIcon className="w-3 h-3" aria-hidden="true" \/>/);
  assert.match(GRID_SRC, /title=\{app\.audience === 'invited' \? 'Group' : 'Just you'\}/);
});

// ── declared checks ────────────────────────────────────────────────────

test('both screens have a declared check on their own screenshot state', () => {
  const join = DAPP.tests.find((t) => t.id === 'auth.join-communities-first-run');
  assert.equal(join.path, '/?shot=join-communities');
  assert.equal(join.expectText, 'Join 2 communities');
  assert.equal(join.visual, true);
  const card = DAPP.tests.find((t) => t.id === 'home.getting-started-card');
  assert.equal(card.path, '/?shot=getting-started');
  assert.match(card.expectSelector, /\[data-getting-started="1\/3"\]/);
  for (const t of [join, card]) assert.ok(t.expectSelector.length <= 256);
});
