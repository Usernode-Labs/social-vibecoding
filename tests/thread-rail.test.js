'use strict';

// "How it got here": the timeline of a thread's big events beside a
// request's or a change's card (frontend/src/features/dev-board/topic/
// rail-model.ts and thread-rail.tsx; app.css "THE THREAD'S RAIL").
//
// The model is pure: who asked, the newest plan, each change built, what its
// tests said, then where the thread stands, which is the standing the server
// stored and worded. These tests read its steps in words, and hold the three
// places that draw it: the shell's host between the root post and the
// replies, the two heads that portal into it (never under one of the frame's
// looks), and the stylesheet that stands it beside the card on a wide page
// and folds its earlier steps into a pile on a narrow one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { withWords } = require('./lib/work-words');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/rail-model.ts';
const RAIL = 'frontend/src/features/dev-board/topic/thread-rail.tsx';

const words = (p) => (p == null ? null : typeof p === 'string' ? p : message(p.id, p.values));
const names = (steps) => steps.map((s) => words(s.title));

const plan = (over = {}) => ({
  key: 'spec:1', title: 'Plan', version: 1, by: 'Homeroom bot', at: '2026-11-07T10:00:00Z', time: 'Nov 7', timeTitle: '',
  read: { kind: 'shared', sessionId: 9, version: 1, previewTitle: 'Plan' }, ...over,
});
const change = (over = {}) => ({
  type: 'change', id: 51, number: 8, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 0,
  by: 'Homeroom bot', at: '2026-11-08T09:00:00Z', ...over,
});
const lead = (over = {}) => ({
  id: 51, number: 8, status: 'promoted', checks: { state: 'passing', phase: 'done', failing: null }, votes: { yes: 0, no: 0 },
  voteOpen: true, firstVersion: false, githubHold: false, shotsHeld: false, conflict: false, update: null, ...over,
});
const standing = (state) => withWords({ since: '2026-11-08T12:00:00Z', ...state });
const base = { asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: null };

test('a request just asked: Asked, then the stage the bot is on', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({ ...base, standing: standing({ stage: 'reading' }) });
  assert.deepEqual(names(steps), ['Asked', 'Reading it']);
  assert.equal(words(steps[0].desc), 'By maya.');
  assert.deepEqual(JSON.parse(JSON.stringify(steps[0].link.open)), { kind: 'request' });
  assert.equal(words(steps[0].link.label), 'Read the request');
  assert.equal(steps[1].now, true);
  assert.equal(steps[1].busy, true, 'the bot is at work on it');
  assert.equal(steps[1].since, true, 'its stamp reads "since"');
  assert.equal(steps.filter((s) => s.now).length, 1, 'one step is where it stands');
});

test('a request with no words of its own offers nothing to read', () => {
  const { requestRail } = loadTsx(MODEL);
  assert.equal(requestRail({ ...base, words: false })[0].link, null);
});

test('the newest plan standing is the Planned step, and opens that plan', () => {
  const { requestRail, newestPlan } = loadTsx(MODEL);
  const specs = [plan({ key: 'a', version: 1, ended: 'replaced' }), plan({ key: 'b', version: 2, by: 'evan' }), plan({ key: 'c', version: 3, ended: 'stopped' })];
  assert.equal(newestPlan(specs).key, 'b', 'a plan that ended is passed over while another stands');
  assert.equal(newestPlan([specs[0], specs[2]]).key, 'c', 'with none standing, the newest of them');
  assert.equal(newestPlan([]), null);
  const steps = requestRail({ ...base, specs, standing: standing({ stage: 'waiting_for_you', why: 'plan' }) });
  assert.deepEqual(names(steps), ['Asked', 'Planned, v2', 'Waiting for you to OK the plan']);
  assert.equal(words(steps[1].desc), 'By evan.');
  assert.deepEqual(JSON.parse(JSON.stringify(steps[1].link.open)), { kind: 'plan', key: 'b' });
  assert.equal(steps[2].busy, false, 'it waits on a person');
  const others = requestRail({ ...base, specs, yours: false, standing: standing({ stage: 'waiting_for_you', why: 'plan' }) });
  assert.equal(words(others[2].title), 'Waiting for the plan to be OK’d'.replace('’', "'"), 'anyone else reads their own wording');
  const first = requestRail({ ...base, specs: [plan({ by: 'System', bySystem: true })] });
  assert.equal(words(first[1].title), 'Planned');
  assert.equal(first[1].desc, null, 'a stand-in author is not named');
});

test('a change being built is the last step, not an event behind it', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({
    ...base, specs: [plan()], changes: [change({ state: 'underway', ready: false })],
    standing: standing({ stage: 'building', change: lead({ status: 'active', checks: { state: null, phase: null, failing: null } }) }),
  });
  assert.deepEqual(names(steps), ['Asked', 'Planned', 'Building']);
});

test('tests running, tests failed, and only the screenshots left', () => {
  const { requestRail } = loadTsx(MODEL);
  const running = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'checks_running', minutes: 2 }, change: lead({ checks: { state: 'pending', phase: 'testing', failing: null } }) }),
  });
  assert.deepEqual(names(running), ['Asked', 'Built', 'Checking']);
  assert.equal(running[2].busy, true);

  const failing = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'fixing' }, change: lead({ checks: { state: 'failing', phase: 'done', failing: 3 } }) }),
  });
  assert.deepEqual(names(failing), ['Asked', 'Built', '3 tests failed', 'Checking']);
  assert.equal(failing[2].tone, 'bad');
  assert.equal(words(failing[2].link.label), 'See what failed');
  assert.deepEqual(JSON.parse(JSON.stringify(failing[2].link.open)), { kind: 'checks', changeId: 51 });
  assert.equal(words(failing[3].note), 'Fixing what its tests found');

  const one = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'stopped', reason: 'fix_stopped', change: lead({ checks: { state: 'failing', phase: 'done', failing: 1 } }) }),
  });
  assert.deepEqual(names(one), ['Asked', 'Built', '1 test failed', 'Stopped: its tests still fail']);
  assert.equal(one[3].tone, 'bad');
  const unknown = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'stopped', reason: 'fix_stopped', change: lead({ checks: { state: 'failing', phase: 'done', failing: null } }) }),
  });
  assert.equal(words(unknown[2].title), 'Tests failed', 'with no count it says so plainly');

  const shots = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'shots' }, change: lead() }),
  });
  assert.deepEqual(names(shots), ['Asked', 'Built', 'Tested', 'Taking screenshots']);
  assert.equal(shots[3].icon, 'shots');
});

test('up for a vote, approved and going live, live, and closed', () => {
  const { requestRail } = loadTsx(MODEL);
  const vote = requestRail({ ...base, specs: [plan()], changes: [change()], standing: standing({ stage: 'up_for_vote', change: lead() }) });
  assert.deepEqual(names(vote), ['Asked', 'Planned', 'Built', 'Tested', 'Up for a vote']);
  assert.equal(words(vote[3].desc), 'All checks passed.');
  assert.equal(vote[4].busy, false);

  const going = requestRail({ ...base, changes: [change()], standing: standing({ stage: 'going_live', change: lead({ votes: { yes: 2, no: 0 } }) }) });
  assert.deepEqual(names(going), ['Asked', 'Built', 'Tested', 'Approved', 'Going live']);
  assert.equal(words(going[3].desc), '2 yes votes.');

  const live = requestRail({ ...base, changes: [change({ state: 'merged', status: 'merged' })], standing: standing({ stage: 'live', change: lead({ status: 'merged', votes: { yes: 1, no: 0 } }) }) });
  assert.deepEqual(names(live), ['Asked', 'Built', 'Tested', 'Approved', 'Live']);
  assert.equal(words(live[3].desc), '1 yes vote.');
  assert.equal(live[4].tone, 'ok');
  assert.equal(live[4].since, false, 'a settled step gives its date, not "since"');

  const closed = requestRail({ ...base, standing: standing({ stage: 'closed' }) });
  assert.deepEqual(names(closed), ['Asked', 'Closed']);
  assert.equal(closed[1].tone, 'muted');
});

test('several changes are numbered, and each opens its own section', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({
    ...base,
    changes: [change(), change({ id: 52, number: 9, by: 'sam', at: '2026-11-09T09:00:00Z' })],
    standing: standing({ stage: 'up_for_vote', change: lead() }),
  });
  assert.deepEqual(names(steps), ['Asked', 'Change #8 built', 'Tested', 'Change #9 built', 'Up for a vote']);
  assert.deepEqual(JSON.parse(JSON.stringify(steps[3].link.open)), { kind: 'change', changeId: 52 });
  assert.equal(words(steps[3].link.label), 'Open');
});

test('with no standing (an older server) every step is behind, and nothing is "now"', () => {
  const { requestRail, railFolds, earlierSteps } = loadTsx(MODEL);
  const steps = requestRail({ ...base, specs: [plan()], changes: [change()] });
  assert.deepEqual(names(steps), ['Asked', 'Planned', 'Built']);
  assert.equal(steps.some((s) => s.now), false);
  assert.equal(earlierSteps(steps).length, 3);
  assert.equal(railFolds(steps), true);
  assert.equal(railFolds(requestRail({ ...base, standing: standing({ stage: 'reading' }) })), false, 'one earlier step is not worth a pile');
});

test("a change's own page: planned, built, its tests, then where it stands", () => {
  const { changeRail } = loadTsx(MODEL);
  const input = {
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: plan({ by: 'evan' }),
    testing: { tone: 'done', done: true, figure: 'All checks passed' },
    status: { key: 'vote', label: 'Vote · 0/2' },
    votes: { figure: 'Needs 2 more yes', done: false, asking: true },
  };
  const vote = changeRail(input);
  assert.deepEqual(names(vote), ['Planned', 'Built', 'Tested', 'Up for a vote']);
  assert.equal(words(vote[3].note), 'Needs 2 more yes');

  const failed = changeRail({ ...input, plan: null, testing: { tone: 'bad', done: false, figure: 'Found a problem' }, votes: { figure: '1 yes vote, 1 needed', done: true, asking: false } });
  assert.deepEqual(names(failed), ['Built', 'Tests failed', 'Vote · 0/2']);
  assert.deepEqual(JSON.parse(JSON.stringify(failed[1].link.open)), { kind: 'checks', changeId: 51 });
  assert.equal(failed[2].note, null);

  const testing = changeRail({ ...input, plan: null, testing: { tone: 'muted', done: false, figure: null }, status: { key: 'checking', label: 'Checking' }, votes: null });
  assert.deepEqual(names(testing), ['Built', 'Checking']);
  assert.equal(testing[1].busy, true);

  const merged = changeRail({ ...input, plan: null, status: { key: 'merged', label: 'Live' }, votes: { figure: null, done: true, asking: false } });
  assert.equal(merged[merged.length - 1].tone, 'ok');
  assert.equal(words(merged[merged.length - 1].title), 'Live');
});

test('the shell holds the rail between the root post and the replies, on a request and a change only', () => {
  const shell = read('frontend/src/features/group-chat/thread-shell.tsx');
  assert.match(shell, /<div id="gc-thread-head" \/>[\s\S]{0,600}\{decision \? null : <div id="gc-thread-rail" className="dev-request-rail" \/>\}\s*<div id="gc-thread-messages" \/>/);
});

test('both heads portal the rail into its host, and never under one of the frame\'s looks', () => {
  for (const file of ['frontend/src/features/dev-board/topic/request-head.tsx', 'frontend/src/features/dev-board/topic/change-head.tsx']) {
    const src = read(file);
    assert.match(src, /const rail = frame \? null : host\('gc-thread-rail'\);/, file);
    // `current`: the step open over the card, which the rail marks (thread-card.tsx).
    assert.match(src, /\{rail \? createPortal\(<ThreadRail steps=\{railSteps\} onOpen=\{openRail\} current=\{cardLook \? openNow : null\} \/>, rail\) : null\}/, file);
  }
  const request = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(request, /open\.kind === 'plan'[\s\S]{0,160}openRequestSpec\(card\)/, 'a plan opens in the reader it always did');
  assert.match(request, /call\('openTechnicalDetails', \[open\.changeId\]\)/, 'failed tests open the change\'s details');
  assert.match(request, /showChangeSection\(open\.changeId\)/, 'a competing change opens its own section');
});

test('the rail draws its steps, the folded pile, and the links by what they open', () => {
  const rail = read(RAIL);
  assert.match(rail, /className="dev-rail" data-thread-rail=\{steps\.length\} data-rail-fold=\{folds \? \(open \? 'open' : 'shut'\) : undefined\}/);
  assert.match(rail, /className="dev-rail-pile" data-rail-pile=\{early\.length\} aria-expanded="false"/);
  assert.match(rail, /bare=\{i < early\.length - 1\}/, 'only the newest marker in the pile wears its glyph');
  assert.match(rail, /data-rail-open=\{s\.link\.open\.kind\}/);
  assert.match(rail, /t\('project:topic\.rail\.showEarlier', \{ count: early\.length \}\)/);
  assert.equal(message('project:topic.rail.title'), 'How it got here');
  assert.equal(message('project:topic.rail.showEarlier', { count: 4 }), 'Show 4 earlier steps');
  assert.equal(message('project:topic.rail.showEarlier', { count: 1 }), 'Show 1 earlier step');
  assert.equal(message('project:topic.rail.showLess'), 'Show less');
  assert.equal(message('project:topic.rail.since', { when: 'Nov 13' }), 'since Nov 13');
});

test('the stylesheet: beside the card on a wide page, a folded pile on a narrow one, the standard and brand looks only', () => {
  const css = read('public/css/app.css');
  const at = css.indexOf("THE THREAD'S RAIL: \"How it got here\"");
  // Before the bell's sheet, which is the block that ends at the generated
  // looks (tests/frame-app.test.js), and so before the brand look too.
  const next = css.indexOf("/* THE BELL'S SHEET");
  const brand = css.indexOf('/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING');
  assert.ok(at > 0 && at < next && next < brand, 'the block sits before the brand look, which repaints it');
  const block = css.slice(at, next);
  assert.match(block, /\.dev-request-rail:empty \{ display: none; \}/);
  assert.match(block, /@media \(max-width: 1179\.98px\) \{\s*\.dev-rail\[data-rail-fold="shut"\] \.dev-rail-pile \{ display: flex; \}\s*\.dev-rail\[data-rail-fold="shut"\] \.dev-rail-step:not\(\[data-rail-now\]\) \{ display: none; \}/);
  const wide = block.slice(block.indexOf('@media (min-width: 1180px)'));
  const scope = 'html:is(:not([data-skin]), [data-skin="brand"]):not(.in-side-panel) .gc-tab-body:not(:has(> .gc-spec-side-panel-open)) #dev-topic-thread:not(.dev-ws-side-page) .dev-request:has(.dev-request-rail:not(:empty))';
  const rules = wide.split('\n').filter((line) => /^\s*html/.test(line));
  assert.ok(rules.length >= 9, 'the wide layout has its rules');
  for (const line of rules) assert.ok(line.trim().startsWith(scope), `scoped to the two looks, a page, and no open reader: ${line.trim().slice(0, 80)}`);
  assert.match(wide, /\.dev-request-scroll \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) var\(--thread-rail-w\);/);
  assert.match(wide, /\.dev-request-rail \{\s*grid-column: 2;\s*grid-row: 1 \/ span 2;\s*align-self: start;\s*position: sticky;/);
  // The cards are cards at every width (a phone's three, a desktop's two
  // columns): their paint sits outside the wide rule, on the same scope, and
  // a look paints them through the `-look` variables.
  const cards = block.slice(block.indexOf('/* THE CARDS, at every width'), block.indexOf('/* WIDE: two columns.'));
  assert.ok(cards.length > 0, 'the cards have their own part of the block');
  for (const line of cards.split('\n').filter((l) => /^html/.test(l))) assert.ok(line.startsWith(scope), `scoped as the wide layout is: ${line.slice(0, 80)}`);
  assert.match(cards, /--thread-card: var\(--thread-card-look, var\(--dc-sheet-fill\)\);/);
  assert.match(cards, /:is\(#gc-thread-head, #gc-thread-messages, \.dev-request-rail\) \{\s*min-width: 0;\s*border-radius: var\(--thread-card-r\);\s*background: var\(--thread-card\);/);
  assert.match(css.slice(brand), /\.dev-request \{\s*--thread-card-look: var\(--bl-card\);\s*--thread-card-solid-look: var\(--bl-card\);\s*--thread-card-edge-look: inset 0 0 0 1px var\(--app-sheet-line\), var\(--bl-lift\);/);
});
